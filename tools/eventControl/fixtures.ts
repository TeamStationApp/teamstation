import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Credentials } from './codec'

/**
 * The shared contract fixtures, read where the Swift package keeps them, so
 * there is one copy for the Swift tests and the Node reference alike.
 * `scripts/checkEventControlContract.cjs` checks every other copy against it.
 */
export const FIXTURES_DIR = join(
  __dirname,
  '../../mobile/apps/common/EventControl/Tests/Fixtures'
)

export const FIXTURE_FILES = [
  'assignments.json',
  'frames.json',
  'keys.json',
  'rejections.json',
  'scenarios.json'
]

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as T
}

interface KeyVector extends Credentials {
  name: string
  secret: string
}

/** A key from keys.json by name. */
export function fixtureCredentials(name: string): Credentials {
  const vector = fixture<{ vectors: KeyVector[] }>('keys.json').vectors.find(
    v => v.name === name
  )
  if (vector == null) throw new Error(`no key named ${name}`)
  const { issuer, userId, accountTag, keyId, key } = vector
  return { issuer, userId, accountTag, keyId, key }
}
