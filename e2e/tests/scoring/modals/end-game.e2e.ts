import { defineHarness } from '../../../core/spec'
import { installSceneProbe } from '../../../rigs/fieldPointer'
import { begin, endGameBehavior } from './sheets.e2e'

/**
 * End Game from wherever the scorer is, in a phone-sized window of the
 * runner's browser: from an open at-bat (saved with its pitches, and
 * undone), from a ball in play (left out of the book, and brought back by
 * Undo), from the error's credit (left undecided), and from the tiebreaker.
 * The book is read back from the stack's API after each.
 */
export default defineHarness({
  id: 'scoring/modals/end-game',
  title: 'End Game files what is decided and Undo brings back what it left',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/ErrorCreditSheet.tsx',
    'src/app/scoring/TiebreakerSheets.tsx',
    'src/common/scoring/session.ts',
    'src/app/field/**'
  ],
  stack: 'isolated',
  fixtures: ['scoring-sheets'],
  exclusive: false,
  surfaces: {
    // The field draws in 3D: the Mac's browser, which has a GPU.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'from-each-decision': async ctx => {
      const run = await begin(ctx)
      // Reading where the fielders draw needs the scene's fiber roots,
      // kept from the next page load on.
      await installSceneProbe(run.s.web!.page)
      await endGameBehavior(run)
      await ctx.checkpoint(
        'end-game-over',
        { expect: [{ text: 'Game over', timeout: 20000 }] },
        run.s.m
      )
    }
  }
})
