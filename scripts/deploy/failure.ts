export const buildStages = [
  'builder',
  'apple.signing',
  'apple.prepare',
  'apple.archive',
  'apple.export',
  'apple.verify',
  'android.prepare',
  'android.compile',
  'android.verify',
  'sentry.dsyms',
  'sentry.source-map',
  'sentry.native-libraries',
  'package.retain'
] as const
export type BuildStage = (typeof buildStages)[number]

const validationChecks = [
  'bundle-id',
  'version',
  'build-number',
  'certificate',
  'signer-count',
  'debuggable'
] as const
export type ValidationCheck = (typeof validationChecks)[number]
export class BuildValidationFailure extends Error {
  readonly checks: ValidationCheck[]
  constructor(message: string, checks: ValidationCheck[]) {
    super(message)
    this.checks = checks.filter(check => validationChecks.includes(check))
  }
}

/** Only fixed deployment messages may leave a caught exception. */
const publicMessages = new Set([
  'Android package identity, version or signing certificate did not match',
  'Android signing and verification tools are required',
  'Android keystore must be a private regular file',
  'Android project is missing',
  'Expected one universal release APK',
  'Release APK has no bundled JavaScript',
  'Invalid profile UUID',
  'Invalid device family',
  'Invalid keychain list',
  'Signing profile identity, expiry or registered devices did not match',
  'Signing checkout must be private and owned',
  'Apple session directory must be private and owned',
  'Separate Match signing branch and Apple settings are required',
  'Existing provisioning profile differs; preserving it',
  'Match did not supply all requested profiles',
  'Unsupported property list value',
  'Invalid app executable',
  'A locked CocoaPods graph is required',
  'Apple package metadata did not match',
  'Package is missing configured architectures',
  'Wrong iOS device family',
  'Distribution certificate identity or expiry is invalid',
  'App certificate is absent from provisioning profile',
  'Release entitlements did not match provisioning',
  'Release IPA has no bundled JavaScript',
  'Extension verification must be configured before publication',
  'Expected one exported IPA',
  'Expected one IPA application',
  'Unsupported Sentry token file',
  'Sentry token file is for another server',
  'Sentry upload failed: dSYMs',
  'Sentry upload failed: source map',
  'Sentry upload failed: native libraries',
  'Sentry upload failed: no dSYMs',
  'Sentry upload failed: no bundle or source map',
  'Sentry upload failed: no native libraries',
  'Expected one built app',
  'Selected app is absent from this branch',
  'A locked JavaScript dependency graph is required',
  'Invalid or insecure deployment configuration',
  'Deployment tool failed',
  'Could not start deployment tool',
  'Deployment cancelled',
  'Deployment tool output exceeded limit',
  'Deployment state cannot use symlinks',
  'Signed build adapter is unavailable',
  'Package build number did not match allocation',
  'Missing regular artifact'
])
const systemCodes = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EEXIST',
  'EISDIR',
  'ENOTDIR',
  'EMFILE',
  'ENFILE'
])

function sourceLocation(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return ''
  const header = `${error.name}: ${error.message}\n`
  if (!error.stack.startsWith(header)) return ''
  // Strip the entire message before reading frames, including any newlines
  // in a private input. Only known repository filenames and line numbers leave.
  const frame =
    /\/scripts\/deploy\/(apple|android|sentry|prepare|config|state)\.ts:(\d{1,6}):\d+/.exec(
      error.stack.slice(header.length)
    )
  return frame == null
    ? ''
    : `; source: scripts/deploy/${frame[1]}.ts:${frame[2]}`
}

export function buildFailureReason(error: unknown): string {
  if (error instanceof Error && publicMessages.has(error.message)) {
    if (error instanceof BuildValidationFailure) {
      const checks = error.checks.filter(check =>
        validationChecks.includes(check)
      )
      if (checks.length > 0)
        return `${error.message}; failed checks: ${checks.join(', ')}`
    }
    return error.message
  }
  if (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    systemCodes.has(error.code)
  )
    return `Build filesystem operation failed (${error.code})`
  // Cleaner and filesystem errors may contain credentials or whole private
  // objects. Neither arbitrary messages nor stacks are safe to log.
  return (
    'Unexpected build validation error; private details withheld' +
    sourceLocation(error)
  )
}
