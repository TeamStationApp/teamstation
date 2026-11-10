/** Local streaming receiver reliability tests. */
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    surface: { type: 'string' },
    case: { type: 'string' }
  }
})
assert(
  values.surface === 'tv' ||
    (values.surface === 'web' && ['gaps', 'sync'].includes(values.case ?? '')),
  'Unknown case'
)
const run =
  values.surface === 'tv'
    ? import('./streamingReliabilityTv').then(async ({ tvReliability }) => {
        await tvReliability(values.case ?? 'transport')
      })
    : import('./streamingReliabilityWeb').then(async ({ webReliability }) => {
        await webReliability(values.case!)
      })
run.catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
