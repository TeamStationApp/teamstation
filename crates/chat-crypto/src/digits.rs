//! The hashes that become something people read or a server stores: the
//! membership log hash, safety numbers, link codes and the two kinds of id.

use crate::bytes::{join, lp, u64be};
use crate::error::{Refusal, Result};
use crate::prim;
use crate::random;

/// A membership log row's hash: `SHA-256(prev_hash ‖ lp(conversationId) ‖
/// u64(seq) ‖ lp(event) ‖ u64(userId) ‖ u64(actorUserId or 0) ‖ lp(reason) ‖
/// u64(at in ms))`. The first row's `prev_hash` is 32 zero bytes, and a row
/// with no reason hashes `lp("")`.
#[allow(clippy::too_many_arguments)]
pub fn log_row_hash(prev_hash: &[u8], conversation_id: &[u8], seq: u64, event: &[u8], user_id: u64, actor_user_id: u64, reason: &[u8], at: u64) -> Result<[u8; 32]> {
    if prev_hash.len() != 32 {
        return Err(Refusal::Malformed);
    }
    Ok(prim::sha256(&join(&[
        prev_hash,
        &lp(conversation_id),
        &u64be(seq),
        &lp(event),
        &u64be(user_id),
        &u64be(actor_user_id),
        &lp(reason),
        &u64be(at),
    ])))
}

const SAFETY_ITERATIONS: usize = 5200;

/// One person's 30 digits: SHA-512 applied 5,200 times, starting from
/// `0x00 ‖ lp(identityKey) ‖ u64(userId)`, and the first 30 bytes of the
/// result read as six 5-digit groups (each 5 bytes as a big-endian number,
/// mod 100,000, zero-padded).
pub fn safety_half(identity_key: &[u8], user_id: u64) -> String {
    let mut hash = join(&[&[0u8], &lp(identity_key), &u64be(user_id)]);
    for _ in 0..SAFETY_ITERATIONS {
        hash = prim::sha512(&hash).to_vec();
    }
    let mut digits = String::with_capacity(30);
    for group in hash[..30].chunks(5) {
        let value = group.iter().fold(0u64, |value, &byte| value * 256 + byte as u64);
        digits.push_str(&format!("{:05}", value % 100_000));
    }
    digits
}

/// The six digits both screens show while a device is linked: the first 8
/// bytes of `SHA-256(lp(newDevicePublicKey) ‖ lp(linkId))`, big-endian, mod
/// 10^6, zero-padded.
pub fn link_code(new_device_public_key: &[u8], link_id: &[u8]) -> String {
    let hash = prim::sha256(&join(&[&lp(new_device_public_key), &lp(link_id)]));
    let value = u64::from_be_bytes(hash[..8].try_into().expect("8 bytes"));
    format!("{:06}", value % 1_000_000)
}

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Bits taken `width` at a time, most significant first, the last group
/// filled with zero bits: RFC 4648 without padding.
fn encode(bytes: &[u8], alphabet: &[u8], width: u32) -> String {
    let mut out = String::new();
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for &byte in bytes {
        buffer = (buffer << 8) | byte as u32;
        bits += 8;
        while bits >= width {
            bits -= width;
            out.push(alphabet[((buffer >> bits) & ((1 << width) - 1)) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(alphabet[((buffer << (width - bits)) & ((1 << width) - 1)) as usize] as char);
    }
    out
}

/// `msg_` and 26 lowercase base32 characters of 16 random bytes.
pub fn new_message_id() -> Result<String> {
    Ok(format!("msg_{}", encode(&random::array::<16>()?, BASE32, 5)))
}

/// `cid_` and 16 base64url characters of 12 random bytes.
pub fn new_identity_id() -> Result<String> {
    Ok(format!("cid_{}", encode(&random::array::<12>()?, BASE64URL, 6)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_rfc4648() {
        assert_eq!(encode(b"foobar", BASE32, 5), "mzxw6ytboi");
        assert_eq!(encode(b"f", BASE32, 5), "my");
        assert_eq!(encode(b"foob", BASE64URL, 6), "Zm9vYg");
        assert_eq!(encode(&[0xfb, 0xff], BASE64URL, 6), "-_8");
    }

    #[test]
    fn makes_ids_of_their_shape() {
        for _ in 0..50 {
            let id = new_message_id().unwrap();
            assert_eq!(id.len(), 30);
            assert!(id[4..].bytes().all(|c| BASE32.contains(&c)));
            let id = new_identity_id().unwrap();
            assert_eq!(id.len(), 20);
            assert!(id[4..].bytes().all(|c| BASE64URL.contains(&c)));
        }
        assert_ne!(new_message_id().unwrap(), new_message_id().unwrap());
    }

    #[test]
    fn digits_have_their_shape() {
        let half = safety_half(&[1u8; 32], 7);
        assert_eq!(half.len(), 30);
        assert!(half.bytes().all(|c| c.is_ascii_digit()));
        assert_ne!(half, safety_half(&[1u8; 32], 8));
        let code = link_code(&[2u8; 32], b"clk_1");
        assert_eq!(code.len(), 6);
        assert_eq!(log_row_hash(&[0u8; 31], b"c", 1, b"join", 1, 0, b"", 0), Err(Refusal::Malformed));
    }
}
