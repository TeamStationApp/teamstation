/// Why the core refused an operation. Each crosses the ABI as its name, which
/// `src/common/chatCrypto/ops.json` lists and the TypeScript wrappers read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// A field is missing, the wrong length, or not what the op takes.
    Malformed,
    /// No op has that number.
    UnknownOp,
    /// An AEAD did not open: the wrong key, nonce or AAD, or a changed byte.
    NotAuthentic,
    /// X25519 gave the all-zero result of a small-order public key.
    SmallOrder,
    /// An attachment blob ends before its last chunk.
    Truncated,
    /// An attachment blob does not hash to its digest.
    DigestMismatch,
    /// Padded content has no `0x80` before its trailing zeros.
    NoPaddingMarker,
    /// A length beyond the largest padding bucket.
    TooLarge,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Malformed => "malformed",
            Refusal::UnknownOp => "unknownOp",
            Refusal::NotAuthentic => "notAuthentic",
            Refusal::SmallOrder => "smallOrder",
            Refusal::Truncated => "truncated",
            Refusal::DigestMismatch => "digestMismatch",
            Refusal::NoPaddingMarker => "noPaddingMarker",
            Refusal::TooLarge => "tooLarge",
        }
    }

    pub const ALL: [Refusal; 8] = [
        Refusal::Malformed,
        Refusal::UnknownOp,
        Refusal::NotAuthentic,
        Refusal::SmallOrder,
        Refusal::Truncated,
        Refusal::DigestMismatch,
        Refusal::NoPaddingMarker,
        Refusal::TooLarge,
    ];
}

pub type Result<T> = core::result::Result<T, Refusal>;
