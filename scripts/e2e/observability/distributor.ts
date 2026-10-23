/** Exercise the debug app's real export/upload API with isolated synthetic files. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function main(): Promise<void> {
  const harness = new URL(process.env.OBSERVABILITY_DISTRIBUTOR_HARNESS!)
  assert(['localhost', '127.0.0.1', '[::1]'].includes(harness.hostname))
  const collector = new URL(process.env.OBSERVABILITY_LOG_URL!)
  assert.equal(collector.protocol, 'https:')
  const secrets = JSON.parse(
    await readFile(process.env.OBSERVABILITY_SECRETS!, 'utf8')
  )
  const started = new Date().toISOString()
  const call = async (path: string): Promise<any> => {
    const response = await fetch(new URL(path, harness))
    assert.equal(response.status, 200)
    return await response.json()
  }
  const finished = async (): Promise<any> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await call('/dump-state')
      assert.equal(state.teamStation, 'signedOut')
      assert.equal(state.devices.length, 0)
      if (state.export?.isFinished === true) return state.export.takes[0]
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.fail('Synthetic export did not finish')
  }
  assert.equal((await call('/observability-fixture')).ok, true)
  assert.equal(
    (
      await call(
        '/export?recording=1&tracks=primary,camera:fixture-camera&combined=1'
      )
    ).ok,
    true
  )
  assert.match((await finished()).combined, /^failed/)
  assert.equal((await call('/dismiss-export')).ok, true)
  assert.equal(
    (
      await call(
        '/export?recording=1&tracks=primary&upload=primary&game=gam_fixture'
      )
    ).ok,
    true
  )
  assert.match((await finished()).uploads[0].state, /^failed/)
  // The signed-out account path refuses before any real upload is attempted.
  assert.equal((await call('/dismiss-export')).ok, true)
  assert.equal((await call('/observability-fixture?uploadFailure=0')).ok, true)
  assert.equal(
    (
      await call(
        '/export?recording=1&tracks=primary&upload=primary&game=gam_fixture'
      )
    ).ok,
    false
  )
  let rows: any[] = []
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(new URL('/search', collector), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + secrets.readToken
      },
      body: JSON.stringify({
        environment: 'development',
        app: 'TS dist',
        from: started,
        to: new Date().toISOString()
      })
    })
    assert.equal(response.status, 200)
    rows = (await response.json()).hits.hits.map((hit: any) => hit._source)
    if (
      rows.filter(row => row.E === 'export_failed').length === 2 &&
      rows.some(row => row.E === 'upload_failed')
    )
      break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.equal(rows.filter(row => row.E === 'export_failed').length, 2)
  assert(rows.some(row => row.E === 'upload_failed'))
  assert(!rows.some(row => row.E === 'export_completed'))
  for (const row of rows) {
    assert.equal(Object.keys(row)[0], 'D')
    assert.equal(row.A, 'TS dist')
    assert.equal(row.N, 'development')
    assert(typeof row.V === 'string' && row.V !== '')
    assert(!JSON.stringify(row).includes('invalid synthetic video'))
  }
  console.log(
    'Distributor: actual decoder and upload failures indexed; both batches failed; signed out, no device connection, D first and no file contents'
  )
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Distributor verification failed'
  )
  process.exitCode = 1
})
