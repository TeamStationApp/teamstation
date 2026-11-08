import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import type { ConcurrentScoringRig } from './concurrentScoring'

const exec = promisify(execFile)

/** Real routed impairment, restored even when a scoring assertion fails. */
export async function networkRecovery(
  rig: ConcurrentScoringRig
): Promise<void> {
  const ips = [process.env.TS_CONCURRENT_IP_A, process.env.TS_CONCURRENT_IP_B]
  assert(ips.every(ip => ip != null && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)))
  const shapingUrl = process.env.TS_NETWORK_SHAPING_URL
  assert(
    shapingUrl != null,
    'Supply the authorized test network shaping API URL'
  )
  assert.notEqual(ips[0], ips[1])
  const older = Number(process.env.TS_CONCURRENT_OLDER_AUTHOR ?? 0)
  assert(older === 0 || older === 1)
  const newer = 1 - older
  const evidence: unknown[] = []
  const record = async (value: unknown): Promise<void> => {
    evidence.push({ at: Date.now(), value })
    await writeFile(
      rig.ctx.artifact('network-recovery.json'),
      JSON.stringify(evidence, null, 2)
    )
  }
  const api = async (path: string, body?: unknown): Promise<any> => {
    const args = ['-sk', '--fail', '--max-time', '10', `${shapingUrl}/${path}`]
    if (body != null)
      args.push(
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify(body)
      )
    const response = await exec('curl', args)
    return JSON.parse(response.stdout)
  }
  const devices = (await api('devices')) as { devices: Array<{ ip: string }> }
  assert(
    ips.every(ip =>
      devices.devices.some((device: { ip: string }) => device.ip === ip)
    ),
    'Both phones must be on a test VLAN'
  )
  const before = (await api('shape')) as { shapes: Array<{ ip: string }> }
  assert(
    !before.shapes.some((shape: { ip: string }) => ips.includes(shape.ip)),
    'A phone already has a shape; do not replace another test’s setting'
  )
  const shape = async (shapes: unknown[]): Promise<void> => {
    await record({ shape: await api('shape', { merge: true, shapes }) })
  }
  const clear = async (): Promise<void> => {
    await shape(ips.map(ip => ({ ip })))
  }
  const count = async (): Promise<{ balls?: unknown; strikes?: unknown }> => {
    const read = await rig.api.gameEvents(rig.fixture.ids.game)
    return read.currentPlay?.count ?? {}
  }
  const waitFor = async (
    check: () => Promise<boolean>,
    label: string
  ): Promise<void> => {
    const until = Date.now() + 90000
    while (!(await check())) {
      if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const synced = async (
    balls: number,
    strikes: number,
    since: number
  ): Promise<void> => {
    let lastMismatch: number | null = null
    await waitFor(async () => {
      const started = Date.now()
      const [a, b, stored] = await Promise.all([
        rig.summary(0),
        rig.summary(1),
        count()
      ])
      const finished = Date.now()
      const matches =
        a !== '' &&
        a === b &&
        a.includes(`${balls} balls ${strikes} strikes`) &&
        stored.balls === balls &&
        stored.strikes === strikes
      await record({
        inspectionStartedMs: started - since,
        inspectionFinishedMs: finished - since,
        matches,
        screens: [a, b],
        stored
      })
      if (!matches) lastMismatch = started - since
      else
        await record({
          recoveryUpperBoundMs: finished - since,
          lastMismatchingInspectionStartedMs: lastMismatch
        })
      return matches
    }, 'both scorers and saved game to agree')
  }
  await rig.open()
  let owned = false
  try {
    await record({
      baselineRtt: (await exec('ping', ['-c', '3', ips[0]!])).stdout
    })
    owned = true
    await shape(
      ips.map(ip => ({
        ip,
        latencyMs: 500,
        jitterMs: 100,
        lossPct: 2,
        mbit: 1
      }))
    )
    await record({
      shapedRtt: (await exec('ping', ['-c', '3', ips[0]!])).stdout,
      statsBefore: await api('stats')
    })
    const started = Date.now()
    await rig.pitch(0, 'Ball', true)
    await record({ action: 'Ball', author: 0, started, finished: Date.now() })
    await synced(1, 0, started)
    await record({ statsAfter: await api('stats') })
    await clear()
    // Hold the older scorer’s routed traffic. WDA remains on its USB tunnel.
    await shape([{ ip: ips[older], lossPct: 100 }])
    await rig.pitch(older, 'Ball', true)
    await record({ action: 'older Ball', author: older })
    await rig.pitch(newer, 'Called Strike', true)
    await record({ action: 'newer Called Strike', author: newer })
    await waitFor(async () => {
      const current = await count()
      return current.balls === 1 && current.strikes === 1
    }, 'the newer strike to save before releasing the older ball')
    await record({ statsBeforeRecovery: await api('stats') })
    await clear()
    const restored = Date.now()
    await record({ networkRestoredAt: restored })
    await synced(1, 1, restored)
    await rig.converge(
      newer,
      'newer physical pitch after delayed older delivery'
    )
    await rig.capture('network-recovered')
    await record({ status: 'passed' })
  } finally {
    if (owned) await clear()
    await record({ finalShapes: await api('shape') })
  }
}
