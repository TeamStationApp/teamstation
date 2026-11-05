/** Local streaming receiver reliability tests. */
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    surface: { type: 'string' },
    case: { type: 'string' },
    seconds: { type: 'string', default: '3600' }
  }
})
assert(
  values.surface === 'tv' ||
    (values.surface === 'web' && values.case === 'gaps'),
  'Unknown case'
)
const seconds = Number(values.seconds)
assert(Number.isFinite(seconds) && seconds > 0 && seconds <= 3600)
const run =
  values.surface === 'tv'
    ? import('./streamingReliabilityTv').then(async ({ tvReliability }) => {
        await tvReliability(values.case ?? 'transport')
      })
    : import('./streamingReliabilityWeb').then(async ({ webReliability }) => {
          await webReliability('gaps')
        })
run.catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
