import { fromUtf8, utf8 } from './bytes'
import { type CoreCall, num } from './coreCall'
import vectors from './frozenVectors.json'

/** Independent HKDF-SHA256 and libsodium XChaCha20-Poly1305 known answer. */
export function runPreviewVectors(
  core: CoreCall
): Array<{ name: string; got: string; want: string; ok: boolean }> {
  const fields = [
    utf8('preview-vector-room'),
    num(1),
    utf8('preview-vector-post'),
    num(42),
    utf8('post')
  ]
  const epoch = new Uint8Array(32).fill(3)
  const text = 'private preview'
  const [nonce, box] = core('sealPreview', [
    ...fields,
    epoch,
    utf8(text),
    new Uint8Array(24).fill(5)
  ])
  const digest = Array.from(core('sha256', [box])[0], v =>
    v.toString(16).padStart(2, '0')
  ).join('')
  const opened = fromUtf8(
    core('openPreview', [...fields, epoch, nonce, box])[0]
  )
  const [report] = core('messageKey', [epoch, fields[0], fields[2]])
  let refused = 'opened'
  try {
    core('openPreview', [...fields, report, nonce, box])
  } catch {
    refused = 'refused'
  }
  return [
    [
      'private preview ciphertext',
      digest,
      vectors.frozen.previewCiphertextSha256
    ],
    ['private preview open', opened, text],
    ['preview with report key', refused, 'refused']
  ].map(([name, got, want]) => ({ name, got, want, ok: got === want }))
}
