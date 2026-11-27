// The functions the page runs are transpiled by sucrase, which turns ?. and
// ?? into helpers the page does not have: they use neither.
/* eslint-disable @typescript-eslint/prefer-optional-chain */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { fakeMicrophone } from '../../../rigs/fakeMicrophone'

const WIDTH = 402
const HEIGHT = 874
const CLIPS = join(__dirname, '../../../../src/app/scoring/fixtures/audio')
const ROSTER_MIC = '[data-testid="Roster mic"] [aria-label="Dictation"]'
const MIC_STATUS = '[data-testid="Roster mic"] [aria-label="Dictation status"]'

/**
 * A silent microphone the scenario plays its clip into, and every dictation
 * frame both ways, for what the API was asked and answered, from before the
 * page's own script.
 */
const MICROPHONE = `
  (${fakeMicrophone.toString()})('');
  (() => {
    const heard = { sent: [], received: [] };
    window.__dictation = heard;
    const Native = window.WebSocket;
    const json = data => {
      try {
        return JSON.parse(String(data));
      } catch (error) {
        return null;
      }
    };
    class Watched extends Native {
      constructor(url, protocols) {
        super(url, protocols);
        if (!String(url).endsWith('/dictation')) return;
        this.addEventListener('message', event => {
          heard.received.push(json(event.data));
        });
      }
      send(data) {
        if (typeof data === 'string' && this.url.endsWith('/dictation'))
          heard.sent.push(json(data));
        super.send(data);
      }
    }
    window.WebSocket = Watched;
  })();
`

/** A PCM WAV's length, from its header's byte rate and its data chunk. */
function wavSeconds(bytes: Buffer): number {
  const byteRate = bytes.readUInt32LE(28)
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4)
    if (bytes.toString('ascii', at, at + 4) === 'data') return size / byteRate
    at += 8 + size
  }
  throw new Error('The clip has no data chunk')
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * C5: the visitors' head coach, on Coach Game's Box Score tab, holds the
 * roster microphone and says "Judge to fourth"; the real recogniser and
 * the default model (Claude Haiku 5.5) stage Judge fourth in his lineup,
 * the chat says so, and Cancel discards it.
 */
export default defineHarness({
  id: 'scoring/coach-game/dictated-lineup',
  title:
    "A coach's dictated lineup change is staged on Coach Game, and Cancel discards it",
  kind: 'e2e',
  covers: [
    'src/app/screens/CoachGameScreen.tsx',
    'src/app/scoring/RosterEditor.tsx',
    'src/app/scoring/RosterChat.tsx',
    'src/server/dictation/**'
  ],
  stack: 'isolated',
  fixtures: ['coach-plan'],
  exclusive: false,
  surfaces: {
    // The roster editor is the scoring screens' own, which only a GPU
    // draws: the Mac's browser.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  // The recogniser and the model are the API's real ones.
  services: ['dictation-model'],
  apps: [],
  secrets: [],
  costUsd: 0.05,
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'c5-dictated-change-staged-and-cancelled': async (ctx: HarnessContext) => {
      const world = await ctx.fixture('coach-plan')
      const { DEFAULT_DICTATION_MODEL } =
        await import('../../../../src/common/api')
      const { signInTestAccount } =
        await import('../../../../src/test/passwordFixtures')
      const session = await ctx.browser(
        { width: WIDTH, height: HEIGHT },
        { beforeLoad: MICROPHONE }
      )
      session.page.setDefaultTimeout(30000)
      const { m, page } = session
      const origin = ctx.stack.origin
      // The visitors' head coach: Judge bats first for them.
      const token = await signInTestAccount(
        `${origin}/api/v1`,
        world.accounts.awayCoach
      )
      await m.setCookies({
        cookies: [
          {
            name: 'ts_session',
            value: encodeURIComponent(token),
            domain: new URL(origin).hostname,
            path: '/'
          }
        ]
      })
      await m.openLink({ link: `${origin}/games/${world.ids.game}` })
      await page.waitForSelector('[aria-label="Game sections"]', {
        timeout: 60000
      })
      await m.tapOn({ css: '[aria-label="Coach"]', timeout: 15000 })
      await page.waitForSelector('[aria-label="Save Rosters"]', {
        timeout: 60000
      })
      await page.waitForSelector(
        '[aria-label="Box Score"][role="tab"][aria-selected="true"]',
        { timeout: 15000 }
      )
      const lineup = async (): Promise<string[]> =>
        await page.$$eval(
          '[data-roster-target^="lineup-"][data-roster-player]',
          nodes =>
            nodes.map(node =>
              String(node.textContent)
                .replace(/^\D*\d+\. (#\S+ )?/, '')
                .replace(/\W+$/, '')
            )
        )
      await page.waitForSelector(ROSTER_MIC)
      const mic = await page.$eval(ROSTER_MIC, node => {
        const r = node.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      const point = `${Math.round(mic.x)},${Math.round(mic.y)}`
      await m.tapOnPoint({ x: Math.round(mic.x), y: Math.round(mic.y) })
      const status = async (text: string): Promise<void> => {
        await page.waitForFunction(
          (wanted: string, selector: string) => {
            const node = document.querySelector(selector)
            return node != null && node.textContent === wanted
          },
          { timeout: 30000 },
          text,
          MIC_STATUS
        )
      }
      await status('Push to talk')
      // Held while the clip plays into the microphone, then let go: the
      // clip starts in the page once the hold has begun.
      const wav = readFileSync(join(CLIPS, 'lineupJudgeFourth.wav')).toString(
        'base64'
      )
      await m.evalBrowserScript({
        script: `
          window.__clipDone = false;
          setTimeout(() => {
            window.__playClip(${JSON.stringify(wav)}).then(() => { window.__clipDone = true });
          }, 1200);
        `
      })
      const seconds = wavSeconds(Buffer.from(wav, 'base64'))
      await m.dragAndDrop({
        from: { point },
        to: { point },
        holdDuration: Math.round(1200 + seconds * 1000 + 600),
        duration: 50
      })
      expect(await page.evaluate(() => (window as any).__clipDone)).equals(true)
      const answer = (await (
        await page.waitForFunction(
          () => {
            const heard = (window as any).__dictation
            const starts = heard.sent.filter(
              (frame: any) => frame != null && frame.kind === 'start'
            )
            const start = starts[starts.length - 1]
            if (start == null) return null
            const answers = heard.received.filter(
              (frame: any) =>
                frame != null &&
                frame.id === start.id &&
                ['actions', 'ask', 'error'].includes(frame.kind)
            )
            return answers.length === 0
              ? null
              : { start, answer: answers[answers.length - 1] }
          },
          { timeout: 90000 }
        )
      ).jsonValue()) as { start: any; answer: any }
      await sleep(500)
      expect(answer.start.model).equals(DEFAULT_DICTATION_MODEL)
      expect(answer.start.scope).equals('roster')
      expect(answer.start.target).deep.equals({
        gameId: world.ids.game,
        side: 'away'
      })
      expect(answer.answer.kind).equals('actions')
      await page.waitForSelector(
        '[aria-label="Lineup"][role="tab"][aria-selected="true"]',
        { timeout: 15000 }
      )
      expect((await lineup())[3]).equals('Judge')
      const lines = await page.$$eval(
        '[data-testid="Roster chat line"]',
        nodes => nodes.map(node => String(node.textContent))
      )
      expect(lines).deep.equals(['Judge to 4th in the lineup'])
      expect(
        await page.$eval('[data-testid="Roster chat said"]', node =>
          String(node.textContent)
        )
      ).equals(answer.answer.transcript)
      expect(
        await page.$eval(
          '[aria-label="Save Rosters"]',
          node => node.getAttribute('aria-disabled') === 'true'
        )
      ).equals(false)
      await m.waitForAnimationToEnd()
      await m.takeScreenshot({ path: ctx.artifact('coach-lineup-chat.png') })
      await m.tapOn({ css: '[aria-label="Cancel"]', timeout: 15000 })
      await page.waitForFunction(
        () => String(document.body.textContent).includes('Changes discarded'),
        { timeout: 15000 }
      )
      expect((await lineup())[0]).equals('Judge')
      expect(new URL(page.url()).pathname).includes('/coach/')
    }
  }
})
