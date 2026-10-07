import { type Builders, options, run } from './deploy/runner'

export async function main(
  args: string[],
  builders: Builders = {}
): Promise<number> {
  let parsed
  try {
    parsed = options(args)
  } catch {
    console.error(
      'Usage: npm run deploy -- --app <identifier> --branch <branch> --platform ios,android,macos [--config <file>] [--dry-run | --publish-only <run-id>]'
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
    return await run(parsed, builders, cancel.signal)
  } catch {
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
