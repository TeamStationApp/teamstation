/**
 * What a failed build may print. A deployment tool's output can carry the
 * credentials it was given, so nothing it wrote reaches the log until it has
 * been through `redact`: every secret this process has read from private
 * configuration or handed a tool is replaced, and so is anything shaped like
 * a credential.
 */

const secrets = new Set<string>()

/** A field whose name says it holds a credential, whatever its length. */
const secretName = /pass|secret|token|credential|auth|private|cookie|dsn/i
/** Shorter values are too common in tool output to replace safely. */
const minimumLength = 4

export function rememberSecret(value: unknown): void {
  if (typeof value === 'string' && value.length >= minimumLength)
    secrets.add(value)
}

/** Remembers every string under a credential-named field, at any depth. */
export function rememberSecrets(value: unknown, named = false): void {
  if (typeof value === 'string') {
    if (named) rememberSecret(value)
  } else if (Array.isArray(value)) {
    for (const item of value) rememberSecrets(item, named)
  } else if (value != null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      rememberSecrets(item, named || secretName.test(key))
  }
}

/** Remembers an environment's credential-named values. */
export function rememberEnvironment(env: NodeJS.ProcessEnv = {}): void {
  for (const [key, value] of Object.entries(env))
    if (secretName.test(key)) rememberSecret(value)
}

const shapes: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[redacted private key]'
  ],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[redacted]@'],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/g, '$1 [redacted]'],
  [
    /\b([\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key)[\w-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1$2[redacted]'
  ],
  [/(\s-(?:storepass|keypass)|\s--password)(\s+)\S+/g, '$1$2[redacted]']
]

export function redact(text: string): string {
  let out = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    out = out.split(secret).join('[redacted]')
  for (const [pattern, replacement] of shapes)
    out = out.replace(pattern, replacement)
  return out
}

/** The last `count` nonblank lines of `text`, redacted. */
export function redactedTail(text: string, count: number): string[] {
  return redact(text)
    .split(/\r?\n|\r/)
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .slice(-count)
}

/** For tests: forget everything remembered. */
export function forgetSecrets(): void {
  secrets.clear()
}
