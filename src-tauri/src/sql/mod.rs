//! SQL blocks: read-only queries against SQLite, Postgres and MySQL.
//!
//! A note names a connection; it never holds connection details. Profiles
//! (host, user, limits) are metadata in the state database. Passwords are
//! in the OS keychain, or in this process's memory for "ask every session";
//! they are accepted from the UI and never returned to it.
//!
//! Read-only is enforced by the database, not by reading the SQL: SQLite is
//! opened read-only with an authorizer, Postgres and MySQL run inside a
//! read-only transaction that is always rolled back, and every driver sends
//! the text as a single prepared statement. `guard` adds friendly up-front
//! messages only.
pub mod guard;
mod mysql;
mod postgres;
pub mod secrets;
mod sqlite;
mod tls;
#[cfg(test)]
mod tests;

use crate::storage::Database;
use rusqlite::{params, OptionalExtension};
use secrets::{scrub, Secret, SecretStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const DEFAULT_ROW_LIMIT: u32 = 1000;
pub const MAX_ROW_LIMIT: u32 = 10_000;
pub const DEFAULT_TIMEOUT_SECONDS: u32 = 30;
pub const MAX_TIMEOUT_SECONDS: u32 = 600;
/// Longest text kept for one cell; the rest is cut and the cell marked.
pub const MAX_CELL_BYTES: usize = 8 * 1024;
/// Bytes of a binary value kept for display.
pub const MAX_BLOB_PREVIEW: usize = 64;
/// Total size of one result; reading stops there.
pub const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_COLUMNS: usize = 1024;
const MAX_CONNECTIONS: usize = 64;
const MAX_RUNNING: usize = 4;
const MAX_PASSWORD_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Sqlite,
    Postgres,
    Mysql,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    /// Never encrypt.
    Disable,
    /// Encrypt when the server offers it; do not verify the certificate.
    #[default]
    Prefer,
    /// Always encrypt; do not verify the certificate.
    Require,
    /// Always encrypt and verify the certificate chain and host name.
    VerifyFull,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PasswordStorage {
    /// The connection needs no password.
    #[default]
    None,
    /// The password is in the OS keychain.
    Keychain,
    /// The password is asked for once per app session and kept in memory.
    Session,
}

/// Connection metadata. It has no password field, and unknown fields are
/// rejected, so a password cannot ride along into the state database.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub name: String,
    pub kind: Kind,
    /// SQLite database file.
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub tls_mode: TlsMode,
    /// PEM file of the certificate authority, for `verify-full`.
    #[serde(default)]
    pub ca_file: String,
    #[serde(default = "default_row_limit")]
    pub row_limit: u32,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u32,
    #[serde(default)]
    pub password_storage: PasswordStorage,
}
fn default_row_limit() -> u32 {
    DEFAULT_ROW_LIMIT
}
fn default_timeout() -> u32 {
    DEFAULT_TIMEOUT_SECONDS
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    #[serde(flatten)]
    pub profile: Profile,
    /// `none`, `keychain`, `session` (held for this session) or `needed`
    /// (ask-every-session, not entered yet).
    pub password_state: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionList {
    pub connections: Vec<ConnectionView>,
    pub keychain_available: bool,
    /// Why the keychain cannot be used, when it cannot.
    pub keychain_reason: Option<String>,
    pub max_row_limit: u32,
    pub max_timeout_seconds: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SqlError {
    /// `invalid`, `unknown_connection`, `password_required`, `keychain`,
    /// `refused`, `connect`, `query`, `timeout`, `cancelled`, `busy`,
    /// `internal`.
    pub code: &'static str,
    pub message: String,
}
impl SqlError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}
impl std::fmt::Display for SqlError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    /// Chosen by the caller; `cancel` takes the same id.
    pub id: String,
    pub connection: String,
    pub sql: String,
    /// Values for `:name` placeholders: text, numbers, booleans or null.
    #[serde(default)]
    pub parameters: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// The database's name for the column type, when it reports one.
    pub type_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub connection: String,
    pub kind: Kind,
    pub columns: Vec<Column>,
    /// One array per row. A cell is `null`, a boolean, a number, a string,
    /// or `{ "t": kind, "v": text }` for values JSON cannot carry as such:
    /// `number` (big or exact), `date`, `time`, `datetime`, `json`,
    /// `bytes` (`v` is a hex preview, `n` the full length), `text` (cut to
    /// the cell limit, `n` the full length) and `other`.
    pub rows: Vec<Vec<Value>>,
    pub row_count: usize,
    pub row_limit: u32,
    /// `rows` when the row limit stopped the read, `size` for the byte cap.
    pub truncated: Option<&'static str>,
    pub duration_ms: u64,
    /// Milliseconds since the Unix epoch.
    pub finished_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    /// What the server said about itself, e.g. `PostgreSQL 17.2`.
    pub server: String,
    pub duration_ms: u64,
}

/// A bound parameter value.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Parameter {
    Null,
    Bool(bool),
    Integer(i64),
    Float(f64),
    Text(String),
}

/// Cooperative cancellation shared by a running query and `cancel`.
#[derive(Default)]
pub(crate) struct Cancel {
    flag: AtomicBool,
    notify: tokio::sync::Notify,
}
impl Cancel {
    pub(crate) fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub(crate) fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    pub(crate) async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// Everything a driver needs for one run.
pub(crate) struct Job<'a> {
    pub profile: &'a Profile,
    pub password: Option<&'a Secret>,
    pub sql: &'a str,
    /// In the order `guard::check` reported the names.
    pub parameters: Vec<(String, Parameter)>,
    pub timeout: Duration,
    pub cancel: Arc<Cancel>,
}

/// Rows read so far, with the caps applied.
#[derive(Debug)]
pub(crate) struct Collector {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: Option<&'static str>,
    limit: usize,
    bytes: usize,
}
impl Collector {
    fn new(limit: u32) -> Self {
        Self { columns: Vec::new(), rows: Vec::new(), truncated: None, limit: limit as usize, bytes: 0 }
    }
    /// How many more rows are worth fetching: one past the limit, to know
    /// whether more exist.
    pub(crate) fn wanted(&self) -> usize {
        self.limit + 1 - self.rows.len().min(self.limit)
    }
    /// Keep a row. `false` means a cap was reached and reading must stop.
    pub(crate) fn push(&mut self, row: Vec<Value>) -> bool {
        if self.rows.len() >= self.limit {
            self.truncated = Some("rows");
            return false;
        }
        let size: usize = row.iter().map(weight).sum::<usize>() + 2;
        if self.bytes + size > MAX_RESULT_BYTES {
            self.truncated = Some("size");
            return false;
        }
        self.bytes += size;
        self.rows.push(row);
        true
    }
    pub(crate) fn set_columns(&mut self, columns: Vec<Column>) -> Result<(), SqlError> {
        if columns.len() > MAX_COLUMNS {
            return Err(SqlError::new("query", format!("The result has more than {MAX_COLUMNS} columns.")));
        }
        self.columns = columns;
        Ok(())
    }
}
fn weight(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(_) => 5,
        Value::Number(_) => 20,
        Value::String(text) => text.len() + 2,
        Value::Object(fields) => 24 + fields.get("v").and_then(Value::as_str).map_or(0, str::len),
        Value::Array(_) => 2,
    }
}

/// Builders for result cells; see `QueryResult::rows`.
pub(crate) mod cell {
    use super::{json, Value, MAX_BLOB_PREVIEW, MAX_CELL_BYTES};

    pub fn tagged(kind: &str, text: impl Into<String>) -> Value {
        json!({ "t": kind, "v": text.into() })
    }
    /// Text, cut at a character boundary when it exceeds the cell limit.
    pub fn text(value: &str) -> Value {
        if value.len() <= MAX_CELL_BYTES {
            return Value::String(value.to_string());
        }
        let mut end = MAX_CELL_BYTES;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        json!({ "t": "text", "v": &value[..end], "n": value.len() })
    }
    /// Text of a special kind (`json`, `number`, …), cut like `text`.
    pub fn tagged_text(kind: &str, value: &str) -> Value {
        if value.len() <= MAX_CELL_BYTES {
            return tagged(kind, value);
        }
        let mut end = MAX_CELL_BYTES;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        json!({ "t": "text", "v": &value[..end], "n": value.len() })
    }
    pub fn text_bytes(value: &[u8]) -> Value {
        match std::str::from_utf8(value) {
            Ok(value) => text(value),
            Err(_) => bytes(value),
        }
    }
    pub fn bytes(value: &[u8]) -> Value {
        let preview: String = value.iter().take(MAX_BLOB_PREVIEW).map(|byte| format!("{byte:02x}")).collect();
        json!({ "t": "bytes", "v": preview, "n": value.len() })
    }
    /// Integers JavaScript can hold exactly are numbers; larger ones text.
    pub fn integer(value: i64) -> Value {
        if value.unsigned_abs() <= (1 << 53) {
            Value::from(value)
        } else {
            tagged("number", value.to_string())
        }
    }
    pub fn float(value: f64) -> Value {
        serde_json::Number::from_f64(value).map_or_else(
            || tagged("number", if value.is_nan() { "NaN".to_string() } else if value > 0.0 { "Infinity".into() } else { "-Infinity".into() }),
            Value::Number,
        )
    }
}

/// Calendar date for a day count from 1970-01-01 (proleptic Gregorian).
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}
/// `HH:MM:SS` with microseconds only when there are any.
pub(crate) fn clock(hours: i64, minutes: u32, seconds: u32, micros: u32) -> String {
    if micros == 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{hours:02}:{minutes:02}:{seconds:02}.{micros:06}")
    }
}

/// The runtime the network drivers run on. It is separate from the UI's
/// runtime so this module works, and is tested, without Tauri.
pub(crate) fn runtime() -> Result<&'static tokio::runtime::Runtime, SqlError> {
    static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("notation-sql")
                .enable_all()
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| SqlError::new("internal", format!("Could not start the database runtime: {error}")))
}

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphabetic()
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
fn plain(field: &str, value: &str, limit: usize) -> Result<(), SqlError> {
    if value.len() > limit || value.chars().any(char::is_control) {
        return Err(SqlError::new("invalid", format!("{field} is too long or contains control characters.")));
    }
    Ok(())
}

impl Profile {
    /// Check a profile and fill in defaults (port, limits).
    pub fn validated(mut self) -> Result<Self, SqlError> {
        let invalid = |message: &str| Err(SqlError::new("invalid", message));
        if !valid_name(&self.name) {
            return invalid("A connection name starts with a letter and uses letters, digits, - or _ (at most 64).");
        }
        for (field, value, limit) in [
            ("The file path", &self.path, 4096),
            ("The host", &self.host, 255),
            ("The database name", &self.database, 128),
            ("The user name", &self.user, 128),
            ("The CA file path", &self.ca_file, 4096),
        ] {
            plain(field, value, limit)?;
        }
        if self.kind == Kind::Sqlite {
            if !std::path::Path::new(&self.path).is_absolute() {
                return invalid("Choose the SQLite database file (an absolute path).");
            }
            self.host.clear();
            self.database.clear();
            self.user.clear();
            self.ca_file.clear();
            self.port = 0;
            self.tls_mode = TlsMode::Disable;
            self.password_storage = PasswordStorage::None;
        } else {
            self.path.clear();
            if self.host.trim().is_empty() || self.host.chars().any(char::is_whitespace) {
                return invalid("Enter the database host name or address.");
            }
            if self.user.trim().is_empty() {
                return invalid("Enter the database user name.");
            }
            if self.port == 0 {
                self.port = if self.kind == Kind::Postgres { 5432 } else { 3306 };
            }
            if self.tls_mode != TlsMode::VerifyFull {
                self.ca_file.clear();
            } else if !self.ca_file.is_empty() && !std::path::Path::new(&self.ca_file).is_absolute() {
                return invalid("The CA file must be an absolute path to a PEM file.");
            }
        }
        if self.row_limit == 0 || self.row_limit > MAX_ROW_LIMIT {
            return Err(SqlError::new("invalid", format!("The row limit must be between 1 and {MAX_ROW_LIMIT}.")));
        }
        if self.timeout_seconds == 0 || self.timeout_seconds > MAX_TIMEOUT_SECONDS {
            return Err(SqlError::new("invalid", format!("The timeout must be between 1 and {MAX_TIMEOUT_SECONDS} seconds.")));
        }
        Ok(self)
    }
}

fn storage_error(error: impl std::fmt::Display) -> SqlError {
    SqlError::new("internal", format!("Local database: {error}"))
}

/// Connections, their passwords and the queries in flight.
pub struct Service {
    database: Result<Database, String>,
    keychain: Box<dyn SecretStore>,
    session: secrets::MemoryStore,
    running: Mutex<HashMap<String, Arc<Cancel>>>,
}

impl Service {
    /// Use the OS keychain. Entries are scoped to this state database, so
    /// two Notation profiles (or a test profile) never share or delete each
    /// other's passwords. `NOTATION_KEYCHAIN=off` turns the keychain off:
    /// passwords are then only ever held in memory.
    pub fn new(database: Result<Database, String>) -> Self {
        let keychain: Box<dyn SecretStore> = if std::env::var("NOTATION_KEYCHAIN").is_ok_and(|value| value == "off") {
            Box::new(secrets::NoKeychain("The system keychain is turned off for this session (NOTATION_KEYCHAIN=off).".into()))
        } else {
            match database.as_ref().map_err(Clone::clone).and_then(keychain_scope) {
                Ok(scope) => Box::new(secrets::Keychain::new(format!("app.notation.database.{scope}"))),
                Err(error) => Box::new(secrets::NoKeychain(format!("The keychain cannot be used because local settings are unavailable: {error}"))),
            }
        };
        Self::with_keychain(database, keychain)
    }
    pub fn with_keychain(database: Result<Database, String>, keychain: Box<dyn SecretStore>) -> Self {
        Self { database, keychain, session: secrets::MemoryStore::default(), running: Mutex::new(HashMap::new()) }
    }
    fn database(&self) -> Result<&Database, SqlError> {
        self.database.as_ref().map_err(|error| SqlError::new("internal", error.clone()))
    }

    fn profiles(&self) -> Result<Vec<Profile>, SqlError> {
        let connection = self.database()?.lock().map_err(storage_error)?;
        let mut statement = connection.prepare("SELECT json FROM sql_connections ORDER BY name COLLATE NOCASE").map_err(storage_error)?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(storage_error)?;
        let mut profiles = Vec::new();
        for row in rows {
            // A row this version cannot read is skipped, not fatal.
            if let Ok(profile) = serde_json::from_str::<Profile>(&row.map_err(storage_error)?) {
                profiles.push(profile);
            }
        }
        Ok(profiles)
    }
    fn profile(&self, name: &str) -> Result<Profile, SqlError> {
        let stored: Option<String> = self
            .database()?
            .lock()
            .map_err(storage_error)?
            .query_row("SELECT json FROM sql_connections WHERE name=?1", [name], |row| row.get(0))
            .optional()
            .map_err(storage_error)?;
        stored
            .and_then(|json| serde_json::from_str::<Profile>(&json).ok())
            .ok_or_else(|| SqlError::new("unknown_connection", format!("No connection named {name} — add it in Settings → Databases.")))
    }

    fn view(&self, profile: Profile) -> ConnectionView {
        let password_state = match profile.password_storage {
            PasswordStorage::None => "none",
            PasswordStorage::Keychain => "keychain",
            PasswordStorage::Session => match self.session.get(&profile.name) {
                Ok(Some(_)) => "session",
                _ => "needed",
            },
        };
        ConnectionView { profile, password_state }
    }

    /// Profiles and whether the keychain can be used. Reads no password.
    pub fn list(&self) -> Result<ConnectionList, SqlError> {
        let availability = self.keychain.availability();
        Ok(ConnectionList {
            connections: self.profiles()?.into_iter().map(|profile| self.view(profile)).collect(),
            keychain_available: availability.is_ok(),
            keychain_reason: availability.err(),
            max_row_limit: MAX_ROW_LIMIT,
            max_timeout_seconds: MAX_TIMEOUT_SECONDS,
        })
    }

    /// Create or update a connection. `password` is stored according to
    /// `profile.password_storage` and never written to the state database;
    /// `None` keeps the password already stored. `original` is the name
    /// being edited, when the profile already exists.
    pub fn save(&self, profile: Profile, password: Option<String>, original: Option<String>) -> Result<ConnectionView, SqlError> {
        let password = password.filter(|value| !value.is_empty()).map(Secret::new);
        if password.as_ref().is_some_and(|secret| secret.expose().len() > MAX_PASSWORD_BYTES) {
            return Err(SqlError::new("invalid", "The password is too long."));
        }
        let profile = profile.validated()?;
        let existing = self.profiles()?;
        let previous = original.as_deref().and_then(|name| existing.iter().find(|item| item.name == name));
        if original.is_some() && previous.is_none() {
            return Err(SqlError::new("invalid", "The connection being edited no longer exists."));
        }
        let renamed = previous.is_some_and(|item| item.name != profile.name);
        if (previous.is_none() || renamed) && existing.iter().any(|item| item.name.eq_ignore_ascii_case(&profile.name)) {
            return Err(SqlError::new("invalid", format!("A connection named {} already exists.", profile.name)));
        }
        if previous.is_none() && existing.len() >= MAX_CONNECTIONS {
            return Err(SqlError::new("invalid", format!("At most {MAX_CONNECTIONS} connections can be saved.")));
        }
        let keychain_error = |error: String| SqlError::new("keychain", error);
        let previous_storage = previous.map_or(PasswordStorage::None, |item| item.password_storage);
        let previous_name = previous.map_or(profile.name.as_str(), |item| item.name.as_str());
        match profile.password_storage {
            PasswordStorage::Keychain => {
                let secret = match password {
                    Some(secret) => Some(secret),
                    // Keep the stored password; move it when the name changed.
                    None if previous_storage == PasswordStorage::Keychain && renamed => self.keychain.get(previous_name).map_err(keychain_error)?,
                    None if previous_storage == PasswordStorage::Keychain => None,
                    None => return Err(SqlError::new("invalid", "Enter the password to store in the keychain.")),
                };
                if let Some(secret) = secret {
                    self.keychain.set(&profile.name, &secret).map_err(keychain_error)?;
                }
            }
            PasswordStorage::Session => {
                if let Some(secret) = password {
                    self.session.set(&profile.name, &secret).map_err(keychain_error)?;
                } else if renamed {
                    if let Ok(Some(secret)) = self.session.get(previous_name) {
                        let _ = self.session.set(&profile.name, &secret);
                    }
                }
            }
            PasswordStorage::None => {}
        }
        let stored = serde_json::to_string(&profile).map_err(storage_error)?;
        {
            let mut connection = self.database()?.lock().map_err(storage_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            if let Some(name) = &original {
                transaction.execute("DELETE FROM sql_connections WHERE name=?1", [name]).map_err(storage_error)?;
            }
            transaction
                .execute("INSERT INTO sql_connections(name,json) VALUES(?1,?2)", params![profile.name, stored])
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
        }
        // Remove what the new settings no longer use. A keychain that is
        // gone cannot hold an entry to remove.
        if previous_storage == PasswordStorage::Keychain && (renamed || profile.password_storage != PasswordStorage::Keychain) {
            let _ = self.keychain.delete(previous_name);
        }
        if renamed || profile.password_storage != PasswordStorage::Session {
            let _ = self.session.delete(previous_name);
        }
        Ok(self.view(profile))
    }

    /// Delete a connection and its keychain entry.
    pub fn delete(&self, name: &str) -> Result<(), SqlError> {
        let profile = self.profile(name)?;
        if profile.password_storage == PasswordStorage::Keychain {
            // Fail before forgetting the profile, so a locked keychain does
            // not leave an orphaned password behind.
            self.keychain.delete(name).map_err(|error| {
                SqlError::new("keychain", format!("The keychain entry could not be removed, so the connection was kept: {error}"))
            })?;
        }
        let _ = self.session.delete(name);
        self.database()?
            .lock()
            .map_err(storage_error)?
            .execute("DELETE FROM sql_connections WHERE name=?1", [name])
            .map_err(storage_error)?;
        Ok(())
    }

    /// Keep a password in memory for an ask-every-session connection.
    pub fn unlock(&self, name: &str, password: String) -> Result<(), SqlError> {
        let profile = self.profile(name)?;
        if profile.password_storage != PasswordStorage::Session {
            return Err(SqlError::new("invalid", "This connection does not ask for its password each session."));
        }
        if password.len() > MAX_PASSWORD_BYTES {
            return Err(SqlError::new("invalid", "The password is too long."));
        }
        self.session.set(name, &Secret::new(password)).map_err(|error| SqlError::new("internal", error))
    }

    fn password(&self, profile: &Profile) -> Result<Option<Secret>, SqlError> {
        match profile.password_storage {
            PasswordStorage::None => Ok(None),
            PasswordStorage::Keychain => match self.keychain.get(&profile.name) {
                Ok(Some(secret)) => Ok(Some(secret)),
                Ok(None) => Err(SqlError::new(
                    "keychain",
                    format!("The keychain has no password for {}. Open Settings → Databases and replace it.", profile.name),
                )),
                Err(error) => Err(SqlError::new("keychain", error)),
            },
            PasswordStorage::Session => self.session.get(&profile.name).ok().flatten().map(Some).ok_or_else(|| {
                SqlError::new("password_required", format!("Enter the password for {} to use it in this session.", profile.name))
            }),
        }
    }

    fn register(&self, id: &str) -> Result<Arc<Cancel>, SqlError> {
        if id.is_empty() || id.len() > 64 {
            return Err(SqlError::new("invalid", "Invalid run id."));
        }
        let mut running = self.running.lock().map_err(|_| SqlError::new("internal", "Query registry failed."))?;
        if running.contains_key(id) {
            return Err(SqlError::new("busy", "This query is already running."));
        }
        if running.len() >= MAX_RUNNING {
            return Err(SqlError::new("busy", format!("{MAX_RUNNING} queries are already running. Wait for one to finish or cancel it.")));
        }
        let cancel = Arc::new(Cancel::default());
        running.insert(id.to_string(), cancel.clone());
        Ok(cancel)
    }
    fn finish(&self, id: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(id);
        }
    }

    /// Ask a running query to stop. The driver cancels it on the server.
    pub fn cancel(&self, id: &str) -> bool {
        match self.running.lock().ok().and_then(|running| running.get(id).cloned()) {
            Some(cancel) => {
                cancel.cancel();
                true
            }
            None => false,
        }
    }

    fn execute(&self, id: &str, profile: &Profile, password: Option<&Secret>, sql: &str, supplied: &BTreeMap<String, Value>) -> Result<QueryResult, SqlError> {
        let checked = guard::check(sql, profile.kind).map_err(|message| SqlError::new("refused", message))?;
        let mut parameters = Vec::with_capacity(checked.parameters.len());
        for name in &checked.parameters {
            let value = match supplied.get(name) {
                None => return Err(SqlError::new("invalid", format!("Parameter :{name} is not defined. Add {name} to this note's properties."))),
                Some(Value::Null) => Parameter::Null,
                Some(Value::Bool(value)) => Parameter::Bool(*value),
                Some(Value::String(value)) => Parameter::Text(value.clone()),
                Some(Value::Number(value)) => match value.as_i64() {
                    Some(integer) => Parameter::Integer(integer),
                    None => Parameter::Float(value.as_f64().unwrap_or(f64::NAN)),
                },
                Some(_) => return Err(SqlError::new("invalid", format!("Parameter :{name} must be text, a number, true/false or empty, not a list or map."))),
            };
            parameters.push((name.clone(), value));
        }
        let cancel = self.register(id)?;
        let job = Job { profile, password, sql: &checked.sql, parameters, timeout: Duration::from_secs(u64::from(profile.timeout_seconds)), cancel };
        let mut collector = Collector::new(profile.row_limit);
        let started = Instant::now();
        let outcome = match profile.kind {
            Kind::Sqlite => sqlite::run(&job, &mut collector),
            Kind::Postgres => runtime().and_then(|runtime| runtime.block_on(postgres::run(&job, &mut collector))),
            Kind::Mysql => runtime().and_then(|runtime| runtime.block_on(mysql::run(&job, &mut collector))),
        };
        self.finish(id);
        outcome.map_err(|error| SqlError { code: error.code, message: scrub(&error.message, password) })?;
        Ok(QueryResult {
            connection: profile.name.clone(),
            kind: profile.kind,
            row_count: collector.rows.len(),
            columns: collector.columns,
            rows: collector.rows,
            row_limit: profile.row_limit,
            truncated: collector.truncated,
            duration_ms: started.elapsed().as_millis() as u64,
            finished_at: crate::storage::now(),
        })
    }

    /// Run one read-only statement. Blocks until it finishes, fails, times
    /// out or is cancelled; call it from a blocking task.
    pub fn run(&self, request: RunRequest) -> Result<QueryResult, SqlError> {
        let profile = self.profile(&request.connection)?;
        let password = self.password(&profile)?;
        self.execute(&request.id, &profile, password.as_ref(), &request.sql, &request.parameters)
    }

    /// Try a profile as entered in Settings, saved or not. `password` is
    /// what was typed; without it the stored password of `original` is used.
    pub fn test(&self, profile: Profile, password: Option<String>, original: Option<String>) -> Result<TestResult, SqlError> {
        let mut profile = profile.validated()?;
        profile.row_limit = 1;
        profile.timeout_seconds = profile.timeout_seconds.min(15);
        let password = match password.filter(|value| !value.is_empty()) {
            Some(typed) => Some(Secret::new(typed)),
            None if profile.password_storage == PasswordStorage::None => None,
            None => {
                let stored = original.as_deref().map(|name| self.profile(name)).transpose()?;
                match stored {
                    Some(stored) if stored.password_storage == profile.password_storage => self.password(&stored)?,
                    _ => return Err(SqlError::new("password_required", "Enter the password to test this connection.")),
                }
            }
        };
        let sql = match profile.kind {
            Kind::Sqlite => "select 'SQLite ' || sqlite_version()",
            Kind::Postgres => "select 'PostgreSQL ' || current_setting('server_version')",
            Kind::Mysql => "select version()",
        };
        let id = format!("test-{}", crate::storage::now());
        let result = self.execute(&id, &profile, password.as_ref(), sql, &BTreeMap::new())?;
        let reported = result.rows.first().and_then(|row| row.first()).and_then(Value::as_str).unwrap_or("").to_string();
        let server = if profile.kind == Kind::Mysql { format!("MySQL {reported}") } else { reported };
        Ok(TestResult { server, duration_ms: result.duration_ms })
    }
}

/// A random id for this state database, naming its keychain entries.
fn keychain_scope(database: &Database) -> Result<String, String> {
    const KEY: &str = "sql_keychain_scope";
    let connection = database.lock()?;
    let known: Option<String> = connection
        .query_row("SELECT value FROM app_meta WHERE key=?1", [KEY], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(scope) = known.filter(|scope| scope.len() == 16 && scope.bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return Ok(scope);
    }
    let mut bytes = [0u8; 8];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes))
        .map_err(|error| format!("Could not read random bytes: {error}"))?;
    let scope: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    connection
        .execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES(?1,?2)", params![KEY, scope])
        .map_err(|error| error.to_string())?;
    Ok(scope)
}
