//! Where connection passwords live: the OS keychain, or this process's
//! memory for "ask every session". There is no on-disk fallback.
use std::collections::HashMap;
use std::sync::Mutex;
use zeroize::Zeroizing;

/// A password. It has no `Serialize`, and `Debug` never prints it.
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);
impl Secret {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Secret(…)")
    }
}

/// A place passwords are kept, addressed by connection name.
pub trait SecretStore: Send + Sync {
    /// `Err` explains, for the user, why the store cannot be used.
    fn availability(&self) -> Result<(), String>;
    fn set(&self, account: &str, secret: &Secret) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<Secret>, String>;
    /// Deleting an entry that does not exist succeeds.
    fn delete(&self, account: &str) -> Result<(), String>;
}

impl<T: SecretStore + ?Sized> SecretStore for std::sync::Arc<T> {
    fn availability(&self) -> Result<(), String> {
        (**self).availability()
    }
    fn set(&self, account: &str, secret: &Secret) -> Result<(), String> {
        (**self).set(account, secret)
    }
    fn get(&self, account: &str) -> Result<Option<Secret>, String> {
        (**self).get(account)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        (**self).delete(account)
    }
}

/// The OS keychain: Secret Service on Linux, Keychain Services on macOS.
pub struct Keychain {
    service: String,
}
impl Keychain {
    /// Entries are stored under `service`, one per connection name.
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }
    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, account).map_err(describe)
    }
}

/// A keychain error for the user. Platform errors describe the keychain
/// (locked, no service), never the secret.
fn describe(error: keyring::Error) -> String {
    match error {
        keyring::Error::NoDefaultStore => unavailable(),
        keyring::Error::NoStorageAccess(cause) => {
            format!("The system keychain is locked or refused access: {cause}")
        }
        keyring::Error::PlatformFailure(cause) => format!("The system keychain failed: {cause}"),
        keyring::Error::BadEncoding(_) | keyring::Error::BadDataFormat(..) => {
            "The keychain entry for this connection is not readable text. Replace the password.".into()
        }
        keyring::Error::Ambiguous(_) => {
            "More than one keychain entry matches this connection. Remove the duplicates in your keychain manager.".into()
        }
        keyring::Error::TooLong(field, limit) => format!("The {field} is longer than the keychain allows ({limit})."),
        other => format!("The system keychain could not be used: {other}"),
    }
}
fn unavailable() -> String {
    if cfg!(target_os = "macos") {
        "The macOS Keychain is not available to this app.".into()
    } else {
        "No Secret Service keychain is running (GNOME Keyring, KWallet or KeePassXC provide one).".into()
    }
}

impl SecretStore for Keychain {
    fn availability(&self) -> Result<(), String> {
        match keyring::Entry::store_status() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoDefaultStore) => Err(unavailable()),
            Err(error) => Err(format!("{} ({error})", unavailable())),
        }
    }
    fn set(&self, account: &str, secret: &Secret) -> Result<(), String> {
        self.availability()?;
        self.entry(account)?.set_password(secret.expose()).map_err(describe)
    }
    fn get(&self, account: &str) -> Result<Option<Secret>, String> {
        self.availability()?;
        match self.entry(account)?.get_password() {
            Ok(password) => Ok(Some(Secret::new(password))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(describe(error)),
        }
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.availability()?;
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(describe(error)),
        }
    }
}

/// A store that is never available: `NOTATION_KEYCHAIN=off`, and builds
/// where the state database (and so the keychain scope) cannot be opened.
pub struct NoKeychain(pub String);
impl SecretStore for NoKeychain {
    fn availability(&self) -> Result<(), String> {
        Err(self.0.clone())
    }
    fn set(&self, _: &str, _: &Secret) -> Result<(), String> {
        Err(self.0.clone())
    }
    fn get(&self, _: &str) -> Result<Option<Secret>, String> {
        Err(self.0.clone())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Passwords held in memory only: the "ask every session" store, and the
/// keychain stand-in for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, Secret>>);
impl SecretStore for MemoryStore {
    fn availability(&self) -> Result<(), String> {
        Ok(())
    }
    fn set(&self, account: &str, secret: &Secret) -> Result<(), String> {
        self.0.lock().map_err(|_| "Password store failed.".to_string())?.insert(account.into(), secret.clone());
        Ok(())
    }
    fn get(&self, account: &str) -> Result<Option<Secret>, String> {
        Ok(self.0.lock().map_err(|_| "Password store failed.".to_string())?.get(account).cloned())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().map_err(|_| "Password store failed.".to_string())?.remove(account);
        Ok(())
    }
}

/// Remove every occurrence of `secret` from a message bound for the UI.
/// Drivers do not echo passwords; this is a second line of defence.
pub fn scrub(message: &str, secret: Option<&Secret>) -> String {
    match secret.map(Secret::expose) {
        Some(value) if !value.is_empty() && message.contains(value) => message.replace(value, "•••"),
        _ => message.to_string(),
    }
}
