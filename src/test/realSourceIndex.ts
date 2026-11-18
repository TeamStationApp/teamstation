import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSourceIndex } from '../server/tess/sourceIndex/build'

/**
 * Building this checkout's index takes about 25 s, and several times that
 * under coverage, so tests in one run share one build.
 */
export const REAL_INDEX_TIMEOUT = 600000

let built:
  { out: string; result: ReturnType<typeof buildSourceIndex> } | undefined

export function realSourceIndex(): {
  out: string
  result: ReturnType<typeof buildSourceIndex>
} {
  if (built != null) return built
  const temp = mkdtempSync(join(tmpdir(), 'tess-real-index-'))
  process.once('exit', () => {
    rmSync(temp, { recursive: true, force: true })
  })
  const out = join(temp, 'source.db')
  built = { out, result: buildSourceIndex({ root: process.cwd(), out }) }
  return built
}
