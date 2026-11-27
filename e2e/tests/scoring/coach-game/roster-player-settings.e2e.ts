import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import { clearSignInLimits, stackSql } from '../../../rigs/coach/coachApp'

/**
 * A head coach edits a player's settings from Coach Game's Roster tab in
 * Safari on an iPhone: the settings action is on the card, the jersey
 * number he saves is the membership's, and it is still there when the
 * coaching screen is opened again.
 */
export default defineHarness({
  id: 'scoring/coach-game/roster-player-settings',
  title:
    "A coach edits a player's settings from Coach Game's Roster tab, and the change persists",
  kind: 'e2e',
  covers: ['src/app/screens/CoachGameScreen.tsx', 'src/server/routes/teams.ts'],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: {
    // Safari pages only: no camera, microphone, real keyboard or GPU check.
    'web-safari-ios': {
      devices: [{ role: 'browser', needs: ['ios-phone'], simulator: 'allowed' }]
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'jersey-saved-and-reopened': async ctx => {
      const world = await ctx.fixture('coach-game')
      const origin = ctx.stack.origin
      const path = `/games/${world.ids.game}/coach/${world.ids.homeTeam}`
      await clearSignInLimits(ctx)
      const m = await ctx.mobileBrowser('browser', `${origin}/sign-in`)
      await ctx.signIn('coach', m)
      await m.openLink({ link: origin + path, browser: true })
      await m.assertVisible({ text: 'Save Rosters', timeout: 20000 })
      await m.tapOn({ text: 'Roster', index: 0 })
      await m.assertNotVisible({
        text: 'Player settings are unavailable for this team.'
      })
      await m.takeScreenshot({ path: ctx.artifact('coach-roster-footer.png') })
      // The visible cards expose the settings action on their label.
      await m.tapOn({ text: '.*edit settings.*', index: 0 })
      await m.assertVisible({ text: 'Jersey number', timeout: 10000 })
      await m.tapOn({ text: 'Jersey number' })
      await m.eraseText({ characters: 20 })
      await m.inputText({ text: '42' })
      await m.hideKeyboard()
      await m.tapOn({ text: 'Save', index: 0 })
      await m.assertVisible({ text: 'Saved.' })
      await m.takeScreenshot({
        path: ctx.artifact('coach-player-settings-saved.png')
      })
      const saved = await stackSql(
        ctx,
        "select user_id from memberships where team_id = $1 and jersey = '42'",
        [world.ids.homeTeam]
      )
      expect(saved.rows).length(1)
      await m.tapOn({ text: 'Cancel', index: 0 })
      await m.assertVisible({ text: '.*jersey 42.*' })
      await m.openLink({ link: origin + path, browser: true })
      await m.assertVisible({ text: 'Save Rosters', timeout: 20000 })
      await m.tapOn({ text: 'Roster', index: 0 })
      await m.assertVisible({ text: '.*jersey 42.*' })
      await m.takeScreenshot({
        path: ctx.artifact('coach-roster-reopened.png')
      })
    }
  }
})
