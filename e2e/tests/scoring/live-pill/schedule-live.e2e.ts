import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import { openEventWeb, sql } from '../../../rigs/eventWeb'

/**
 * A team schedule marks LIVE only the game in progress that has been
 * scored, from the real schedule API in a phone-sized browser, and undoing
 * its last action takes the mark away again.
 */

const HOUR = 3600000

export default defineHarness({
  id: 'scoring/live-pill/schedule-live',
  title: 'Only the scored game in progress reads LIVE on the team schedule',
  kind: 'e2e',
  covers: [
    'src/app/components/ScheduleRow.tsx',
    'src/app/screens/GroupGameSchedule.tsx'
  ],
  stack: 'isolated',
  fixtures: ['event-groups'],
  exclusive: false,
  surfaces: {
    // The schedule draws no 3D: headless Chromium on a browser droplet.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'live-after-undo': async ctx => {
      const world = await ctx.fixture('event-groups')
      const { teamA, teamB, seasonA } = world.ids
      const now = Date.now()
      const ids: Record<string, string> = {}
      for (const [name, offset, scored, status] of [
        ['empty', 0, false, 'inProgress'],
        ['active', 0, true, 'inProgress'],
        ['past', -24 * HOUR, true, 'inProgress'],
        ['future', 24 * HOUR, true, 'inProgress'],
        ['final', 0, true, 'final']
      ] as const) {
        ids[name] = `gam_live_${name}_${world.nonce}`
        await sql(
          ctx,
          `insert into games (id, home_team_id, away_team_id, season_id, start_at, end_at, status, "currentPlay")
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            ids[name],
            teamA,
            teamB,
            seasonA,
            new Date(now + offset).toISOString(),
            new Date(now + offset + 2 * HOUR).toISOString(),
            status,
            JSON.stringify({
              teamStation: {
                actions: scored ? [{ type: 'pitch', kind: 'ball' }] : []
              }
            })
          ]
        )
      }
      const web = await openEventWeb(ctx, world.accounts.owner, {
        width: 390,
        height: 844
      })
      const visit = async (): Promise<void> => {
        await web.go(`/teams/${teamA}?tab=schedule`)
        await web.page.waitForSelector('[data-testid="schedule-date"]')
      }
      const liveCount = async (): Promise<number> =>
        await web.page.$$eval(
          '*',
          nodes =>
            nodes.filter(
              node =>
                node.childElementCount === 0 && node.textContent === 'LIVE'
            ).length
        )
      await visit()
      expect(await liveCount(), 'only the active, scored game is LIVE').equals(
        1
      )
      await web.shot('schedule-live.png')
      await sql(ctx, `update games set "currentPlay" = $1 where id = $2`, [
        JSON.stringify({ teamStation: { actions: [] } }),
        ids.active
      ])
      await visit()
      expect(await liveCount(), 'undoing the last action removes LIVE').equals(
        0
      )
      await web.shot('schedule-after-undo.png')
    }
  }
})
