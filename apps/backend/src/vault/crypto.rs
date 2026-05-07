//! AES-256-GCM helpers for vault secrets.
//!
//! Two layers:
//!   - DEK (data encryption key): 256-bit, freshly generated per secret row.
//!     Encrypts the actual plaintext (e.g. the value of `DATABASE_URL`).
//!   - KEK (key encryption key): 256-bit, lives in Cloudflare Secrets Store.
//!     Wraps the DEK so the DB never sees a raw DEK.
//!
//! Why two layers? Lets us rotate KEK by re-wrapping every row's `dek_wrapped`
//! without touching the (potentially large) ciphertexts.
//!
//! AAD strategy: we bind the wrapped DEK to `(tenant_id, name)` so an
//! attacker who steals the DB row can't substitute a DEK from a different
//! row to learn the plaintext.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use rand::RngCore;

/// Output of encrypting plaintext with a fresh DEK.
///
/// `dek` is the raw 32-byte DEK. Caller must wrap it with the active KEK
/// (via [`wrap_dek`]) before persisting.
pub struct SecretEnvelope {
    pub ciphertext: Vec<u8>,
    pub nonce: [u8; 12],
    pub auth_tag: [u8; 16],
    pub dek: [u8; 32],
}

/// Output of wrapping a DEK with the KEK.
pub struct WrappedDek {
    pub wrapped: Vec<u8>,
    pub nonce: [u8; 12],
}

/// Encrypt `plaintext` with a freshly generated 256-bit DEK.
///
/// We split the GCM tag from the ciphertext so the DB schema can store
/// them in separate columns (matches the migration's CHECK constraints
/// that pin `nonce`=12 / `auth_tag`=16). aes-gcm's `encrypt()` returns
/// `ciphertext || tag` — we slice the trailing 16 bytes off as the tag.
pub fn encrypt_with_fresh_dek(plaintext: &[u8]) -> Result<SecretEnvelope> {
    let mut dek = [0u8; 32];
    rand::rng().fill_bytes(&mut dek);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&dek));

    let nonce_bytes = Aes256Gcm::generate_nonce(&mut OsRng);
    let combined = cipher
        .encrypt(&nonce_bytes, plaintext)
        .map_err(|e| anyhow!("AES-GCM encrypt failed: {e}"))?;

    if combined.len() < 16 {
        return Err(anyhow!("AES-GCM output too short"));
    }
    let split_at = combined.len() - 16;
    let ciphertext = combined[..split_at].to_vec();
    let mut auth_tag = [0u8; 16];
    auth_tag.copy_from_slice(&combined[split_at..]);

    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(nonce_bytes.as_slice());

    Ok(SecretEnvelope {
        ciphertext,
        nonce,
        auth_tag,
        dek,
    })
}

/// Decrypt a stored secret using the unwrapped DEK.
///
/// Wired up but unused on disk until the persona launch endpoint lands;
/// `#[allow(dead_code)]` so the upcoming P3 work doesn't fight CI.
#[allow(dead_code)]
pub fn decrypt_with_dek(
    dek: &[u8; 32],
    nonce: &[u8; 12],
    auth_tag: &[u8; 16],
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(dek));
    let nonce = Nonce::from_slice(nonce);
    // Re-glue ciphertext || tag for aes-gcm's API.
    let mut combined = Vec::with_capacity(ciphertext.len() + 16);
    combined.extend_from_slice(ciphertext);
    combined.extend_from_slice(auth_tag);
    cipher
        .decrypt(nonce, combined.as_ref())
        .map_err(|e| anyhow!("AES-GCM decrypt failed: {e}"))
}

/// Wrap a raw DEK with the KEK, binding it to `(tenant_id, secret_name)`
/// via AAD so substitution attacks don't work.
///
/// Wrapped output = `ciphertext || tag` (16-byte tag).
pub fn wrap_dek(
    kek: &[u8; 32],
    dek: &[u8; 32],
    tenant_id: &uuid::Uuid,
    secret_name: &str,
) -> Result<WrappedDek> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(kek));
    let nonce_bytes = Aes256Gcm::generate_nonce(&mut OsRng);
    let aad = build_aad(tenant_id, secret_name);
    let wrapped = cipher
        .encrypt(
            &nonce_bytes,
            aes_gcm::aead::Payload {
                msg: dek,
                aad: &aad,
            },
        )
        .map_err(|e| anyhow!("KEK wrap failed: {e}"))?;
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(nonce_bytes.as_slice());
    Ok(WrappedDek { wrapped, nonce })
}

/// Reverse of [`wrap_dek`]. Returns the raw 32-byte DEK on success.
///
/// Used by (a) the persona launch endpoint when it needs to decrypt a
/// secret to inject into envVars, and (b) the KEK rotation bg task that
/// re-wraps every row's DEK with a new KEK version. Marked dead_code
/// until the launch endpoint lands.
#[allow(dead_code)]
pub fn unwrap_dek(
    kek: &[u8; 32],
    wrapped: &[u8],
    nonce: &[u8; 12],
    tenant_id: &uuid::Uuid,
    secret_name: &str,
) -> Result<[u8; 32]> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(kek));
    let nonce = Nonce::from_slice(nonce);
    let aad = build_aad(tenant_id, secret_name);
    let pt = cipher
        .decrypt(
            nonce,
            aes_gcm::aead::Payload {
                msg: wrapped,
                aad: &aad,
            },
        )
        .map_err(|e| anyhow!("KEK unwrap failed: {e}"))?;
    if pt.len() != 32 {
        return Err(anyhow!("unwrapped DEK has wrong length: {}", pt.len()));
    }
    let mut dek = [0u8; 32];
    dek.copy_from_slice(&pt);
    Ok(dek)
}

fn build_aad(tenant_id: &uuid::Uuid, secret_name: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(16 + 1 + secret_name.len());
    aad.extend_from_slice(tenant_id.as_bytes());
    aad.push(0x00);
    aad.extend_from_slice(secret_name.as_bytes());
    aad
}

/// Decode a base64 KEK string (with or without padding) into a 32-byte key.
pub fn decode_kek_b64(s: &str) -> Result<[u8; 32]> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
    let trimmed = s.trim();
    let bytes = STANDARD
        .decode(trimmed)
        .or_else(|_| STANDARD_NO_PAD.decode(trimmed))
        .context("KEK must be base64")?;
    if bytes.len() != 32 {
        return Err(anyhow!(
            "KEK must decode to 32 bytes (got {})",
            bytes.len()
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// Stable short fingerprint of a KEK so logs / `vault_kek_versions.fingerprint`
/// can identify it without leaking the key. SHA-256 truncated to 16 hex chars.
pub fn kek_fingerprint(kek: &[u8; 32]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"shujian-kek-v1\0");
    h.update(kek);
    let digest = h.finalize();
    hex::encode(&digest[..8])
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn round_trip_dek() {
        let env = encrypt_with_fresh_dek(b"hello world").unwrap();
        let pt = decrypt_with_dek(&env.dek, &env.nonce, &env.auth_tag, &env.ciphertext).unwrap();
        assert_eq!(pt, b"hello world");
    }

    #[test]
    fn round_trip_kek_envelope() {
        let kek = [7u8; 32];
        let tenant = Uuid::now_v7();
        let name = "onion.database_url";
        let env = encrypt_with_fresh_dek(b"postgres://...").unwrap();
        let wrapped = wrap_dek(&kek, &env.dek, &tenant, name).unwrap();

        let unwrapped =
            unwrap_dek(&kek, &wrapped.wrapped, &wrapped.nonce, &tenant, name).unwrap();
        assert_eq!(unwrapped, env.dek);

        let pt =
            decrypt_with_dek(&unwrapped, &env.nonce, &env.auth_tag, &env.ciphertext).unwrap();
        assert_eq!(pt, b"postgres://...");
    }

    #[test]
    fn aad_substitution_fails() {
        let kek = [7u8; 32];
        let env = encrypt_with_fresh_dek(b"x").unwrap();
        let tenant = Uuid::now_v7();
        let wrapped = wrap_dek(&kek, &env.dek, &tenant, "secret_a").unwrap();

        // Same tenant, different name → must fail.
        let other = unwrap_dek(&kek, &wrapped.wrapped, &wrapped.nonce, &tenant, "secret_b");
        assert!(other.is_err());
    }

    #[test]
    fn fingerprint_is_stable() {
        let k = [42u8; 32];
        assert_eq!(kek_fingerprint(&k), kek_fingerprint(&k));
        let k2 = [43u8; 32];
        assert_ne!(kek_fingerprint(&k), kek_fingerprint(&k2));
        assert_eq!(kek_fingerprint(&k).len(), 16);
    }

    #[test]
    fn decode_kek_strict_length() {
        let key = [9u8; 32];
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key);
        let decoded = decode_kek_b64(&b64).unwrap();
        assert_eq!(decoded, key);

        // 16 bytes → reject
        let short = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [1u8; 16]);
        assert!(decode_kek_b64(&short).is_err());
    }
}
