//! Vault subsystem.
//!
//! Manages encrypted tenant secrets, scopes, operator references, and
//! agent personas. See `ARCHITECTURE_VAULT.md` for the design.
//!
//! The "happy path" lives in three files:
//!   - `crypto.rs`   AES-256-GCM helpers (DEK / KEK envelope).
//!   - `kek.rs`      Cloudflare Secrets Store client + in-memory cache.
//!   - `handlers/`   HTTP handlers split by resource (secrets, refs, scopes,
//!                   personas).
//!
//! Re-exported `routes()` is mounted under `/v1/vault` and `/v1/personas`
//! by `main.rs`.

pub mod crypto;
pub mod handlers;
pub mod kek;
pub mod models;

pub use kek::KekProvider;
