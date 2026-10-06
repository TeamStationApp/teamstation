//! Every frozen vector of chat, byte for byte, read from the same file the
//! TypeScript's `runVectors()` reads (`src/common/chatCrypto/frozenVectors.json`),
//! with the same fixed inputs: `seed(label)` is SHA-256 of the label.

use chat_crypto::bytes::{bucket_size, join, lp, u64be};
use chat_crypto::{chain, digits, hpke, prim, seal, stream};
use serde_json::Value;

fn file() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/common/chatCrypto/frozenVectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn seed(label: &str) -> [u8; 32] {
    prim::sha256(label.as_bytes())
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

#[test]
fn bytes_vectors() {
    assert_eq!(to_hex(&lp("é🎉".as_bytes())), "00000006c3a9f09f8e89");
    assert_eq!(to_hex(&u64be(1234567890123)), "0000011f71fb04cb");
    assert_eq!(bucket_size(541).unwrap(), 569);
    assert_eq!(bucket_size(20971520).unwrap(), 21453467);
}

#[test]
fn rfc9180_a21() {
    let rfc = &file()["rfc9180A21"];
    let derived = hpke::derive_key_pair(&hex(s(rfc, "ikmE"))).unwrap();
    assert_eq!(to_hex(&derived.public_key), s(rfc, "pkEm"));
    let recipient = hpke::derive_key_pair(&hex(s(rfc, "ikmR"))).unwrap();
    assert_eq!(to_hex(&recipient.public_key), s(rfc, "pkRm"));
    assert_eq!(to_hex(&recipient.secret_key), s(rfc, "skRm"));
    let run = hpke::vector_sequence(
        &hex(s(rfc, "pkRm")),
        &hex(s(rfc, "skRm")),
        &hex(s(rfc, "info")),
        &hex(s(rfc, "ikmE")),
        &hex(s(rfc, "aad0")),
        &hex(s(rfc, "pt")),
        &[],
        32,
    )
    .unwrap();
    assert_eq!(to_hex(&run.enc), s(rfc, "pkEm"));
    assert_eq!(to_hex(&run.key), s(rfc, "key"));
    assert_eq!(to_hex(&run.base_nonce), s(rfc, "baseNonce"));
    assert_eq!(to_hex(&run.exporter_secret), s(rfc, "exporterSecret"));
    assert_eq!(to_hex(&run.ciphertext), s(rfc, "ct0"));
    assert_eq!(to_hex(&run.opened), s(rfc, "pt"));
    assert_eq!(to_hex(&run.exported), s(rfc, "exported"));
}

#[test]
fn chat_vectors() {
    let frozen = &file()["frozen"];
    let recipient = hpke::derive_key_pair(&seed("recipient")).unwrap();
    assert_eq!(to_hex(&recipient.public_key), s(frozen, "recipientPublicKey"));

    // HPKE, for each purpose, with its AAD.
    let epoch_aad = join(&[&lp(b"cnv_c1"), &u64be(7), &u64be(42), &lp(b"cid_1"), &u64be(3)]);
    let aads: [(&str, Vec<u8>); 4] = [
        ("link", join(&[&lp(b"clk_link1"), &lp(b"cdv_dev2")])),
        ("puk", join(&[&u64be(42), &lp(b"cid_1"), &u64be(3), &lp(b"cdv_dev2")])),
        ("epoch", epoch_aad.clone()),
        ("grant", epoch_aad),
    ];
    let epoch_key = seed("epoch key");
    for (purpose, aad) in &aads {
        let sealed = hpke::seal(purpose.as_bytes(), &recipient.public_key, aad, &epoch_key, Some(&seed("ephemeral"))).unwrap();
        assert_eq!(to_hex(&sealed), s(&frozen["boxes"], purpose), "HPKE {purpose}");
        let opened = hpke::open(purpose.as_bytes(), &recipient.secret_key, aad, &hex(s(&frozen["boxes"], purpose))).unwrap();
        assert_eq!(opened, epoch_key, "HPKE {purpose} open");
    }

    // Messages.
    let identity = seed("identity");
    let identity_key = prim::ed25519_public_key(&identity).unwrap();
    assert_eq!(to_hex(&identity_key), s(frozen, "identityPublicKey"));
    let fields = seal::Fields {
        conversation_id: b"cnv_c1",
        epoch: 7,
        message_id: b"msg_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        sender_user_id: 42,
        kind: b"post",
    };
    let key = seal::message_key(&epoch_key, b"cnv_c1", fields.message_id).unwrap();
    assert_eq!(to_hex(&key), s(frozen, "messageKey"));
    let plaintext = r#"{"type":"text","body":"hi 🎉","mentions":[],"attachments":[]}"#.as_bytes();
    let nonce = &seed("nonce")[..24];
    let sealed = seal::seal_message(&fields, &epoch_key, plaintext, &identity, Some(nonce)).unwrap();
    assert_eq!(to_hex(&prim::sha256(&sealed.ciphertext)), s(frozen, "sealCiphertextSha256"));
    assert_eq!(to_hex(&sealed.signature), s(frozen, "sealSignature"));
    assert!(seal::verify_message(&fields, &sealed.nonce, &sealed.ciphertext, &sealed.signature, &identity_key));
    assert_eq!(seal::open_with_message_key(&fields, &key, &sealed.nonce, &sealed.ciphertext).unwrap(), plaintext);

    // Attachments.
    let attachment_key = seed("attachment key");
    let prefix = &seed("prefix")[..16];
    let small = stream::seal_attachment(b"hello attachment", &attachment_key, prefix).unwrap();
    assert_eq!(to_hex(&small.digest), s(frozen, "streamSmallDigest"));
    let big: Vec<u8> = (0..200_000).map(|i| (i % 251) as u8).collect();
    let sealed_big = stream::seal_attachment(&big, &attachment_key, prefix).unwrap();
    assert_eq!(to_hex(&sealed_big.digest), s(frozen, "streamBigDigest"));
    assert_eq!(stream::open_attachment(&attachment_key, &sealed_big.blob, Some(&sealed_big.digest)).unwrap(), big);

    // The epoch chain.
    let epoch8 = seed("epoch 8");
    let previous = chain::seal_previous_epoch_key(b"cnv_c1", 8, &epoch8, &epoch_key, Some(nonce)).unwrap();
    assert_eq!(to_hex(&previous), s(frozen, "previousKeyBox"));
    assert_eq!(chain::open_previous_epoch_key(b"cnv_c1", 8, &epoch8, &previous).unwrap(), epoch_key);
    let signed = chain::epoch_signed_bytes(b"cnv_c1", 8, &previous);
    let epoch_signature = prim::ed25519_sign(&signed, &identity).unwrap();
    assert_eq!(to_hex(&epoch_signature), s(frozen, "epochSignature"));
    let first = prim::ed25519_sign(&chain::epoch_signed_bytes(b"cnv_c1", 1, &[]), &identity).unwrap();
    assert_eq!(to_hex(&first), s(frozen, "firstEpochSignature"));
    assert!(prim::ed25519_verify(&epoch_signature, &signed, &identity_key));
    assert!(!prim::ed25519_verify(&epoch_signature, &chain::epoch_signed_bytes(b"cnv_c1", 9, &previous), &identity_key));

    // The per-user key chain: the older keys laid out as the TypeScript does,
    // oldest first, each `u64(generation) ‖ lp(privateKey)`.
    let older = join(&[&u64be(1), &lp(&seed("puk 1")), &u64be(2), &lp(&seed("puk 2"))]);
    let previous_keys = chain::seal_previous_puk_keys(42, b"cid_1", 3, &seed("puk 3"), &older, Some(nonce)).unwrap();
    assert_eq!(to_hex(&previous_keys), s(frozen, "previousKeysBox"));
    assert_eq!(chain::open_previous_puk_keys(42, b"cid_1", 3, &seed("puk 3"), &previous_keys).unwrap(), older);
    let puk_signed = join(&[&u64be(42), &u64be(3), &lp(&recipient.public_key)]);
    let puk_signature = prim::ed25519_sign(&puk_signed, &identity).unwrap();
    assert_eq!(to_hex(&puk_signature), s(frozen, "pukSignature"));
    let other_identity = prim::ed25519_public_key(&seed("identity 7")).unwrap();
    assert!(!prim::ed25519_verify(&puk_signature, &puk_signed, &other_identity));

    // The membership log.
    let first_row = digits::log_row_hash(&[0u8; 32], b"cnv_c1", 1, b"join", 42, 0, b"", 1790000000000).unwrap();
    let second_row = digits::log_row_hash(&first_row, b"cnv_c1", 2, b"leave", 42, 7, b"notEligible", 1790000001000).unwrap();
    let hashes = frozen["logHashes"].as_array().unwrap();
    assert_eq!(to_hex(&first_row), hashes[0].as_str().unwrap());
    assert_eq!(to_hex(&second_row), hashes[1].as_str().unwrap());

    // Safety numbers (lower user id first) and link codes.
    let safety = digits::safety_half(&other_identity, 7) + &digits::safety_half(&identity_key, 42);
    assert_eq!(safety, s(frozen, "safetyNumber"));
    assert_eq!(digits::link_code(&recipient.public_key, b"clk_link1"), s(frozen, "linkCode"));
}
