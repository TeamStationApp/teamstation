//! The two key chains, which are why a later key opens everything before it.
//!
//! - **Epochs.** Epoch n's record carries `previous_key_box`: epoch n−1's key,
//!   sealed with XChaCha20-Poly1305 under `HKDF-SHA256(epoch n key, info =
//!   "ts-chat/v1/prev-epoch")`, AAD `lp(conversationId) ‖ u64(n)`. The
//!   creator's identity signs `lp(conversationId) ‖ u64(n) ‖
//!   SHA-256(previous_key_box)`, the SHA-256 of no bytes when there is none.
//! - **Per-user keys.** PUK generation n carries `previous_keys_box`: every
//!   older private key, sealed under `HKDF-SHA256(generation n private key,
//!   info = "ts-chat/v1/prev-puk")`, AAD `u64(userId) ‖ lp(identityId) ‖
//!   u64(n)`. The TypeScript lays out and reads back the list of older keys;
//!   this seals and opens it.
//!
//! A box is `nonce ‖ ciphertext`, the nonce 24 random bytes. Neither HKDF has
//! a salt.

use crate::bytes::{join, lp, u64be};
use crate::error::{Refusal, Result};
use crate::prim;
use crate::random;
use zeroize::Zeroizing;

const NONCE: usize = 24;
const TAG: usize = 16;

fn seal_box(key: &[u8], aad: &[u8], plaintext: &[u8], nonce: Option<&[u8]>) -> Result<Vec<u8>> {
    let nonce = match nonce {
        Some(given) if given.len() == NONCE => given.to_vec(),
        Some(_) => return Err(Refusal::Malformed),
        None => random::bytes(NONCE)?,
    };
    Ok(join(&[&nonce, &prim::xchacha20_poly1305_seal(key, &nonce, aad, plaintext)?]))
}

fn open_box(key: &[u8], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < NONCE + TAG {
        return Err(Refusal::Malformed);
    }
    prim::xchacha20_poly1305_open(key, &sealed[..NONCE], aad, &sealed[NONCE..])
}

fn epoch_chain_key(epoch_key: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Ok(Zeroizing::new(prim::hkdf(epoch_key, &[], b"ts-chat/v1/prev-epoch", 32)?))
}

fn epoch_chain_aad(conversation_id: &[u8], epoch: u64) -> Vec<u8> {
    join(&[&lp(conversation_id), &u64be(epoch)])
}

pub fn seal_previous_epoch_key(conversation_id: &[u8], epoch: u64, epoch_key: &[u8], previous_epoch_key: &[u8], nonce: Option<&[u8]>) -> Result<Vec<u8>> {
    seal_box(&epoch_chain_key(epoch_key)?, &epoch_chain_aad(conversation_id, epoch), previous_epoch_key, nonce)
}

pub fn open_previous_epoch_key(conversation_id: &[u8], epoch: u64, epoch_key: &[u8], previous_key_box: &[u8]) -> Result<Vec<u8>> {
    open_box(&epoch_chain_key(epoch_key)?, &epoch_chain_aad(conversation_id, epoch), previous_key_box)
}

pub fn epoch_signed_bytes(conversation_id: &[u8], epoch: u64, previous_key_box: &[u8]) -> Vec<u8> {
    join(&[&lp(conversation_id), &u64be(epoch), &prim::sha256(previous_key_box)])
}

fn puk_chain_key(private_key: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Ok(Zeroizing::new(prim::hkdf(private_key, &[], b"ts-chat/v1/prev-puk", 32)?))
}

fn puk_chain_aad(user_id: u64, identity_id: &[u8], generation: u64) -> Vec<u8> {
    join(&[&u64be(user_id), &lp(identity_id), &u64be(generation)])
}

pub fn seal_previous_puk_keys(user_id: u64, identity_id: &[u8], generation: u64, private_key: &[u8], plaintext: &[u8], nonce: Option<&[u8]>) -> Result<Vec<u8>> {
    seal_box(&puk_chain_key(private_key)?, &puk_chain_aad(user_id, identity_id, generation), plaintext, nonce)
}

pub fn open_previous_puk_keys(user_id: u64, identity_id: &[u8], generation: u64, private_key: &[u8], previous_keys_box: &[u8]) -> Result<Vec<u8>> {
    open_box(&puk_chain_key(private_key)?, &puk_chain_aad(user_id, identity_id, generation), previous_keys_box)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_chain_round_trips_and_binds_its_place() {
        let sealed = seal_previous_epoch_key(b"cnv_1", 8, &[1u8; 32], &[2u8; 32], None).unwrap();
        assert_eq!(sealed.len(), 24 + 32 + 16);
        assert_eq!(open_previous_epoch_key(b"cnv_1", 8, &[1u8; 32], &sealed).unwrap(), vec![2u8; 32]);
        assert_eq!(open_previous_epoch_key(b"cnv_1", 9, &[1u8; 32], &sealed), Err(Refusal::NotAuthentic));
        assert_eq!(open_previous_epoch_key(b"cnv_2", 8, &[1u8; 32], &sealed), Err(Refusal::NotAuthentic));
        assert_eq!(open_previous_epoch_key(b"cnv_1", 8, &[1u8; 32], &sealed[..39]), Err(Refusal::Malformed));
        assert_eq!(seal_previous_epoch_key(b"c", 1, &[1u8; 32], &[2u8; 32], Some(&[0u8; 12])), Err(Refusal::Malformed));
        assert_eq!(epoch_signed_bytes(b"c", 1, &[]), join(&[&lp(b"c"), &u64be(1), &prim::sha256(&[])]));
    }

    #[test]
    fn puk_chain_round_trips_and_binds_its_place() {
        let sealed = seal_previous_puk_keys(42, b"cid_1", 3, &[5u8; 32], b"older keys", None).unwrap();
        assert_eq!(open_previous_puk_keys(42, b"cid_1", 3, &[5u8; 32], &sealed).unwrap(), b"older keys");
        assert_eq!(open_previous_puk_keys(43, b"cid_1", 3, &[5u8; 32], &sealed), Err(Refusal::NotAuthentic));
        assert_eq!(open_previous_puk_keys(42, b"cid_1", 3, &[6u8; 32], &sealed), Err(Refusal::NotAuthentic));
    }
}
