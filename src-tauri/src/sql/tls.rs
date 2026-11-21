//! TLS for the network drivers: rustls with the ring provider.
use super::{Profile, SqlError, TlsMode};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use std::sync::Arc;

pub(crate) fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// `mysql_async` builds its TLS configuration from the process default.
pub(crate) fn install_default_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// `prefer` and `require` encrypt without authenticating the server, as
/// `sslmode=require` does elsewhere. Handshake signatures are still checked.
#[derive(Debug)]
struct AcceptAnyCertificate(Arc<CryptoProvider>);
impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Client configuration for a profile whose TLS mode is not `disable`.
pub(crate) fn client_config(profile: &Profile) -> Result<ClientConfig, SqlError> {
    let tls_error = |error: &dyn std::fmt::Display| SqlError::new("connect", format!("TLS setup failed: {error}"));
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|error| tls_error(&error))?;
    if profile.tls_mode != TlsMode::VerifyFull {
        return Ok(builder.dangerous().with_custom_certificate_verifier(Arc::new(AcceptAnyCertificate(provider))).with_no_client_auth());
    }
    let mut roots = RootCertStore::empty();
    if profile.ca_file.is_empty() {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    } else {
        let certificates = CertificateDer::pem_file_iter(&profile.ca_file)
            .map_err(|error| SqlError::new("connect", format!("The CA file could not be read: {error}")))?;
        for certificate in certificates {
            let certificate = certificate.map_err(|error| SqlError::new("connect", format!("The CA file is not valid PEM: {error}")))?;
            roots.add(certificate).map_err(|error| tls_error(&error))?;
        }
        if roots.is_empty() {
            return Err(SqlError::new("connect", "The CA file contains no certificates."));
        }
    }
    Ok(builder.with_root_certificates(roots).with_no_client_auth())
}
