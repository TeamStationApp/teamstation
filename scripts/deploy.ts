import { android } from './deploy/android'
import { ios } from './deploy/apple'
import { macos } from './deploy/macos'
import { type Builders, options, run } from './deploy/runner'

export async function main(
  args: string[],
  builders: Builders = { ios, android, macos },
  workingDirectory = process.cwd()
): Promise<number> {
  let parsed
  try {
    parsed = options(args)
  } catch {
    console.error(
      'Usage: npm run deploy -- --app <identifier> --branch <branch> --platform ios,android,macos [--config <file>] --build-number-file <shared-file> [--dry-run | --publish-only <run-id>]'
    )
    return 2
  }
  const cancel = new AbortController()
  const stop = (): void => {
    cancel.abort()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    return await run(
      parsed,
      builders,
      cancel.signal,
      console.log,
      workingDirectory
    )
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'maximum build number reached',
        'A shared --build-number-file is required'
      ].includes(error.message)
    ) {
      console.error(error.message)
      return 1
    }
    console.error(
      'Deployment failed. Check private configuration, source branch and required tools.'
    )
    return 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
if (require.main === module)
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code
    })
    .catch(() => {
      process.exitCode = 1
    })
