import { mkdir } from 'node:fs/promises'

import {
  browserSession,
  capture,
  contains,
  maestro
} from '../../e2e/rigs/refinementsMaestro'
import { groupFixture } from '../test/groupFixtures'

async function main(): Promise<void> {
  const artifacts = process.env.TS_UMPIRE_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_UMPIRE_ARTIFACTS')
  await mkdir(artifacts, { recursive: true })
  const f = await groupFixture(process.env.TS_UMPIRE_WEB)
  const daemon = await maestro('umpireBeforeCapture')
  try {
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_umpire_baseline',
        season_id: f.seasonA,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        start_at: new Date('2027-04-03T00:00:00Z'),
        end_at: new Date('2027-04-03T02:00:00Z'),
        timezone: 'America/Los_Angeles',
        venue: 'Demo Field',
        status: 'scheduled'
      })
      .execute()
    for (const [label, width, height] of [
      ['wide', 1280, 800],
      ['narrow', 390, 844]
    ] as const) {
      const b = await browserSession(
        daemon,
        `umpire-before-${label}`,
        width,
        height,
        artifacts
      )
      try {
        await b.browser.setCookie({
          name: 'ts_session',
          value: f.h.tokens.get(101)!,
          domain: new URL(f.h.origin).hostname,
          path: '/',
          httpOnly: true
        })
        await b.m.openBrowser({ url: f.h.origin })
        await contains(b.page, 'Home')
        await capture(b.m, artifacts, `header-${label}-before.png`)
        if (label === 'wide') {
          await b.m.openBrowser({
            url: `${f.h.origin}/groups/league/${f.leagueA}/settings`
          })
          await contains(b.page, 'Save name')
          await capture(b.m, artifacts, 'league-settings-before.png')
          await b.m.openBrowser({
            url: `${f.h.origin}/games/gam_umpire_baseline`
          })
          await contains(b.page, 'Demo Hawks')
          await capture(b.m, artifacts, 'game-screen-before.png')
        }
      } finally {
        await b.browser.disconnect()
        await b.m.detach()
      }
    }
  } finally {
    await daemon.shutdown()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
