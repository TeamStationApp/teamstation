import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  sign as nodeSign,
  verify as nodeVerify
} from 'node:crypto'

/**
 * Node's own crypto, as the oracle the chat crypto tests check the core
 * against: an implementation that shares no code with RustCrypto. Node has
 * no XChaCha20-Poly1305, so its HChaCha20 step is written out here (checked
 * against the draft's own vector) in front of Node's ChaCha20-Poly1305. HPKE
 * is checked against the RFC's and frozen hex.
 *
 * Raw 32-byte X25519 and Ed25519 keys go in and out through the fixed DER
 * prefixes of their PKCS#8 and SPKI forms.
 */

const PKCS8 = {
  x25519: '302e020100300506032b656e04220420',
  ed25519: '302e020100300506032b657004220420'
}
const SPKI = {
  x25519: '302a300506032b656e032100',
  ed25519: '302a300506032b6570032100'
}

type Curve = keyof typeof PKCS8

const bytes = (buffer: Buffer): Uint8Array => new Uint8Array(buffer)

function privateKey(
  curve: Curve,
  secret: Uint8Array
): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from(PKCS8[curve], 'hex'), secret]),
    format: 'der',
    type: 'pkcs8'
  })
}

function publicKey(
  curve: Curve,
  raw: Uint8Array
): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([Buffer.from(SPKI[curve], 'hex'), raw]),
    format: 'der',
    type: 'spki'
  })
}

function rawPublic(curve: Curve, secret: Uint8Array): Uint8Array {
  const der = createPublicKey(privateKey(curve, secret)).export({
    format: 'der',
    type: 'spki'
  })
  return bytes(der.subarray(der.length - 32))
}

/**
 * HChaCha20 (draft-irtf-cfrg-xchacha §2.2), the one piece of
 * XChaCha20-Poly1305 Node does not have: twenty ChaCha rounds over the key
 * and the nonce's first 16 bytes, keeping words 0–3 and 12–15.
 */
function hchacha20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  const word = (bytes: Uint8Array, at: number): number =>
    (bytes[at] |
      (bytes[at + 1] << 8) |
      (bytes[at + 2] << 16) |
      (bytes[at + 3] << 24)) >>>
    0
  const x = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
  for (let i = 0; i < 8; i++) x.push(word(key, 4 * i))
  for (let i = 0; i < 4; i++) x.push(word(nonce16, 4 * i))
  const rotl = (v: number, n: number): number =>
    ((v << n) | (v >>> (32 - n))) >>> 0
  const quarter = (a: number, b: number, c: number, d: number): void => {
    x[a] = (x[a] + x[b]) >>> 0
    x[d] = rotl(x[d] ^ x[a], 16)
    x[c] = (x[c] + x[d]) >>> 0
    x[b] = rotl(x[b] ^ x[c], 12)
    x[a] = (x[a] + x[b]) >>> 0
    x[d] = rotl(x[d] ^ x[a], 8)
    x[c] = (x[c] + x[d]) >>> 0
    x[b] = rotl(x[b] ^ x[c], 7)
  }
  for (let round = 0; round < 10; round++) {
    quarter(0, 4, 8, 12)
    quarter(1, 5, 9, 13)
    quarter(2, 6, 10, 14)
    quarter(3, 7, 11, 15)
    quarter(0, 5, 10, 15)
    quarter(1, 6, 11, 12)
    quarter(2, 7, 8, 13)
    quarter(3, 4, 9, 14)
  }
  const out = new Uint8Array(32)
  const view = new DataView(out.buffer)
  ;[0, 1, 2, 3, 12, 13, 14, 15].forEach((index, i) => {
    view.setUint32(4 * i, x[index], true)
  })
  return out
}

/** XChaCha20-Poly1305's key and nonce as ChaCha20-Poly1305's. */
function xchacha(
  key: Uint8Array,
  nonce: Uint8Array
): { key: Uint8Array; nonce: Uint8Array } {
  const short = new Uint8Array(12)
  short.set(nonce.subarray(16, 24), 4)
  return { key: hchacha20(key, nonce.subarray(0, 16)), nonce: short }
}

export const oracle = {
  sha256: (data: Uint8Array): Uint8Array =>
    bytes(createHash('sha256').update(data).digest()),
  sha512: (data: Uint8Array): Uint8Array =>
    bytes(createHash('sha512').update(data).digest()),
  hmacSha256: (key: Uint8Array, data: Uint8Array): Uint8Array =>
    bytes(createHmac('sha256', key).update(data).digest()),
  hkdf: (
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number
  ): Uint8Array => new Uint8Array(hkdfSync('sha256', ikm, salt, info, length)),
  x25519PublicKey: (secret: Uint8Array): Uint8Array =>
    rawPublic('x25519', secret),
  x25519: (secret: Uint8Array, peer: Uint8Array): Uint8Array =>
    bytes(
      diffieHellman({
        privateKey: privateKey('x25519', secret),
        publicKey: publicKey('x25519', peer)
      })
    ),
  ed25519PublicKey: (seed: Uint8Array): Uint8Array =>
    rawPublic('ed25519', seed),
  ed25519Sign: (message: Uint8Array, seed: Uint8Array): Uint8Array =>
    bytes(nodeSign(null, message, privateKey('ed25519', seed))),
  ed25519Verify: (
    signature: Uint8Array,
    message: Uint8Array,
    raw: Uint8Array
  ): boolean => nodeVerify(null, message, publicKey('ed25519', raw), signature),
  chacha20Poly1305Seal: (
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array
  ): Uint8Array => {
    const cipher = createCipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: 16
    })
    cipher.setAAD(aad, { plaintextLength: plaintext.length })
    return bytes(
      Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag()
      ])
    )
  },
  chacha20Poly1305Open: (
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    sealed: Uint8Array
  ): Uint8Array => {
    const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: 16
    })
    decipher.setAAD(aad, { plaintextLength: sealed.length - 16 })
    decipher.setAuthTag(sealed.subarray(sealed.length - 16))
    return bytes(
      Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final()
      ])
    )
  },
  hchacha20,
  xchacha20Poly1305Seal: (
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array
  ): Uint8Array => {
    const inner = xchacha(key, nonce)
    return oracle.chacha20Poly1305Seal(inner.key, inner.nonce, aad, plaintext)
  },
  xchacha20Poly1305Open: (
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    sealed: Uint8Array
  ): Uint8Array => {
    const inner = xchacha(key, nonce)
    return oracle.chacha20Poly1305Open(inner.key, inner.nonce, aad, sealed)
  }
}

export const hex = (data: Uint8Array): string =>
  Buffer.from(data).toString('hex')

export const fromHex = (text: string): Uint8Array =>
  Uint8Array.from(Buffer.from(text.replace(/\s+/g, ''), 'hex'))

/** SHA-256 of a label's UTF-8: the fixed inputs of every vector. */
export const seed = (label: string): Uint8Array =>
  oracle.sha256(Buffer.from(label, 'utf8'))
