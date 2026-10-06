//! HPKE (RFC 9180) in base mode, for one suite only:
//! `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, `ChaCha20Poly1305`
//! (KEM 0x0020, KDF 0x0001, AEAD 0x0003).
//!
//! Chat wraps a key to somebody's public key with it: a new device's identity
//! key (`link`), a per-user key generation to a device (`puk`), and an epoch
//! key to a member's PUK (`epoch` when the epoch is made, `grant` when it is
//! handed on later). A box is `enc ‖ ciphertext`: the 32-byte ephemeral public
//! key, then the AEAD output with its 16-byte tag. The RFC's Appendix A.2.1
//! vector checks it, the key schedule included.

use zeroize::{Zeroize, Zeroizing};

use crate::bytes::{join, lp, u64be};
use crate::error::{Refusal, Result};
use crate::prim;
use crate::random;

const N_SECRET: usize = 32;
const N_ENC: usize = 32;
const N_K: usize = 32;
const N_N: usize = 12;
const N_H: usize = 32;
const TAG: usize = 16;

const HPKE_V1: &[u8] = b"HPKE-v1";
const KEM_SUITE: &[u8] = &[b'K', b'E', b'M', 0x00, 0x20];
const HPKE_SUITE: &[u8] = &[b'H', b'P', b'K', b'E', 0x00, 0x20, 0x00, 0x01, 0x00, 0x03];

fn labeled_extract(suite: &[u8], salt: &[u8], label: &[u8], ikm: &[u8]) -> [u8; 32] {
    prim::hkdf_extract(salt, &join(&[HPKE_V1, suite, label, ikm]))
}

fn labeled_expand(suite: &[u8], prk: &[u8], label: &[u8], info: &[u8], length: usize) -> Result<Vec<u8>> {
    // I2OSP(L, 2) and HKDF's own limit, both checked rather than truncated.
    if length > prim::HKDF_MOST {
        return Err(Refusal::TooLarge);
    }
    let length_bytes = (length as u16).to_be_bytes();
    prim::hkdf_expand(prk, &join(&[&length_bytes, HPKE_V1, suite, label, info]), length)
}

pub struct KeyPair {
    pub secret_key: [u8; 32],
    pub public_key: [u8; 32],
}

impl Drop for KeyPair {
    fn drop(&mut self) {
        self.secret_key.zeroize();
    }
}

/// RFC 9180 `DeriveKeyPair` for X25519: the same `ikm` always gives the same pair.
pub fn derive_key_pair(ikm: &[u8]) -> Result<KeyPair> {
    let prk = Zeroizing::new(labeled_extract(KEM_SUITE, &[], b"dkp_prk", ikm));
    let expanded = Zeroizing::new(labeled_expand(KEM_SUITE, &*prk, b"sk", &[], 32)?);
    let secret_key = prim::key32(&expanded)?;
    let public_key = prim::x25519_public_key(&secret_key)?;
    Ok(KeyPair { secret_key, public_key })
}

fn shared_secret(dh: &[u8], enc: &[u8], recipient_public_key: &[u8]) -> Result<Vec<u8>> {
    let prk = Zeroizing::new(labeled_extract(KEM_SUITE, &[], b"eae_prk", dh));
    labeled_expand(KEM_SUITE, &*prk, b"shared_secret", &join(&[enc, recipient_public_key]), N_SECRET)
}

/// A base-mode context: the key, the base nonce, the exporter secret, and a
/// sequence number that moves on with every seal or open.
pub struct Context {
    pub key: Vec<u8>,
    pub base_nonce: Vec<u8>,
    pub exporter_secret: Vec<u8>,
    seq: u64,
}

impl Context {
    fn new(shared: &[u8], info: &[u8]) -> Result<Context> {
        let psk_id_hash = labeled_extract(HPKE_SUITE, &[], b"psk_id_hash", &[]);
        let info_hash = labeled_extract(HPKE_SUITE, &[], b"info_hash", info);
        let context = join(&[&[0u8], &psk_id_hash, &info_hash]);
        let mut secret = labeled_extract(HPKE_SUITE, shared, b"secret", &[]);
        let key = labeled_expand(HPKE_SUITE, &secret, b"key", &context, N_K)?;
        let base_nonce = labeled_expand(HPKE_SUITE, &secret, b"base_nonce", &context, N_N)?;
        let exporter_secret = labeled_expand(HPKE_SUITE, &secret, b"exp", &context, N_H)?;
        secret.zeroize();
        Ok(Context { key, base_nonce, exporter_secret, seq: 0 })
    }

    fn next_nonce(&mut self) -> Vec<u8> {
        let mut nonce = self.base_nonce.clone();
        for (i, byte) in u64be(self.seq).iter().enumerate() {
            nonce[N_N - 8 + i] ^= byte;
        }
        self.seq += 1;
        nonce
    }

    pub fn seal(&mut self, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
        let nonce = self.next_nonce();
        prim::chacha20_poly1305_seal(&self.key, &nonce, aad, plaintext)
    }

    pub fn open(&mut self, aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        let nonce = self.next_nonce();
        prim::chacha20_poly1305_open(&self.key, &nonce, aad, ciphertext)
    }

    pub fn export(&self, exporter_context: &[u8], length: usize) -> Result<Vec<u8>> {
        labeled_expand(HPKE_SUITE, &self.exporter_secret, b"sec", exporter_context, length)
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        self.key.zeroize();
        self.exporter_secret.zeroize();
    }
}

/// RFC 9180 `SetupBaseS`. The ephemeral key is random unless `ephemeral_ikm`
/// is given, which only the vectors do, to make a box come out the same.
pub fn setup_sender(recipient_public_key: &[u8], info: &[u8], ephemeral_ikm: Option<&[u8]>) -> Result<(Vec<u8>, Context)> {
    let ephemeral = match ephemeral_ikm {
        Some(ikm) => derive_key_pair(ikm)?,
        None => {
            let secret_key = Zeroizing::new(random::array::<32>()?);
            let public_key = prim::x25519_public_key(&*secret_key)?;
            KeyPair { secret_key: *secret_key, public_key }
        }
    };
    let mut dh = prim::x25519(&ephemeral.secret_key, recipient_public_key)?;
    let shared = shared_secret(&dh, &ephemeral.public_key, recipient_public_key);
    dh.zeroize();
    let mut shared = shared?;
    let context = Context::new(&shared, info);
    shared.zeroize();
    Ok((ephemeral.public_key.to_vec(), context?))
}

/// RFC 9180 `SetupBaseR`.
pub fn setup_recipient(enc: &[u8], recipient_secret_key: &[u8], info: &[u8]) -> Result<Context> {
    if enc.len() != N_ENC {
        return Err(Refusal::Malformed);
    }
    let mut dh = prim::x25519(recipient_secret_key, enc)?;
    let shared = shared_secret(&dh, enc, &prim::x25519_public_key(recipient_secret_key)?);
    dh.zeroize();
    let mut shared = shared?;
    let context = Context::new(&shared, info);
    shared.zeroize();
    context
}

/// `"ts-chat/v1/" + purpose`, for the four purposes chat has.
pub fn info(purpose: &[u8]) -> Result<Vec<u8>> {
    match purpose {
        b"link" | b"puk" | b"epoch" | b"grant" => Ok(join(&[b"ts-chat/v1/", purpose])),
        _ => Err(Refusal::Malformed),
    }
}

/// Wraps `plaintext` to `recipient_public_key`: one single-shot seal,
/// `enc ‖ ciphertext`.
pub fn seal(purpose: &[u8], recipient_public_key: &[u8], aad: &[u8], plaintext: &[u8], ephemeral_ikm: Option<&[u8]>) -> Result<Vec<u8>> {
    let (enc, mut context) = setup_sender(recipient_public_key, &info(purpose)?, ephemeral_ikm)?;
    Ok(join(&[&enc, &context.seal(aad, plaintext)?]))
}

/// Opens a box from `seal`. A wrong key, purpose, AAD or a changed byte is
/// refused.
pub fn open(purpose: &[u8], recipient_secret_key: &[u8], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < N_ENC + TAG {
        return Err(Refusal::Malformed);
    }
    let mut context = setup_recipient(&sealed[..N_ENC], recipient_secret_key, &info(purpose)?)?;
    context.open(aad, &sealed[N_ENC..])
}

/// The RFC 9180 A.2.1 run the vectors check: the sender's key schedule and
/// first seal from a fixed ephemeral IKM, and the recipient's open and export.
pub struct VectorRun {
    pub enc: Vec<u8>,
    pub key: Vec<u8>,
    pub base_nonce: Vec<u8>,
    pub exporter_secret: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub opened: Vec<u8>,
    pub exported: Vec<u8>,
}

#[allow(clippy::too_many_arguments)]
pub fn vector_sequence(
    recipient_public_key: &[u8],
    recipient_secret_key: &[u8],
    info: &[u8],
    ephemeral_ikm: &[u8],
    aad: &[u8],
    plaintext: &[u8],
    exporter_context: &[u8],
    export_length: usize,
) -> Result<VectorRun> {
    let (enc, mut sender) = setup_sender(recipient_public_key, info, Some(ephemeral_ikm))?;
    let ciphertext = sender.seal(aad, plaintext)?;
    let mut recipient = setup_recipient(&enc, recipient_secret_key, info)?;
    let opened = recipient.open(aad, &ciphertext)?;
    let exported = recipient.export(exporter_context, export_length)?;
    Ok(VectorRun {
        key: sender.key.clone(),
        base_nonce: sender.base_nonce.clone(),
        exporter_secret: sender.exporter_secret.clone(),
        enc,
        ciphertext,
        opened,
        exported,
    })
}

/// `link`: `lp(linkId) ‖ lp(newDeviceId)`.
pub fn link_aad(link_id: &[u8], new_device_id: &[u8]) -> Vec<u8> {
    join(&[&lp(link_id), &lp(new_device_id)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_refuses() {
        let recipient = derive_key_pair(b"recipient ikm").unwrap();
        let aad = link_aad(b"clk_1", b"cdv_2");
        let sealed = seal(b"link", &recipient.public_key, &aad, b"secret", None).unwrap();
        assert_eq!(sealed.len(), 32 + 6 + 16);
        assert_eq!(open(b"link", &recipient.secret_key, &aad, &sealed).unwrap(), b"secret");
        // Another purpose, AAD, key or a changed byte does not open.
        assert_eq!(open(b"puk", &recipient.secret_key, &aad, &sealed), Err(Refusal::NotAuthentic));
        assert_eq!(open(b"link", &recipient.secret_key, b"x", &sealed), Err(Refusal::NotAuthentic));
        let other = derive_key_pair(b"other").unwrap();
        assert_eq!(open(b"link", &other.secret_key, &aad, &sealed), Err(Refusal::NotAuthentic));
        let mut changed = sealed.clone();
        changed[40] ^= 1;
        assert_eq!(open(b"link", &recipient.secret_key, &aad, &changed), Err(Refusal::NotAuthentic));
        // Two random seals differ.
        assert_ne!(sealed, seal(b"link", &recipient.public_key, &aad, b"secret", None).unwrap());
        // Too short, an unknown purpose, a small-order recipient.
        assert_eq!(open(b"link", &recipient.secret_key, &aad, &sealed[..47]), Err(Refusal::Malformed));
        assert_eq!(seal(b"chat", &recipient.public_key, &aad, b"", None), Err(Refusal::Malformed));
        assert_eq!(open(b"chat", &recipient.secret_key, &aad, &sealed), Err(Refusal::Malformed));
        assert_eq!(seal(b"link", &[0u8; 32], &aad, b"", None), Err(Refusal::SmallOrder));
        assert_eq!(setup_recipient(&[1u8; 31], &recipient.secret_key, b"").err(), Some(Refusal::Malformed));
    }
}
