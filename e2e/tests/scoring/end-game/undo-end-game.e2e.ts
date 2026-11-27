import { expect } from 'chai'

import { TeamStationClient } from '../../../../src/common/api'
import type { StoredGame } from '../../../../src/common/scoring/session'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'

/**
 * End Game on a live at-bat saves its pitches with the final score, and
 * Undo End game reopens that same at-bat as it was. The web scorer, in the
 * runner's browser, scores the lineup game of `coach-game` as its home
 * team's scorekeeper; the book is read back from the API.
 */

/** Waits for the save to reach the API, independently of the browser's cache. */
async function waitForBook(
  api: TeamStationClient,
  game: string,
  matches: (book: StoredGame) => boolean,
  description: string
): Promise<StoredGame> {
  const end = Date.now() + 30000
  do {
    const book = await api.gameEvents(game)
    if (matches(book)) return book
    await new Promise(resolve => setTimeout(resolve, 200))
  } while (Date.now() < end)
  throw new Error(`The saved game did not reach ${description}`)
}

async function tap(m: any, label: string): Promise<void> {
  await m.tapOn({
    css: `[aria-label="${label}"]:not([aria-disabled="true"]):not(:disabled)`,
    timeout: 15000
  })
}

async function apiAs(
  ctx: HarnessContext,
  account: { email: string; password: string }
): Promise<TeamStationClient> {
  const { signInTestAccount } =
    await import('../../../../src/test/passwordFixtures')
  const baseUrl = `${ctx.stack.origin}/api/v1`
  const token = await signInTestAccount(baseUrl, account)
  return new TeamStationClient({ baseUrl, token })
}

export default defineHarness({
  id: 'scoring/end-game/undo-end-game',
  title: 'End Game saves the open at-bat, and Undo reopens it as it was',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/**',
    'src/common/scoring/session.ts'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: {
    // The scoring screen draws in 3D: the Mac's Chrome, with its GPU.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'saves-and-undoes': async ctx => {
      const world = await ctx.fixture('coach-game')
      const game = world.ids.game
      await clearSignInLimits(ctx)
      const api = await apiAs(ctx, world.accounts.scorekeeper)
      const { m } = await ctx.browser({ width: 430, height: 932 })
      await m.openLink({ link: `${ctx.stack.origin}/` })
      await ctx.signIn('scorekeeper', m)
      await m.openLink({ link: `${ctx.stack.origin}/games/${game}/score` })
      await tap(m, 'Ball')
      const live = await waitForBook(
        api,
        game,
        book =>
          book.currentPlay?.count != null &&
          (book.currentPlay.count as { balls?: number }).balls === 1,
        'one ball'
      )
      await tap(m, 'Open scoring menu')
      await tap(m, 'End Game')
      await m.assertVisible({
        text: 'The open at-bat is saved with its pitches',
        timeout: 15000
      })
      await m.takeScreenshot({ path: ctx.artifact('end-game-confirm.png') })
      await tap(m, 'Confirm End Game')
      const final = await waitForBook(
        api,
        game,
        book =>
          book.currentPlay == null &&
          book.plays.some(play => play.result.eventType === 'final_score'),
        'the final score'
      )
      expect(final.plays.map(play => play.result.eventType)).deep.equals([
        'ts_at_bat_ended',
        'final_score'
      ])
      const events = final.plays[0].playEvents
      expect(Array.isArray(events)).equals(true)
      if (!Array.isArray(events)) throw new Error('The at-bat has no events')
      expect(
        events
          .filter(event => event.isPitch === true)
          .map(event => event.details.code)
      ).deep.equals(['B'])
      await tap(m, 'Undo End game')
      const restored = await waitForBook(
        api,
        game,
        book =>
          book.currentPlay != null &&
          !book.plays.some(play => play.result.eventType === 'final_score'),
        'the restored live appearance'
      )
      await m.takeScreenshot({ path: ctx.artifact('end-game-undone.png') })
      expect(
        restored.plays.every(
          play => play.about.atBatIndex === live.currentPlay?.about.atBatIndex
        )
      ).equals(true)
      expect(restored.currentPlay?.about.isComplete).equals(false)
      expect(restored.currentPlay?.about.atBatIndex).equals(
        live.currentPlay?.about.atBatIndex
      )
      expect(restored.currentPlay?.about.inning).equals(
        live.currentPlay?.about.inning
      )
      expect(restored.currentPlay?.about.halfInning).equals(
        live.currentPlay?.about.halfInning
      )
      expect(restored.currentPlay?.count).deep.equals(live.currentPlay?.count)
      expect(restored.currentPlay?.playEvents).deep.equals(
        live.currentPlay?.playEvents
      )
    }
  }
})
