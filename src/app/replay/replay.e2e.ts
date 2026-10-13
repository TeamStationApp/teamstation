import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TeamStationClient } from '../../common/api'
import {
  replayContextOf,
  replayTimelineOf
} from '../../common/replay/replayTimeline'
import {
  artifactsDir,
  attachWeb,
  connect,
  type Device,
  required,
  sessionFor,
  shot,
  signInWeb
} from './kit.e2e'

/**
 * The replay in Chromium at a phone's size, against a server and web build
 * with the replay seed loaded (`src/server/dev/replaySeed.ts`).
 *
 *   REPLAY_SCENARIO=pills REPLAY_PHASE=before|after [REPLAY_PILLS=final,live]
 *     The pills under the final and the in-progress game's hero card.
 *     `before` expects no Replay or Live pill; `after` expects them.
 *
 *   REPLAY_SCENARIO=replay
 *     The final game's replay from its pill: the controls, the pitch pacing,
 *     the first home run, pause and play, the box score's pitchers, Exit,
 *     the imported game with nothing to replay, and the wide layout.
 *
 *   REPLAY_SCENARIO=announcer   (the server's `speech` set)
 *     The announcer through the first half-inning: every sentence played as
 *     its step is shown, none over another, pause and play mid-sentence, and
 *     muting silencing it at once. Writes narration-first-half.log and the
 *     served audio, narration-first-half.mp3.
 *
 *   REPLAY_SCENARIO=noAnnouncer   (the server's `speech` removed)
 *     The replay offers no speaker.
 *
 * The seed's game ids are fixed; REPLAY_FINAL, REPLAY_LIVE and
 * REPLAY_IMPORTED override them.
 */

const FINAL = process.env.REPLAY_FINAL ?? 'gam_replaySeedFinal'
const LIVE = process.env.REPLAY_LIVE ?? 'gam_replaySeedLive'
const IMPORTED = process.env.REPLAY_IMPORTED ?? 'gam_replaySeedImported'
const LEAGUE = 'replay-league@example.test'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A script's JSON result, whatever envelope the daemon wraps it in. */
async function evalJson<T>(m: Device, body: string): Promise<T> {
  const result = await m.evalBrowserScript({
    script: `return '<<' + JSON.stringify((() => { ${body} })()) + '>>'`
  })
  let text = JSON.stringify(result)
  // Unwrap however many times the result was encoded as a string.
  while (!/<<(.*)>>/s.test(text) || text.includes('\\"')) {
    const inner = /"<<(.*)>>"/s.exec(text)
    if (inner == null) break
    text = JSON.parse(`"<<${inner[1]}>>"`) as string
  }
  const match = /<<(.*)>>/s.exec(text)
  assert.ok(match != null, `no result in ${text.slice(0, 200)}`)
  return JSON.parse(match[1]) as T
}

/**
 * A video of the page from back-to-back screenshots, each shown for as long
 * as it was on screen, since maestro-d records no video on the web.
 */
function screenRecorder(m: Device): { stop: (path: string) => Promise<void> } {
  const frames: Array<{ file: string; at: number }> = []
  const state = { running: true }
  const dir = mkdtemp(join(tmpdir(), 'replay-frames-'))
  const loop = (async () => {
    const into = await dir
    while (state.running) {
      const file = join(
        into,
        `frame-${String(frames.length).padStart(5, '0')}.png`
      )
      await writeFile(file, await m.screenshot())
      frames.push({ file, at: Date.now() })
    }
  })()
  return {
    async stop(path) {
      state.running = false
      await loop
      const end = Date.now()
      const list = frames
        .map(
          (frame, i) =>
            `file '${frame.file}'\nduration ${(((frames[i + 1]?.at ?? end) - frame.at) / 1000).toFixed(3)}`
        )
        .join('\n')
      const listFile = join(await dir, 'frames.txt')
      await writeFile(listFile, `${list}\nfile '${frames.at(-1)!.file}'\n`)
      const made = spawnSync(
        'ffmpeg',
        [
          '-nostdin',
          '-loglevel',
          'error',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listFile,
          '-vf',
          'pad=ceil(iw/2)*2:ceil(ih/2)*2',
          '-fps_mode',
          'vfr',
          '-pix_fmt',
          'yuv420p',
          '-y',
          path
        ],
        { stdio: 'inherit' }
      )
      assert.equal(made.status, 0, 'ffmpeg made no video')
      console.log(
        `video: ${frames.length} frames over ${((end - frames[0].at) / 1000).toFixed(1)} s`
      )
    }
  }
}

const CARD = `document.querySelector('[data-testid="replay-play-card"]')?.textContent ?? ''`

async function openGame(m: Device, gameId: string): Promise<void> {
  await m.openBrowser({ url: `${required('REPLAY_WEB_URL')}/games/${gameId}` })
  await m.assertVisible({ text: 'Box score', timeout: 20000 })
  await m.evalBrowserScript({ script: 'window.scrollTo(0, 0)' })
}

/** The labels of the game page's section pills, in order. */
async function pillLabels(m: Device): Promise<string[]> {
  const result = await m.evalBrowserScript({
    script: `
      const row = document.querySelector('[aria-label="Game sections"]');
      if (!row) throw new Error('No game section pills');
      return JSON.stringify([...row.querySelectorAll('[role="tab"], [role="button"]')]
        .map(node => node.textContent.trim()).filter(Boolean));
    `
  })
  const text = JSON.stringify(result)
  const match = /\[[^\]]*\]/.exec(text.replace(/\\"/g, '"'))
  return match == null ? [] : (JSON.parse(match[0]) as string[])
}

async function pills(m: Device): Promise<void> {
  const phase = required('REPLAY_PHASE')
  const wanted = (process.env.REPLAY_PILLS ?? 'final,live').split(',')
  await signInWeb(m, LEAGUE)
  for (const [name, gameId, label] of [
    ['final', FINAL, 'Replay'],
    ['live', LIVE, 'Live']
  ] as const) {
    if (!wanted.includes(name)) continue
    await openGame(m, gameId)
    const labels = await pillLabels(m)
    console.log(`${name} pills: ${labels.join(', ')}`)
    assert.ok(labels.length >= 2, `${name}: no pills read`)
    if (phase === 'after')
      assert.ok(labels.includes(label), `${name}: pills ${labels.join(', ')}`)
    else
      assert.ok(!labels.includes(label), `${name}: pills ${labels.join(', ')}`)
    await shot(m, `game-pills-${name}-${phase}`)
  }
}

/** Waits until `ready` holds for the card's text, and returns it. */
async function cardUntil(
  m: Device,
  what: string,
  ready: (text: string) => boolean,
  ms: number
): Promise<string> {
  const deadline = Date.now() + ms
  for (;;) {
    const text = await evalJson<string>(m, `return ${CARD}`)
    if (ready(text)) return text
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}; the card says ${text}`)
    await wait(200)
  }
}

async function replay(m: Device): Promise<void> {
  await signInWeb(m, LEAGUE)
  await openGame(m, FINAL)
  assert.ok((await pillLabels(m)).includes('Replay'), 'no Replay pill')
  await m.tapOn({ text: 'Replay' })
  await m.assertVisible({ id: 'game-replay', timeout: 20000 })
  await m.assertVisible({ text: 'Exit' })
  await m.assertVisible({ id: 'replay-speaker' })
  await m.assertVisible({ id: 'replay-pause' })
  const video = join(await artifactsDir(), 'replay-first-inning-web.mp4')
  const recorder = screenRecorder(m)

  // The steps' pacing: when the card's sentence changes, for six steps.
  const changes: number[] = []
  let last = await cardUntil(m, 'the card', text => text !== '', 15000)
  await shot(m, 'replay-open')
  while (changes.length < 6) {
    const before = last
    last = await cardUntil(m, 'the next step', text => text !== before, 15000)
    changes.push(Date.now())
  }
  const gaps = changes.slice(1).map((at, i) => at - changes[i])
  console.log(`step gaps (ms): ${gaps.join(', ')}`)
  const pitchGaps = gaps.filter(gap => gap < 5200)
  assert.ok(pitchGaps.length >= 3, `few pitch-length gaps: ${gaps.join(', ')}`)
  for (const gap of pitchGaps)
    assert.ok(gap >= 4000, `a pitch came after ${gap} ms`)

  const homer = await cardUntil(
    m,
    'the first home run',
    text => /home run|grand slam/i.test(text),
    150000
  )
  console.log(`home run card: ${homer}`)
  await wait(1500)
  await shot(m, 'replay-home-run')
  await recorder.stop(video)

  // Pause holds the card; play moves on.
  await m.tapOn({ id: 'replay-pause' })
  const paused = await cardUntil(
    m,
    'Paused',
    text => text.includes('Paused'),
    5000
  )
  await m.assertVisible({ text: 'Play replay' })
  await shot(m, 'replay-paused')
  await wait(10000)
  assert.equal(await evalJson<string>(m, `return ${CARD}`), paused)
  await m.tapOn({ id: 'replay-pause' })
  await cardUntil(m, 'play to resume', text => !text.includes('Paused'), 5000)
  await cardUntil(
    m,
    'the step after play',
    text => text !== paused.replace('Paused', ''),
    20000
  )

  // The pitchers, in the order they pitched, clear of the pause button.
  const box = await evalJson<{
    order: boolean | null
    clear: boolean
    text: string
  }>(
    m,
    `
    const deck = document.querySelector('[data-testid="replay-box-score"]');
    deck.scrollTop = deck.scrollHeight;
    const text = deck.textContent;
    const pitching = text.indexOf('Harbor Hawks pitching');
    const after = text.slice(pitching);
    const cole = after.indexOf('Cole'), gil = after.indexOf('Gil');
    const rows = [...deck.querySelectorAll('[dir="auto"]')];
    const lastRow = rows[rows.length - 1].getBoundingClientRect();
    const button = document.querySelector('[data-testid="replay-pause"]').getBoundingClientRect();
    return {
      order: cole < 0 || gil < 0 ? null : cole < gil,
      clear: lastRow.bottom <= button.top || lastRow.right <= button.left,
      text: after.slice(0, 160)
    };
  `
  )
  console.log(`pitching: ${box.text}`)
  assert.notEqual(box.order, false, 'Gil listed before Cole')
  assert.ok(box.clear, 'the last row is under the pause button')
  await wait(400)
  await shot(m, 'replay-box-pitchers')

  await m.tapOn({ text: 'Exit' })
  await m.assertVisible({ text: 'Box score', timeout: 10000 })
  const path = await evalJson<string>(m, 'return location.pathname')
  assert.equal(path, `/games/${FINAL}`)

  // Nothing to replay: no pill, and the address shows the game instead.
  await openGame(m, IMPORTED)
  assert.ok(!(await pillLabels(m)).includes('Replay'), 'imported has Replay')
  await m.openBrowser({
    url: `${required('REPLAY_WEB_URL')}/games/${IMPORTED}/replay`
  })
  await m.assertVisible({ text: 'Box score', timeout: 20000 })
  assert.equal(
    await evalJson<string>(m, 'return location.pathname'),
    `/games/${IMPORTED}`
  )
}

/** The replay on a wide window: the box score in a column on the right. */
async function desktop(m: Device): Promise<void> {
  await signInWeb(m, LEAGUE)
  await m.openBrowser({
    url: `${required('REPLAY_WEB_URL')}/games/${FINAL}/replay`
  })
  await m.assertVisible({ id: 'game-replay', timeout: 20000 })
  await cardUntil(
    m,
    'the second step',
    text => !text.startsWith('Play ball') && text !== '',
    20000
  )
  const side = await evalJson<boolean>(
    m,
    `
    const deck = document.querySelector('[data-testid="replay-box-score"]').getBoundingClientRect();
    return deck.left > window.innerWidth / 2 && deck.top < 100;
  `
  )
  assert.ok(side, 'the box score is not beside the field')
  await shot(m, 'replay-desktop')
}

/**
 * Records the announcer's element in the page: it is never in the document,
 * so its play, pause and end are caught on the element's prototype.
 */
const MEDIA_LOG = `
  if (!window.__narrated) {
    window.__narrated = [];
    const card = () => document.querySelector('[data-testid="replay-play-card"]')?.textContent ?? '';
    const log = (type, el) => {
      if (String(el.src).startsWith('data:')) return;
      window.__narrated.push({ type, t: Date.now(), src: String(el.src), card: card() });
    };
    const proto = HTMLMediaElement.prototype;
    const play = proto.play, pause = proto.pause;
    proto.play = function () {
      if (!this.__logged) {
        this.__logged = true;
        this.addEventListener('ended', () => log('ended', this));
        this.addEventListener('error', () => log('error', this));
      }
      log('play', this);
      return play.apply(this, arguments);
    };
    proto.pause = function () {
      if (!this.paused) log('pause', this);
      return pause.apply(this, arguments);
    };
  }
  return true;
`

interface MediaEvent {
  type: 'play' | 'pause' | 'ended' | 'error'
  t: number
  src: string
  card: string
}

const mediaEvents = async (m: Device): Promise<MediaEvent[]> =>
  await evalJson<MediaEvent[]>(m, 'return window.__narrated ?? []')

/** Checks no sentence starts while another is still sounding. */
function overlaps(events: readonly MediaEvent[]): string[] {
  const problems: string[] = []
  let sounding: string | null = null
  for (const event of events) {
    if (event.type === 'play') {
      if (sounding != null && sounding !== event.src)
        problems.push(`${event.src} started over ${sounding}`)
      sounding = event.src
    } else if (event.src === sounding) sounding = null
  }
  return problems
}

async function announcer(m: Device): Promise<void> {
  await signInWeb(m, LEAGUE)
  await m.openBrowser({
    url: `${required('REPLAY_WEB_URL')}/games/${FINAL}/replay`
  })
  await m.assertVisible({ id: 'game-replay', timeout: 20000 })
  await evalJson<boolean>(m, MEDIA_LOG)
  const started = Date.now()
  await m.tapOn({ id: 'replay-speaker' })
  await m.assertVisible({ text: 'Turn announcer off' })

  // Pause in the middle of the third sentence, then play.
  const deadline = Date.now() + 60000
  for (;;) {
    const events = await mediaEvents(m)
    const plays = events.filter(event => event.type === 'play')
    const last = events.at(-1)
    if (plays.length >= 3 && last?.type === 'play') break
    assert.ok(Date.now() < deadline, 'no third sentence')
    await wait(150)
  }
  await m.tapOn({ id: 'replay-pause' })
  const pausedAt = (await mediaEvents(m)).length
  await wait(3000)
  const whilePaused = (await mediaEvents(m)).slice(pausedAt - 1)
  assert.equal(whilePaused[0]?.type, 'pause', 'pause did not stop speech')
  assert.ok(
    whilePaused.slice(1).every(event => event.type !== 'play'),
    'speech went on while paused'
  )
  await m.tapOn({ id: 'replay-pause' })

  // Through the visitors' half, until the home side's first batter.
  await cardUntil(
    m,
    'the bottom of the 1st',
    text => text.startsWith('Mookie B steps in'),
    180000
  )
  await m.tapOn({ id: 'replay-speaker' })
  const mutedAt = Date.now()
  await m.assertVisible({ text: 'Turn announcer on' })
  await wait(6000)
  const events = await mediaEvents(m)
  const afterMute = events.filter(event => event.t > mutedAt + 300)
  assert.ok(
    afterMute.every(event => event.type !== 'play'),
    'speech after muting'
  )
  const stoppedAtMute = events.filter(
    event => event.type === 'pause' && event.t >= mutedAt - 50
  )
  console.log(`muted: ${stoppedAtMute.length} sentence(s) stopped at once`)
  const problems = overlaps(events)
  assert.deepEqual(problems, [], problems.join('; '))

  // The served audio of the half-inning, step by step, and the log.
  const token = await sessionFor(LEAGUE)
  const client = new TeamStationClient({
    baseUrl: required('REPLAY_API'),
    token
  })
  const [game, stored] = await Promise.all([
    client.game(FINAL),
    client.gameEvents(FINAL)
  ])
  const context = replayContextOf(game, stored)
  assert.ok(context != null, 'no context')
  const steps = replayTimelineOf(stored, context).steps.filter(
    step => step.atBatIndex < 4
  )
  const dir = await mkdtemp(join(tmpdir(), 'narration-'))
  const files: string[] = []
  for (const step of steps) {
    const file = join(dir, `${step.key}.mp3`)
    await writeFile(
      file,
      Buffer.from(
        await (
          await client.narrationAudio(FINAL, {
            key: step.key,
            count: step.actions.length
          })
        ).arrayBuffer()
      )
    )
    files.push(file)
  }
  const list = join(dir, 'list.txt')
  await writeFile(list, files.map(file => `file '${file}'`).join('\n'))
  const out = await artifactsDir()
  const mp3 = join(out, 'narration-first-half.mp3')
  const joined = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c',
      'copy',
      '-y',
      mp3
    ],
    { stdio: 'inherit' }
  )
  assert.equal(joined.status, 0, 'ffmpeg joined nothing')
  const lines = [
    '$ REPLAY_SCENARIO=announcer node -r sucrase/register src/app/replay/replay.e2e.ts',
    `# ${steps.length} steps in the top of the 1st; the announcer's element, seconds from unmuting:`,
    ...events.map(
      event =>
        `${((event.t - started) / 1000).toFixed(2).padStart(7)}s  ${event.type.padEnd(6)} ${event.src.slice(-8)}  card: ${event.card}`
    ),
    `# plays: ${events.filter(event => event.type === 'play').length}, overlaps: ${problems.length}, speech after muting: 0`,
    `# served audio: ${steps.map(step => step.key).join(' ')} -> narration-first-half.mp3`
  ]
  await writeFile(
    join(out, 'narration-first-half.log'),
    `${lines.join('\n')}\n`
  )
  console.log(lines.slice(-2).join('\n'))
}

/** With no speech on the server, the replay has no speaker to offer. */
async function noAnnouncer(m: Device): Promise<void> {
  await signInWeb(m, LEAGUE)
  await m.openBrowser({
    url: `${required('REPLAY_WEB_URL')}/games/${FINAL}/replay`
  })
  await m.assertVisible({ id: 'game-replay', timeout: 20000 })
  await m.assertVisible({ text: 'Exit' })
  await m.assertNotVisible({ id: 'replay-speaker', timeout: 3000 })
  await shot(m, 'replay-no-announcer')
}

async function main(): Promise<void> {
  const scenario = required('REPLAY_SCENARIO')
  const daemon = await connect()
  let m: Device | undefined
  try {
    if (scenario === 'pills') await pills((m = await attachWeb(daemon)))
    else if (scenario === 'replay') {
      await replay((m = await attachWeb(daemon)))
      await m.detach()
      await desktop((m = await attachWeb(daemon, '1440x900')))
    } else if (scenario === 'announcer')
      await announcer((m = await attachWeb(daemon)))
    else if (scenario === 'noAnnouncer')
      await noAnnouncer((m = await attachWeb(daemon)))
    else assert.fail(`Unknown scenario ${scenario}`)
    console.log(`PASS: ${scenario}`)
  } finally {
    await m?.detach()
    await daemon.shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
