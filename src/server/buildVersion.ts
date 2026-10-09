import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The version a deploy stamped into `build.json`, or `undefined` for a
 * checkout nobody deployed. Read beside the working directory, then beside
 * the compiled tree, which is where the deploy writes it.
 */
export function deployedVersion(): string | undefined {
  for (const at of [
    path.join(process.cwd(), 'build.json'),
    path.join(__dirname, '..', '..', 'build.json')
  ]) {
    try {
      const read: unknown = JSON.parse(readFileSync(at, 'utf8'))
      if (
        typeof read === 'object' &&
        read !== null &&
        typeof (read as { version?: unknown }).version === 'string'
      ) {
        return (read as { version: string }).version
      }
    } catch {
      // The next place.
    }
  }
  return undefined
}

/**
 * What `/health` and the API document call this build: the deployed version,
 * and otherwise the package version, which is the honest answer for a
 * checkout.
 */
export function versionOf(): string {
  return deployedVersion() ?? '0.1.0'
}
