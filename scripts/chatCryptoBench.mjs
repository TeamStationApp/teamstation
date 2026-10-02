// The chat crypto bench in Node: the same work `ChatBenchScreen` does on a
// phone (`src/app/dev/chatBenchRun.ts`), so the two figures compare.
//
//   node scripts/chatCryptoBench.mjs [--bytes 20971520] [--wraps 1000] [--json]
//
// Seals and opens a 20 MiB buffer through `src/common/chatCrypto/stream.ts`
// and makes 1,000 HPKE wraps, after checking every frozen vector
// (`src/common/chatCrypto/vectors.ts`, `vectors ok`), then prints `stream MB/s` (the slower of seal
// and open, MB = 2^20 bytes) and `wraps/s`. With --json it prints the whole
// result as one line of JSON instead.
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const require = createRequire(import.meta.url)
require('sucrase/register')
const {
  benchLines,
  BENCH_BYTES,
  BENCH_WRAPS,
  runChatBench
} = require('../src/app/dev/chatBenchRun.ts')

const { vectorSummary } = require('../src/common/chatCrypto/vectors.ts')

const { values } = parseArgs({
  options: {
    bytes: { type: 'string', default: String(BENCH_BYTES) },
    wraps: { type: 'string', default: String(BENCH_WRAPS) },
    json: { type: 'boolean', default: false }
  }
})

const vectors = vectorSummary()
const result = runChatBench({
  bytes: Number(values.bytes),
  wraps: Number(values.wraps)
})
if (values.json) {
  console.log(JSON.stringify({ node: process.version, vectors, ...result }))
} else {
  console.log(`Node ${process.version} (${process.arch})`)
  console.log(vectors)
  for (const line of benchLines(result)) console.log(line)
}
