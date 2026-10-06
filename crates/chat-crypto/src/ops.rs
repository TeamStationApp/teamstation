//! The core's operations, by number. Written from
//! `src/common/chatCrypto/ops.json`; `matches_ops_json` checks the two agree.

pub const SHA256: u32 = 1;
pub const RANDOM_BYTES: u32 = 2;
pub const NEW_BOX_KEY_PAIR: u32 = 3;
pub const NEW_SIGNING_KEY_PAIR: u32 = 4;
pub const BOX_PUBLIC_KEY: u32 = 5;
pub const SIGNING_PUBLIC_KEY: u32 = 6;
pub const SIGN: u32 = 7;
pub const VERIFY: u32 = 8;
pub const DERIVE_KEY_PAIR: u32 = 9;
pub const HPKE_SEAL: u32 = 10;
pub const HPKE_OPEN: u32 = 11;
pub const HPKE_VECTOR_SEQUENCE: u32 = 12;
pub const MESSAGE_KEY: u32 = 13;
pub const SEAL_MESSAGE: u32 = 14;
pub const VERIFY_MESSAGE: u32 = 15;
pub const OPEN_WITH_MESSAGE_KEY: u32 = 16;
pub const BUCKET_SIZE: u32 = 17;
pub const BLOB_LENGTH: u32 = 18;
pub const CHUNK_NONCE: u32 = 19;
pub const SEAL_ATTACHMENT_PART: u32 = 20;
pub const OPEN_ATTACHMENT_PART: u32 = 21;
pub const SEAL_PREVIOUS_EPOCH_KEY: u32 = 22;
pub const OPEN_PREVIOUS_EPOCH_KEY: u32 = 23;
pub const EPOCH_SIGNED_BYTES: u32 = 24;
pub const SEAL_PREVIOUS_PUK_KEYS: u32 = 25;
pub const OPEN_PREVIOUS_PUK_KEYS: u32 = 26;
pub const LOG_ROW_HASH: u32 = 27;
pub const SAFETY_HALF: u32 = 28;
pub const LINK_CODE: u32 = 29;
pub const NEW_MESSAGE_ID: u32 = 30;
pub const NEW_IDENTITY_ID: u32 = 31;
pub const SHA256_UPDATE: u32 = 32;
pub const SHA256_FINISH: u32 = 33;

/// Every op, as `(number, name)`.
pub const ALL: [(u32, &str); 33] = [
    (SHA256, "sha256"),
    (RANDOM_BYTES, "randomBytes"),
    (NEW_BOX_KEY_PAIR, "newBoxKeyPair"),
    (NEW_SIGNING_KEY_PAIR, "newSigningKeyPair"),
    (BOX_PUBLIC_KEY, "boxPublicKey"),
    (SIGNING_PUBLIC_KEY, "signingPublicKey"),
    (SIGN, "sign"),
    (VERIFY, "verify"),
    (DERIVE_KEY_PAIR, "deriveKeyPair"),
    (HPKE_SEAL, "hpkeSeal"),
    (HPKE_OPEN, "hpkeOpen"),
    (HPKE_VECTOR_SEQUENCE, "hpkeVectorSequence"),
    (MESSAGE_KEY, "messageKey"),
    (SEAL_MESSAGE, "sealMessage"),
    (VERIFY_MESSAGE, "verifyMessage"),
    (OPEN_WITH_MESSAGE_KEY, "openWithMessageKey"),
    (BUCKET_SIZE, "bucketSize"),
    (BLOB_LENGTH, "blobLength"),
    (CHUNK_NONCE, "chunkNonce"),
    (SEAL_ATTACHMENT_PART, "sealAttachmentPart"),
    (OPEN_ATTACHMENT_PART, "openAttachmentPart"),
    (SEAL_PREVIOUS_EPOCH_KEY, "sealPreviousEpochKey"),
    (OPEN_PREVIOUS_EPOCH_KEY, "openPreviousEpochKey"),
    (EPOCH_SIGNED_BYTES, "epochSignedBytes"),
    (SEAL_PREVIOUS_PUK_KEYS, "sealPreviousPukKeys"),
    (OPEN_PREVIOUS_PUK_KEYS, "openPreviousPukKeys"),
    (LOG_ROW_HASH, "logRowHash"),
    (SAFETY_HALF, "safetyHalf"),
    (LINK_CODE, "linkCode"),
    (NEW_MESSAGE_ID, "newMessageId"),
    (NEW_IDENTITY_ID, "newIdentityId"),
    (SHA256_UPDATE, "sha256Update"),
    (SHA256_FINISH, "sha256Finish"),
];

#[cfg(test)]
mod tests {
    #[test]
    fn matches_ops_json() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/common/chatCrypto/ops.json");
        let file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let listed: Vec<(u32, String)> = file["ops"]
            .as_array()
            .unwrap()
            .iter()
            .map(|op| (op["id"].as_u64().unwrap() as u32, op["name"].as_str().unwrap().to_string()))
            .collect();
        let ours: Vec<(u32, String)> = super::ALL.iter().map(|(id, name)| (*id, name.to_string())).collect();
        assert_eq!(ours, listed);
        let refusals: Vec<&str> = file["refusals"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
        let codes: Vec<&str> = crate::error::Refusal::ALL.iter().map(|r| r.code()).collect();
        assert_eq!(codes, refusals);
    }
}
