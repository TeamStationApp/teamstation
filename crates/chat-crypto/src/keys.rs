//! The keys of encrypted chat, made here and nowhere else.
//!
//! | Key | Kind |
//! | --- | --- |
//! | Device keys | an X25519 pair (link boxes come to it) and an Ed25519 pair (proves the device on resume) |
//! | Identity key | Ed25519, shared by a user's linked devices; signs PUKs, epochs and messages |
//! | Per-user key (PUK) | X25519, one per generation; epoch keys are wrapped to it |
//! | Epoch key | 32 random bytes per conversation and epoch |
//!
//! A secret key is always 32 bytes: an X25519 secret or an Ed25519 seed.

use crate::error::Result;
use crate::hpke::KeyPair;
use crate::prim;
use crate::random;
use zeroize::Zeroizing;

pub fn new_box_key_pair() -> Result<KeyPair> {
    let secret_key = Zeroizing::new(random::array::<32>()?);
    let public_key = prim::x25519_public_key(&*secret_key)?;
    Ok(KeyPair { secret_key: *secret_key, public_key })
}

pub fn new_signing_key_pair() -> Result<KeyPair> {
    let secret_key = Zeroizing::new(random::array::<32>()?);
    let public_key = prim::ed25519_public_key(&*secret_key)?;
    Ok(KeyPair { secret_key: *secret_key, public_key })
}
