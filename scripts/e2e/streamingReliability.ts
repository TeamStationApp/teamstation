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
assert(values.surface === 'tv', 'Unknown surface')
const seconds = Number(values.seconds)
assert(Number.isFinite(seconds) && seconds > 0 && seconds <= 3600)
const run = import('./streamingReliabilityTv').then(async ({ tvReliability }) => {
  await tvReliability(values.case ?? 'transport')
})
run.catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
