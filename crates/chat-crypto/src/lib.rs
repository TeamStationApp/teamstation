//! Every cryptographic operation of TeamStation's encrypted chat.
//!
//! One crate for every platform: a Node-API addon for the server (`node`
//! feature), a static library behind a C++ TurboModule on iOS and Android,
//! and a WebAssembly module in the browser. Each calls `abi::chat_crypto_call`
//! (or `abi::call_bytes`) with an op from `ops`, so the bytes are the same
//! everywhere; `tests/vectors.rs` and the TypeScript's `runVectors()` check
//! them against `src/common/chatCrypto/frozenVectors.json`.

pub mod abi;
mod buckets;
pub mod bytes;
pub mod chain;
pub mod digits;
pub mod error;
pub mod hpke;
pub mod keys;
pub mod ops;
pub mod prim;
pub mod random;
pub mod seal;
pub mod stream;
pub mod user_id;

#[cfg(feature = "node")]
mod node;
