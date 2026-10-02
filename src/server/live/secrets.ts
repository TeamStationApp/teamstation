import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'crypto'

/**
 * Sealing a secret that has to be read back.
 *
 * Almost every secret here is hashed and never recovered — a session token, an
 * API token, an e-mail code. A stream key is the exception: it is printed on a
 * screen to be copied into streaming software, so the server has to be able
 * to say it again.
 *
 * So they are sealed rather than hashed: AES-256-GCM under a key derived from
 * the server's `sessionSecret`, which means a copy of the database alone does
 * not yield a publishable key. It is not a vault — anything that can read the
 * database can usually read the config too — but it keeps the credential out
 * of backups, logs and `psql` output, which is where these things actually
 * leak from.
 *
 * Changing `sessionSecret` makes every sealed value unreadable. That is the
 * honest outcome: the keys are rotated, not recovered.
 */

const VERSION = 'v1'

function keyFor(masterSecret: string): Buffer {
  if (masterSecret === '') {
    throw new Error('sessionSecret must be set before sealing a secret')
  }
  return createHash('sha256').update(`${masterSecret}/live-secret`).digest()
}

export function sealSecret(masterSecret: string, plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(masterSecret), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url')
  ].join('.')
}

/**
 * Opens a sealed value, or throws. A caller that would rather show "this key
 * cannot be read, rotate it" than fail should catch: an unreadable seal means
 * the server's secret changed, which is not the caller's mistake to report.
 */
export function openSecret(masterSecret: string, sealed: string): string {
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Not a sealed secret')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFor(masterSecret),
    Buffer.from(parts[1], 'base64url')
  )
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], 'base64url')),
    decipher.final()
  ]).toString('utf8')
}
