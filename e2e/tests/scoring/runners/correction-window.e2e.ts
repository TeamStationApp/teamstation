import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { framesText, videoSeconds } from '../../../rigs/app/screenRecording'
import { defineCoachSpec } from '../../../rigs/coach/coachApp'
import { openScoringField, WALK } from '../../../rigs/scoring/scoringField'

/**
 * Once a play's runners settle, the scorekeeper has five seconds to move
 * another runner before the play closes and the next batter comes up
 * (`CORRECTION_WINDOW_MS`). A runner on first and a Single: the countdown
 * starts from five, and the play closes between five and six and a half
 * seconds after it opens, never before four and a half.
 */

/**
 * The window as a screen recording shows it, read ten frames a second: the
 * countdown's first digit, and the seconds from its first frame to the
 * first frame after it without the window's instruction, "Drag any other
 * runners".
 */
function recordedWindow(video: string): { first: number; seconds: number } {
  const frames = framesText(video, 0, videoSeconds(video), 10)
  const open = frames.findIndex(frame =>
    frame.lines.some(line => line.includes('Drag any other runners'))
  )
  if (open < 0) throw new Error('The recording never shows the window')
  const close = frames.findIndex(
    (frame, at) =>
      at > open &&
      !frame.lines.some(line => line.includes('Drag any other runners'))
  )
  if (close < 0) throw new Error('The recording ends with the window open')
  const digit = frames
    .slice(open, close)
    .flatMap(frame => frame.lines)
    .map(line => /^\s*(\d)\s*$/.exec(line)?.[1])
    .find(found => found != null)
  return {
    first: digit == null ? NaN : Number(digit),
    seconds: frames[close].atSec - frames[open].atSec
  }
}

/**
 * Saves the recording `stopRecording` answered with (its path in the
 * device's report, wherever its host is) to `path` here.
 */
async function fetchRecording(
  m: any,
  stopped: unknown,
  path: string
): Promise<void> {
  const found =
    typeof stopped === 'string'
      ? stopped
      : /[^"]*recordings\/[^"]+\.mp4/.exec(JSON.stringify(stopped))?.[0]
  if (found == null)
    throw new Error(`No recording saved: ${JSON.stringify(stopped)}`)
  const bytes: unknown = await m.artifact(found)
  writeFileSync(
    path,
    Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer)
  )
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export default defineCoachSpec({
  id: 'scoring/runners/correction-window',
  title:
    'The runner window after a play lasts five seconds, then the next batter is up',
  covers: [
    'src/app/scoring/scoringTypes.ts',
    'src/app/scoring/InstructionToast.tsx',
    'src/app/scoring/useCorrectionClock.ts',
    'src/app/scoring/useScoringClock.native.ts',
    'src/app/scoring/scoringFlow.ts',
    'src/app/scoring/scoringMachine.ts'
  ],
  minutes: 6,
  faults: ['api-500', 'hidden-element'],
  scenarios: {
    'five-seconds': async ctx => {
      const field = await openScoringField(ctx, WALK)
      const before = await field.batter()
      // The app's hierarchy names the countdown but not its digits: there the
      // screen is recorded, and its frames read the window's length.
      const video = field.web
        ? undefined
        : ctx.artifact('correction-window.mp4')
      if (video != null) await field.m.startRecording({ path: video })
      await field.hit('Single')
      // The window opens once the runners have settled after the hit.
      const watchEnd = Date.now() + 60000
      let first = await field.countdown()
      while (first == null) {
        if (Date.now() > watchEnd)
          throw new Error('No correction window opened after the Single')
        await sleep(100)
        first = await field.countdown()
      }
      const opened = Date.now()
      await field.m.takeScreenshot({
        path: ctx.artifact('correction-window.png')
      })
      let last = first
      let closed: number | undefined
      while (closed == null) {
        const now = await field.countdown()
        if (now == null) closed = Date.now()
        else {
          last = now
          if (Date.now() - opened > 20000)
            throw new Error(
              `The correction window was still open after 20 s, at ${now.now}`
            )
          await sleep(100)
        }
      }
      let seconds = (closed - opened) / 1000
      if (video != null) {
        await sleep(1000)
        await fetchRecording(field.m, await field.m.stopRecording(), video)
        const read = recordedWindow(video)
        first = { now: read.first, max: null }
        seconds = read.seconds
      }
      const after = await field.batter()
      writeFileSync(
        ctx.artifact('correction-window.log'),
        [
          `surface ${ctx.surface}`,
          `batter before the Single: ${before}`,
          `countdown first read: ${JSON.stringify(first)}`,
          `countdown last read: ${JSON.stringify(last)}`,
          `window open to play closed: ${seconds.toFixed(2)} s`,
          `batter after: ${after}`
        ].join('\n') + '\n'
      )
      await ctx.checkpoint('play-closed', {
        expect: [{ text: 'Ball' }],
        readBack: async () => {
          // The countdown starts from five, and its bar is five seconds long.
          expect(first.now, 'the countdown it starts from').equals(5)
          if (first.max != null && ctx.surface === 'web-chromium')
            expect(first.max, 'the bar’s full length').equals(5)
          expect(seconds, 'seconds from window open to play closed')
            .greaterThan(4.5)
            .and.lessThan(6.5)
          if (ctx.surface === 'web-chromium')
            expect(after, 'the next batter is up').not.equals(before)
          const { TeamStationClient } =
            await import('../../../../src/common/api')
          const { signInTestAccount } =
            await import('../../../../src/test/passwordFixtures')
          const api = `${ctx.stack.origin}/api/v1`
          const client = new TeamStationClient({
            baseUrl: api,
            token: await signInTestAccount(
              api,
              field.world.accounts.scorekeeper
            )
          })
          await eventually(async () => {
            const game = await client.gameEvents(field.world.ids.game)
            expect(game.plays.map(play => play.result.eventType)).deep.equals([
              'walk',
              'single'
            ])
          }, 20000)
        }
      })
    }
  }
})
