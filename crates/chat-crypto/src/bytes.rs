//! The byte encodings every chat construction is built from.
//!
//! - `lp(x)`: bytes prefixed with their length as 4 bytes big-endian.
//! - `u64(n)`: a whole number as 8 bytes big-endian.
//! - `join(...)` (written `‖`) puts them end to end. Every AAD, KDF input and
//!   hash input is such a join, so no two different inputs encode alike.
//!
//! Strings arrive as their UTF-8 bytes: the TypeScript side encodes them,
//! with its own handling of lone surrogates, so both sides agree byte for
//! byte.

use crate::buckets::{CEILINGS, FLOORS};
use crate::error::{Refusal, Result};

pub fn lp(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
    out
}

pub fn u64be(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}

pub fn join(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(|part| part.len()).sum());
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

/// Equal length and equal bytes, in time that does not depend on where they
/// differ.
pub fn equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The smallest padded size, whatever the content.
pub const SMALLEST_BUCKET: u64 = 541;

/// The padded size of `length` bytes of plaintext:
/// `max(541, ceil(1.05^ceil(log_1.05(length + 1))))`. The `+ 1` is the `0x80`
/// that marks where the padding starts. `ceil(log_1.05(m))` is the least `k`
/// with `1.05^k ≥ m`, which for a whole `m` is the least `k` with
/// `floor(1.05^k) ≥ m`.
pub fn bucket_size(length: u64) -> Result<u64> {
    let wanted = length.checked_add(1).ok_or(Refusal::TooLarge)?;
    let k = FLOORS
        .iter()
        .position(|&floor| floor >= wanted)
        .ok_or(Refusal::TooLarge)?;
    Ok(SMALLEST_BUCKET.max(CEILINGS[k]))
}

/// `plaintext`, then `0x80`, then zeros up to its bucket.
pub fn pad(plaintext: &[u8]) -> Result<Vec<u8>> {
    let size = bucket_size(plaintext.len() as u64)? as usize;
    let mut out = vec![0u8; size];
    out[..plaintext.len()].copy_from_slice(plaintext);
    out[plaintext.len()] = 0x80;
    Ok(out)
}

/// The plaintext of a padded buffer: trailing zeros and the `0x80` before
/// them go.
pub fn unpad(padded: &[u8]) -> Result<&[u8]> {
    let end = padded
        .iter()
        .rposition(|&byte| byte != 0)
        .ok_or(Refusal::NoPaddingMarker)?;
    if padded[end] != 0x80 {
        return Err(Refusal::NoPaddingMarker);
    }
    Ok(&padded[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigUint;

    #[test]
    fn encodes_lengths_and_numbers() {
        assert_eq!(lp(&[0xc3, 0xa9]), vec![0, 0, 0, 2, 0xc3, 0xa9]);
        assert_eq!(lp(&[]), vec![0, 0, 0, 0]);
        assert_eq!(u64be(1234567890123), [0, 0, 1, 0x1f, 0x71, 0xfb, 0x04, 0xcb]);
        assert_eq!(join(&[&[1], &[], &[2, 3]]), vec![1, 2, 3]);
    }

    #[test]
    fn compares_bytes() {
        assert!(equal(&[1, 2], &[1, 2]));
        assert!(!equal(&[1, 2], &[1, 3]));
        assert!(!equal(&[1, 2], &[1, 2, 3]));
        assert!(equal(&[], &[]));
    }

    #[test]
    fn buckets_at_their_edges() {
        assert_eq!(bucket_size(0).unwrap(), 541);
        assert_eq!(bucket_size(514).unwrap(), 541);
        assert_eq!(bucket_size(515).unwrap(), 542);
        assert_eq!(bucket_size(539).unwrap(), 542);
        assert_eq!(bucket_size(540).unwrap(), 542);
        assert_eq!(bucket_size(541).unwrap(), 569);
        assert_eq!(bucket_size(542).unwrap(), 569);
        assert_eq!(bucket_size(10 * 1024 * 1024).unwrap(), 10_835_459);
        assert_eq!(bucket_size(104_857_600).unwrap(), 107_335_739);
        assert_eq!(bucket_size(20_971_520).unwrap(), 21_453_467);
        // Every size fits its bucket, with room for the marker.
        for length in [0u64, 1, 540, 541, 568, 569, 100_000, 104_857_600] {
            assert!(bucket_size(length).unwrap() > length);
        }
        assert_eq!(bucket_size(FLOORS[420]), Err(Refusal::TooLarge));
        assert_eq!(bucket_size(u64::MAX), Err(Refusal::TooLarge));
    }

    #[test]
    fn buckets_match_exact_powers() {
        let mut numerator = BigUint::from(1u32);
        let mut denominator = BigUint::from(1u32);
        for k in 0..FLOORS.len() {
            if k > 0 {
                numerator *= 21u32;
                denominator *= 20u32;
            }
            let floor = &numerator / &denominator;
            let ceiling = (&numerator + &denominator - 1u32) / &denominator;
            assert_eq!(floor, BigUint::from(FLOORS[k]), "floor {k}");
            assert_eq!(ceiling, BigUint::from(CEILINGS[k]), "ceiling {k}");
        }
    }

    #[test]
    fn pads_and_unpads() {
        let padded = pad(b"hello").unwrap();
        assert_eq!(padded.len(), 541);
        assert_eq!(&padded[..6], b"hello\x80");
        assert!(padded[6..].iter().all(|&byte| byte == 0));
        assert_eq!(unpad(&padded).unwrap(), b"hello");
        assert_eq!(unpad(&pad(b"").unwrap()).unwrap(), b"");
        // Content ending in zeros keeps them: the marker comes after.
        assert_eq!(unpad(&pad(&[1, 0, 0]).unwrap()).unwrap(), &[1, 0, 0]);
        assert_eq!(unpad(&[1, 2, 0]), Err(Refusal::NoPaddingMarker));
        assert_eq!(unpad(&[0, 0, 0]), Err(Refusal::NoPaddingMarker));
        assert_eq!(unpad(&[]), Err(Refusal::NoPaddingMarker));
    }
}
