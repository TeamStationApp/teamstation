//! The one entry point every platform calls: an op number and its arguments
//! as length-prefixed fields in, a status byte and length-prefixed results
//! out.
//!
//! - In: each argument as `u32 big-endian length ‖ bytes`. Numbers are 8
//!   bytes big-endian, a flag 1 byte (0 or 1), and an optional argument that
//!   is absent is empty.
//! - Out: `0 ‖ results`, each length-prefixed, or `1 ‖ reason`, the
//!   refusal's name in ASCII.
//!
//! Nothing panics across the boundary: malformed input is a refusal.

use zeroize::Zeroize;

use crate::error::{Refusal, Result};
use crate::{chain, digits, hpke, keys, ops, prim, random, seal, stream, user_id};

struct Args<'a> {
    fields: Vec<&'a [u8]>,
}

impl<'a> Args<'a> {
    fn parse(input: &'a [u8]) -> Result<Args<'a>> {
        let mut fields = Vec::new();
        let mut at = 0usize;
        while at < input.len() {
            let header = input.get(at..at + 4).ok_or(Refusal::Malformed)?;
            let length = u32::from_be_bytes(header.try_into().expect("4 bytes")) as usize;
            let start = at + 4;
            let end = start.checked_add(length).ok_or(Refusal::Malformed)?;
            fields.push(input.get(start..end).ok_or(Refusal::Malformed)?);
            at = end;
        }
        Ok(Args { fields })
    }

    fn count(&self, wanted: usize) -> Result<()> {
        if self.fields.len() == wanted {
            Ok(())
        } else {
            Err(Refusal::Malformed)
        }
    }

    fn bytes(&self, index: usize) -> &'a [u8] {
        self.fields[index]
    }

    fn optional(&self, index: usize) -> Option<&'a [u8]> {
        let field = self.fields[index];
        (!field.is_empty()).then_some(field)
    }

    fn number(&self, index: usize) -> Result<u64> {
        Ok(u64::from_be_bytes(self.fields[index].try_into().map_err(|_| Refusal::Malformed)?))
    }

    fn identity(&self, index: usize, nullable: bool) -> Result<u128> {
        user_id::parse(self.fields[index], nullable)
    }

    fn flag(&self, index: usize) -> Result<bool> {
        match self.fields[index] {
            [0] => Ok(false),
            [1] => Ok(true),
            _ => Err(Refusal::Malformed),
        }
    }
}

fn number(value: u64) -> Vec<u8> {
    value.to_be_bytes().to_vec()
}

fn flag(value: bool) -> Vec<u8> {
    vec![u8::from(value)]
}

fn size(value: u64) -> Result<usize> {
    usize::try_from(value).map_err(|_| Refusal::TooLarge)
}

/// The results of one op, or why it was refused.
pub fn dispatch(op: u32, input: &[u8]) -> Result<Vec<Vec<u8>>> {
    let args = Args::parse(input)?;
    let a = &args;
    match op {
        ops::SHA256 => {
            a.count(1)?;
            Ok(vec![prim::sha256(a.bytes(0)).to_vec()])
        }
        ops::SHA256_UPDATE => {
            a.count(2)?;
            let mut running = prim::RunningSha256::from_bytes(a.bytes(0))?;
            running.update(a.bytes(1))?;
            Ok(vec![running.to_bytes()])
        }
        ops::SHA256_FINISH => {
            a.count(1)?;
            Ok(vec![prim::RunningSha256::from_bytes(a.bytes(0))?.finish().to_vec()])
        }
        ops::RANDOM_BYTES => {
            a.count(1)?;
            let length = a.number(0)?;
            // Nothing asks for more than a key's worth; a huge length is refused, not
            // allocated.
            if length > 1 << 20 {
                return Err(Refusal::TooLarge);
            }
            Ok(vec![random::bytes(size(length)?)?])
        }
        ops::NEW_BOX_KEY_PAIR => {
            a.count(0)?;
            let pair = keys::new_box_key_pair()?;
            Ok(vec![pair.secret_key.to_vec(), pair.public_key.to_vec()])
        }
        ops::NEW_SIGNING_KEY_PAIR => {
            a.count(0)?;
            let pair = keys::new_signing_key_pair()?;
            Ok(vec![pair.secret_key.to_vec(), pair.public_key.to_vec()])
        }
        ops::BOX_PUBLIC_KEY => {
            a.count(1)?;
            Ok(vec![prim::x25519_public_key(a.bytes(0))?.to_vec()])
        }
        ops::SIGNING_PUBLIC_KEY => {
            a.count(1)?;
            Ok(vec![prim::ed25519_public_key(a.bytes(0))?.to_vec()])
        }
        ops::SIGN => {
            a.count(2)?;
            Ok(vec![prim::ed25519_sign(a.bytes(0), a.bytes(1))?.to_vec()])
        }
        ops::VERIFY => {
            a.count(3)?;
            Ok(vec![flag(prim::ed25519_verify(a.bytes(0), a.bytes(1), a.bytes(2)))])
        }
        ops::DERIVE_KEY_PAIR => {
            a.count(1)?;
            let pair = hpke::derive_key_pair(a.bytes(0))?;
            Ok(vec![pair.secret_key.to_vec(), pair.public_key.to_vec()])
        }
        ops::HPKE_SEAL => {
            a.count(5)?;
            Ok(vec![hpke::seal(a.bytes(0), a.bytes(1), a.bytes(2), a.bytes(3), a.optional(4))?])
        }
        ops::HPKE_OPEN => {
            a.count(4)?;
            Ok(vec![hpke::open(a.bytes(0), a.bytes(1), a.bytes(2), a.bytes(3))?])
        }
        ops::HPKE_VECTOR_SEQUENCE => {
            a.count(8)?;
            let run = hpke::vector_sequence(a.bytes(0), a.bytes(1), a.bytes(2), a.bytes(3), a.bytes(4), a.bytes(5), a.bytes(6), size(a.number(7)?)?)?;
            Ok(vec![run.enc, run.key, run.base_nonce, run.exporter_secret, run.ciphertext, run.opened, run.exported])
        }
        ops::MESSAGE_KEY => {
            a.count(3)?;
            Ok(vec![seal::message_key(a.bytes(0), a.bytes(1), a.bytes(2))?])
        }
        ops::SEAL_MESSAGE => {
            a.count(9)?;
            let fields = message_fields(a)?;
            let sealed = seal::seal_message(&fields, a.bytes(5), a.bytes(6), a.bytes(7), a.optional(8))?;
            Ok(vec![sealed.nonce, sealed.ciphertext, sealed.signature])
        }
        ops::VERIFY_MESSAGE => {
            a.count(9)?;
            let fields = message_fields(a)?;
            Ok(vec![flag(seal::verify_message(&fields, a.bytes(5), a.bytes(6), a.bytes(7), a.bytes(8)))])
        }
        ops::OPEN_WITH_MESSAGE_KEY => {
            a.count(8)?;
            let fields = message_fields(a)?;
            Ok(vec![seal::open_with_message_key(&fields, a.bytes(5), a.bytes(6), a.bytes(7))?])
        }
        ops::BUCKET_SIZE => {
            a.count(1)?;
            Ok(vec![number(crate::bytes::bucket_size(a.number(0)?)?)])
        }
        ops::BLOB_LENGTH => {
            a.count(1)?;
            Ok(vec![number(stream::blob_length(a.number(0)?)?)])
        }
        ops::CHUNK_NONCE => {
            a.count(3)?;
            Ok(vec![stream::chunk_nonce(a.bytes(0), a.number(1)?, a.flag(2)?)?.to_vec()])
        }
        ops::SEAL_ATTACHMENT_PART => {
            a.count(7)?;
            let mut digest = prim::RunningSha256::from_bytes(a.bytes(6))?;
            let sealed = stream::seal_part(a.bytes(0), a.bytes(1), a.number(2)?, a.number(3)?, a.number(4)?, a.bytes(5), &mut digest)?;
            Ok(vec![sealed, digest.to_bytes()])
        }
        ops::OPEN_ATTACHMENT_PART => {
            a.count(6)?;
            let mut digest = prim::RunningSha256::from_bytes(a.bytes(5))?;
            let padded = stream::open_part(a.bytes(0), a.bytes(1), a.number(2)?, a.flag(3)?, a.bytes(4), &mut digest)?;
            let end = stream::content_end(&padded);
            Ok(vec![padded, number(end), digest.to_bytes()])
        }
        ops::SEAL_PREVIOUS_EPOCH_KEY => {
            a.count(5)?;
            Ok(vec![chain::seal_previous_epoch_key(a.bytes(0), a.number(1)?, a.bytes(2), a.bytes(3), a.optional(4))?])
        }
        ops::OPEN_PREVIOUS_EPOCH_KEY => {
            a.count(4)?;
            Ok(vec![chain::open_previous_epoch_key(a.bytes(0), a.number(1)?, a.bytes(2), a.bytes(3))?])
        }
        ops::EPOCH_SIGNED_BYTES => {
            a.count(3)?;
            Ok(vec![chain::epoch_signed_bytes(a.bytes(0), a.number(1)?, a.bytes(2))])
        }
        ops::SEAL_PREVIOUS_PUK_KEYS => {
            a.count(6)?;
            Ok(vec![chain::seal_previous_puk_keys(a.identity(0, false)?, a.bytes(1), a.number(2)?, a.bytes(3), a.bytes(4), a.optional(5))?])
        }
        ops::OPEN_PREVIOUS_PUK_KEYS => {
            a.count(5)?;
            Ok(vec![chain::open_previous_puk_keys(a.identity(0, false)?, a.bytes(1), a.number(2)?, a.bytes(3), a.bytes(4))?])
        }
        ops::LOG_ROW_HASH => {
            a.count(8)?;
            let hash = digits::log_row_hash(a.bytes(0), a.bytes(1), a.number(2)?, a.bytes(3), a.identity(4, false)?, a.identity(5, true)?, a.bytes(6), a.number(7)?)?;
            Ok(vec![hash.to_vec()])
        }
        ops::SAFETY_HALF => {
            a.count(2)?;
            Ok(vec![digits::safety_half(a.bytes(0), a.identity(1, false)?).into_bytes()])
        }
        ops::SAFETY_BYTES => {
            a.count(2)?;
            Ok(vec![digits::safety_bytes(a.bytes(0), a.identity(1, false)?)])
        }
        ops::LINK_CODE => {
            a.count(2)?;
            Ok(vec![digits::link_code(a.bytes(0), a.bytes(1)).into_bytes()])
        }
        ops::NEW_MESSAGE_ID => {
            a.count(0)?;
            Ok(vec![digits::new_message_id()?.into_bytes()])
        }
        ops::NEW_IDENTITY_ID => {
            a.count(0)?;
            Ok(vec![digits::new_identity_id()?.into_bytes()])
        }
        _ => Err(Refusal::UnknownOp),
    }
}

fn message_fields<'a>(a: &Args<'a>) -> Result<seal::Fields<'a>> {
    Ok(seal::Fields {
        conversation_id: a.bytes(0),
        epoch: a.number(1)?,
        message_id: a.bytes(2),
        sender_user_id: a.identity(3, false)?,
        kind: a.bytes(4),
    })
}

/// `dispatch`, encoded for the wire.
pub fn call_bytes(op: u32, input: &[u8]) -> Vec<u8> {
    match dispatch(op, input) {
        Ok(mut results) => {
            // Sized once, so no half-grown buffer is left behind unzeroed.
            let length = 1 + results.iter().map(|result| 4 + result.len()).sum::<usize>();
            let mut out = Vec::with_capacity(length);
            out.push(0u8);
            for result in &mut results {
                out.extend_from_slice(&(result.len() as u32).to_be_bytes());
                out.extend_from_slice(result);
                result.zeroize();
            }
            out
        }
        Err(refusal) => {
            let mut out = vec![1u8];
            out.extend_from_slice(refusal.code().as_bytes());
            out
        }
    }
}

/// Hands `bytes` to the caller, who frees them with `chat_crypto_free`.
fn hand_over(bytes: Vec<u8>, out: *mut *mut u8, out_len: *mut usize) {
    let boxed = bytes.into_boxed_slice();
    let length = boxed.len();
    let pointer = Box::into_raw(boxed) as *mut u8;
    // SAFETY: the caller passes two writable out-pointers.
    unsafe {
        *out = pointer;
        *out_len = length;
    }
}

/// # Safety
///
/// `input` points at `input_len` readable bytes (or is null with a length of
/// zero); `out` and `out_len` are writable. The result is freed with
/// `chat_crypto_free(*out, *out_len)`.
#[no_mangle]
pub unsafe extern "C" fn chat_crypto_call(op: u32, input: *const u8, input_len: usize, out: *mut *mut u8, out_len: *mut usize) -> i32 {
    let input = if input_len == 0 {
        &[][..]
    } else {
        // SAFETY: see the function's contract.
        unsafe { core::slice::from_raw_parts(input, input_len) }
    };
    hand_over(call_bytes(op, input), out, out_len);
    0
}

/// # Safety
///
/// `pointer` and `length` are exactly what `chat_crypto_call` or
/// `chat_crypto_alloc` handed out, and they are freed once.
#[no_mangle]
pub unsafe extern "C" fn chat_crypto_free(pointer: *mut u8, length: usize) {
    if pointer.is_null() {
        return;
    }
    // SAFETY: see the function's contract.
    let mut boxed = unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(pointer, length)) };
    boxed.zeroize();
}

/// Room for `length` bytes the caller fills: the WASM loader writes a call's
/// input here, then frees it with `chat_crypto_free`.
#[no_mangle]
pub extern "C" fn chat_crypto_alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; length].into_boxed_slice()) as *mut u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::{join, lp};

    fn input(fields: &[&[u8]]) -> Vec<u8> {
        join(&fields.iter().map(|field| lp(field)).collect::<Vec<_>>().iter().map(|f| f.as_slice()).collect::<Vec<_>>())
    }

    fn results(bytes: &[u8]) -> Vec<Vec<u8>> {
        assert_eq!(bytes[0], 0, "refused: {}", String::from_utf8_lossy(&bytes[1..]));
        let mut out = Vec::new();
        let mut at = 1;
        while at < bytes.len() {
            let length = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
            out.push(bytes[at + 4..at + 4 + length].to_vec());
            at += 4 + length;
        }
        out
    }

    fn refusal(bytes: &[u8]) -> String {
        assert_eq!(bytes[0], 1);
        String::from_utf8(bytes[1..].to_vec()).unwrap()
    }

    fn n(value: u64) -> [u8; 8] {
        value.to_be_bytes()
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        assert_eq!(refusal(&call_bytes(999, &[])), "unknownOp");
        assert_eq!(refusal(&call_bytes(ops::SHA256, &[0, 0])), "malformed");
        assert_eq!(refusal(&call_bytes(ops::SHA256, &[0, 0, 0, 5, 1])), "malformed");
        assert_eq!(refusal(&call_bytes(ops::SHA256, &input(&[b"a", b"b"]))), "malformed");
        assert_eq!(refusal(&call_bytes(ops::RANDOM_BYTES, &input(&[&[1, 2]]))), "malformed");
        assert_eq!(refusal(&call_bytes(ops::RANDOM_BYTES, &input(&[&n(1 << 31)]))), "tooLarge");
        assert_eq!(refusal(&call_bytes(ops::RANDOM_BYTES, &input(&[&n((1 << 20) + 1)]))), "tooLarge");
        // An export longer than HKDF can give is refused before anything is
        // allocated, never an abort.
        let pair = prim::x25519_public_key(&[7u8; 32]).unwrap();
        let sequence = |length: u64| {
            call_bytes(
                ops::HPKE_VECTOR_SEQUENCE,
                &input(&[&pair, &[7u8; 32], b"info", &[9u8; 32], b"aad", b"pt", b"", &n(length)]),
            )
        };
        assert_eq!(refusal(&sequence(1 << 40)), "tooLarge");
        assert_eq!(refusal(&sequence(255 * 32 + 1)), "tooLarge");
        assert_eq!(results(&sequence(255 * 32))[6].len(), 255 * 32);
        assert_eq!(refusal(&call_bytes(ops::CHUNK_NONCE, &input(&[&[0u8; 16], &n(0), &[2]]))), "malformed");
        assert_eq!(refusal(&call_bytes(ops::BUCKET_SIZE, &input(&[&n(u64::MAX)]))), "tooLarge");
        let mut overflow = vec![0xff, 0xff, 0xff, 0xff];
        overflow.extend_from_slice(&[0u8; 3]);
        assert_eq!(refusal(&call_bytes(ops::SHA256, &overflow)), "malformed");
    }

    #[test]
    fn every_op_answers() {
        let one = |op: u32, fields: &[&[u8]]| results(&call_bytes(op, &input(fields)));
        assert_eq!(one(ops::SHA256, &[b"abc"])[0], prim::sha256(b"abc"));
        assert_eq!(one(ops::RANDOM_BYTES, &[&n(65536 * 2 + 5)])[0].len(), 65536 * 2 + 5);
        let boxes = one(ops::NEW_BOX_KEY_PAIR, &[]);
        assert_eq!(one(ops::BOX_PUBLIC_KEY, &[&boxes[0]])[0], boxes[1]);
        let signing = one(ops::NEW_SIGNING_KEY_PAIR, &[]);
        assert_eq!(one(ops::SIGNING_PUBLIC_KEY, &[&signing[0]])[0], signing[1]);
        let signature = one(ops::SIGN, &[b"m", &signing[0]])[0].clone();
        assert_eq!(one(ops::VERIFY, &[&signature, b"m", &signing[1]])[0], vec![1]);
        assert_eq!(one(ops::VERIFY, &[&signature, b"n", &signing[1]])[0], vec![0]);
        let derived = one(ops::DERIVE_KEY_PAIR, &[b"ikm"]);
        let sealed = one(ops::HPKE_SEAL, &[b"epoch", &derived[1], b"aad", b"key", b""])[0].clone();
        assert_eq!(one(ops::HPKE_OPEN, &[b"epoch", &derived[0], b"aad", &sealed])[0], b"key");
        assert_eq!(refusal(&call_bytes(ops::HPKE_OPEN, &input(&[b"grant", &derived[0], b"aad", &sealed]))), "notAuthentic");
        let run = one(ops::HPKE_VECTOR_SEQUENCE, &[&derived[1], &derived[0], b"info", b"ikmE", b"aad", b"pt", b"", &n(32)]);
        assert_eq!(run.len(), 7);
        assert_eq!(run[5], b"pt");
        let key = one(ops::MESSAGE_KEY, &[&[1u8; 32], b"cnv", b"msg"])[0].clone();
        let fields: [&[u8]; 5] = [b"cnv", &n(3), b"msg", &n(42), b"post"];
        let mut seal_args: Vec<&[u8]> = fields.to_vec();
        let epoch_key = [1u8; 32];
        seal_args.extend_from_slice(&[&epoch_key, b"hi", &signing[0], b""]);
        let sealed = one(ops::SEAL_MESSAGE, &seal_args);
        let mut verify_args: Vec<&[u8]> = fields.to_vec();
        verify_args.extend_from_slice(&[&sealed[0], &sealed[1], &sealed[2], &signing[1]]);
        assert_eq!(one(ops::VERIFY_MESSAGE, &verify_args)[0], vec![1]);
        let mut open_args: Vec<&[u8]> = fields.to_vec();
        open_args.extend_from_slice(&[&key, &sealed[0], &sealed[1]]);
        assert_eq!(one(ops::OPEN_WITH_MESSAGE_KEY, &open_args)[0], b"hi");
        assert_eq!(one(ops::BUCKET_SIZE, &[&n(541)])[0], n(569));
        assert_eq!(one(ops::BLOB_LENGTH, &[&n(0)])[0], n(16 + 541 + 16));
        assert_eq!(one(ops::CHUNK_NONCE, &[&[0u8; 16], &n(1), &[1]])[0][16..], [0, 0, 0, 0, 0, 0, 1, 1]);
        let file = vec![6u8; 70_000];
        let size = n(70_000);
        let part = one(ops::SEAL_ATTACHMENT_PART, &[&[4u8; 32], &[5u8; 16], &size, &n(0), &n(2), &file, b""]);
        let whole = stream::seal_attachment(&file, &[4u8; 32], &[5u8; 16]).unwrap();
        let sealed = part[0].clone();
        assert_eq!(sealed, whole.blob[16..]);
        assert_eq!(one(ops::SHA256_FINISH, &[&part[1]])[0], whole.digest);
        let opened = one(ops::OPEN_ATTACHMENT_PART, &[&[4u8; 32], &[5u8; 16], &n(0), &[1], &sealed, b""]);
        assert_eq!(opened[1], n(70_001));
        assert_eq!(one(ops::SHA256_FINISH, &[&opened[2]])[0], whole.digest);
        assert_eq!(stream::unpad(opened[0].clone()).unwrap(), file);
        assert_eq!(refusal(&call_bytes(ops::OPEN_ATTACHMENT_PART, &input(&[&[4u8; 32], &[5u8; 16], &n(0), &[0], &sealed, b""]))), "truncated");
        let state = one(ops::SHA256_UPDATE, &[b"", b"ab"])[0].clone();
        let state = one(ops::SHA256_UPDATE, &[&state, b"c"])[0].clone();
        assert_eq!(one(ops::SHA256_FINISH, &[&state])[0], prim::sha256(b"abc"));
        assert_eq!(refusal(&call_bytes(ops::SHA256_FINISH, &input(&[&[1u8; 20]]))), "malformed");
        let previous = one(ops::SEAL_PREVIOUS_EPOCH_KEY, &[b"cnv", &n(2), &[1u8; 32], &[2u8; 32], b""])[0].clone();
        assert_eq!(one(ops::OPEN_PREVIOUS_EPOCH_KEY, &[b"cnv", &n(2), &[1u8; 32], &previous])[0], [2u8; 32]);
        assert_eq!(one(ops::EPOCH_SIGNED_BYTES, &[b"cnv", &n(2), &previous])[0].len(), 4 + 3 + 8 + 32);
        let older = one(ops::SEAL_PREVIOUS_PUK_KEYS, &[&n(42), b"cid", &n(3), &[5u8; 32], b"older", b""])[0].clone();
        assert_eq!(one(ops::OPEN_PREVIOUS_PUK_KEYS, &[&n(42), b"cid", &n(3), &[5u8; 32], &older])[0], b"older");
        assert_eq!(one(ops::LOG_ROW_HASH, &[&[0u8; 32], b"cnv", &n(1), b"join", &n(42), &n(0), b"", &n(5)])[0].len(), 32);
        assert_eq!(one(ops::SAFETY_HALF, &[&[1u8; 32], &n(7)])[0].len(), 30);
        assert_eq!(one(ops::SAFETY_BYTES, &[&[1u8; 32], &n(7)])[0],
            vec![0x6b, 0x0f, 0xc9, 0x0c, 0x5c, 0x18, 0x00, 0x62, 0x3d, 0x00, 0xe2]);
        assert_eq!(refusal(&call_bytes(ops::SAFETY_BYTES, &input(&[&[1u8; 32]]))), "malformed");
        assert_eq!(one(ops::LINK_CODE, &[&[1u8; 32], b"clk"])[0].len(), 6);
        assert!(one(ops::NEW_MESSAGE_ID, &[])[0].starts_with(b"msg_"));
        assert!(one(ops::NEW_IDENTITY_ID, &[])[0].starts_with(b"cid_"));
    }

    #[test]
    fn the_c_entry_points_hand_over_and_take_back() {
        let data = input(&[b"abc"]);
        let mut out: *mut u8 = core::ptr::null_mut();
        let mut out_len = 0usize;
        // SAFETY: valid input and out-pointers.
        let status = unsafe { chat_crypto_call(ops::SHA256, data.as_ptr(), data.len(), &mut out, &mut out_len) };
        assert_eq!(status, 0);
        // SAFETY: the call handed out exactly this.
        let answer = unsafe { core::slice::from_raw_parts(out, out_len) }.to_vec();
        unsafe { chat_crypto_free(out, out_len) };
        assert_eq!(results(&answer)[0], prim::sha256(b"abc"));
        // No input at all, through a null pointer.
        let status = unsafe { chat_crypto_call(ops::NEW_MESSAGE_ID, core::ptr::null(), 0, &mut out, &mut out_len) };
        assert_eq!(status, 0);
        unsafe { chat_crypto_free(out, out_len) };
        let room = chat_crypto_alloc(16);
        assert!(!room.is_null());
        unsafe { chat_crypto_free(room, 16) };
        unsafe { chat_crypto_free(core::ptr::null_mut(), 0) };
    }
}
