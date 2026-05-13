use argon2::password_hash::SaltString;
use argon2::password_hash::rand_core::OsRng as ArgonOsRng;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

/// Argon2id hashing using OWASP-tier defaults shipped with the `argon2` crate.
pub fn hash_password(plaintext: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut ArgonOsRng);
    let argon = Argon2::default();
    let phc = argon.hash_password(plaintext.as_bytes(), &salt)?;
    Ok(phc.to_string())
}

pub fn verify_password(plaintext: &str, phc_hash: &str) -> AppResult<bool> {
    let parsed = match PasswordHash::new(phc_hash) {
        Ok(p) => p,
        Err(_) => return Ok(false), // malformed hash row → treat as bad password
    };
    Ok(Argon2::default()
        .verify_password(plaintext.as_bytes(), &parsed)
        .is_ok())
}

/// Mint a fresh opaque session token. Returns `(raw_token, token_hash)`.
/// Raw token goes to the client (once), hash goes into the DB.
pub fn mint_session_token() -> (String, String) {
    // 32 bytes ≈ 256 bits of entropy. URL-safe base64 keeps it cookie/header
    // friendly without `=` padding.
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let raw = URL_SAFE_NO_PAD.encode(bytes);
    let hash = sha256_hex(&raw);
    (raw, hash)
}

pub fn sha256_hex(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    hex::encode(h.finalize())
}

/// Extract a bearer token from `Authorization: Bearer <...>`.
pub fn parse_bearer(h: Option<&str>) -> AppResult<&str> {
    let raw = h.ok_or(AppError::Unauthorized)?;
    let token = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .ok_or(AppError::Unauthorized)?;
    if token.is_empty() {
        return Err(AppError::Unauthorized);
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_password() {
        let h = hash_password("hello").unwrap();
        assert!(verify_password("hello", &h).unwrap());
        assert!(!verify_password("wrong", &h).unwrap());
    }

    #[test]
    fn token_is_url_safe_and_hash_is_64_hex() {
        let (raw, hash) = mint_session_token();
        assert!(!raw.contains('='));
        assert_eq!(hash.len(), 64);
        assert_eq!(sha256_hex(&raw), hash);
    }

    #[test]
    fn parses_bearer() {
        assert_eq!(parse_bearer(Some("Bearer abc")).unwrap(), "abc");
        assert!(parse_bearer(Some("Basic abc")).is_err());
        assert!(parse_bearer(None).is_err());
    }
}
