import { defineHarness } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'

/**
 * The coach's game roster: each player card holds its switch centred inside
 * it, a game-only guest's card is as wide as a team player's, the header
 * fits the window, and the help sheet fits the screen and closes. The coach
 * of the Falcons (`existing-player-guest`, whose side has team players and
 * the guest Mike Trout) opens their game in the runner's browser.
 */
export default defineHarness({
  id: 'scoring/roster-layout/cards-and-help',
  title: 'Game roster cards centre their switches and the help sheet fits',
  kind: 'e2e',
  covers: [
    'src/app/scoring/GameRosterHeader.tsx',
    'src/app/scoring/EditRosterList.tsx',
    'src/app/screens/CoachGameScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['existing-player-guest'],
  exclusive: false,
  surfaces: {
    // It covers the scoring screens, drawn in 3D: the Mac's Chrome.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
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
    'phone-window': async ctx => {
      const world = await ctx.fixture('existing-player-guest')
      await clearSignInLimits(ctx)
      const { m } = await ctx.browser({ width: 390, height: 844 })
      await m.openLink({ link: `${ctx.stack.origin}/` })
      await ctx.signIn('coach', m)
      await m.openLink({
        link: `${ctx.stack.origin}/games/${world.ids.game}/coach/${world.ids.falcons}`
      })
      // The coach's game screen opens on another tab than its roster.
      await m.assertVisible({ text: 'Roster', timeout: 30000 })
      await m.tapOn({ text: 'Roster' })
      await m.assertVisible({ text: 'Tap player to edit.', timeout: 30000 })
      await m.evalBrowserScript({
        script: "await document.fonts.ready; return 'ready'"
      })
      await m.evalBrowserScript({
        script: `
        const cards = [...document.querySelectorAll('[data-testid^="Player card "]')];
        if (!cards.length) throw Error('No roster cards with switches');
        for (const card of cards) {
          const toggle = card.querySelector('input[type=checkbox]');
          if (!toggle) throw Error('Missing switch');
          const c = card.getBoundingClientRect(), t = toggle.getBoundingClientRect();
          if (t.left < c.left || t.right > c.right ||
              Math.abs((t.top + t.bottom - c.top - c.bottom) / 2) > 2)
            throw Error('Switch must be centered inside its card');
          if (toggle.closest('[role=button]')) throw Error('Nested switch');
        }
        const guest = document.querySelector('[aria-label*="game-only player"]');
        if (!guest || Math.abs(guest.getBoundingClientRect().width - cards[0].getBoundingClientRect().width) > 2)
          throw Error('Team and guest cards must have equal widths');
        const header = document.querySelector('[aria-label="Game roster information"]').getBoundingClientRect();
        if (header.right > innerWidth || header.left < 0) throw Error('Header overflow');
        return 'Roster layout passed';`
      })
      await m.takeScreenshot({ path: ctx.artifact('roster.png') })
      await m.tapOn({ text: 'Game roster information' })
      await m.assertVisible({ text: '.*Toggle a player off.*' })
      await m.waitForAnimationToEnd({ timeout: 3000 })
      await m.evalBrowserScript({
        script: `
        const sheet = document.querySelector('[data-testid="Scoring sheet"]').getBoundingClientRect();
        if (sheet.top < 0 || sheet.bottom > innerHeight) throw Error('Help modal clipped');
        return 'Help modal fits';`
      })
      await m.takeScreenshot({ path: ctx.artifact('help.png') })
      await m.tapOn({ text: '^Done$' })
      await m.assertNotVisible({ text: '.*Toggle a player off.*' })
    }
  }
})
