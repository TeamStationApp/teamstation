// Writes the chat wake test vectors for the iOS extension's
// `ChatWakeDecryptorTests.swift`: the cases `chatWake.test.ts` opens (a wake,
// the reader's key record without its device keys, the epochs and
// identities a device would fetch, and what it should show), made with the
// real chat crypto and fresh throwaway keys each run. Nothing here is
// committed; the test run makes its own.
//
//   node -r sucrase/register scripts/pushWakeVectors.ts <out.json>
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { wakeVectors } from '../src/test/chatWakeCases'

const out = process.argv[2]
if (out == null || out === '') {
  console.error('Usage: scripts/pushWakeVectors.ts <out.json>')
  process.exit(2)
}
const path = resolve(out)
mkdirSync(dirname(path), { recursive: true })
const vectors = wakeVectors()
writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`)
console.log(`${vectors.cases.length} wake vectors written to ${path}`)
