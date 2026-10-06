//! The primitives every construction is built on, from RustCrypto and dalek.
//!
//! Keys are raw: a 32-byte X25519 secret (clamped by the curve when used), a
//! 32-byte Ed25519 seed. An AEAD's output is ciphertext ‖ 16-byte tag, and
//! opening anything that does not authenticate is `NotAuthentic`.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, XChaCha20Poly1305};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::digest::consts::U64;
use sha2::digest::generic_array::GenericArray;
use sha2::{Digest, Sha256, Sha512};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::error::{Refusal, Result};

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn sha512(data: &[u8]) -> [u8; 64] {
    Sha512::digest(data).into()
}

/// HKDF-SHA256 extract. An empty salt is HMAC's empty key, which is the same
/// as RFC 5869's 32 zero bytes.
pub fn hkdf_extract(salt: &[u8], ikm: &[u8]) -> [u8; 32] {
    let (prk, _) = Hkdf::<Sha256>::extract(Some(salt), ikm);
    prk.into()
}

/// HKDF-SHA256 gives at most 255 blocks of 32 bytes.
pub const HKDF_MOST: usize = 255 * 32;

pub fn hkdf_expand(prk: &[u8], info: &[u8], length: usize) -> Result<Vec<u8>> {
    // Refused before anything is allocated: a length nobody can have is
    // never a reason to abort.
    if length > HKDF_MOST {
        return Err(Refusal::TooLarge);
    }
    let hkdf = Hkdf::<Sha256>::from_prk(prk).map_err(|_| Refusal::Malformed)?;
    let mut out = vec![0u8; length];
    hkdf.expand(info, &mut out).map_err(|_| Refusal::Malformed)?;
    Ok(out)
}

/// Extract, then expand.
pub fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8], length: usize) -> Result<Vec<u8>> {
    let prk = Zeroizing::new(hkdf_extract(salt, ikm));
    hkdf_expand(&*prk, info, length)
}

pub fn key32(bytes: &[u8]) -> Result<[u8; 32]> {
    bytes.try_into().map_err(|_| Refusal::Malformed)
}

/// A secret key's 32 bytes, wiped when dropped.
pub fn secret32(bytes: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    Ok(Zeroizing::new(key32(bytes)?))
}

pub fn x25519_public_key(secret_key: &[u8]) -> Result<[u8; 32]> {
    let secret = StaticSecret::from(*secret32(secret_key)?);
    Ok(PublicKey::from(&secret).to_bytes())
}

/// X25519. The all-zero result of a small-order public key is refused, the
/// check RFC 9180 §7.1.4 requires.
pub fn x25519(secret_key: &[u8], public_key: &[u8]) -> Result<[u8; 32]> {
    let secret = StaticSecret::from(*secret32(secret_key)?);
    let shared = secret.diffie_hellman(&PublicKey::from(key32(public_key)?));
    if !shared.was_contributory() {
        return Err(Refusal::SmallOrder);
    }
    Ok(shared.to_bytes())
}

pub fn ed25519_public_key(seed: &[u8]) -> Result<[u8; 32]> {
    let seed = secret32(seed)?;
    Ok(SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes())
}

pub fn ed25519_sign(message: &[u8], seed: &[u8]) -> Result<[u8; 64]> {
    let seed = secret32(seed)?;
    Ok(SigningKey::from_bytes(&seed).sign(message).to_bytes())
}

/// RFC 8032's strict rules: a non-canonical signature, or a weak key, is not
/// valid. A malformed signature or key is simply false.
pub fn ed25519_verify(signature: &[u8], message: &[u8], public_key: &[u8]) -> bool {
    let Ok(key_bytes) = key32(public_key) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_bytes) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    key.verify_strict(message, &signature).is_ok()
}

pub fn chacha20_poly1305_seal(key: &[u8], nonce: &[u8], aad: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    if nonce.len() != 12 {
        return Err(Refusal::Malformed);
    }
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|_| Refusal::Malformed)?;
    cipher
        .encrypt(nonce.into(), Payload { msg: data, aad })
        .map_err(|_| Refusal::Malformed)
}

pub fn chacha20_poly1305_open(key: &[u8], nonce: &[u8], aad: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    if nonce.len() != 12 {
        return Err(Refusal::Malformed);
    }
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|_| Refusal::Malformed)?;
    cipher
        .decrypt(nonce.into(), Payload { msg: data, aad })
        .map_err(|_| Refusal::NotAuthentic)
}

pub fn xchacha20_poly1305_seal(key: &[u8], nonce: &[u8], aad: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    if nonce.len() != 24 {
        return Err(Refusal::Malformed);
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| Refusal::Malformed)?;
    cipher
        .encrypt(nonce.into(), Payload { msg: data, aad })
        .map_err(|_| Refusal::Malformed)
}

pub fn xchacha20_poly1305_open(key: &[u8], nonce: &[u8], aad: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    if nonce.len() != 24 {
        return Err(Refusal::Malformed);
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| Refusal::Malformed)?;
    cipher
        .decrypt(nonce.into(), Payload { msg: data, aad })
        .map_err(|_| Refusal::NotAuthentic)
}

/// SHA-256's initial state.
const SHA256_START: [u32; 8] = [
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
];

/// SHA-256 carried from one call to the next, so a blob is hashed a part
/// at a time. Its bytes are the eight state words big-endian, the length
/// hashed so far as 8 bytes big-endian, then the bytes not yet a whole
/// block; no bytes at all is the start.
pub struct RunningSha256 {
    state: [u32; 8],
    length: u64,
    pending: Vec<u8>,
}

impl RunningSha256 {
    pub fn from_bytes(bytes: &[u8]) -> Result<RunningSha256> {
        if bytes.is_empty() {
            return Ok(RunningSha256 { state: SHA256_START, length: 0, pending: Vec::new() });
        }
        if bytes.len() < 40 {
            return Err(Refusal::Malformed);
        }
        let length = u64::from_be_bytes(bytes[32..40].try_into().expect("8 bytes"));
        let pending = bytes[40..].to_vec();
        if pending.len() as u64 != length % 64 {
            return Err(Refusal::Malformed);
        }
        let mut state = [0u32; 8];
        for (word, at) in state.iter_mut().zip((0..32).step_by(4)) {
            *word = u32::from_be_bytes(bytes[at..at + 4].try_into().expect("4 bytes"));
        }
        Ok(RunningSha256 { state, length, pending })
    }

    /// How many bytes it has hashed.
    pub fn length(&self) -> u64 {
        self.length
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(40 + self.pending.len());
        for word in self.state {
            out.extend_from_slice(&word.to_be_bytes());
        }
        out.extend_from_slice(&self.length.to_be_bytes());
        out.extend_from_slice(&self.pending);
        out
    }

    /// Every whole 64-byte block of `data`, in one call.
    fn compress(&mut self, data: &[u8]) {
        let count = data.len() / 64;
        // SAFETY: `GenericArray<u8, U64>` is `repr(transparent)` over 64
        // bytes with an alignment of 1, and `count` blocks lie inside `data`;
        // block-buffer makes the same cast for sha2's own `update`.
        let blocks = unsafe { core::slice::from_raw_parts(data.as_ptr().cast::<GenericArray<u8, U64>>(), count) };
        sha2::compress256(&mut self.state, blocks);
    }

    pub fn update(&mut self, data: &[u8]) -> Result<()> {
        // SHA-256 counts bits in 64: no more than 2^61 bytes.
        self.length = self
            .length
            .checked_add(data.len() as u64)
            .filter(|&length| length < 1 << 61)
            .ok_or(Refusal::TooLarge)?;
        let mut data = data;
        if !self.pending.is_empty() {
            let take = (64 - self.pending.len()).min(data.len());
            self.pending.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.pending.len() < 64 {
                return Ok(());
            }
            let block = core::mem::take(&mut self.pending);
            self.compress(&block);
        }
        let whole = data.len() / 64 * 64;
        self.compress(&data[..whole]);
        self.pending.extend_from_slice(&data[whole..]);
        Ok(())
    }

    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.length * 8;
        let mut tail = core::mem::take(&mut self.pending);
        tail.push(0x80);
        while tail.len() % 64 != 56 {
            tail.push(0);
        }
        tail.extend_from_slice(&bits.to_be_bytes());
        self.compress(&tail);
        let mut digest = [0u8; 32];
        for (word, at) in self.state.iter().zip((0..32).step_by(4)) {
            digest[at..at + 4].copy_from_slice(&word.to_be_bytes());
        }
        digest
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn hashes_a_part_at_a_time() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7 % 256) as u8).collect();
        for cuts in [vec![], vec![0], vec![1, 63], vec![64, 128], vec![55, 56, 57, 120, 999], vec![500]] {
            let mut running = RunningSha256::from_bytes(&[]).unwrap();
            let mut from = 0;
            for cut in cuts.iter().copied().chain([data.len()]) {
                let bytes = running.to_bytes();
                running = RunningSha256::from_bytes(&bytes).unwrap();
                running.update(&data[from..cut]).unwrap();
                from = cut;
            }
            assert_eq!(running.finish(), sha256(&data));
        }
        for length in [0usize, 55, 56, 63, 64, 65, 119, 120] {
            let mut running = RunningSha256::from_bytes(&[]).unwrap();
            running.update(&data[..length]).unwrap();
            assert_eq!(running.finish(), sha256(&data[..length]));
        }
        assert!(RunningSha256::from_bytes(&[0u8; 39]).is_err());
        let mut odd = RunningSha256::from_bytes(&[]).unwrap();
        odd.update(b"abc").unwrap();
        let mut bytes = odd.to_bytes();
        bytes.pop();
        assert!(RunningSha256::from_bytes(&bytes).is_err());
        let mut huge = RunningSha256 { state: SHA256_START, length: (1 << 61) - 1, pending: Vec::new() };
        assert_eq!(huge.update(b"x").err(), Some(Refusal::TooLarge));
    }

    #[test]
    fn hashes_known_answers() {
        assert_eq!(
            sha256(b"abc").to_vec(),
            hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(sha512(b"abc")[..4], [0xdd, 0xaf, 0x35, 0xa1]);
    }

    #[test]
    fn hkdf_rfc5869_case_1() {
        let ikm = hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        let salt = hex("000102030405060708090a0b0c");
        let info = hex("f0f1f2f3f4f5f6f7f8f9");
        let okm = hkdf(&ikm, &salt, &info, 42).unwrap();
        assert_eq!(
            okm,
            hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
        );
        // An empty salt is the zero salt.
        assert_eq!(hkdf_extract(&[], &ikm), hkdf_extract(&[0u8; 32], &ikm));
        assert_eq!(hkdf_expand(&[1, 2, 3], &[], 32), Err(Refusal::Malformed));
        assert_eq!(hkdf_expand(&[0u8; 32], &[], 255 * 32 + 1), Err(Refusal::TooLarge));
    }

    #[test]
    fn x25519_refuses_small_order_and_bad_lengths() {
        let secret = [7u8; 32];
        assert_eq!(x25519(&secret, &[0u8; 32]), Err(Refusal::SmallOrder));
        assert_eq!(x25519(&secret, &[1u8; 31]), Err(Refusal::Malformed));
        assert_eq!(x25519_public_key(&[1u8; 33]), Err(Refusal::Malformed));
        let other = [9u8; 32];
        let a = x25519(&secret, &x25519_public_key(&other).unwrap()).unwrap();
        let b = x25519(&other, &x25519_public_key(&secret).unwrap()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn ed25519_is_strict() {
        let seed = [3u8; 32];
        let key = ed25519_public_key(&seed).unwrap();
        let signature = ed25519_sign(b"m", &seed).unwrap();
        assert!(ed25519_verify(&signature, b"m", &key));
        assert!(!ed25519_verify(&signature, b"n", &key));
        // S + L: the same scalar, not canonical.
        let l: [u8; 32] = hex("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010")
            .try_into()
            .unwrap();
        let mut high = signature;
        let mut carry = 0u16;
        for i in 0..32 {
            let sum = high[32 + i] as u16 + l[i] as u16 + carry;
            high[32 + i] = sum as u8;
            carry = sum >> 8;
        }
        assert!(!ed25519_verify(&high, b"m", &key));
        // A small-order (identity) public key.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(!ed25519_verify(&[0u8; 64], b"m", &identity));
        // A mixed-order key: the real key plus the point of order 2.
        let order_two = hex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f");
        let mixed = curve_add(&key, &order_two);
        assert!(!ed25519_verify(&signature, b"m", &mixed));
        assert!(!ed25519_verify(&signature[..63], b"m", &key));
        assert!(!ed25519_verify(&signature, b"m", &key[..31]));
        assert!(!ed25519_verify(&signature, b"m", &[0xff; 32]));
        assert_eq!(ed25519_sign(b"m", &[0u8; 31]), Err(Refusal::Malformed));
        assert_eq!(ed25519_public_key(&[0u8; 31]), Err(Refusal::Malformed));
    }

    /// The Edwards sum of two encoded points, for the mixed-order key.
    fn curve_add(a: &[u8], b: &[u8]) -> Vec<u8> {
        use curve25519_dalek::edwards::CompressedEdwardsY;
        let point = |bytes: &[u8]| {
            CompressedEdwardsY(bytes.try_into().unwrap())
                .decompress()
                .unwrap()
        };
        (point(a) + point(b)).compress().to_bytes().to_vec()
    }

    #[test]
    fn aeads_open_only_what_they_sealed() {
        let key = [5u8; 32];
        let sealed = chacha20_poly1305_seal(&key, &[1u8; 12], b"aad", b"pt").unwrap();
        assert_eq!(chacha20_poly1305_open(&key, &[1u8; 12], b"aad", &sealed).unwrap(), b"pt");
        assert_eq!(chacha20_poly1305_open(&key, &[1u8; 12], b"aab", &sealed), Err(Refusal::NotAuthentic));
        assert_eq!(chacha20_poly1305_open(&key, &[2u8; 12], b"aad", &sealed), Err(Refusal::NotAuthentic));
        assert_eq!(chacha20_poly1305_seal(&key, &[1u8; 11], b"", b""), Err(Refusal::Malformed));
        assert_eq!(chacha20_poly1305_open(&key, &[1u8; 11], b"", b""), Err(Refusal::Malformed));
        assert_eq!(chacha20_poly1305_seal(&key[..31], &[1u8; 12], b"", b""), Err(Refusal::Malformed));
        assert_eq!(chacha20_poly1305_open(&key[..31], &[1u8; 12], b"", &sealed), Err(Refusal::Malformed));
        let mut flipped = sealed.clone();
        flipped[0] ^= 1;
        assert_eq!(chacha20_poly1305_open(&key, &[1u8; 12], b"aad", &flipped), Err(Refusal::NotAuthentic));
        let mut tag = sealed.clone();
        *tag.last_mut().unwrap() ^= 1;
        assert_eq!(chacha20_poly1305_open(&key, &[1u8; 12], b"aad", &tag), Err(Refusal::NotAuthentic));

        let x = xchacha20_poly1305_seal(&key, &[1u8; 24], b"aad", b"pt").unwrap();
        assert_eq!(xchacha20_poly1305_open(&key, &[1u8; 24], b"aad", &x).unwrap(), b"pt");
        assert_eq!(xchacha20_poly1305_open(&key, &[1u8; 24], b"x", &x), Err(Refusal::NotAuthentic));
        assert_eq!(xchacha20_poly1305_seal(&key, &[1u8; 12], b"", b""), Err(Refusal::Malformed));
        assert_eq!(xchacha20_poly1305_open(&key, &[1u8; 12], b"", b""), Err(Refusal::Malformed));
        assert_eq!(xchacha20_poly1305_seal(&key[..1], &[1u8; 24], b"", b""), Err(Refusal::Malformed));
        assert_eq!(xchacha20_poly1305_open(&key[..1], &[1u8; 24], b"", &x), Err(Refusal::Malformed));
    }
}
