/**
 * The chat2 harness's per-call fixture control (`fixtureControl`): reads one
 * `{action, ownershipId, …}` request on stdin and answers the owned proxy's
 * JSON proof on stdout. A refusal answers `{ok: false, error}` and exits 2.
 *
 *   node -r sucrase/register src/test/chat2FixtureControl.e2e.ts <ready.json>
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

async function main(): Promise<void> {
  const file = process.argv[2]
  assert(file != null && isAbsolute(file), 'Private proxy settings required')
  const ready = JSON.parse(readFileSync(file, 'utf8')) as {
    disposable: true
    ownershipId: string
    control: string
    token: string
  }
  assert.equal(ready.disposable, true)
  const control = new URL(ready.control)
  assert.equal(control.protocol, 'http:')
  assert.equal(control.hostname, '127.0.0.1')
  assert.equal(control.pathname, '/__chat2_fixture')
  const input = JSON.parse(readFileSync(0, 'utf8')) as {
    ownershipId?: unknown
  }
  assert.equal(input.ownershipId, ready.ownershipId, 'Another ownership')
  const answer = await fetch(control, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + ready.token,
      'content-type': 'application/json'
    },
    body: JSON.stringify(input),
    redirect: 'error',
    signal: AbortSignal.timeout(55000)
  })
  const text = await answer.text()
  process.stdout.write(text)
  if (!answer.ok) process.exitCode = 2
}

main().catch((error: unknown) => {
  process.stdout.write(
    JSON.stringify({ ok: false, error: String((error as Error).message) })
  )
  process.exitCode = 2
})
