//! A private link preview inside a reportable message envelope.
use crate::bytes::{join, lp, pad, unpad};
use crate::error::{Refusal, Result};
use crate::{prim, random, seal::Fields};
use zeroize::Zeroizing;

const PURPOSE: &[u8] = b"ts-chat/v1/preview";
const MAX_PLAINTEXT: usize = 32 * 1024;

fn key(fields: &Fields, epoch_key: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if epoch_key.len() != 32 {
        return Err(Refusal::Malformed);
    }
    let context = join(&[&lp(PURPOSE), &lp(fields.message_id)]);
    Ok(Zeroizing::new(prim::hkdf(
        epoch_key,
        fields.conversation_id,
        &context,
        32,
    )?))
}

fn aad(fields: &Fields) -> Vec<u8> {
    join(&[&fields.aad(), &lp(PURPOSE), &[1]])
}

pub fn seal(
    fields: &Fields,
    epoch_key: &[u8],
    plaintext: &[u8],
    nonce: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>)> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(Refusal::TooLarge);
    }
    let nonce = match nonce {
        Some(bytes) if bytes.len() == 24 => bytes.to_vec(),
        Some(_) => return Err(Refusal::Malformed),
        None => random::bytes(24)?,
    };
    let key = key(fields, epoch_key)?;
    let padded = Zeroizing::new(pad(plaintext)?);
    let ciphertext = prim::xchacha20_poly1305_seal(&key, &nonce, &aad(fields), &padded)?;
    Ok((nonce, ciphertext))
}

pub fn open(fields: &Fields, epoch_key: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    if ciphertext.len() as u64 > crate::bytes::bucket_size(MAX_PLAINTEXT as u64)? + 16 {
        return Err(Refusal::TooLarge);
    }
    let key = key(fields, epoch_key)?;
    let padded = Zeroizing::new(prim::xchacha20_poly1305_open(
        &key,
        nonce,
        &aad(fields),
        ciphertext,
    )?);
    let plaintext = unpad(&padded)?;
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(Refusal::TooLarge);
    }
    Ok(plaintext.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seal::message_key;

    #[test]
    fn only_the_epoch_holder_can_open_the_preview_for_this_message() {
        let epoch_key = [3; 32];
        let fields = Fields {
            conversation_id: b"room",
            epoch: 1,
            message_id: b"post-a",
            sender_user_id: 42,
            kind: b"post",
        };
        let text = b"private thumbnail key";
        let (nonce, ciphertext) = seal(&fields, &epoch_key, text, None).unwrap();
        assert_eq!(
            open(&fields, &epoch_key, &nonce, &ciphertext).unwrap(),
            text
        );
        let report_key =
            message_key(&epoch_key, fields.conversation_id, fields.message_id).unwrap();
        assert!(open(&fields, &report_key, &nonce, &ciphertext).is_err());
        assert!(open(
            &Fields {
                kind: b"edit",
                ..fields
            },
            &epoch_key,
            &nonce,
            &ciphertext
        )
        .is_err());
        assert!(open(
            &Fields {
                message_id: b"post-b",
                ..fields
            },
            &epoch_key,
            &nonce,
            &ciphertext
        )
        .is_err());
        let mut changed = ciphertext.clone();
        changed[0] ^= 1;
        assert!(open(&fields, &epoch_key, &nonce, &changed).is_err());
        assert_ne!(nonce, seal(&fields, &epoch_key, text, None).unwrap().0);
        assert_eq!(
            seal(&fields, &epoch_key, text, Some(&nonce)).unwrap().1,
            ciphertext
        );
        assert!(seal(&fields, &[], text, None).is_err());
        assert!(seal(&fields, &epoch_key, text, Some(&[])).is_err());
        assert!(seal(&fields, &epoch_key, &vec![0; MAX_PLAINTEXT + 1], None).is_err());
        assert!(open(&fields, &epoch_key, &nonce, &vec![0; MAX_PLAINTEXT * 2]).is_err());
    }
}
