import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/* eslint-disable @typescript-eslint/prefer-optional-chain --
   The functions puppeteer runs in the page are transpiled by sucrase, which
   turns ?. and ?? into helpers the page does not have. */
import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import NodeSocket from 'ws'

import { dictationModelOf } from '../../common/api'
import { idOfTag } from '../../common/scoring/playerTags'
import { fakeMicrophone } from '../../test/fakeMicrophone.e2e'
import { signInTestAccount } from '../../test/passwordFixtures'

/**
 * Dictation end to end: a faked microphone plays a clip into the scoring
 * screen, the real API sends it to xAI's dictation model and LLM, and the
 * actions come back through the screen's reducer and are saved. Nothing is
 * intercepted.
 *
 *   TS_SCORER_PASSWORD=… TS_VIEWER_PASSWORD=… \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 120000 src/app/scoring/dictationPipeline.e2e.ts
 *
 * Needs what `scoringServer.e2e.ts` needs — the API (`npm start`), the web app
 * built against it (`npm run start.web`), the scorer from `npm run seed` and
 * `npm run scoring-game` — with the `dictation` block in `serverConfig.json`.
 * The scenarios that rename players write to the API's database,
 * `TS_E2E_DATABASE` on port `TS_E2E_DATABASE_PORT` (5433 when unset).
 * Two scenarios need the API started differently, and run only when told:
 *
 *   TS_E2E_DICTATION=providerDown   dictation.baseUrl at an unreachable host (E5)
 *   TS_E2E_DICTATION=off            no dictation block at all (E8)
 *
 * The microphone is `fakeMicrophone`, which the test plays each clip into
 * once the button is held. Everything after it — the AudioWorklet, the PCM,
 * the socket, the server, xAI — is the real path.
 */
const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8080'
const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9100/api/v1'
const DATABASE = process.env.TS_E2E_DATABASE ?? 'AppDb_scoringCore'
const DATABASE_PORT = process.env.TS_E2E_DATABASE_PORT ?? '5433'
const MODE = process.env.TS_E2E_DICTATION ?? 'on'
const API_LOG = process.env.TS_E2E_API_LOG
const SCORER = {
  email: process.env.TS_SCORER_EMAIL ?? 'scoring@teamstation.local',
  password: process.env.TS_SCORER_PASSWORD ?? ''
}
const VIEWER = {
  email: process.env.TS_VIEWER_EMAIL ?? 'viewer@teamstation.local',
  password: process.env.TS_VIEWER_PASSWORD ?? ''
}
const CLIPS = resolve('src/app/scoring/fixtures/audio')
const temp = mkdtempSync(join(tmpdir(), 'dictation-e2e-'))
const trace = (step: string): void => {
  if (process.env.TS_E2E_TRACE != null) console.log(`  · ${step}`)
}

interface Fixture {
  games: string[]
  away: number[]
  home: number[]
}
function scoringGame(games = 1): Fixture {
  const out = execFileSync(
    'npm',
    [
      'run',
      '--silent',
      'scoring-game',
      '--',
      VIEWER.email,
      VIEWER.password,
      '--games',
      String(games)
    ],
    { encoding: 'utf8' }
  )
  const value = (key: string): string[] =>
    out
      .split('\n')
      .filter(line => line.startsWith(`${key}=`))
      .map(line => line.slice(key.length + 1))
  return {
    games: value('GAME_ID'),
    away: value('AWAY')[0].split(',').map(Number),
    home: value('HOME')[0].split(',').map(Number)
  }
}
function sql(query: string): string {
  return execFileSync(
    'psql',
    ['-h', 'localhost', '-p', DATABASE_PORT, '-d', DATABASE, '-tAc', query],
    {
      encoding: 'utf8'
    }
  ).trim()
}
async function signIn(who: {
  email: string
  password: string
}): Promise<string> {
  return await signInTestAccount(API, who)
}
interface Stored {
  plays: Array<{ id: string; gumbo: Record<string, any> }>
  currentPlay: Record<string, any> | null
}
async function stored(token: string, gameId: string): Promise<Stored> {
  const response = await fetch(`${API}/games/${gameId}/events`, {
    headers: { cookie: `ts_session=${encodeURIComponent(token)}` }
  })
  return (await response.json()) as Stored
}

/** The saved play of this kind, the last one. */
async function playOf(
  token: string,
  gameId: string,
  eventType: string
): Promise<Record<string, any>> {
  const play = (await stored(token, gameId)).plays
    .map(p => p.gumbo)
    .filter(gumbo => gumbo.result?.eventType === eventType)
    .at(-1)
  if (play == null) throw new Error(`No ${eventType} saved`)
  return play
}
/**
 * Where a play left each runner, by where his last move began (`batter` for
 * the batter's own): a base, `score`, or `out 2B`.
 */
function endsOf(play: Record<string, any>): Record<string, string> {
  const byRunner = new Map<number, Array<Record<string, any>>>()
  for (const runner of play.runners as Array<Record<string, any>>) {
    const id = Number(runner.details.runner.id)
    byRunner.set(id, [...(byRunner.get(id) ?? []), runner.movement])
  }
  const ends: Record<string, string> = {}
  for (const moves of byRunner.values()) {
    const last = moves[moves.length - 1]
    ends[String(last.start ?? 'batter')] =
      last.isOut === true
        ? `out ${String(last.outBase)}`
        : String(last.end ?? 'score')
  }
  return ends
}
/** Every fielding credit of a play, as `credit position`. */
function creditsOf(play: Record<string, any>): string[] {
  return (play.runners as Array<Record<string, any>>).flatMap(runner =>
    (runner.credits as Array<Record<string, any>>).map(
      credit =>
        `${String(credit.credit)} ${String(credit.position.abbreviation)}`
    )
  )
}

/** The PCM of a 16 kHz mono WAV, whatever chunks its writer added. */
function pcmOf(wav: Buffer): Buffer {
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString('ascii', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    if (id === 'data') return wav.subarray(at + 8, at + 8 + size)
    at += 8 + size + (size % 2)
  }
  throw new Error('No data chunk')
}
/** 16 kHz mono 16-bit PCM as a WAV with the plain 44-byte header. */
function wavOf(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
/** A clip as a plain 16 kHz WAV, from the fixtures or made for this run. */
function clipFile(name: string): { path: string; seconds: number } {
  const made = join(temp, `${name}.spoken.wav`)
  const pcm = pcmOf(
    readFileSync(existsSync(made) ? made : join(CLIPS, `${name}.wav`))
  )
  const path = join(temp, `${name}.wav`)
  writeFileSync(path, wavOf(pcm))
  return { path, seconds: pcm.length / 32000 }
}
/** A clip made now, for a name the fixture game only has once it is set up. */
function spoken(name: string, sentence: string): void {
  execFileSync('say', ['-o', join(temp, `${name}.aiff`), sentence])
  execFileSync('afconvert', [
    '-f',
    'WAVE',
    '-d',
    'LEI16@16000',
    '-c',
    '1',
    join(temp, `${name}.aiff`),
    join(temp, `${name}.spoken.wav`)
  ])
}

interface Heard {
  sent: Array<Record<string, any>>
  received: Array<Record<string, any>>
  audioFrames: number
  audioPeak: number
}

async function launch(): Promise<Browser> {
  return await puppeteer.launch({
    headless: true,
    executablePath: process.env.TS_CHROME_PATH,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required'
    ]
  })
}

async function open(
  browser: Browser,
  token: string,
  gameId: string,
  clip?: string
): Promise<Page> {
  const page = await browser.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => {
    console.error('Browser error:', error)
  })
  if (clip != null)
    await page.evaluateOnNewDocument(
      fakeMicrophone,
      readFileSync(clip).toString('base64')
    )
  // Every dictation frame, both ways, for the assertions below. The scoring
  // screen's game socket is not watched: only the dictation socket.
  await page.evaluateOnNewDocument(() => {
    const heard = {
      sent: [] as unknown[],
      received: [] as unknown[],
      audioFrames: 0,
      audioPeak: 0,
      sockets: [] as WebSocket[]
    }
    ;(window as any).__dictation = heard
    const Native = window.WebSocket
    class Watched extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (!String(url).endsWith('/dictation')) return
        heard.sockets.push(this)
        this.addEventListener('message', event => {
          heard.received.push(JSON.parse(String(event.data)))
        })
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (!this.url.endsWith('/dictation')) {
          super.send(data)
          return
        }
        if (typeof data === 'string') heard.sent.push(JSON.parse(data))
        else {
          heard.audioFrames++
          const samples = new Int16Array(data as ArrayBuffer)
          for (const sample of samples)
            heard.audioPeak = Math.max(heard.audioPeak, Math.abs(sample))
        }
        super.send(data)
      }
    }
    window.WebSocket = Watched
  })
  await page.setViewport({ width: 1200, height: 900 })
  await browser.defaultBrowserContext().setCookie({
    name: 'ts_session',
    value: encodeURIComponent(token),
    domain: '127.0.0.1',
    path: '/'
  })
  await page.goto(`${APP}/games/${gameId}`)
  // The game page's Score pill, then its screen's Full game scoring.
  await (await page.waitForSelector('[aria-label="Score"]'))!.click()
  await page.waitForFunction(() => location.pathname.endsWith('/score-game'))
  await (await page.waitForSelector(
    '[aria-label="Full game scoring"]'
  ))!.click()
  await page.waitForFunction(() => location.pathname.endsWith('/score'))
  await page.waitForSelector('canvas[data-field-ready="true"]', {
    timeout: 60000
  })
  if ((await page.$('[aria-label="OK"]')) != null)
    await page.locator('[aria-label="OK"]').click()
  return page
}

async function heard(page: Page): Promise<Heard> {
  return await page.evaluate(() => {
    const { sent, received, audioFrames, audioPeak } = (window as any)
      .__dictation
    return { sent, received, audioFrames, audioPeak }
  })
}
async function summary(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const board = document.querySelector('[aria-label*=" balls "]')
    return board == null ? '' : String(board.getAttribute('aria-label'))
  })
}
/** What the control is telling the scorer: a question, or a message. */
async function shown(page: Page): Promise<string | null> {
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Dictation question"]') != null ||
      document.querySelector('[aria-label="Dictation message"]') != null
  )
  return await page.evaluate(() => {
    const question = document.querySelector('[aria-label="Dictation question"]')
    const message = document.querySelector('[aria-label="Dictation message"]')
    // No ?? here: sucrase would turn it into a helper the page lacks.
    const node = [question, message].find(n => n != null)
    return node == null ? null : String(node.textContent)
  })
}
async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const ball = document.querySelector('[aria-label="Ball"]')
      return ball != null && ball.getAttribute('aria-disabled') !== 'true'
    },
    { timeout: 30000 }
  )
}
async function tap(page: Page, label: string): Promise<void> {
  await waitReady(page)
  await page.locator(`[aria-label="${label}"]`).click()
}
async function waitSaved(page: Page): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 30000 })
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Save status"]') == null,
    {
      timeout: 30000
    }
  )
}
async function finishAtBat(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const ball = document.querySelector('[aria-label="Ball"]')
      return (
        document.querySelector('[aria-label="Finish at-bat"]') != null ||
        (ball != null && ball.getAttribute('aria-disabled') !== 'true')
      )
    },
    { timeout: 30000 }
  )
  if ((await page.$('[aria-label="Finish at-bat"]')) != null)
    await page.locator('[aria-label="Finish at-bat"]').click()
}

/** One frame, so the screen has taken the key before the next one. */
async function frame(page: Page): Promise<void> {
  await page.evaluate(
    async () =>
      await new Promise(resolve => {
        requestAnimationFrame(resolve)
      })
  )
}

/** Switches dictation on, and waits until the button can be held. */
async function switchOn(page: Page): Promise<void> {
  await page.waitForSelector('[aria-label="Dictation"]', { timeout: 30000 })
  // A tap on the microphone switches dictation on.
  const button = await page.$('[aria-label="Dictation"]')
  const box = await button!.boundingBox()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await ready(page)
}
/** Waits until the microphone reads Push to talk: connected, and nothing in flight. */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const status = document.querySelector('[aria-label="Dictation status"]')
      return status != null && status.textContent === 'Push to talk'
    },
    { timeout: 15000 }
  )
}
/** Plays the clip into the microphone, resolving when it has finished. */
async function play(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as any).__playClip()
  })
}
/** Holds the button while the clip plays, and a moment after. */
async function hold(page: Page): Promise<void> {
  const button = await page.$('[aria-label="Dictation"]')
  const box = await button!.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await play(page)
  await new Promise(resolve => setTimeout(resolve, 600))
  await page.mouse.up()
}

/** The last reply for the last utterance: actions, an ask, or an error. */
async function answered(page: Page): Promise<Record<string, any>> {
  await page.waitForFunction(
    () => {
      const heard = (window as any).__dictation
      const start = [...heard.sent]
        .reverse()
        .find((f: any) => f.kind === 'start')
      return (
        start != null &&
        heard.received.some(
          (r: any) =>
            r.id === start.id && ['actions', 'ask', 'error'].includes(r.kind)
        )
      )
    },
    { timeout: 120000 }
  )
  return await page.evaluate(() => {
    const heard = (window as any).__dictation
    const start = [...heard.sent].reverse().find((f: any) => f.kind === 'start')
    return [...heard.received]
      .reverse()
      .find(
        (r: any) =>
          r.id === start.id && ['actions', 'ask', 'error'].includes(r.kind)
      )
  })
}

/**
 * The reply a question comes to when the scorer takes its first option: that
 * option's actions, or the LLM's next reply. Anything else is returned as is.
 */
async function settled(
  page: Page,
  reply: Record<string, any>
): Promise<Record<string, any>> {
  if (reply.kind !== 'ask') return reply
  const count = (await heard(page)).received.length
  await page.locator(`[aria-label="${String(reply.options[0].label)}"]`).click()
  await page.waitForFunction(
    seen =>
      (window as any).__dictation.received
        .slice(seen)
        .some((r: any) => ['actions', 'ask', 'error'].includes(r.kind)),
    { timeout: 120000 },
    count
  )
  return await settled(page, (await heard(page)).received.at(-1)!)
}

/**
 * Records every change to what the field shows — its picture and the players
 * it is moving — from now on, as the field's data attributes report them.
 */
async function watchField(page: Page): Promise<void> {
  await page.evaluate(() => {
    const field = document.querySelector('[role="application"]')!
    const seen: string[] = []
    ;(window as any).__field = seen
    const read = (): void => {
      const entry = [
        field.getAttribute('data-presentation'),
        field.getAttribute('data-presentation-id'),
        field.getAttribute('data-moving')
      ].join('|')
      if (seen[seen.length - 1] !== entry) seen.push(entry)
    }
    read()
    new MutationObserver(read).observe(field, {
      attributes: true,
      attributeFilter: [
        'data-presentation',
        'data-presentation-id',
        'data-moving'
      ]
    })
  })
}
interface FieldMoment {
  presentation: string
  id: string
  moving: number[]
}
/** What the field showed, once it has shown nothing for a while. */
async function fieldShown(page: Page): Promise<FieldMoment[]> {
  await page.waitForFunction(
    () => {
      const seen: string[] = (window as any).__field
      const last = seen[seen.length - 1]
      const w = window as any
      if (last !== w.__fieldLast) {
        w.__fieldLast = last
        w.__fieldSince = Date.now()
        return false
      }
      return (
        last != null &&
        last.startsWith('none|') &&
        last.endsWith('|') &&
        Date.now() - Number(w.__fieldSince) > 1500
      )
    },
    { timeout: 60000, polling: 100 }
  )
  const seen = await page.evaluate(() => (window as any).__field as string[])
  return seen.map(entry => {
    const [presentation, id, moving] = entry.split('|')
    return {
      presentation,
      id,
      moving: moving === '' ? [] : moving.split(',').map(Number)
    }
  })
}
/** A player's id, from the tag the sentence's context named him by. */
function idIn(context: string, label: string): number {
  const match = new RegExp(`${label}: [^(]*\\(tag ([A-Z]{2}[0-9])\\)`).exec(
    context
  )
  const id = match == null ? undefined : idOfTag(match[1])
  if (id == null) throw new Error(`No ${label} in ${context}`)
  return id
}
/** One utterance watched: the reply and what the field showed of it. */
async function dictateWatched(
  token: string,
  gameId: string,
  clip: string
): Promise<{
  reply: Record<string, any>
  shown: FieldMoment[]
  context: string
  page: Page
  browser: Browser
}> {
  const { path } = clipFile(clip)
  const browser = await launch()
  const page = await open(browser, token, gameId, path)
  await switchOn(page)
  await watchField(page)
  await hold(page)
  const reply = await answered(page)
  trace(`${clip}: ${JSON.stringify(reply)}`)
  const shown = await fieldShown(page)
  trace(`${clip}: shown ${JSON.stringify(shown)}`)
  const context = String(
    (await heard(page)).sent.find(f => f.kind === 'start')!.context
  )
  return { reply, shown, context, page, browser }
}
/** Walks this many batters by tapping four balls each. */
async function walks(
  token: string,
  gameId: string,
  count: number
): Promise<void> {
  const setup = await launch()
  try {
    const page = await open(setup, token, gameId)
    for (let batter = 0; batter < count; batter++) {
      for (let n = 0; n < 4; n++) await tap(page, 'Ball')
      await finishAtBat(page)
    }
    await waitSaved(page)
  } finally {
    await setup.close()
  }
}
/** Nothing waits on the screen: a pitch can be tapped. */
async function nothingToTap(page: Page): Promise<void> {
  await waitReady(page)
  expect(await page.$('[aria-label="Dictation question"]')).equals(null)
}

/** Walks the leadoff batter by tapping, then dictates steals for him. */
async function runnerOn(
  token: string,
  gameId: string,
  base: 'second' | 'third'
): Promise<void> {
  const setup = await launch()
  try {
    const page = await open(setup, token, gameId)
    for (let n = 0; n < 4; n++) await tap(page, 'Ball')
    await finishAtBat(page)
    await waitSaved(page)
  } finally {
    await setup.close()
  }
  for (const clip of base === 'second'
    ? ['fullPass2']
    : ['fullPass2', 'stealThird']) {
    const { reply, browser } = await dictate(token, gameId, clip)
    await browser.close()
    expect(reply.kind, `${clip}: ${JSON.stringify(reply)}`).equals('actions')
  }
}

/** One utterance: a browser with the clip as its microphone, held and released. */
async function dictate(
  token: string,
  gameId: string,
  clip: string,
  settle = true
): Promise<{
  reply: Record<string, any>
  heard: Heard
  summary: string
  browser: Browser
  page: Page
}> {
  const { path, seconds } = clipFile(clip)
  trace(`${clip}: launch`)
  const browser = await launch()
  trace(`${clip}: open`)
  const page = await open(browser, token, gameId, path)
  trace(`${clip}: switch on`)
  await switchOn(page)
  trace(`${clip}: hold ${seconds.toFixed(1)}s`)
  await hold(page)
  trace(`${clip}: wait for the reply`)
  const reply = await answered(page)
  trace(`${clip}: ${JSON.stringify(reply)}`)
  const sent = await heard(page)
  trace(`${clip}: ${sent.audioFrames} audio frames, peak ${sent.audioPeak}`)
  trace(
    `${clip}: model ${String(sent.sent.filter(f => f.kind === 'start').at(-1)?.model)}`
  )
  if (process.env.TS_E2E_TRACE != null) {
    await new Promise(resolve => setTimeout(resolve, 300))
    const shown = await page.evaluate(() => {
      const message = document.querySelector('[aria-label="Dictation message"]')
      return message == null ? null : message.textContent
    })
    trace(`${clip}: shown ${String(shown)}`)
  }
  if (settle && reply.kind === 'actions') await waitSaved(page)
  return {
    reply,
    heard: await heard(page),
    summary: await summary(page),
    browser,
    page
  }
}

/** The part of a play that a transcript can carry. */
function projection(play: Record<string, any>): unknown {
  return {
    atBatIndex: play.about?.atBatIndex,
    eventType: play.result?.eventType,
    description: play.result?.description,
    runners: (play.runners ?? []).map((r: any) => ({
      id: r.details?.runner?.id,
      originBase: r.movement?.originBase ?? null,
      end: r.movement?.end ?? null,
      isOut: r.movement?.isOut ?? false,
      credits: (r.credits ?? []).map((c: any) => [c.player?.id, c.credit])
    })),
    score: [play.result?.awayScore, play.result?.homeScore]
  }
}

let scorer = ''

describe('dictation, end to end', function () {
  this.timeout(600000)
  before(async function () {
    if (SCORER.password === '' || VIEWER.password === '')
      throw new Error('Set TS_SCORER_PASSWORD and TS_VIEWER_PASSWORD')
    scorer = await signIn(SCORER)
  })
  after(function () {
    execFileSync('rm', ['-rf', temp])
  })

  if (MODE === 'on') {
    it('E1: one dictated pitch moves the count and writes no play', async function () {
      const gameId = scoringGame().games[0]
      const { reply, heard, summary, browser } = await dictate(
        scorer,
        gameId,
        'ball'
      )
      try {
        const start = heard.sent.find(f => f.kind === 'start')!
        expect(
          heard.received.some(r => r.id === start.id && r.kind === 'partial')
        ).equals(true)
        expect(reply).deep.include({
          kind: 'actions',
          actions: [{ type: 'pitch', call: 'B' }]
        })
        expect(summary).includes('1 balls 0 strikes')
        expect((await stored(scorer, gameId)).plays).to.have.length(0)
        expect(heard.audioFrames).greaterThan(0)
      } finally {
        await browser.close()
      }
    })

    it('E1s: holding Space dictates, even with the field focused', async function () {
      const gameId = scoringGame().games[0]
      const { path } = clipFile('ball')
      const browser = await launch()
      try {
        const page = await open(browser, scorer, gameId, path)
        await switchOn(page)
        // The field takes focus when it is tapped; Space there would grab a
        // player, but with the mic on and the screen at rest it talks.
        await page.focus('[role="application"]')
        await page.keyboard.down('Space')
        await play(page)
        await new Promise(resolve => setTimeout(resolve, 600))
        await page.keyboard.up('Space')
        const reply = await answered(page)
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        expect(reply.actions).deep.equals([{ type: 'pitch', call: 'B' }])
        await waitSaved(page)
        expect(await summary(page)).includes('1 balls 0 strikes')
        const sent = (await heard(page)).sent.map(f => f.kind)
        expect(sent.filter(kind => kind === 'start')).to.have.length(1)
        expect(sent.at(-1)).equals('release')
        // The switch was not toggled by the key.
        expect(
          await page.$eval('[aria-label="Dictation"]', n =>
            n.getAttribute('aria-pressed')
          )
        ).equals('true')
      } finally {
        await browser.close()
      }
    })

    it('E2: a single with a runner scoring arrives in one reply, animates and posts', async function () {
      const gameId = scoringGame().games[0]
      // A walk, then a steal, puts the runner on second.
      const setup = await launch()
      try {
        const page = await open(setup, scorer, gameId)
        for (let n = 0; n < 4; n++) await tap(page, 'Ball')
        await finishAtBat(page)
        await waitSaved(page)
      } finally {
        await setup.close()
      }
      const steal = await dictate(scorer, gameId, 'fullPass2')
      await steal.browser.close()
      expect(steal.reply.kind).equals('actions')
      const { reply, page, browser } = await dictate(
        scorer,
        gameId,
        'singleRunnerScored',
        false
      )
      try {
        expect(reply.kind).equals('actions')
        const types = reply.actions.map((a: any) => a.type)
        expect(types).includes('result')
        expect(types).includes('runnerMovement')
        // The runners animate on the field.
        await page.waitForFunction(
          () =>
            document.querySelector('canvas[data-field-ready="true"]') != null
        )
        await finishAtBat(page)
        await waitSaved(page)
        expect(await summary(page)).match(/^Visitors [^·]* 1 · /)
        const game = await stored(scorer, gameId)
        const single = game.plays.find(
          p => p.gumbo.result?.eventType === 'single'
        )
        expect(single?.gumbo.result.awayScore).equals(1)
      } finally {
        await browser.close()
      }
    })

    it('E2b: "number six" is the fielder wearing 6, not the shortstop', async function () {
      // scoring-game gives the third baseman jersey 6 and the shortstop 5, so
      // reading "six" as a position would charge the wrong fielder.
      const gameId = scoringGame().games[0]
      const { reply, heard, page, browser } = await dictate(
        scorer,
        gameId,
        'errorByJersey',
        false
      )
      try {
        const context = String(
          heard.sent.find(f => f.kind === 'start')!.context
        )
        const third = /3B [^,]*#6 \(tag ([A-Z]{2}[0-9])\)/.exec(context)
        const short = /SS [^,]*#5 \(tag ([A-Z]{2}[0-9])\)/.exec(context)
        expect(third, context).not.equal(null)
        expect(short, context).not.equal(null)
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        const charged = reply.actions.find(
          (a: any) => a.type === 'fieldingPlay'
        )
        expect(charged?.error, JSON.stringify(reply.actions)).equals(
          idOfTag(third![1])
        )
        expect(
          reply.actions.find((a: any) => a.type === 'result')?.eventType
        ).equals('field_error')
        expect(await page.$('[aria-label="Dictation question"]')).equals(null)
        await finishAtBat(page)
        await waitSaved(page)
        expect(await summary(page)).includes('0 outs')
      } finally {
        await browser.close()
      }
    })

    it('E10: a hit runs the batter and the runner at once, while the ball flies', async function () {
      const gameId = scoringGame().games[0]
      await runnerOn(scorer, gameId, 'second')
      const { reply, shown, context, page, browser } = await dictateWatched(
        scorer,
        gameId,
        'singleToLeft'
      )
      try {
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        const batter = idIn(context, 'Batter')
        const runner = idIn(context, 'On second')
        const kinds = shown.map(moment => moment.presentation)
        expect(kinds).includes('hit:swing')
        expect(kinds).includes('hit:flight')
        expect(
          shown.some(
            moment =>
              moment.presentation === 'hit:flight' &&
              moment.moving.includes(batter) &&
              moment.moving.includes(runner)
          ),
          JSON.stringify(shown)
        ).equals(true)
        // Neither ran before the ball was hit.
        const contact = kinds.indexOf('hit:flight')
        expect(
          shown.slice(0, contact).some(moment => moment.moving.length > 0)
        ).equals(false)
        await finishAtBat(page)
        await waitSaved(page)
        expect(endsOf(await playOf(scorer, gameId, 'single'))).deep.equals({
          batter: '1B',
          '2B': '3B'
        })
      } finally {
        await browser.close()
      }
    })

    it('E11: a tag-up waits for the catch', async function () {
      const gameId = scoringGame().games[0]
      await runnerOn(scorer, gameId, 'third')
      const { reply, shown, context, page, browser } = await dictateWatched(
        scorer,
        gameId,
        'tagUp'
      )
      try {
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        const runner = idIn(context, 'On third')
        const flying = shown.filter(moment =>
          moment.presentation.startsWith('hit:')
        )
        expect(flying.length).greaterThan(0)
        expect(flying.some(moment => moment.moving.includes(runner))).equals(
          false
        )
        const caught = shown.findIndex(
          (moment, index) =>
            index > 0 &&
            moment.presentation === 'none' &&
            shown[index - 1].presentation.startsWith('hit:')
        )
        expect(caught).greaterThan(0)
        expect(
          shown.slice(caught).some(moment => moment.moving.includes(runner)),
          JSON.stringify(shown)
        ).equals(true)
        await finishAtBat(page)
        await waitSaved(page)
        expect(await summary(page)).match(/^Visitors [^·]* 1 · /)
      } finally {
        await browser.close()
      }
    })

    it('E12: a throw-out plays its throw after the hit', async function () {
      const gameId = scoringGame().games[0]
      const { reply, shown, page, browser } = await dictateWatched(
        scorer,
        gameId,
        'groundOut'
      )
      try {
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        const pictures: string[] = []
        for (const moment of shown)
          if (moment.presentation !== 'none') {
            const key = `${moment.id}|${moment.presentation}`
            if (pictures.at(-1) !== key) pictures.push(key)
          }
        expect(pictures.map(key => key.split('|')[1])).deep.equals([
          'hit:swing',
          'hit:flight',
          'throw:transfer'
        ])
        await waitSaved(page)
        expect(await summary(page)).includes('1 outs')
        // Credited as said: the shortstop's assist, the first baseman's out.
        const play = await playOf(scorer, gameId, 'field_out')
        expect(creditsOf(play)).deep.equals(['f_assist SS', 'f_putout 1B'])
        expect(endsOf(play)).deep.equals({ batter: 'out 1B' })
      } finally {
        await browser.close()
      }
    })

    it('E13: two dictated pitches play one after the other', async function () {
      const gameId = scoringGame().games[0]
      const { reply, shown, page, browser } = await dictateWatched(
        scorer,
        gameId,
        'ballStrike'
      )
      try {
        expect(reply.actions, JSON.stringify(reply)).deep.equals([
          { type: 'pitch', call: 'B' },
          { type: 'pitch', call: 'C' }
        ])
        const pitches = new Set(
          shown
            .filter(moment => moment.presentation === 'pitch:delivery')
            .map(moment => moment.id)
        )
        // One picture each, the second straight after the first.
        expect(pitches.size).equals(2)
        expect(await summary(page)).includes('1 balls 1 strikes')
      } finally {
        await browser.close()
      }
    })

    it('E17: settings offers no model, and dictation sends the default', async function () {
      this.timeout(300000)
      const offered = (
        (await (await fetch(`${API}/health`)).json()) as {
          dictationModels: string[]
        }
      ).dictationModels
      const model = dictationModelOf(undefined, offered)
      const gameId = scoringGame().games[0]
      const browser = await launch()
      try {
        const page = await open(
          browser,
          scorer,
          gameId,
          clipFile('ballStrike').path
        )
        await page.locator('[aria-label="Open scoring menu"]').click()
        await page.locator('[aria-label="Settings"]').click()
        await page.waitForSelector('[aria-label="Toggle scoring sound"]')
        expect(
          await page.$('[role="radiogroup"][aria-label="Dictation Model"]')
        ).equals(null)
        expect(await page.$$('[role="radio"]')).length(0)
        // The sheet is the screen's height, and a pull on its handle closes
        // it.
        const handle = (await (await page.$(
          '[aria-label="Pull down to close"]'
        ))!.boundingBox())!
        const done = (await (await page.$(
          '[aria-label="Done"]'
        ))!.boundingBox())!
        const height = await page.evaluate(() => window.innerHeight)
        expect(handle.y).lessThan(40)
        expect(done.y + done.height).greaterThan(height - 60)
        const x = handle.x + handle.width / 2
        const y = handle.y + handle.height / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        for (let step = 1; step <= 10; step++)
          await page.mouse.move(x, y + step * 30)
        await page.mouse.up()
        await page.waitForSelector('[aria-label="Done"]', { hidden: true })
        await switchOn(page)
        await hold(page)
        const reply = await answered(page)
        const start = (await heard(page)).sent.find(f => f.kind === 'start')
        expect(start?.model).equals(model)
        expect(
          (reply.actions as Array<{ call?: string }>)
            .map(action => String(action.call))
            .sort((a, b) => a.localeCompare(b)),
          JSON.stringify(reply)
        ).deep.equals(['B', 'C'])
        await waitSaved(page)
        expect(await summary(page)).includes('1 balls 1 strikes')
      } finally {
        await browser.close()
      }
    })

    it('E15: a fielder’s choice finishes itself', async function () {
      const gameId = scoringGame().games[0]
      await walks(scorer, gameId, 1)
      const { reply, page, browser } = await dictateWatched(
        scorer,
        gameId,
        'fieldersChoice'
      )
      try {
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        await finishAtBat(page)
        await nothingToTap(page)
        await waitSaved(page)
        expect(await summary(page)).includes('1 outs')
        // The runner out at second, the batter on first, and no credit
        // beyond the fielder who was named.
        const play = await playOf(scorer, gameId, 'force_out')
        expect(endsOf(play)).deep.equals({ '1B': 'out 2B', batter: '1B' })
        expect(
          creditsOf(play).filter(credit => !credit.startsWith('f_fielded_ball'))
        ).deep.equals([])
      } finally {
        await browser.close()
      }
    })

    it('E16: a fielder’s choice with two runners asks which were out', async function () {
      const gameId = scoringGame().games[0]
      await walks(scorer, gameId, 2)
      const { reply, page, browser } = await dictate(
        scorer,
        gameId,
        'fieldersChoice',
        false
      )
      try {
        // The LLM sends the play; the screen asks, in a modal, which runners
        // were out.
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        await page.waitForSelector('[aria-label="Dictation question"]')
        const box = '[aria-label="Visitor 01 out at third"]'
        await page.waitForSelector(box)
        expect(
          await page.$('[aria-label="Visitor 02 out at second"]')
        ).not.equal(null)
        // Nothing else can be scored while it is open: the modal is on top
        // of Ball, and a click there does not reach it.
        const ball = await page.$eval('[aria-label="Ball"]', node => {
          const r = node.getBoundingClientRect()
          const x = r.x + r.width / 2
          const y = r.y + r.height / 2
          const top = document.elementFromPoint(x, y)
          return { x, y, covered: top == null || !node.contains(top) }
        })
        expect(ball.covered).equals(true)
        await page.mouse.click(ball.x, ball.y)
        expect(await page.$('[aria-label="Dictation question"]')).not.equal(
          null
        )
        await page.locator(box).click()
        await page.locator('[aria-label="Record"]').click()
        await finishAtBat(page)
        await nothingToTap(page)
        await waitSaved(page)
        expect(await summary(page)).includes('1 outs')
        expect(await summary(page)).includes('0 balls')
        const play = await playOf(scorer, gameId, 'force_out')
        expect(endsOf(play)).deep.equals({
          '2B': 'out 3B',
          '1B': '2B',
          batter: '1B'
        })
        // The whole sentence is one Undo step.
        const undo = await page.$eval('[aria-label^="Undo "]', n =>
          n.getAttribute('aria-label')
        )
        await page.locator(`[aria-label="${undo}"]`).click()
        await waitSaved(page)
        expect(await summary(page)).includes('0 outs')
      } finally {
        await browser.close()
      }
    })

    it('E18: a steal names its runner by base, or by being the only one, and a double steal goes lead first', async function () {
      for (const clip of ['heStealsThird', 'doubleSteal', 'heSteals']) {
        const gameId = scoringGame().games[0]
        await walks(scorer, gameId, clip === 'heSteals' ? 1 : 2)
        const { reply, heard, page, browser } = await dictate(
          scorer,
          gameId,
          clip
        )
        try {
          expect(reply.kind, `${clip}: ${JSON.stringify(reply)}`).equals(
            'actions'
          )
          const context = String(
            heard.sent.find(f => f.kind === 'start')!.context
          )
          const first = idIn(context, 'On first')
          const steals = Object.fromEntries(
            (reply.actions as Array<Record<string, any>>)
              .filter(action => action.type === 'baseRunning')
              .map(action => [action.runner, `${action.kind} ${action.to}`])
          )
          expect(steals, clip).deep.equals(
            clip === 'heSteals'
              ? { [first]: 'steal 2B' }
              : clip === 'heStealsThird'
                ? { [idIn(context, 'On second')]: 'steal 3B' }
                : {
                    [idIn(context, 'On second')]: 'steal 3B',
                    [first]: 'steal 2B'
                  }
          )
          // Applied, whichever order it came in: nothing refused, and the
          // Undo control reads the lead runner's steal.
          expect(await page.$('[aria-label="Dictation message"]')).equals(null)
          const undo = await page.$eval(
            '[aria-label^="Undo "]',
            node => node.textContent
          )
          expect(undo).includes(
            clip === 'heSteals' ? 'steals second' : 'steals third'
          )
          if (clip === 'doubleSteal') expect(undo).includes('steals second')
        } finally {
          await browser.close()
        }
      }
    })

    it('E19: the log has what was said on the right, what was done on the left, and Undo by voice', async function () {
      const gameId = scoringGame().games[0]
      const first = await dictate(scorer, gameId, 'ball')
      try {
        expect(first.reply.kind, JSON.stringify(first.reply)).equals('actions')
        expect(first.summary).includes('1 balls')
        const styleOf = async (
          label: string
        ): Promise<{ align: string; color: string; text: string }> =>
          await first.page.$eval(`[aria-label="${label}"]`, node => {
            const style = getComputedStyle(node)
            return {
              align: style.textAlign,
              color: style.color,
              text: String(node.textContent)
            }
          })
        const said = await styleOf('Dictated text')
        expect(said.align).equals('right')
        expect(said.color).equals('rgb(255, 255, 255)')
        const done = await styleOf('Dictated play')
        expect(done).deep.include({ align: 'left', text: 'Ball' })
        expect(done.color).not.equals('rgb(255, 255, 255)')
      } finally {
        await first.browser.close()
      }
      // Undo and a new pitch in one sentence: the ball is taken back first.
      const board = async (page: Page, count: string): Promise<void> => {
        await page.waitForFunction(
          want => {
            const node = document.querySelector('[aria-label*=" balls "]')
            return (
              node != null &&
              String(node.getAttribute('aria-label')).includes(want)
            )
          },
          {},
          count
        )
      }
      const scratch = await dictate(scorer, gameId, 'scratchStrike')
      try {
        expect(scratch.reply, JSON.stringify(scratch.reply)).deep.include({
          kind: 'actions',
          undo: true
        })
        await board(scratch.page, '0 balls 1 strikes')
        const log = await scratch.page.$eval(
          '[aria-label="Dictation log"]',
          node => node.textContent
        )
        expect(log).includes('Undid Ball')
        expect(log).includes('Called strike')
        await waitSaved(scratch.page)
      } finally {
        await scratch.browser.close()
      }
      const undo = await dictate(scorer, gameId, 'undoLast')
      try {
        expect(undo.reply, JSON.stringify(undo.reply)).deep.include({
          kind: 'actions',
          actions: [],
          undo: true
        })
        await board(undo.page, '0 balls 0 strikes')
        expect(
          await undo.page.$eval(
            '[aria-label="Dictation log"]',
            node => node.textContent
          )
        ).includes('Undid Called strike')
        await waitSaved(undo.page)
        const current = (await stored(scorer, gameId)).currentPlay
        expect(
          ((current?.playEvents ?? []) as Array<Record<string, any>>).filter(
            event => event.details?.call?.code != null
          )
        ).to.have.length(0)
      } finally {
        await undo.browser.close()
      }
    })

    it('E20: where the ball went, a caught foul, a foul tip, and a throw home', async function () {
      // Where a stored ball in play went: its angle from straight away, the
      // saved coordinates being MLB's, with home at (125, 204).
      const spray = (
        play: Record<string, any>
      ): { angle: number; fair: boolean; trajectory: string } => {
        const hit = (play.playEvents as Array<Record<string, any>>).find(
          event => event.hitData != null
        )!.hitData
        const x = Number(hit.coordinates.coordX) - 125
        const y = 204 - Number(hit.coordinates.coordY)
        return {
          angle: (Math.atan2(x, y) * 180) / Math.PI,
          fair: Math.abs(x) <= y,
          trajectory: String(hit.trajectory)
        }
      }
      const undoText = async (page: Page): Promise<string> =>
        String(
          await page.$eval('[aria-label^="Undo "]', node => node.textContent)
        )
      {
        const gameId = scoringGame().games[0]
        const { reply, page, browser } = await dictate(
          scorer,
          gameId,
          'singleLeftCenter'
        )
        try {
          expect(reply.kind, JSON.stringify(reply)).equals('actions')
          expect(await undoText(page)).includes(
            'line drive single to left center'
          )
          await finishAtBat(page)
          await waitSaved(page)
          const hit = spray(await playOf(scorer, gameId, 'single'))
          expect(hit.angle).within(-20, -10)
          expect(hit.trajectory).equals('line_drive')
        } finally {
          await browser.close()
        }
      }
      {
        const gameId = scoringGame().games[0]
        const { reply, page, browser } = await dictate(
          scorer,
          gameId,
          'foulCaughtFirst'
        )
        try {
          expect(reply.kind, JSON.stringify(reply)).equals('actions')
          expect(await undoText(page)).includes('fouls out to first')
          await finishAtBat(page)
          await waitSaved(page)
          const play = await playOf(scorer, gameId, 'field_out')
          expect(play.result.description).equals('Foul ball caught')
          expect(spray(play).fair).equals(false)
        } finally {
          await browser.close()
        }
      }
      // Said with no fielder: a caught foul is the corner infielder's away
      // from the batter, a fly sent left center the center fielder's.
      for (const clip of ['foulCaught', 'flyLeftCenter']) {
        const gameId = scoringGame().games[0]
        const { reply, page, browser } = await dictate(scorer, gameId, clip)
        try {
          expect(reply.kind, JSON.stringify(reply)).equals('actions')
          expect(await summary(page)).includes('1 outs')
          expect(await undoText(page)).includes(
            clip === 'foulCaught' ? 'fouls out' : 'to left center'
          )
          await finishAtBat(page)
          await waitSaved(page)
          const play = await playOf(scorer, gameId, 'field_out')
          expect(
            creditsOf(play).some(credit => credit.startsWith('f_putout'))
          ).equals(true)
          if (clip === 'flyLeftCenter')
            expect(creditsOf(play)).includes('f_putout CF')
        } finally {
          await browser.close()
        }
      }
      {
        const gameId = scoringGame().games[0]
        const setup = await launch()
        try {
          const page = await open(setup, scorer, gameId)
          await tap(page, 'Called Strike')
          await tap(page, 'Called Strike')
          await waitSaved(page)
        } finally {
          await setup.close()
        }
        const {
          reply,
          summary: board,
          browser
        } = await dictate(scorer, gameId, 'foulTip')
        try {
          expect(reply.actions, JSON.stringify(reply)).deep.equals([
            { type: 'pitch', call: 'F' }
          ])
          expect(board).includes('0 balls 2 strikes 0 outs')
        } finally {
          await browser.close()
        }
      }
      {
        const gameId = scoringGame().games[0]
        await runnerOn(scorer, gameId, 'third')
        const { reply, page, browser } = await dictate(
          scorer,
          gameId,
          'tagThrownHome'
        )
        try {
          expect(reply.kind, JSON.stringify(reply)).equals('actions')
          expect(await summary(page)).includes('2 outs')
          await finishAtBat(page)
          await waitSaved(page)
          const play = (await stored(scorer, gameId)).plays
            .map(each => each.gumbo)
            .at(-1)!
          const credits = creditsOf(play)
          for (const credit of ['f_putout CF', 'f_assist CF', 'f_putout C'])
            expect(credits, JSON.stringify(credits)).includes(credit)
          // Gumbo names home 4B.
          expect(endsOf(play)).deep.include({ '3B': 'out 4B' })
        } finally {
          await browser.close()
        }
      }
    })

    it('E21: a steal whose runner scored, and a caught foul with a runner tagging up', async function () {
      {
        const gameId = scoringGame().games[0]
        await runnerOn(scorer, gameId, 'second')
        const { reply, page, browser } = await dictate(
          scorer,
          gameId,
          'stealScores'
        )
        try {
          expect(reply.kind, JSON.stringify(reply)).equals('actions')
          expect(await page.$('[aria-label="Dictation message"]')).equals(null)
          expect(
            await page.$eval('[aria-label^="Undo "]', node => node.textContent)
          ).includes('steals third')
          await waitSaved(page)
          // The steal is of third, and the runner then scores: no steal of
          // home from second.
          const moves = (
            ((await stored(scorer, gameId)).currentPlay?.runners ??
              []) as Array<Record<string, any>>
          ).map(
            runner =>
              `${String(runner.movement.start)}>${String(runner.movement.end ?? 'score')}`
          )
          trace(`stealScores moves ${JSON.stringify(moves)}`)
          expect(moves).includes('2B>3B')
          expect(moves.some(move => /^3B>(4B|score)$/.test(move))).equals(true)
          expect(moves.some(move => /^2B>(4B|score)$/.test(move))).equals(false)
        } finally {
          await browser.close()
        }
      }
      {
        const gameId = scoringGame().games[0]
        await runnerOn(scorer, gameId, 'second')
        const { reply, page, browser } = await dictate(
          scorer,
          gameId,
          'foulPopTagThird'
        )
        try {
          expect(reply.kind, JSON.stringify(reply)).equals('actions')
          await finishAtBat(page)
          await waitSaved(page)
          const play = await playOf(scorer, gameId, 'field_out')
          expect(play.result.description).equals('Foul ball caught')
          // Away from the batter, whatever the runner's "to third".
          const away = play.matchup?.batSide?.code === 'L' ? '3B' : '1B'
          expect(creditsOf(play)).includes(`f_putout ${away}`)
        } finally {
          await browser.close()
        }
      }
    })

    it('E3: a play the rules engine refuses is shown and nothing changes', async function () {
      const gameId = scoringGame().games[0]
      const { reply, page, browser } = await dictate(
        scorer,
        gameId,
        'stealThird',
        false
      )
      try {
        // The LLM sees the bases are empty and usually asks; when it sends
        // the steal anyway, the rules engine refuses it. Either way the
        // scorer is told why on screen, and nothing is applied.
        expect(await shown(page), JSON.stringify(reply))
          .is.a('string')
          .and.not.equal('')
        if (reply.kind === 'actions')
          expect(reply.actions.map((a: any) => a.type)).includes('baseRunning')
        expect(await summary(page)).includes('0 balls 0 strikes 0 outs')
        await new Promise(resolve => setTimeout(resolve, 1500))
        expect((await stored(scorer, gameId)).plays).to.have.length(0)
        expect((await stored(scorer, gameId)).currentPlay).equals(null)
      } finally {
        await browser.close()
      }
    })

    it('E3c: a sentence while a play is being drawn is refused whole, with the reason', async function () {
      const gameId = scoringGame().games[0]
      const { path } = clipFile('ball')
      const browser = await launch()
      try {
        const page = await open(browser, scorer, gameId, path)
        await switchOn(page)
        // A single chosen, the fielder not yet placed.
        await tap(page, 'Swing in Play')
        await page.locator('[aria-label="Single"]').click()
        await page.waitForSelector(
          '[aria-label^="Tap or drag a player to where the ball was fielded"]'
        )
        await hold(page)
        const reply = await answered(page)
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        expect(await shown(page)).equals(
          'Finish what is on screen, then say it again'
        )
        // The ball was not applied: the screen is still asking for the fielder.
        expect(
          await page.$(
            '[aria-label^="Tap or drag a player to where the ball was fielded"]'
          )
        ).not.equal(null)
        // Nothing from the sentence was saved: the play in progress, if the
        // screen has saved it, carries no ball.
        await new Promise(resolve => setTimeout(resolve, 1500))
        const game = await stored(scorer, gameId)
        expect(game.plays).to.have.length(0)
        const balls = (game.currentPlay?.playEvents ?? []).filter(
          (event: any) => event.details?.call?.code === 'B'
        )
        expect(balls).to.have.length(0)
        expect(await summary(page)).not.match(/1 balls/)
      } finally {
        await browser.close()
      }
    })

    it('E3b: "whiffed, K" is one pitch; "beaned" is a hit by pitch; a dropped third strike is the only result strikeout', async function () {
      const fixture = scoringGame()
      const gameId = fixture.games[0]
      const setup = await launch()
      try {
        const page = await open(setup, scorer, gameId)
        await tap(page, 'Ball')
        await tap(page, 'Called Strike')
        await tap(page, 'Swing and Miss')
        await waitSaved(page)
      } finally {
        await setup.close()
      }
      const k = await dictate(scorer, gameId, 'whiffedK')
      try {
        k.reply = await settled(k.page, k.reply)
        expect(k.reply.actions).deep.equals([{ type: 'pitch', call: 'S' }])
        // The strikeout is recorded from that pitch, and the next batter starts at 0-0.
        await finishAtBat(k.page)
        await waitSaved(k.page)
        expect(await summary(k.page)).includes('0 balls 0 strikes 1 outs')
      } finally {
        await k.browser.close()
      }
      const hbp = await dictate(scorer, gameId, 'beaned')
      try {
        hbp.reply = await settled(hbp.page, hbp.reply)
        expect(hbp.reply.actions).deep.equals([
          { type: 'result', eventType: 'hit_by_pitch' }
        ])
      } finally {
        await hbp.browser.close()
      }
      // A fresh game: two strikes, first base empty.
      const dropped = scoringGame().games[0]
      const two = await launch()
      try {
        const page = await open(two, scorer, dropped)
        await tap(page, 'Called Strike')
        await tap(page, 'Called Strike')
        await waitSaved(page)
      } finally {
        await two.close()
      }
      const d3k = await dictate(scorer, dropped, 'droppedThirdStrike', false)
      try {
        // The LLM may ask whether the batter was safe; each option it offers
        // still carries the strikeout, and that is what is checked.
        d3k.reply = await settled(d3k.page, d3k.reply)
        expect(d3k.reply.kind, JSON.stringify(d3k.reply)).equals('actions')
        expect(
          d3k.reply.actions.map((a: any) => [a.type, a.eventType ?? null])
        ).deep.include(['result', 'strikeout'])
      } finally {
        await d3k.browser.close()
      }
    })

    it('E4: speech outside a hold goes nowhere', async function () {
      const gameId = scoringGame().games[0]
      const { path } = clipFile('ball')
      const browser = await launch()
      try {
        const page = await open(browser, scorer, gameId, path)
        const logBefore = API_LOG == null ? '' : readFileSync(API_LOG, 'utf8')
        // Switched off: the clip plays into a microphone nobody opened.
        await page.waitForSelector('[aria-label="Dictation"]', {
          timeout: 30000
        })
        await play(page)
        expect((await heard(page)).sent).to.have.length(0)
        expect(
          await page.evaluate(() => (window as any).__dictation.sockets.length)
        ).equals(0)
        // Switched on, and the scorer speaks without holding the button.
        await switchOn(page)
        await play(page)
        await new Promise(resolve => setTimeout(resolve, 2000))
        const after = await heard(page)
        expect(after.sent.map(f => f.kind)).deep.equals(['keyterms'])
        expect(after.audioFrames).equals(0)
        expect(after.received).to.have.length(0)
        expect(
          await page.$('[aria-label="Dictated text"]'),
          'no transcript'
        ).equals(null)
        expect(await summary(page)).includes('0 balls 0 strikes')
        // No utterance began, so the route logged none.
        if (API_LOG != null)
          expect(
            readFileSync(API_LOG, 'utf8').slice(logBefore.length)
          ).not.match(/dictation u/)
      } finally {
        await browser.close()
      }
    })

    it('E6: a socket that drops mid-utterance loses that utterance only', async function () {
      const gameId = scoringGame().games[0]
      const { path } = clipFile('ball')
      const browser = await launch()
      try {
        const page = await open(browser, scorer, gameId, path)
        await switchOn(page)
        const button = await page.$('[aria-label="Dictation"]')
        const box = await button!.boundingBox()
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
        await page.mouse.down()
        const speaking = play(page)
        await new Promise(resolve => setTimeout(resolve, 400))
        // The socket goes mid-sentence; the hook sees the same close a server
        // that dropped it would give.
        await page.evaluate(() => {
          for (const socket of (window as any).__dictation.sockets)
            socket.close(4000, 'dropped')
        })
        await speaking
        await page.mouse.up()
        await page.waitForFunction(() => {
          const message = document.querySelector(
            '[aria-label="Dictation message"]'
          )
          return (
            message != null &&
            String(message.textContent).includes('connection dropped')
          )
        })
        expect(await summary(page)).includes('0 balls 0 strikes')
        expect((await stored(scorer, gameId)).plays).to.have.length(0)
        // It comes back on its own, key terms first.
        await page.waitForFunction(
          () => (window as any).__dictation.sockets.length === 2,
          { timeout: 15000 }
        )
        await ready(page)
        const keyterms = (await heard(page)).sent.filter(
          f => f.kind === 'keyterms'
        )
        expect(keyterms).to.have.length(2)
        // The next hold, on the socket it reopened, transcribes and applies.
        await hold(page)
        const reply = await answered(page)
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        expect(reply.actions).deep.equals([{ type: 'pitch', call: 'B' }])
        await waitSaved(page)
        expect(await summary(page)).includes('1 balls 0 strikes')
      } finally {
        await browser.close()
      }
    })

    it('E6b: two players with one first name make the LLM ask, and the answer applies', async function () {
      const fixture = scoringGame()
      const gameId = fixture.games[0]
      // The first two visitors share a first name, and both walk: a sentence
      // naming only "Chase" could be about either runner.
      sql(
        `update users set first_name = 'Chase', last_name = 'Lee', display_name = 'Chase Lee' where id = ${fixture.away[0]}`
      )
      sql(
        `update users set first_name = 'Chase', last_name = 'Moore', display_name = 'Chase Moore' where id = ${fixture.away[1]}`
      )
      const setup = await launch()
      try {
        const page = await open(setup, scorer, gameId)
        for (let batter = 0; batter < 2; batter++) {
          for (let n = 0; n < 4; n++) await tap(page, 'Ball')
          await finishAtBat(page)
        }
        await waitSaved(page)
      } finally {
        await setup.close()
      }
      spoken('chaseSingled', 'Chase was picked off.')
      const plays = async (): Promise<number> =>
        (await stored(scorer, gameId)).plays.length
      const before = await plays()
      // Dismissed: nothing is applied, and the button is free again.
      const first = await dictate(scorer, gameId, 'chaseSingled', false)
      try {
        expect(first.reply.kind, JSON.stringify(first.reply)).equals('ask')
        await first.page.locator('[aria-label="Dismiss question"]').click()
        await first.page.waitForFunction(
          () =>
            document.querySelector('[aria-label="Dictation question"]') == null
        )
        expect((await heard(first.page)).sent.at(-1)?.kind).equals('dismiss')
        expect(
          await first.page.$eval(
            '[aria-label="Dictation status"]',
            n => n.textContent
          )
        ).equals('Push to talk')
        expect(await plays()).equals(before)
      } finally {
        await first.browser.close()
      }
      // Answered: the choice applies to that runner.
      const second = await dictate(scorer, gameId, 'chaseSingled', false)
      try {
        expect(second.reply.kind, JSON.stringify(second.reply)).equals('ask')
        expect(second.reply.options.length).within(2, 5)
        const labels = second.reply.options.map((o: any) => o.label).join(' ')
        expect(labels).includes('Chase')
        const choice = second.reply.options[0].label as string
        const replies = (await heard(second.page)).received.length
        await second.page.locator(`[aria-label="${choice}"]`).click()
        await second.page.waitForFunction(
          count =>
            (window as any).__dictation.received
              .slice(count)
              .some((r: any) => r.kind === 'actions' || r.kind === 'error'),
          { timeout: 120000 },
          replies
        )
        const reply = (await heard(second.page)).received.at(-1)!
        expect(reply.kind, JSON.stringify(reply)).equals('actions')
        await waitSaved(second.page)
        expect(await summary(second.page)).includes('1 outs')
      } finally {
        await second.browser.close()
      }
    })

    it('E7: a dictated half inning and a tapped one make the same game', async function () {
      const fixture = scoringGame(2)
      const [tapped, dictated] = fixture.games
      const setup = await launch()
      try {
        const page = await open(setup, scorer, tapped)
        const hitTo = async (
          outcome: string,
          slot: number,
          angle: number
        ): Promise<void> => {
          await tap(page, 'Swing in Play')
          if (['Throw Out', 'Ball Caught'].includes(outcome))
            await page.locator('[aria-label="Batter Out"]').click()
          await page.locator(`[aria-label="${outcome}"]`).click()
          await page.waitForSelector(
            '[aria-label^="Tap or drag a player to where the ball was fielded"]'
          )
          await page.focus('[role="application"]')
          for (let i = 0; i <= slot; i++) await page.keyboard.press(']')
          await frame(page)
          await page.keyboard.press('Space')
          await page.keyboard.press('ArrowUp')
          await page.keyboard.press('Enter')
          await page.waitForSelector(
            '[aria-label^="Drag up and down for ball trajectory."]'
          )
          for (let value = 45; value > angle; value--)
            await page.keyboard.press('ArrowDown')
          await frame(page)
          await page.keyboard.press('Enter')
        }
        await tap(page, 'Ball')
        await tap(page, 'Called Strike')
        await hitTo('Single', 7, 15)
        await finishAtBat(page)
        await tap(page, 'Called Strike')
        await tap(page, 'Swing and Miss')
        await tap(page, 'Swing and Miss')
        await finishAtBat(page)
        await hitTo('Throw Out', 4, -10)
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        await page.focus('[role="application"]')
        await frame(page)
        await frame(page)
        for (let i = 0; i < 3; i++) await page.keyboard.press(']')
        await frame(page)
        await page.keyboard.press('Space')
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('Enter')
        await page.locator('[aria-label="Finish defensive play"]').click()
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        await page.waitForSelector('canvas[data-field-ready="true"]')
        await page.focus('[role="application"]')
        await page.keyboard.press('Space')
        for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp')
        await page.keyboard.press('s')
        await page.keyboard.press('Enter')
        await finishAtBat(page)
        await hitTo('Ball Caught', 6, 40)
        await finishAtBat(page)
        await waitSaved(page)
      } finally {
        await setup.close()
      }
      for (const clip of [
        'halfInning1',
        'halfInning2',
        'halfInning3',
        'halfInning4'
      ]) {
        const { reply, browser, page } = await dictate(scorer, dictated, clip)
        try {
          expect(reply.kind, `${clip}: ${JSON.stringify(reply)}`).equals(
            'actions'
          )
          if (clip === 'halfInning4') {
            await finishAtBat(page)
            await waitSaved(page)
          }
        } finally {
          await browser.close()
        }
      }
      const a = (await stored(scorer, tapped)).plays.map(p =>
        projection(p.gumbo)
      )
      const b = (await stored(scorer, dictated)).plays.map(p =>
        projection(p.gumbo)
      )
      expect(b).deep.equals(a)
    })

    it('E9: a half inning in one sitting, with a steal, a refusal re-dictated and an undo', async function () {
      const gameId = scoringGame().games[0]
      const say = async (
        clip: string,
        expected: 'actions' | 'refused' = 'actions'
      ): Promise<string> => {
        const { reply, browser, page, summary } = await dictate(
          scorer,
          gameId,
          clip,
          expected === 'actions'
        )
        try {
          if (expected === 'refused') {
            // Refused by the rules engine, or questioned by the LLM first;
            // either way nothing is applied, and the scorer says it again.
            let message: unknown = reply.message
            if (reply.kind === 'actions')
              message = await page.$eval(
                '[aria-label="Dictation message"]',
                n => n.textContent
              )
            if (reply.kind === 'ask') {
              message = reply.question
              expect(await shown(page)).includes(String(reply.question))
              await page.locator('[aria-label="Dismiss question"]').click()
            }
            expect(message, clip).is.a('string').and.not.equal('')
          } else
            expect(reply.kind, `${clip}: ${JSON.stringify(reply)}`).equals(
              'actions'
            )
          return summary
        } finally {
          await browser.close()
        }
      }
      await say('fullPass1')
      await say('fullPass2')
      await say('fullPass3')
      const before = (await stored(scorer, gameId)).plays.length
      await say('fullPass4', 'refused')
      expect((await stored(scorer, gameId)).plays).to.have.length(before)
      await say('fullPass5')
      // The ground out again, undone as one sentence, then said once more.
      const undo = await dictate(scorer, gameId, 'fullPass6')
      try {
        const scored = (await stored(scorer, gameId)).plays.length
        const label = `Undo ${String(undo.reply.transcript)}`
        await undo.page.locator(`[aria-label="${label}"]`).click()
        await waitSaved(undo.page)
        expect((await stored(scorer, gameId)).plays.length).lessThan(scored + 1)
        expect(await summary(undo.page)).includes('1 outs')
      } finally {
        await undo.browser.close()
      }
      await say('fullPass6')
      await say('fullPass7')
      await say('fullPass8')
      const end = await say('fullPass9')
      expect(end).match(/3 outs|Bottom|bottom/)
      const game = await stored(scorer, gameId)
      const runs = game.plays.at(-1)?.gumbo.result?.awayScore
      expect(runs).equals(1)
    })
  }

  if (MODE === 'providerDown')
    it('E5: with the LLM unreachable the transcript shows, the error names it, and tapping still works', async function () {
      const gameId = scoringGame().games[0]
      const { reply, heard, page, browser } = await dictate(
        scorer,
        gameId,
        'ball',
        false
      )
      try {
        expect(heard.received.some(r => r.kind === 'transcript')).equals(true)
        expect(reply.kind).equals('error')
        const message = await page.$eval(
          '[aria-label="Dictation message"]',
          n => n.textContent
        )
        expect(message).match(/could not be reached|answered|no answer/)
        expect(await summary(page)).includes('0 balls 0 strikes')
        await tap(page, 'Ball')
        expect(await summary(page)).includes('1 balls')
      } finally {
        await browser.close()
      }
    })

  if (MODE === 'off')
    it('E8: with dictation not configured there is no button and no socket, and tapping works', async function () {
      const health = (await (await fetch(`${API}/health`)).json()) as {
        dictation: boolean
      }
      expect(health.dictation).equals(false)
      // Signed in, so a refusal can only mean there is no route to refuse it.
      const status = await new Promise<number>(resolve => {
        const socket = new NodeSocket(
          API.replace(/^http/, 'ws') + '/dictation',
          {
            headers: { authorization: `Bearer ${scorer}` }
          }
        )
        socket.on('open', () => {
          socket.close()
          resolve(101)
        })
        socket.on('unexpected-response', (_request, response) => {
          resolve(response.statusCode ?? 0)
        })
        socket.on('error', () => undefined)
      })
      expect(status).equals(404)
      const gameId = scoringGame().games[0]
      const browser = await launch()
      try {
        const page = await open(browser, scorer, gameId)
        await tap(page, 'Ball')
        await new Promise(resolve => setTimeout(resolve, 1000))
        expect(await page.$('[aria-label="Dictation"]')).equals(null)
        expect(await summary(page)).includes('1 balls')
      } finally {
        await browser.close()
      }
    })
})
