//! One message, sealed and signed.
//!
//! - The message key is `HKDF-SHA256(epochKey, salt = conversationId,
//!   info = "ts-chat/v1/msg" ‖ messageId)`, so each message has its own key
//!   and a reporter can hand the server that one key without the epoch's.
//! - The cipher is XChaCha20-Poly1305 with a random 24-byte nonce, over the
//!   content padded to its bucket, with AAD `lp(conversationId) ‖ u64(epoch)
//!   ‖ lp(messageId) ‖ identity(senderUserId) ‖ lp(kind)`.
//! - The sender's identity key signs `SHA-256(aad ‖ nonce ‖ ciphertext)`.

use crate::bytes::{join, lp, pad, u64be, unpad};
use crate::error::{Refusal, Result};
use crate::prim;
use crate::user_id;
use crate::random;
use zeroize::Zeroizing;

pub struct Fields<'a> {
    pub conversation_id: &'a [u8],
    pub epoch: u64,
    pub message_id: &'a [u8],
    pub sender_user_id: u128,
    pub kind: &'a [u8],
}

impl Fields<'_> {
    pub fn aad(&self) -> Vec<u8> {
        join(&[
            &lp(self.conversation_id),
            &u64be(self.epoch),
            &lp(self.message_id),
            &user_id::encode(self.sender_user_id),
            &lp(self.kind),
        ])
    }
}

/// This one message's key, from the epoch key.
pub fn message_key(epoch_key: &[u8], conversation_id: &[u8], message_id: &[u8]) -> Result<Vec<u8>> {
    prim::hkdf(epoch_key, conversation_id, &join(&[b"ts-chat/v1/msg", message_id]), 32)
}

fn signed_digest(aad: &[u8], nonce: &[u8], ciphertext: &[u8]) -> [u8; 32] {
    prim::sha256(&join(&[aad, nonce, ciphertext]))
}

pub struct Sealed {
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub signature: Vec<u8>,
}

/// Pads, seals and signs a message's content.
pub fn seal_message(fields: &Fields, epoch_key: &[u8], plaintext: &[u8], identity_secret_key: &[u8], nonce: Option<&[u8]>) -> Result<Sealed> {
    let nonce = match nonce {
        Some(given) if given.len() == 24 => given.to_vec(),
        Some(_) => return Err(Refusal::Malformed),
        None => random::bytes(24)?,
    };
    let aad = fields.aad();
    let key = Zeroizing::new(message_key(epoch_key, fields.conversation_id, fields.message_id)?);
    let padded = Zeroizing::new(pad(plaintext)?);
    let ciphertext = prim::xchacha20_poly1305_seal(&key, &nonce, &aad, &padded)?;
    let signature = prim::ed25519_sign(&signed_digest(&aad, &nonce, &ciphertext), identity_secret_key)?;
    Ok(Sealed { nonce, ciphertext, signature: signature.to_vec() })
}

/// Whether the signature is the sender identity's over this envelope.
pub fn verify_message(fields: &Fields, nonce: &[u8], ciphertext: &[u8], signature: &[u8], identity_public_key: &[u8]) -> bool {
    prim::ed25519_verify(signature, &signed_digest(&fields.aad(), nonce, ciphertext), identity_public_key)
}

/// The content of a message sealed under `message_key`, unpadded: the
/// server's half of a report.
pub fn open_with_message_key(fields: &Fields, message_key: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    let padded = Zeroizing::new(prim::xchacha20_poly1305_open(message_key, nonce, &fields.aad(), ciphertext)?);
    Ok(unpad(&padded)?.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> Fields<'static> {
        Fields {
            conversation_id: b"cnv_c1",
            epoch: 7,
            message_id: b"msg_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            sender_user_id: 42,
            kind: b"post",
        }
    }

    #[test]
    fn seals_verifies_and_opens() {
        let identity = [4u8; 32];
        let identity_key = prim::ed25519_public_key(&identity).unwrap();
        let epoch_key = [6u8; 32];
        let sealed = seal_message(&fields(), &epoch_key, b"hello", &identity, None).unwrap();
        assert_eq!(sealed.nonce.len(), 24);
        assert_eq!(sealed.ciphertext.len(), 541 + 16);
        assert!(verify_message(&fields(), &sealed.nonce, &sealed.ciphertext, &sealed.signature, &identity_key));
        let key = message_key(&epoch_key, b"cnv_c1", fields().message_id).unwrap();
        assert_eq!(open_with_message_key(&fields(), &key, &sealed.nonce, &sealed.ciphertext).unwrap(), b"hello");
        // Another kind is another AAD.
        let edit = Fields { kind: b"edit", ..fields() };
        assert!(!verify_message(&edit, &sealed.nonce, &sealed.ciphertext, &sealed.signature, &identity_key));
        assert_eq!(open_with_message_key(&edit, &key, &sealed.nonce, &sealed.ciphertext).err(), Some(Refusal::NotAuthentic));
        // Sealed lengths follow the buckets.
        for (length, sealed_length) in [(540, 542), (541, 569), (542, 569)] {
            let text = vec![b'a'; length];
            let sealed = seal_message(&fields(), &epoch_key, &text, &identity, None).unwrap();
            assert_eq!(sealed.ciphertext.len(), sealed_length + 16);
        }
        assert_eq!(seal_message(&fields(), &epoch_key, b"", &identity, Some(&[0u8; 12])).err(), Some(Refusal::Malformed));
    }

    #[test]
    fn a_padding_without_its_marker_is_refused() {
        let key = [8u8; 32];
        let nonce = [1u8; 24];
        let ciphertext = prim::xchacha20_poly1305_seal(&key, &nonce, &fields().aad(), &[1, 2, 0]).unwrap();
        assert_eq!(open_with_message_key(&fields(), &key, &nonce, &ciphertext).err(), Some(Refusal::NoPaddingMarker));
    }
}
