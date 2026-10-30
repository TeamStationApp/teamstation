/**
 * The chat crypto core's operations by name, as `ops.json` lists them
 * (`coreOps.test.ts` checks the two agree), and the refusals it gives.
 */
export const OP = {
  sha256: 1,
  randomBytes: 2,
  newBoxKeyPair: 3,
  newSigningKeyPair: 4,
  boxPublicKey: 5,
  signingPublicKey: 6,
  sign: 7,
  verify: 8,
  deriveKeyPair: 9,
  hpkeSeal: 10,
  hpkeOpen: 11,
  hpkeVectorSequence: 12,
  messageKey: 13,
  sealMessage: 14,
  verifyMessage: 15,
  openWithMessageKey: 16,
  bucketSize: 17,
  blobLength: 18,
  chunkNonce: 19,
  sealAttachmentPart: 20,
  openAttachmentPart: 21,
  sealPreviousEpochKey: 22,
  openPreviousEpochKey: 23,
  epochSignedBytes: 24,
  sealPreviousPukKeys: 25,
  openPreviousPukKeys: 26,
  logRowHash: 27,
  safetyHalf: 28,
  linkCode: 29,
  newMessageId: 30,
  newIdentityId: 31,
  sha256Update: 32,
  sha256Finish: 33,
  safetyBytes: 34
} as const

export type OpName = keyof typeof OP

export const REFUSALS = [
  'malformed',
  'unknownOp',
  'notAuthentic',
  'smallOrder',
  'truncated',
  'digestMismatch',
  'noPaddingMarker',
  'tooLarge'
] as const

export type Refusal = (typeof REFUSALS)[number]
