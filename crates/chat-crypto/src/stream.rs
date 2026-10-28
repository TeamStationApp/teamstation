//! Attachments: a STREAM construction over XChaCha20-Poly1305.
//!
//! - A random 32-byte key per attachment, carried inside the message.
//! - The file is padded to its bucket and cut into 64 KiB chunks. Chunk i is
//!   sealed with the nonce `prefix ‖ i ‖ last`: a 16-byte random prefix, a
//!   7-byte big-endian counter and a 1-byte flag that is 1 on the final chunk
//!   only.
//! - The blob is `prefix ‖ sealed chunk 0 ‖ sealed chunk 1 ‖ …`, and its
//!   digest is the SHA-256 of the whole blob.
//!
//! A reordered chunk fails its counter, a truncated blob ends on a chunk not
//! sealed as last, and a blob with its last chunk dropped likewise.

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{Tag, XChaCha20Poly1305, XNonce};
use zeroize::Zeroize;

use crate::bytes::{bucket_size, equal};
use crate::error::{Refusal, Result};
use crate::prim::{self, RunningSha256};

pub const CHUNK_SIZE: usize = 65536;
const TAG: usize = 16;
const PREFIX: usize = 16;
const SEALED_CHUNK: usize = CHUNK_SIZE + TAG;

/// `prefix ‖ u56(counter) ‖ last`.
pub fn chunk_nonce(prefix: &[u8], counter: u64, last: bool) -> Result<[u8; 24]> {
    if prefix.len() != PREFIX || counter >= 1 << 56 {
        return Err(Refusal::Malformed);
    }
    let mut nonce = [0u8; 24];
    nonce[..PREFIX].copy_from_slice(prefix);
    nonce[16..23].copy_from_slice(&counter.to_be_bytes()[1..]);
    nonce[23] = u8::from(last);
    Ok(nonce)
}

/// How long the blob of `size` plaintext bytes is.
pub fn blob_length(size: u64) -> Result<u64> {
    let padded = bucket_size(size)?;
    let chunk = CHUNK_SIZE as u64;
    Ok(PREFIX as u64 + padded + padded.div_ceil(chunk) * TAG as u64)
}

/// How many chunks a whole blob of `padded` bytes has.
fn chunk_count(padded: usize) -> usize {
    padded.div_ceil(CHUNK_SIZE)
}

/// Seals chunks `first .. first + count` of a file of `size` bytes, given
/// exactly that range's bytes of the file (none, past its end), and returns
/// them sealed: each `ciphertext ‖ tag`, without the blob's prefix. `digest`
/// is the blob's SHA-256 so far, which the part carries on: the prefix and
/// every earlier part, so it starts empty and the first part hashes the
/// prefix first.
///
/// The padded plaintext is written straight into its place in the answer
/// (the zeros of the padding are the buffer's own) and each chunk is sealed
/// where it lies. A caller seals a large file a part at a time, so no call
/// holds the whole file.
pub fn seal_part(key: &[u8], prefix: &[u8], size: u64, first: u64, count: u64, plaintext: &[u8], digest: &mut RunningSha256) -> Result<Vec<u8>> {
    let padded = usize::try_from(bucket_size(size)?).map_err(|_| Refusal::TooLarge)?;
    let size = size as usize;
    let first = usize::try_from(first).map_err(|_| Refusal::Malformed)?;
    let count = usize::try_from(count).map_err(|_| Refusal::Malformed)?;
    let end = first.checked_add(count).ok_or(Refusal::Malformed)?;
    if count == 0 || end > chunk_count(padded) || prefix.len() != PREFIX {
        return Err(Refusal::Malformed);
    }
    let from = first * CHUNK_SIZE;
    let to = (end * CHUNK_SIZE).min(padded);
    if plaintext.len() != size.min(to).saturating_sub(from) {
        return Err(Refusal::Malformed);
    }
    if digest.length() != hashed_before(first as u64)? {
        return Err(Refusal::Malformed);
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| Refusal::Malformed)?;
    let mut out = vec![0u8; to - from + count * TAG];
    for (j, i) in (first..end).enumerate() {
        let chunk_from = i * CHUNK_SIZE;
        let length = (padded - chunk_from).min(CHUNK_SIZE);
        let at = j * SEALED_CHUNK;
        let chunk = &mut out[at..at + length];
        // This chunk's part of `plaintext ‖ 0x80 ‖ zeros`.
        let data = plaintext.get(chunk_from - from..).unwrap_or(&[]);
        let data = &data[..data.len().min(length)];
        chunk[..data.len()].copy_from_slice(data);
        if (chunk_from..chunk_from + length).contains(&size) {
            chunk[size - chunk_from] = 0x80;
        }
        let nonce = chunk_nonce(prefix, i as u64, i == chunk_count(padded) - 1)?;
        let tag = match cipher.encrypt_in_place_detached(XNonce::from_slice(&nonce), &[], chunk) {
            Ok(tag) => tag,
            Err(_) => {
                out.zeroize();
                return Err(Refusal::Malformed);
            }
        };
        out[at + length..at + length + TAG].copy_from_slice(&tag);
    }
    if first == 0 {
        digest.update(prefix)?;
    }
    digest.update(&out)?;
    Ok(out)
}

/// Opens sealed chunks starting at chunk `first`, `last` when they end the
/// blob, and returns their plaintext, padding and all. Every chunk but a
/// blob's last is whole, and its last is more than a tag. A part that does
/// not open leaves nothing behind. `digest` is the blob's SHA-256 so far,
/// carried on as in `seal_part`, for the caller to check against the
/// message's once the last part is open.
pub fn open_part(key: &[u8], prefix: &[u8], first: u64, last: bool, sealed: &[u8], digest: &mut RunningSha256) -> Result<Vec<u8>> {
    if prefix.len() != PREFIX || digest.length() != hashed_before(first)? {
        return Err(Refusal::Malformed);
    }
    let chunks = sealed.len().div_ceil(SEALED_CHUNK);
    let tail = sealed.len() - chunks.saturating_sub(1) * SEALED_CHUNK;
    if chunks == 0 || (!last && tail != SEALED_CHUNK) || tail <= TAG {
        return Err(Refusal::Truncated);
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| Refusal::Malformed)?;
    let mut out = vec![0u8; sealed.len() - chunks * TAG];
    for (j, chunk_sealed) in sealed.chunks(SEALED_CHUNK).enumerate() {
        let (ciphertext, tag) = chunk_sealed.split_at(chunk_sealed.len() - TAG);
        let chunk = &mut out[j * CHUNK_SIZE..j * CHUNK_SIZE + ciphertext.len()];
        chunk.copy_from_slice(ciphertext);
        let counter = first.checked_add(j as u64).ok_or(Refusal::Malformed)?;
        let nonce = chunk_nonce(prefix, counter, last && j == chunks - 1)?;
        if cipher
            .decrypt_in_place_detached(XNonce::from_slice(&nonce), &[], chunk, Tag::from_slice(tag))
            .is_err()
        {
            out.zeroize();
            return Err(Refusal::NotAuthentic);
        }
    }
    if first == 0 {
        digest.update(prefix)?;
    }
    digest.update(sealed)?;
    Ok(out)
}

/// How much of a blob comes before chunk `first`: nothing before the first,
/// then the prefix and every whole chunk.
fn hashed_before(first: u64) -> Result<u64> {
    if first == 0 {
        return Ok(0);
    }
    first
        .checked_mul(SEALED_CHUNK as u64)
        .and_then(|chunks| chunks.checked_add(PREFIX as u64))
        .ok_or(Refusal::Malformed)
}

/// How far a part's plaintext runs: one past its last non-zero byte, or 0
/// when it is all zeros (all padding). The caller cuts the file at the last
/// part's marker without scanning the padding itself.
pub fn content_end(padded: &[u8]) -> u64 {
    padded.iter().rposition(|&byte| byte != 0).map_or(0, |at| at as u64 + 1)
}

/// `plaintext ‖ 0x80 ‖ zeros`, cut at the marker; anything else is zeroed.
pub fn unpad(mut padded: Vec<u8>) -> Result<Vec<u8>> {
    match padded.iter().rposition(|&byte| byte != 0) {
        Some(end) if padded[end] == 0x80 => {
            padded[end] = 0;
            padded.truncate(end);
            Ok(padded)
        }
        _ => {
            padded.zeroize();
            Err(Refusal::NoPaddingMarker)
        }
    }
}

pub struct Sealed {
    pub key: Vec<u8>,
    pub blob: Vec<u8>,
    pub digest: [u8; 32],
}

/// Pads, seals and digests a whole file in one part: the parts a caller
/// seals one at a time, put together.
pub fn seal_attachment(plaintext: &[u8], key: &[u8], prefix: &[u8]) -> Result<Sealed> {
    let size = plaintext.len() as u64;
    let chunks = chunk_count(bucket_size(size)? as usize) as u64;
    let mut running = RunningSha256::from_bytes(&[])?;
    let mut blob = prefix.to_vec();
    blob.extend_from_slice(&seal_part(key, prefix, size, 0, chunks, plaintext, &mut running)?);
    Ok(Sealed { key: key.to_vec(), blob, digest: running.finish() })
}

/// The file in a blob, unpadded, opened in one part. With `digest`, the
/// blob must hash to it first.
pub fn open_attachment(key: &[u8], blob: &[u8], digest: Option<&[u8]>) -> Result<Vec<u8>> {
    if let Some(digest) = digest {
        if !equal(&prim::sha256(blob), digest) {
            return Err(Refusal::DigestMismatch);
        }
    }
    if blob.len() <= PREFIX {
        return Err(Refusal::Truncated);
    }
    let mut running = RunningSha256::from_bytes(&[])?;
    unpad(open_part(key, &blob[..PREFIX], 0, true, &blob[PREFIX..], &mut running)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_nonces() {
        let nonce = chunk_nonce(&[9u8; 16], 0x0102_0304_0506_07, true).unwrap();
        assert_eq!(&nonce[16..], &[1, 2, 3, 4, 5, 6, 7, 1]);
        assert_eq!(chunk_nonce(&[9u8; 16], 0, false).unwrap()[23], 0);
        assert_eq!(chunk_nonce(&[9u8; 15], 0, false), Err(Refusal::Malformed));
        assert_eq!(chunk_nonce(&[9u8; 16], 1 << 56, false), Err(Refusal::Malformed));
    }

    #[test]
    fn round_trips_every_size() {
        for size in [0usize, 1, 540, 65535, 65536, 65537, 200_000] {
            let file: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let sealed = seal_attachment(&file, &[4u8; 32], &[5u8; 16]).unwrap();
            assert_eq!(sealed.blob.len() as u64, blob_length(size as u64).unwrap());
            assert_eq!(open_attachment(&sealed.key, &sealed.blob, Some(&sealed.digest)).unwrap(), file);
        }
    }

    #[test]
    fn refuses_what_was_changed() {
        let file = vec![7u8; 200_000];
        let sealed = seal_attachment(&file, &[4u8; 32], &[5u8; 16]).unwrap();
        let (key, blob) = (&sealed.key, &sealed.blob);
        assert_eq!(open_attachment(key, blob, Some(&[0u8; 32])), Err(Refusal::DigestMismatch));
        // Reordered: the second and third chunks swapped.
        let mut reordered = blob.clone();
        let (a, b) = (PREFIX + SEALED_CHUNK, PREFIX + 2 * SEALED_CHUNK);
        let second = blob[a..b].to_vec();
        reordered[a..b].copy_from_slice(&blob[b..b + SEALED_CHUNK]);
        reordered[b..b + SEALED_CHUNK].copy_from_slice(&second);
        assert_eq!(open_attachment(key, &reordered, None), Err(Refusal::NotAuthentic));
        // The last chunk dropped: the new last chunk was not sealed as last.
        let chunks = (blob.len() - PREFIX).div_ceil(SEALED_CHUNK);
        let dropped = &blob[..PREFIX + (chunks - 1) * SEALED_CHUNK];
        assert_eq!(open_attachment(key, dropped, None), Err(Refusal::NotAuthentic));
        // Cut inside a chunk or extended by a byte: the last chunk is not what
        // was sealed. Shorter than one tag is truncated.
        assert_eq!(open_attachment(key, &blob[..blob.len() - 1], None), Err(Refusal::NotAuthentic));
        let mut extended = blob.clone();
        extended.push(0);
        assert_eq!(open_attachment(key, &extended, None), Err(Refusal::NotAuthentic));
        // A last chunk of nothing but a tag's worth of bytes is truncated.
        let mut short_last = blob[..PREFIX + SEALED_CHUNK].to_vec();
        short_last.extend_from_slice(&[0u8; TAG]);
        assert_eq!(open_attachment(key, &short_last, None), Err(Refusal::Truncated));
        assert_eq!(open_attachment(key, &blob[..PREFIX + TAG], None), Err(Refusal::Truncated));
        assert_eq!(open_attachment(key, &blob[..3], None), Err(Refusal::Truncated));
        assert_eq!(open_attachment(&[1u8; 32], blob, None), Err(Refusal::NotAuthentic));
        // Given keys and prefixes must be the right length.
        assert_eq!(seal_attachment(b"x", &[1u8; 31], &[5u8; 16]).err(), Some(Refusal::Malformed));
        assert_eq!(seal_attachment(b"x", &[1u8; 32], &[5u8; 15]).err(), Some(Refusal::Malformed));
    }

    #[test]
    fn parts_put_together_are_the_whole() {
        let (key, prefix) = ([4u8; 32], [5u8; 16]);
        // Three chunks of file and the rest padding; then a file whose
        // padding runs past a part.
        for size in [3 * CHUNK_SIZE + 10, 1_400_000] {
            let file: Vec<u8> = (0..size).map(|i| (i % 253) as u8).collect();
            let whole = seal_attachment(&file, &key, &prefix).unwrap();
            let padded = bucket_size(size as u64).unwrap() as usize;
            let chunks = chunk_count(padded);
            for part in [1, 2, 16] {
                let mut blob = prefix.to_vec();
                let mut opened = Vec::new();
                let mut running = RunningSha256::from_bytes(&[]).unwrap();
                let mut reading = RunningSha256::from_bytes(&[]).unwrap();
                for first in (0..chunks).step_by(part) {
                    let count = part.min(chunks - first);
                    let range = (first * CHUNK_SIZE).min(size)..((first + count) * CHUNK_SIZE).min(size);
                    let sealed = seal_part(&key, &prefix, size as u64, first as u64, count as u64, &file[range], &mut running).unwrap();
                    let last = first + count == chunks;
                    opened.extend(open_part(&key, &prefix, first as u64, last, &sealed, &mut reading).unwrap());
                    blob.extend(sealed);
                }
                assert_eq!(blob, whole.blob);
                assert_eq!(running.finish(), whole.digest);
                assert_eq!(reading.finish(), whole.digest);
                assert_eq!(whole.digest, prim::sha256(&whole.blob));
                assert_eq!(unpad(opened).unwrap(), file);
            }
        }
    }

    #[test]
    fn refuses_parts_that_do_not_fit() {
        let (key, prefix) = ([4u8; 32], [5u8; 16]);
        let size = 3 * CHUNK_SIZE as u64;
        let fresh = || RunningSha256::from_bytes(&[]).unwrap();
        // The file's bytes for the range, exactly; a range inside the blob.
        assert_eq!(seal_part(&key, &prefix, size, 0, 1, &[0u8; 10], &mut fresh()), Err(Refusal::Malformed));
        assert_eq!(seal_part(&key, &prefix, size, 0, 0, &[], &mut fresh()), Err(Refusal::Malformed));
        assert_eq!(seal_part(&key, &prefix, size, 4, 1, &[], &mut fresh()), Err(Refusal::Malformed));
        assert_eq!(seal_part(&key, &prefix, size, u64::MAX, 2, &[], &mut fresh()), Err(Refusal::Malformed));
        assert_eq!(seal_part(&key, &prefix[..15], size, 0, 1, &[0u8; CHUNK_SIZE], &mut fresh()), Err(Refusal::Malformed));
        // The digest so far must be the prefix and every earlier chunk.
        assert_eq!(seal_part(&key, &prefix, size, 3, 1, &[], &mut fresh()), Err(Refusal::Malformed));
        let mut after_three = fresh();
        after_three.update(&vec![0u8; PREFIX + 3 * SEALED_CHUNK]).unwrap();
        // Past the end of the file, a part is padding only.
        assert!(seal_part(&key, &prefix, size, 3, 1, &[], &mut after_three).is_ok());
        let mut started = fresh();
        started.update(b"x").unwrap();
        assert_eq!(seal_part(&key, &prefix, size, 0, 1, &[1u8; CHUNK_SIZE], &mut started), Err(Refusal::Malformed));
        let sealed = seal_part(&key, &prefix, size, 0, 2, &vec![1u8; 2 * CHUNK_SIZE], &mut fresh()).unwrap();
        // A part that is not the last is whole chunks; the chunk counter, the
        // last flag and the digest so far are the part's to keep.
        assert_eq!(open_part(&key, &prefix, 0, false, &sealed[..SEALED_CHUNK + 20], &mut fresh()), Err(Refusal::Truncated));
        assert_eq!(open_part(&key, &prefix, 0, true, &sealed[..TAG], &mut fresh()), Err(Refusal::Truncated));
        assert_eq!(open_part(&key, &prefix, 0, false, &[], &mut fresh()), Err(Refusal::Truncated));
        let mut after_one = fresh();
        after_one.update(&vec![0u8; PREFIX + SEALED_CHUNK]).unwrap();
        assert_eq!(open_part(&key, &prefix, 1, false, &sealed, &mut after_one), Err(Refusal::NotAuthentic));
        assert_eq!(open_part(&key, &prefix, 1, false, &sealed, &mut fresh()), Err(Refusal::Malformed));
        assert_eq!(open_part(&key, &prefix, u64::MAX, false, &sealed, &mut fresh()), Err(Refusal::Malformed));
        assert_eq!(open_part(&key, &prefix, 0, true, &sealed, &mut fresh()), Err(Refusal::NotAuthentic));
        assert_eq!(open_part(&key, &prefix[..15], 0, false, &sealed, &mut fresh()), Err(Refusal::Malformed));
        let mut reading = fresh();
        assert_eq!(open_part(&key, &prefix, 0, false, &sealed, &mut reading).unwrap(), vec![1u8; 2 * CHUNK_SIZE]);
        let mut both = prefix.to_vec();
        both.extend_from_slice(&sealed);
        assert_eq!(reading.finish(), prim::sha256(&both));
        assert_eq!(content_end(&[0, 0x80, 0, 0]), 2);
        assert_eq!(content_end(&[0, 0]), 0);
        assert_eq!(content_end(&[]), 0);
        assert_eq!(unpad(vec![1, 2, 0]), Err(Refusal::NoPaddingMarker));
        assert_eq!(unpad(vec![0, 0]), Err(Refusal::NoPaddingMarker));
        assert_eq!(unpad(vec![1, 0x80, 0]).unwrap(), vec![1]);
    }

    #[test]
    fn an_exact_chunk_of_padding_opens() {
        // A blob whose padded content is exactly one chunk.
        let mut size = 60_000u64;
        while bucket_size(size).unwrap() < CHUNK_SIZE as u64 {
            size += 1;
        }
        let file = vec![3u8; size as usize];
        let sealed = seal_attachment(&file, &[4u8; 32], &[5u8; 16]).unwrap();
        assert_eq!(open_attachment(&sealed.key, &sealed.blob, None).unwrap(), file);
    }
}
