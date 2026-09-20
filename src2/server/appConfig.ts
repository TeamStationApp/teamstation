import { readFileSync } from 'node:fs'
import path from 'node:path'

import { asObject, asString } from 'cleaners'

/**
 * The repository's `config.json`.
 *
 * One address for the app server, read by everything that needs it: this
 * server, which uses it to know its own name, the tools, and the apps, which
 * carry the same file in their bundle.
 *
 * It is committed, and it is the only place the address is written down. It
 * used to be duplicated — a literal in the iOS app, a field saved on every
 * iPad, and a line in each deployment's `serverConfig.json` — and when the
 * site moved from `tube2.gamestation.co` to `gamestation.co` the copies did
 * not, so a Director spent a day asking PeerTube for its games.
 *
 * In `server/` rather than `common/`, which reads no files: this one is the
 * server's own copy of a shared fact, not a shared type.
 */
export const asAppConfig = asObject({
  /** Where the app server answers: scheme and host, no trailing slash. */
  appServerUrl: asString
})
export type AppConfig = ReturnType<typeof asAppConfig>

/**
 * Up from wherever this file was compiled to. `__dirname` is `server/` when
 * run through sucrase and `lib/server/` once built, so both are tried: the
 * file sits at the top of the tree that `deploy.sh` unpacks, beside `src2`.
 */
function candidatePaths(): string[] {
  return [
    path.join(__dirname, '..', '..', 'config.json'),
    path.join(__dirname, '..', '..', '..', 'config.json')
  ]
}

let cached: AppConfig | undefined

export function appConfig(): AppConfig {
  if (cached != null) return cached
  const tried = candidatePaths()
  for (const file of tried) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    cached = asAppConfig(JSON.parse(raw))
    return cached
  }
  throw new Error(`config.json not found; looked in ${tried.join(', ')}`)
}

/** Where the app server answers. */
export function appServerUrl(): string {
  return appConfig().appServerUrl
}
