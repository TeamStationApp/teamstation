import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect } from 'chai'

import {
  browserSession,
  capture,
  maestro
} from '../../../e2e/rigs/refinementsMaestro'
import { groupFixture } from '../../test/groupFixtures'

/** Real schedule API and mobile browser, including stored state after undo. */
async function main(): Promise<void> {
  const out = process.env.TS_ARTIFACTS_DIR
  if (out == null) throw new Error('Supply TS_ARTIFACTS_DIR')
  await mkdir(out, { recursive: true })
  const f = await groupFixture(resolve('dist'))
  const d = await maestro('game-live-policy')
  const s = await browserSession(
    d,
    'game-live-policy-web',
    390,
    844,
    out,
    'chrome'
  )
  try {
    const now = Date.now()
    const hour = 3600000
    for (const [name, offset, scored, status] of [
      ['empty', 0, false, 'inProgress'],
      ['active', 0, true, 'inProgress'],
      ['past', -24 * hour, true, 'inProgress'],
      ['future', 24 * hour, true, 'inProgress'],
      ['final', 0, true, 'final']
    ] as const) {
      await f.h.db
        .insertInto('games')
        .values({
          id: `gam_live_${name}`,
          home_team_id: f.teamA,
          away_team_id: f.teamB,
          season_id: f.seasonA,
          start_at: new Date(now + offset),
          end_at: new Date(now + offset + 2 * hour),
          status,
          currentPlay: {
            teamStation: {
              actions: scored ? [{ type: 'pitch', kind: 'ball' }] : []
            }
          }
        })
        .execute()
    }
    await s.browser.setCookie({
      name: 'ts_session',
      value: f.h.tokens.get(101)!,
      domain: new URL(f.h.origin).hostname,
      path: '/'
    })
    const visit = async (): Promise<void> => {
      await s.m.openBrowser({
        url: `${f.h.origin}/teams/${f.teamA}?tab=schedule`
      })
      await s.page.waitForSelector('[data-testid="schedule-date"]')
    }
    const liveCount = async (): Promise<number> =>
      await s.page.$$eval(
        '*',
        nodes =>
          nodes.filter(
            node => node.childElementCount === 0 && node.textContent === 'LIVE'
          ).length
      )
    await visit()
    expect(await liveCount(), 'only the active, scored game is LIVE').equals(1)
    await capture(s.m, out, 'schedule-live.png')
    await f.h.db
      .updateTable('games')
      .set({ currentPlay: { teamStation: { actions: [] } } })
      .where('id', '=', 'gam_live_active')
      .execute()
    await visit()
    expect(await liveCount(), 'undoing the last action removes LIVE').equals(0)
    await capture(s.m, out, 'schedule-after-undo.png')
    console.log(
      'Schedule LIVE eligibility and last-action undo verified in the mobile browser'
    )
  } finally {
    await s.browser.disconnect()
    await s.m.detach()
    await d.shutdown()
    await f.h.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
