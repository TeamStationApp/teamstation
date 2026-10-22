//! Prefix-disjoint account identities. Old safe integers retain their exact
//! eight bytes; newer accounts carry ff followed by all sixteen value bytes.

use crate::error::{Refusal, Result};

const LEGACY_LIMIT: u128 = 1 << 53;

/// Only the membership-log actor slot admits the eight-byte null sentinel.
pub fn parse(bytes: &[u8], nullable: bool) -> Result<u128> {
    match bytes.len() {
        8 => {
            let value = u64::from_be_bytes(bytes.try_into().map_err(|_| Refusal::Malformed)?) as u128;
            if value < LEGACY_LIMIT && (value > 0 || nullable) {
                Ok(value)
            } else {
                Err(Refusal::Malformed)
            }
        }
        17 if bytes[0] == 255 => {
            let value = u128::from_be_bytes(bytes[1..].try_into().map_err(|_| Refusal::Malformed)?);
            if value >= LEGACY_LIMIT { Ok(value) } else { Err(Refusal::Malformed) }
        }
        _ => Err(Refusal::Malformed),
    }
}

/// The caller has parsed the identity; zero is used only for a null actor.
pub fn encode(value: u128) -> Vec<u8> {
    if value < LEGACY_LIMIT {
        (value as u64).to_be_bytes().to_vec()
    } else {
        let mut out = vec![255];
        out.extend_from_slice(&value.to_be_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forms_are_canonical_and_full_width() {
        for value in [1, LEGACY_LIMIT - 1, LEGACY_LIMIT, u64::MAX as u128,
            1 << 64, (1 << 127) + 7, u128::MAX] {
            let bytes = encode(value);
            assert_eq!(bytes.len(), if value < LEGACY_LIMIT { 8 } else { 17 });
            assert_eq!(parse(&bytes, false), Ok(value));
            assert_eq!(parse(&bytes, true), Ok(value));
        }
        assert_ne!(encode((1 << 127) + 7), encode(7));
        assert_ne!(encode((1 << 127) + 7), encode((1 << 127) + 8));
        assert_eq!(parse(&[0; 8], true), Ok(0));
        assert_eq!(parse(&[0; 8], false), Err(Refusal::Malformed));
        assert_eq!(parse(&(LEGACY_LIMIT as u64).to_be_bytes(), true), Err(Refusal::Malformed));
        let mut low = vec![255];
        low.extend_from_slice(&7u128.to_be_bytes());
        assert_eq!(parse(&low, true), Err(Refusal::Malformed));
        let mut wrong_tag = encode(LEGACY_LIMIT);
        wrong_tag[0] = 1;
        assert_eq!(parse(&wrong_tag, false), Err(Refusal::Malformed));
        for bytes in [vec![], vec![0; 7], vec![0; 16], vec![255; 18]] {
            assert_eq!(parse(&bytes, false), Err(Refusal::Malformed));
        }
    }
}
