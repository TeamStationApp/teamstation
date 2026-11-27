import { writeFile } from 'node:fs/promises'

import type { ConcurrentScoringRig } from './concurrentScoring'

/**
 * Real routed impairment, restored even when a scoring assertion fails. Each
 * phone's network is shaped by its own hub (maestro-d's setTrafficShape),
 * never by this machine. `older` is the scorer whose traffic is held while
 * the other authors a newer pitch.
 */
export async function networkRecovery(
  rig: ConcurrentScoringRig,
  older: 0 | 1
): Promise<void> {
  const newer = 1 - older
  const evidence: unknown[] = []
  const record = async (value: unknown): Promise<void> => {
    evidence.push({ at: Date.now(), value })
    await writeFile(
      rig.ctx.artifact('network-recovery.json'),
      JSON.stringify(evidence, null, 2)
    )
  }
  const phones = (): any[] => [rig.clients[0].m, rig.clients[1].m]
  const shape = async (
    index: number,
    values: Record<string, number>
  ): Promise<void> => {
    await phones()[index].setTrafficShape(values)
    await record({ shape: { phone: index, ...values } })
  }
  const clear = async (): Promise<void> => {
    for (const [index, phone] of phones().entries()) {
      await phone.resetTrafficShape()
      await record({ shape: { phone: index, cleared: true } })
    }
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
    owned = true
    for (const index of [0, 1])
      await shape(index, { latencyMs: 500, jitterMs: 100, lossPct: 2, mbit: 1 })
    const started = Date.now()
    await rig.pitch(0, 'Ball', true)
    await record({ action: 'Ball', author: 0, started, finished: Date.now() })
    await synced(1, 0, started)
    await clear()
    // Hold the older scorer’s routed traffic. WDA remains on its USB tunnel.
    await shape(older, { lossPct: 100 })
    await rig.pitch(older, 'Ball', true)
    await record({ action: 'older Ball', author: older })
    await rig.pitch(newer, 'Called Strike', true)
    await record({ action: 'newer Called Strike', author: newer })
    await waitFor(async () => {
      const current = await count()
      return current.balls === 1 && current.strikes === 1
    }, 'the first accepted strike to save before releasing the held ball')
    await clear()
    const restored = Date.now()
    await record({ networkRestoredAt: restored })
    await synced(1, 1, restored)
    await rig.converge(
      newer,
      'first accepted physical pitch after delayed conflicting delivery'
    )
    await rig.capture('network-recovered')
    await record({ status: 'passed' })
  } finally {
    if (owned) await clear()
  }
}
