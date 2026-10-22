import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TeamStationClient } from '../../common/api'
import { narrateTimeline } from '../../common/replay/narration'
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
 *   REPLAY_SCENARIO=live
 *     A season member follows the game in progress from its Live pill while
 *     the scorer, in a second browser, throws pitches, hits a double and
 *     corrects it to a single, scores through the viewer's pause and through
 *     30 s offline, then ends the game. Writes game-pills-live-after.png,
 *     live-follow-web.mp4 and live-follow.log.
 *
 *   REPLAY_SCENARIO=liveAnnouncer   (the server's `speech` set)
 *     A season member follows the game in progress with the speaker on
 *     while the scorer strikes out the side and ends the game: no sentence
 *     is read twice in a row, the final call is read, and no card shows a
 *     count of three strikes. Writes live-announcer.log.
 *
 *   REPLAY_SCENARIO=finalAnnouncer   (the server's `speech` set)
 *     The final game replayed to its end with the speaker on: the last out
 *     and then the final call are read. Writes final-announcer.log.
 *
 *   REPLAY_SCENARIO=noAnnouncer   (the server's `speech` removed)
 *     The replay offers no speaker.
 *
 *   REPLAY_SCENARIO=controls REPLAY_PHASE=before|after
 *     The replay paused at its first pitch at 402 x 874 and 1024 x 1366:
 *     replay-controls-<phase>.png and box-score-centred-<phase>.png. `after`
 *     expects the rewind button.
 *
 *   REPLAY_SCENARIO=rewind
 *     Rewind in the final game's replay: from "Play ball!", after two
 *     sentences paused (the card's height and the box score's place kept,
 *     the box score back at the start) and playing, one sentence into the
 *     bottom of the 1st, two into the top of the 2nd and again within the
 *     words, paused, and after the end; the buttons' margins and the box
 *     score centred at both sizes and with the imported-innings note.
 *     Writes rewind-notice.png, rewind-fade.mp4 and rewind-e2e.log.
 *
 *   REPLAY_SCENARIO=rewindLive
 *     A season member rewinds the game in progress while the scorer pitches:
 *     the rewound half at replay pace, then live again. Writes
 *     rewind-live.log.
 *
 *   REPLAY_SCENARIO=rewindAnnouncer   (the server's `speech` set)
 *     A tap a second into a sentence stops it, and the rewound sentences are
 *     read again. Writes rewind-announcer.log and what was heard,
 *     rewind-announcer.mp3.
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

/** Logs every change of the card's text in the page, with its time. */
const CARD_LOG = `
  if (!window.__cards) {
    window.__cards = [];
    let last = null;
    const read = () => {
      const text = document.querySelector('[data-testid="replay-play-card"]')?.textContent ?? '';
      if (text !== last) { last = text; window.__cards.push({ t: Date.now(), text }); }
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
    read();
  }
  return true;
`

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

  // The pitchers, in the order they pitched: once Gil has relieved Cole,
  // the visitors' pitching lists Cole first. The box score names them as the
  // card does, by first name and last initial.
  const pitching = `
    const deck = document.querySelector('[data-testid="replay-box-score"]');
    const text = deck.textContent;
    const after = text.slice(text.indexOf('Harbor Hawks pitching'), text.indexOf('Valley Pines batting'));
    return { cole: after.indexOf('Gerrit C'), gil: after.indexOf('Luis Gi'), text: after.slice(0, 200) };
  `
  const deadline = Date.now() + 120000
  let order = await evalJson<{ cole: number; gil: number; text: string }>(
    m,
    pitching
  )
  while (order.gil < 0) {
    assert.ok(Date.now() < deadline, `Gil never pitched: ${order.text}`)
    await wait(1000)
    order = await evalJson<{ cole: number; gil: number; text: string }>(
      m,
      pitching
    )
  }
  console.log(`pitching: ${order.text}`)
  assert.ok(
    order.cole >= 0 && order.cole < order.gil,
    'Cole is not listed before Gil'
  )
  await m.tapOn({ id: 'replay-pause' })
  // The last row clears the pause button.
  const clear = await evalJson<boolean>(
    m,
    `
    const deck = document.querySelector('[data-testid="replay-box-score"]');
    deck.scrollTop = deck.scrollHeight;
    const rows = [...deck.querySelectorAll('[dir="auto"]')];
    const lastRow = rows[rows.length - 1].getBoundingClientRect();
    const button = document.querySelector('[data-testid="replay-pause"]').getBoundingClientRect();
    return lastRow.bottom <= button.top || lastRow.right <= button.left;
  `
  )
  assert.ok(clear, 'the last row is under the pause button')
  await evalJson<boolean>(
    m,
    `
    const deck = document.querySelector('[data-testid="replay-box-score"]');
    const title = [...deck.querySelectorAll('[dir="auto"]')].find(n => n.textContent === 'Harbor Hawks pitching');
    deck.scrollTop += title.getBoundingClientRect().top - deck.getBoundingClientRect().top - 8;
    return true;
  `
  )
  await wait(400)
  await shot(m, 'replay-box-pitchers')
  await m.tapOn({ id: 'replay-pause' })

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

const SCORER = 'replay-scorer@example.test'
const SEASON = 'replay-season@example.test'

/**
 * Taps the scorer's button by its accessible name, never text elsewhere that
 * matches; a name ending in `*` matches its start.
 */
async function tapButton(m: Device, name: string): Promise<void> {
  const label = name.endsWith('*')
    ? `[aria-label^=${JSON.stringify(name.slice(0, -1))}]`
    : `[aria-label=${JSON.stringify(name)}]`
  const css = `:is(button, [role="button"])${label}`
  await m.tapOn({ css })
}

/** Whether a control the scorer can tap is on the page, and enabled. */
async function hasControl(m: Device, label: string): Promise<boolean> {
  return await evalJson<boolean>(
    m,
    `return [...document.querySelectorAll('[aria-label]')].some(n =>
       n.getAttribute('aria-label') === ${JSON.stringify(label)} &&
       !n.disabled && n.getAttribute('aria-disabled') !== 'true')`
  )
}

async function untilControl(
  m: Device,
  prefix: string,
  ms = 20000
): Promise<void> {
  const deadline = Date.now() + ms
  while (
    !(await evalJson<boolean>(
      m,
      `return [...document.querySelectorAll('[aria-label]')].some(n => n.getAttribute('aria-label').startsWith(${JSON.stringify(prefix)}))`
    ))
  ) {
    assert.ok(Date.now() < deadline, `no ${prefix}`)
    await wait(200)
  }
}

/** A key on the scorer's field, as the keyboard sends it. */
async function fieldKey(m: Device, key: string): Promise<void> {
  await evalJson<boolean>(
    m,
    `const field = document.querySelector('[role="application"]');
     field.focus();
     field.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
     return true`
  )
  await wait(300)
}

/** The scorer records a hit, placed and angled from the keyboard. */
async function hit(m: Device, outcome: 'Single' | 'Double'): Promise<void> {
  await tapButton(m, 'Swing in Play')
  await tapButton(m, outcome)
  await untilControl(m, 'Tap or drag a player to where the ball was fielded')
  for (const key of [' ', 'ArrowUp', 'Enter']) await fieldKey(m, key)
  await untilControl(m, 'Drag up and down for ball trajectory.')
  await fieldKey(m, 'Enter')
}

async function live(daemon: Parameters<typeof attachWeb>[0]): Promise<void> {
  const out = await artifactsDir()
  const log: string[] = [
    '$ REPLAY_SCENARIO=live node -r sucrase/register src/app/replay/replay.e2e.ts'
  ]
  const started = Date.now()
  const note = (line: string): void => {
    const entry = `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`
    log.push(entry)
    console.log(entry)
  }
  const viewer = await attachWeb(daemon, '402x874', 'viewer')
  const scorer = await attachWeb(daemon, '402x874', 'scorer')
  let recorder: ReturnType<typeof screenRecorder> | undefined
  try {
    await signInWeb(scorer, SCORER)
    await scorer.openBrowser({
      url: `${required('REPLAY_WEB_URL')}/games/${LIVE}/score`
    })
    await scorer.assertVisible({ text: 'Ball', timeout: 30000 })

    await signInWeb(viewer, SEASON)
    await openGame(viewer, LIVE)
    const labels = await pillLabels(viewer)
    assert.ok(labels.includes('Live'), `pills ${labels.join(', ')}`)
    await shot(viewer, 'game-pills-live-after')
    await viewer.tapOn({ text: 'Live' })
    await viewer.assertVisible({ id: 'game-replay', timeout: 20000 })
    recorder = screenRecorder(viewer)
    await evalJson<boolean>(viewer, CARD_LOG)
    const opened = await cardUntil(
      viewer,
      'the card',
      text => text !== '',
      15000
    )
    note(`opened on: ${opened}`)
    await wait(3000)
    assert.equal(
      await evalJson<string>(viewer, `return ${CARD}`),
      opened,
      'the open moved'
    )

    /** One pitch from the scorer, and how long the viewer took to show it. */
    const pitch = async (control: string): Promise<void> => {
      const before = await evalJson<string>(viewer, `return ${CARD}`)
      await tapButton(scorer, control)
      const tapped = Date.now()
      const shown = await cardUntil(
        viewer,
        control,
        text => text !== before,
        10000
      )
      const lag = Date.now() - tapped
      note(`${control}: shown after ${lag} ms: ${shown}`)
      assert.ok(lag < 2500, `${control} took ${lag} ms`)
      await wait(1500)
    }
    await pitch('Ball')
    await pitch('Called Strike')

    // A double, then the scorer takes it back and records a single.
    const beforeHit = await evalJson<string>(viewer, `return ${CARD}`)
    await hit(scorer, 'Double')
    note('scorer: double placed')
    const double = await cardUntil(
      viewer,
      'the double',
      text => /double/i.test(text) && text !== beforeHit,
      15000
    )
    note(`viewer: ${double}`)
    await wait(2500)
    await shot(viewer, 'live-double')
    // Back to the strike before the hit: the undo button names it.
    const undoing = async (): Promise<string> =>
      await evalJson<string>(
        scorer,
        `return [...document.querySelectorAll('[aria-label^="Undo "]')].map(n => n.getAttribute('aria-label'))[0] ?? ''`
      )
    for (let i = 0; i < 8 && (await undoing()) !== 'Undo Called Strike'; i++) {
      await tapButton(scorer, 'Undo*')
      await wait(800)
    }
    assert.equal(
      await undoing(),
      'Undo Called Strike',
      'undo did not reach the pitch'
    )
    note('scorer: double undone')
    const changed = await cardUntil(
      viewer,
      'the correction',
      text => text.includes('Play changed by the scorer'),
      15000
    )
    note(`viewer: ${changed}`)
    await hit(scorer, 'Single')
    await untilControl(scorer, 'Finish at-bat', 30000)
    await tapButton(scorer, 'Finish at-bat')
    note('scorer: single recorded')
    await cardUntil(viewer, 'the single', text => /single/i.test(text), 20000)

    // Pitches while the viewer is paused come out quickly after play.
    await wait(6000)
    await viewer.tapOn({ id: 'replay-pause' })
    note('viewer: paused')
    for (const control of ['Ball', 'Called Strike', 'Ball', 'Foul Ball']) {
      await tapButton(scorer, control)
      await wait(1500)
    }
    const held = await evalJson<string>(viewer, `return ${CARD}`)
    await wait(30000 - 4 * 1500)
    assert.equal(
      await evalJson<string>(viewer, `return ${CARD}`),
      held,
      'moved while paused'
    )
    const played = Date.now()
    await viewer.tapOn({ id: 'replay-pause' })
    note('viewer: playing')
    /**
     * The card's sentences since `from`, one a step: a card that comes back
     * after "Paused" is the step it was, not a new one.
     */
    const cardsSince = async (
      from: number
    ): Promise<Array<{ t: number; text: string }>> => {
      const all = await evalJson<Array<{ t: number; text: string }>>(
        viewer,
        'return window.__cards'
      )
      return all.filter(
        (card, i) =>
          card.t >= from &&
          !card.text.includes('Paused') &&
          !(
            all[i - 1]?.text.includes('Paused') &&
            all[i - 2]?.text === card.text
          )
      )
    }
    const catchUp = async (
      what: string,
      steps: number,
      from: number,
      /** The scorer's saves retry with backoff, up to 30 s apart. */
      ms = 20000
    ): Promise<void> => {
      const deadline = Date.now() + ms
      let cards = await cardsSince(from)
      while (cards.length < steps) {
        assert.ok(
          Date.now() < deadline,
          `${what}: ${cards.length} of ${steps} steps`
        )
        await wait(250)
        cards = await cardsSince(from)
      }
      const gaps = cards.slice(1, steps).map((card, i) => card.t - cards[i].t)
      note(
        `${what}: ${cards
          .slice(0, steps)
          .map(card => card.text.split('.')[0])
          .join(' | ')}; gaps ${gaps.join(', ')} ms`
      )
      assert.ok(
        gaps.every(gap => gap < 1500),
        `${what} did not hurry: ${gaps.join(', ')}`
      )
    }
    await catchUp('catching up after play', 4, played)

    // Thirty seconds offline: the pitches arrive together, then hurry.
    await wait(5000)
    await scorer.setNetworkConditions({ offline: true })
    note('scorer: offline')
    // Each pitch writes a different card: ball three, a foul, ball four and
    // the next batter's first pitch.
    for (const control of ['Ball', 'Foul Ball', 'Ball', 'Called Strike']) {
      if (await hasControl(scorer, 'Finish at-bat'))
        await tapButton(scorer, 'Finish at-bat')
      await tapButton(scorer, control)
      await wait(1500)
    }
    await wait(30000 - 4 * 1500)
    const online = Date.now()
    await scorer.setNetworkConditions({ offline: false })
    note('scorer: online')
    await catchUp('catching up after the network', 4, online, 45000)

    // The scorer strikes the batter out and, with no at-bat open, ends the
    // game from the scoring menu.
    let ended = false
    for (let i = 0; i < 12 && !ended; i++) {
      await wait(1500)
      if (await hasControl(scorer, 'Finish at-bat')) {
        await tapButton(scorer, 'Finish at-bat')
        continue
      }
      await tapButton(scorer, 'Open scoring menu')
      await wait(500)
      if (await hasControl(scorer, 'End Game')) {
        await tapButton(scorer, 'End Game')
        await tapButton(scorer, 'Confirm End Game')
        ended = true
      } else {
        await tapButton(scorer, 'Open scoring menu')
        await wait(500)
        if (await hasControl(scorer, 'Called Strike'))
          await tapButton(scorer, 'Called Strike')
      }
    }
    assert.ok(ended, 'the scorer could not end the game')
    note('scorer: game ended')
    const final = await cardUntil(
      viewer,
      'the final',
      text => text.includes("That's the ballgame"),
      60000
    )
    note(`viewer: ${final}`)
    await wait(1500)
    await viewer.assertNotVisible({ id: 'replay-pause', timeout: 5000 })
    await shot(viewer, 'live-final')
    await recorder.stop(join(out, 'live-follow-web.mp4'))
    recorder = undefined
  } finally {
    await writeFile(join(out, 'live-follow.log'), `${log.join('\n')}\n`)
    if (recorder != null)
      await recorder
        .stop(join(out, 'live-follow-web.mp4'))
        .catch(() => undefined)
    await scorer.setNetworkConditions({ offline: false }).catch(() => undefined)
    await scorer.detach()
    await viewer.detach()
  }
}

async function liveAnnouncer(
  daemon: Parameters<typeof attachWeb>[0]
): Promise<void> {
  const viewer = await attachWeb(daemon, '402x874', 'viewer')
  const scorer = await attachWeb(daemon, '402x874', 'scorer')
  try {
    await signInWeb(scorer, SCORER)
    await scorer.openBrowser({
      url: `${required('REPLAY_WEB_URL')}/games/${LIVE}/score`
    })
    await scorer.assertVisible({ text: 'Ball', timeout: 30000 })
    await signInWeb(viewer, SEASON)
    await viewer.openBrowser({
      url: `${required('REPLAY_WEB_URL')}/games/${LIVE}/replay`
    })
    await viewer.assertVisible({ id: 'game-replay', timeout: 20000 })
    await evalJson<boolean>(viewer, MEDIA_LOG)
    await evalJson<boolean>(viewer, CARD_LOG)
    const started = Date.now()
    await viewer.tapOn({ id: 'replay-speaker' })
    // Swing and miss until the bottom of the 2nd is over; then the end, as
    // a regulation game ends at the end of a half.
    let ended = false
    for (let i = 0; i < 40 && !ended; i++) {
      await wait(1500)
      if (await hasControl(scorer, 'Finish at-bat')) {
        await tapButton(scorer, 'Finish at-bat')
        continue
      }
      // The scorer's own summary says when the bottom of the 2nd is over.
      const summary = await evalJson<string>(
        scorer,
        `return [...document.querySelectorAll('[aria-label]')].map(n => n.getAttribute('aria-label')).find(l => / · (Top|Bottom) \\d/.test(l)) ?? ''`
      )
      if (summary.includes(' · Top 3rd')) {
        await tapButton(scorer, 'Open scoring menu')
        await wait(500)
        if (await hasControl(scorer, 'End Game')) {
          await tapButton(scorer, 'End Game')
          await tapButton(scorer, 'Confirm End Game')
          ended = true
          continue
        }
        await tapButton(scorer, 'Open scoring menu')
        await wait(500)
        continue
      }
      if (await hasControl(scorer, 'Swing and Miss'))
        await tapButton(scorer, 'Swing and Miss')
    }
    assert.ok(ended, 'the scorer could not end the game')
    const halves = (
      await evalJson<Array<{ t: number; text: string }>>(
        viewer,
        'return window.__cards'
      )
    ).filter(card => card.text.includes("That's three outs"))
    assert.match(
      halves.at(-1)?.text ?? '',
      /End of the 2nd/,
      'the game did not end at the end of the bottom of the 2nd'
    )
    await cardUntil(
      viewer,
      'the final',
      text => text.includes("That's the ballgame"),
      60000
    )
    await wait(8000)
    const media = await mediaEvents(viewer)
    const cards = await evalJson<Array<{ t: number; text: string }>>(
      viewer,
      'return window.__cards'
    )
    const plays = media.filter(event => event.type === 'play')
    const sentences = plays.map(event =>
      event.card.replace(/(\d–\d|Paused).*$/, '')
    )
    const repeats = sentences.filter(
      (text, i) => i > 0 && text === sentences[i - 1]
    )
    const impossible = cards.filter(card =>
      /[0-3]–3 ·|4–[0-2] ·/.test(card.text)
    )
    const lines = [
      '$ REPLAY_SCENARIO=liveAnnouncer node -r sucrase/register src/app/replay/replay.e2e.ts',
      ...media.map(
        event =>
          `${((event.t - started) / 1000).toFixed(2).padStart(7)}s  ${event.type.padEnd(6)} card: ${event.card}`
      ),
      `# sentences read: ${plays.length}; read twice in a row: ${repeats.length}; cards with an impossible count: ${impossible.length}`
    ]
    await writeFile(
      join(await artifactsDir(), 'live-announcer.log'),
      `${lines.join('\n')}\n`
    )
    console.log(lines.at(-1))
    assert.deepEqual(repeats, [], `read twice: ${repeats.join(' | ')}`)
    assert.deepEqual(
      impossible.map(card => card.text),
      [],
      'an impossible count'
    )
    assert.ok(
      plays.some(event => event.card.includes("That's the ballgame")),
      'the final call was not read'
    )
    assert.deepEqual(overlaps(media), [])
  } finally {
    await scorer.detach()
    await viewer.detach()
  }
}

async function finalAnnouncer(m: Device): Promise<void> {
  await signInWeb(m, LEAGUE)
  await m.openBrowser({
    url: `${required('REPLAY_WEB_URL')}/games/${FINAL}/replay`
  })
  await m.assertVisible({ id: 'game-replay', timeout: 20000 })
  await evalJson<boolean>(m, MEDIA_LOG)
  const started = Date.now()
  await m.tapOn({ id: 'replay-speaker' })
  await cardUntil(
    m,
    'the final',
    text => text.includes("That's the ballgame"),
    600000
  )
  await wait(12000)
  const media = await mediaEvents(m)
  const plays = media.filter(event => event.type === 'play')
  const lines = [
    '$ REPLAY_SCENARIO=finalAnnouncer node -r sucrase/register src/app/replay/replay.e2e.ts',
    ...media
      .slice(-8)
      .map(
        event =>
          `${((event.t - started) / 1000).toFixed(2).padStart(7)}s  ${event.type.padEnd(6)} card: ${event.card}`
      ),
    `# sentences read: ${plays.length}; the last: ${plays.at(-1)?.card ?? ''}`
  ]
  await writeFile(
    join(await artifactsDir(), 'final-announcer.log'),
    `${lines.join('\n')}\n`
  )
  console.log(lines.slice(-4).join('\n'))
  assert.ok(
    (plays.at(-1)?.card ?? '').includes("That's the ballgame"),
    'the final call was not read'
  )
  assert.deepEqual(overlaps(media), [])
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

const MIXED = process.env.REPLAY_MIXED ?? 'gam_replaySeedMixed'

/** A game's replay, or its live view, straight from its address. */
async function openReplay(m: Device, gameId: string): Promise<void> {
  await m.openBrowser({
    url: `${required('REPLAY_WEB_URL')}/games/${gameId}/replay`
  })
  await m.assertVisible({ id: 'game-replay', timeout: 30000 })
}

interface Card {
  t: number
  text: string
}

const cards = async (m: Device): Promise<Card[]> =>
  await evalJson<Card[]>(m, 'return window.__cards ?? []')

/** A sentence of the game, not "Play ball!", a rewind's words or nothing. */
const isEvent = (text: string): boolean =>
  text !== '' && !text.startsWith('Play ball!') && !text.startsWith('Rewind to')

/** Waits until `count` more game sentences have been shown, and returns the last. */
async function eventsAfter(
  m: Device,
  from: number,
  count: number,
  ms = 120000
): Promise<Card> {
  const deadline = Date.now() + ms
  for (;;) {
    const seen = (await cards(m)).filter(
      card => card.t > from && isEvent(card.text)
    )
    if (seen.length >= count) return seen[count - 1]
    assert.ok(Date.now() < deadline, `fewer than ${count} sentences`)
    await wait(200)
  }
}

/** Taps rewind and returns the card's words and when they showed. */
async function tapRewind(m: Device): Promise<Card> {
  const tapped = Date.now()
  await m.tapOn({ id: 'replay-rewind' })
  const deadline = Date.now() + 5000
  for (;;) {
    const words = (await cards(m)).find(
      card => card.t >= tapped - 50 && card.text.startsWith('Rewind to')
    )
    if (words != null) return words
    assert.ok(Date.now() < deadline, 'the card never said where it went')
    await wait(100)
  }
}

/** The card's first line: the sentence or the rewind's words. */
const LINE = `document.querySelector('[data-testid="replay-play-card-line"]')?.textContent ?? ''`

/** The card and the box score's places, and the two buttons' margins. */
const GEOMETRY = `
  const rect = id => document.querySelector('[data-testid="' + id + '"]')?.getBoundingClientRect();
  const card = rect('replay-play-card'), box = rect('replay-box-score');
  const rewind = rect('replay-rewind'), pause = rect('replay-pause');
  return {
    cardHeight: card ? Math.round(card.height * 10) / 10 : null,
    boxTop: box ? Math.round(box.top * 10) / 10 : null,
    rewind: rewind ? [Math.round(rewind.left), Math.round(innerHeight - rewind.bottom), Math.round(rewind.width)] : null,
    pause: pause ? [Math.round(innerWidth - pause.right), Math.round(innerHeight - pause.bottom), Math.round(pause.width)] : null
  };
`

interface Geometry {
  cardHeight: number | null
  boxTop: number | null
  rewind: number[] | null
  pause: number[] | null
}

/**
 * The drawn box score against the scrolling element's client box: the gap
 * from its left edge to the leftmost cell and from the rightmost cell to its
 * right edge, which leaves out the scrollbar.
 */
const CENTRING = `
  const scroll = document.querySelector('[data-testid="replay-box-score"]');
  const column = document.querySelector('[data-testid="replay-box-score-column"]');
  const box = scroll.getBoundingClientRect();
  const left = box.left + scroll.clientLeft, right = left + scroll.clientWidth;
  const cells = [...column.querySelectorAll('[dir="auto"]')].map(n => n.getBoundingClientRect()).filter(r => r.width > 0);
  const minLeft = Math.min(...cells.map(r => r.left)), maxRight = Math.max(...cells.map(r => r.right));
  const note = [...scroll.querySelectorAll('[dir="auto"]')].find(n => (n.textContent ?? '').startsWith('Stats from'));
  const noteRect = note?.getBoundingClientRect();
  return {
    left: Math.round((minLeft - left) * 10) / 10,
    right: Math.round((right - maxRight) * 10) / 10,
    note: noteRect ? { inColumn: column.contains(note), align: getComputedStyle(note).textAlign } : null
  };
`

interface Centring {
  left: number
  right: number
  note: { inColumn: boolean; align: string } | null
}

async function centred(m: Device, what: string): Promise<Centring> {
  const measured = await evalJson<Centring>(m, CENTRING)
  console.log(`${what}: gaps ${measured.left} / ${measured.right}`)
  assert.ok(
    Math.abs(measured.left - measured.right) <= 1,
    `${what}: the box score is off centre, ${measured.left} against ${measured.right}`
  )
  return measured
}

/**
 * The replay's controls and box score at the first pitch, paused, at a
 * phone's size and a tablet's, before (`REPLAY_PHASE=before`, on the build
 * without rewind) and after.
 */
async function controls(
  daemon: Parameters<typeof attachWeb>[0]
): Promise<void> {
  const phase = required('REPLAY_PHASE')
  for (const [size, name] of [
    ['402x874', `replay-controls-${phase}`],
    ['1024x1366', `box-score-centred-${phase}`]
  ] as const) {
    const m = await attachWeb(daemon, size, `controls${size}`)
    try {
      await signInWeb(m, LEAGUE)
      await openReplay(m, FINAL)
      await evalJson<boolean>(m, CARD_LOG)
      await eventsAfter(m, 0, 1, 30000)
      await m.tapOn({ id: 'replay-pause' })
      await wait(1000)
      await shot(m, name)
      const has = await evalJson<boolean>(
        m,
        `return document.querySelector('[data-testid="replay-rewind"]') != null`
      )
      assert.equal(has, phase === 'after', `rewind button on ${phase}`)
    } finally {
      await m.detach()
    }
  }
}

async function rewind(daemon: Parameters<typeof attachWeb>[0]): Promise<void> {
  const out = await artifactsDir()
  const log: string[] = [
    '$ REPLAY_SCENARIO=rewind node -r sucrase/register src/app/replay/replay.e2e.ts'
  ]
  const started = Date.now()
  const note = (line: string): void => {
    const entry = `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`
    log.push(entry)
    console.log(entry)
  }
  const m = await attachWeb(daemon, '402x874', 'rewind')
  try {
    await signInWeb(m, LEAGUE)
    await openReplay(m, FINAL)
    await evalJson<boolean>(m, CARD_LOG)
    const boxAtStart = await evalJson<string>(
      m,
      `return document.querySelector('[data-testid="replay-box-score"]').textContent`
    )
    const geometry = await evalJson<Geometry>(m, GEOMETRY)
    note(
      `buttons: rewind [left, bottom, width] ${JSON.stringify(geometry.rewind)}, pause [right, bottom, width] ${JSON.stringify(geometry.pause)}`
    )
    // The same distance from the bottom and from their side, the same size.
    assert.ok(geometry.rewind != null && geometry.pause != null)
    assert.deepEqual(geometry.rewind, geometry.pause)
    assert.equal(geometry.rewind[2], 56)
    const phone = await centred(m, 'box score at 402 x 874')
    note(`box score at 402: left gap ${phone.left}, right gap ${phone.right}`)

    // R4: at "Play ball!", a tap starts the game again from its first pitch.
    await cardUntil(
      m,
      'Play ball!',
      text => text.startsWith('Play ball!'),
      15000
    )
    let words = await tapRewind(m)
    note(`R4 at Play ball!: ${words.text}`)
    assert.ok(words.text.startsWith('Rewind to top of first'))

    // R13 and R1: paused after two sentences, a tap; the card keeps its
    // height and the box score its place, and the box score is back to zero.
    const second = await eventsAfter(m, words.t, 2)
    note(`two sentences in: ${second.text}`)
    await m.tapOn({ id: 'replay-pause' })
    await wait(500)
    const before = await evalJson<Geometry>(m, GEOMETRY)
    words = await tapRewind(m)
    const during = await evalJson<Geometry>(m, GEOMETRY)
    note(`R13 paused tap: ${words.text}`)
    assert.ok(words.text.startsWith('Rewind to top of first'))
    assert.ok(words.text.includes('Paused'))
    await wait(2600)
    const afterwards = await evalJson<Geometry>(m, GEOMETRY)
    const line = await evalJson<string>(m, `return ${LINE}`)
    note(
      `R13 after the words: ${line}; card heights ${before.cardHeight} / ${during.cardHeight} / ${afterwards.cardHeight}; box tops ${before.boxTop} / ${during.boxTop} / ${afterwards.boxTop}`
    )
    assert.equal(line, 'Play ball!')
    assert.equal(during.cardHeight, before.cardHeight)
    assert.equal(afterwards.cardHeight, before.cardHeight)
    assert.equal(during.boxTop, before.boxTop)
    assert.equal(afterwards.boxTop, before.boxTop)
    const boxNow = await evalJson<string>(
      m,
      `return document.querySelector('[data-testid="replay-box-score"]').textContent`
    )
    assert.equal(boxNow, boxAtStart, 'the box score is not back at the start')
    await m.tapOn({ id: 'replay-pause' })

    // R1 unpaused: the first pitch about two seconds after the tap.
    await eventsAfter(m, Date.now(), 2)
    words = await tapRewind(m)
    const first = await eventsAfter(m, words.t, 1, 15000)
    note(
      `R1 tap: ${words.text}; then after ${first.t - words.t} ms: ${first.text}`
    )
    assert.ok(words.text.startsWith('Rewind to top of first'))
    assert.ok(first.t - words.t >= 1700 && first.t - words.t <= 3500)

    // R2: one sentence into the bottom of the 1st goes back to the top.
    const bottom = await cardUntil(
      m,
      'the bottom of the 1st',
      text => text.startsWith('Mookie B steps in'),
      240000
    )
    note(`one sentence into the bottom: ${bottom}`)
    words = await tapRewind(m)
    note(`R2 tap: ${words.text}`)
    assert.ok(words.text.startsWith('Rewind to top of first'))

    // R3: two sentences into the top of the 2nd, a tap, then another.
    const ended = await cardUntil(
      m,
      'the end of the 1st',
      text => text.includes('End of the 1st'),
      480000
    )
    const endedAt = (await cards(m)).findLast(card => card.text === ended)!.t
    await eventsAfter(m, endedAt, 2, 60000)
    const recorder = screenRecorder(m)
    words = await tapRewind(m)
    note(`R3 tap: ${words.text}`)
    assert.ok(words.text.startsWith('Rewind to top of second'))
    await shot(m, 'rewind-notice')
    await wait(700)
    words = await tapRewind(m)
    note(`R3 second tap: ${words.text}`)
    assert.ok(words.text.startsWith('Rewind to bottom of first'))
    const resumed = await eventsAfter(m, words.t, 1, 15000)
    note(`then after ${resumed.t - words.t} ms: ${resumed.text}`)
    await wait(1500)
    await recorder.stop(join(out, 'rewind-fade.mp4'))

    // R5: paused two sentences into the top of the 2nd, a tap; the words
    // fade while paused, leaving the last sentence of the bottom of the 1st.
    const endedAgain = await cardUntil(
      m,
      'the end of the 1st again',
      text => text.includes('End of the 1st'),
      240000
    )
    const endedAgainAt = (await cards(m)).findLast(
      card => card.text === endedAgain
    )!.t
    await eventsAfter(m, endedAgainAt, 2, 60000)
    await m.tapOn({ id: 'replay-pause' })
    words = await tapRewind(m)
    note(`R5 paused tap: ${words.text}`)
    assert.ok(words.text.startsWith('Rewind to top of second'))
    await wait(2600)
    const left = await evalJson<string>(m, `return ${CARD}`)
    note(`R5 after the words: ${left}`)
    assert.ok(left.includes('End of the 1st') && left.includes('Paused'))
    // On play the detail turns from "Paused" back to the count; the next
    // sentence comes after the words' two seconds.
    const sentence = left.slice(0, left.lastIndexOf('Paused'))
    const played = Date.now()
    await m.tapOn({ id: 'replay-pause' })
    const next = await cardUntil(
      m,
      'the next sentence',
      text => isEvent(text) && !text.startsWith(sentence),
      15000
    )
    const nextAt = Date.now()
    note(`R5 play: after ${nextAt - played} ms: ${next}`)
    assert.ok(nextAt - played >= 1700)

    // R6: at the end, the pause button goes and rewind stays.
    const deadline = Date.now() + 900000
    while (
      await evalJson<boolean>(
        m,
        `return document.querySelector('[data-testid="replay-pause"]') != null`
      )
    ) {
      assert.ok(Date.now() < deadline, 'the replay never ended')
      await wait(1000)
    }
    note(`R6 ended: ${await evalJson<string>(m, `return ${CARD}`)}`)
    words = await tapRewind(m)
    note(`R6 tap: ${words.text}`)
    assert.ok(words.text.startsWith('Rewind to top of third'))
    await m.assertVisible({ id: 'replay-pause', timeout: 5000 })
  } finally {
    await m.detach()
  }

  // R13 at a tablet's size, on the final game and on the game with
  // imported innings and its note.
  const tablet = await attachWeb(daemon, '1024x1366', 'rewindTablet')
  try {
    await signInWeb(tablet, LEAGUE)
    for (const gameId of [FINAL, MIXED]) {
      await openReplay(tablet, gameId)
      await evalJson<boolean>(tablet, CARD_LOG)
      await eventsAfter(tablet, 0, 1, 30000)
      const measured = await centred(tablet, `${gameId} at 1024 x 1366`)
      note(
        `${gameId} at 1024: left gap ${measured.left}, right gap ${measured.right}, note ${JSON.stringify(measured.note)}`
      )
      if (gameId === MIXED) {
        assert.ok(measured.note != null, 'no imported-innings note')
        assert.equal(measured.note.inColumn, false)
        assert.equal(measured.note.align, 'center')
      }
      const geometry = await evalJson<Geometry>(tablet, GEOMETRY)
      assert.deepEqual(geometry.rewind, geometry.pause)
    }
  } finally {
    await tablet.detach()
  }
  await writeFile(join(out, 'rewind-e2e.log'), `${log.join('\n')}\n`)
}

async function rewindLive(
  daemon: Parameters<typeof attachWeb>[0]
): Promise<void> {
  const out = await artifactsDir()
  const log: string[] = [
    '$ REPLAY_SCENARIO=rewindLive node -r sucrase/register src/app/replay/replay.e2e.ts'
  ]
  const started = Date.now()
  const note = (line: string): void => {
    const entry = `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`
    log.push(entry)
    console.log(entry)
  }
  const viewer = await attachWeb(daemon, '402x874', 'rewindViewer')
  const scorer = await attachWeb(daemon, '402x874', 'rewindScorer')
  try {
    await signInWeb(scorer, SCORER)
    await scorer.openBrowser({
      url: `${required('REPLAY_WEB_URL')}/games/${LIVE}/score`
    })
    await scorer.assertVisible({ text: 'Ball', timeout: 30000 })
    await signInWeb(viewer, SEASON)
    await openReplay(viewer, LIVE)
    await evalJson<boolean>(viewer, CARD_LOG)
    const opened = await cardUntil(
      viewer,
      'the card',
      text => text !== '',
      15000
    )
    note(`opened on: ${opened}`)
    const words = await tapRewind(viewer)
    note(`R7 tap: ${words.text}`)
    assert.ok(words.text.startsWith('Rewind to bottom of second'))
    // The scorer goes on meanwhile.
    await tapButton(scorer, 'Ball')
    const ballAt = Date.now()
    note('the scorer throws a ball')
    // The rewound steps at replay pace, then the scorer's ball.
    const played: Card[] = []
    const deadline = Date.now() + 300000
    for (;;) {
      const seen = (await cards(viewer)).filter(
        card => card.t > words.t && isEvent(card.text)
      )
      played.splice(0, played.length, ...seen)
      const last = seen.at(-1)
      if (last != null && Date.now() - last.t > 8000) break
      assert.ok(Date.now() < deadline, 'the rewound steps never ended')
      await wait(500)
    }
    const gaps = played.slice(1).map((card, i) => card.t - played[i].t)
    note(`R7: ${played.length} steps after the tap, gaps ${gaps.join(', ')} ms`)
    for (const card of played) note(`  ${card.text}`)
    // Replay pace: a lineup change's two seconds, a pitch's four and a half;
    // never a live slot (a second and a half) or a hurried one.
    assert.ok(Math.min(...gaps) >= 1900, 'the rewound steps were hurried')
    assert.ok(Math.max(...gaps) >= 4000, 'no pitch took a replay slot')
    assert.ok(played.at(-1)!.t > ballAt, "the scorer's ball never played")
    // Live again: the next pitch within a live slot.
    const before = await evalJson<string>(viewer, `return ${CARD}`)
    await tapButton(scorer, 'Called Strike')
    const tapped = Date.now()
    const shown = await cardUntil(
      viewer,
      'the strike',
      text => text !== before,
      10000
    )
    note(`live again: the strike after ${Date.now() - tapped} ms: ${shown}`)
    assert.ok(Date.now() - tapped < 3000)
  } finally {
    await viewer.detach()
    await scorer.detach()
  }
  await writeFile(join(out, 'rewind-live.log'), `${log.join('\n')}\n`)
}

/**
 * The played span of each sentence in a media log: from its play to its
 * pause or end, by the card it was played for.
 */
function playedSpans(
  events: readonly MediaEvent[]
): Array<{ card: string; seconds: number | null }> {
  const spans: Array<{ card: string; seconds: number | null }> = []
  for (const [index, event] of events.entries()) {
    if (event.type !== 'play') continue
    const stop = events
      .slice(index + 1)
      .find(other => other.src === event.src && other.type !== 'play')
    spans.push({
      card: event.card,
      seconds:
        stop == null || stop.type === 'ended' ? null : (stop.t - event.t) / 1000
    })
  }
  return spans
}

/** A game's timeline and the announcer's sentences, as the server reads them. */
async function narratedGame(gameId: string): Promise<{
  client: TeamStationClient
  timeline: ReturnType<typeof replayTimelineOf>
  narrations: ReturnType<typeof narrateTimeline>
}> {
  const token = await sessionFor(LEAGUE)
  const client = new TeamStationClient({
    baseUrl: required('REPLAY_API'),
    token
  })
  const [game, stored] = await Promise.all([
    client.game(gameId),
    client.gameEvents(gameId)
  ])
  const context = replayContextOf(game, stored)
  assert.ok(context != null, 'no context')
  const timeline = replayTimelineOf(stored, context)
  return { client, timeline, narrations: narrateTimeline(timeline) }
}

/** The audio heard, clip by clip, each cut where it was stopped. */
async function heardAudio(
  gameId: string,
  spans: ReadonlyArray<{ card: string; seconds: number | null }>,
  path: string
): Promise<string[]> {
  const { client, timeline, narrations } = await narratedGame(gameId)
  const dir = await mkdtemp(join(tmpdir(), 'heard-'))
  const files: string[] = []
  const keys: string[] = []
  for (const [index, span] of spans.entries()) {
    const step = timeline.steps.find(candidate => {
      const text = narrations.get(candidate.key)?.text ?? ''
      return text !== '' && span.card.startsWith(text)
    })
    assert.ok(step != null, `no step reads ${span.card}`)
    keys.push(step.key)
    const whole = join(dir, `${index}-whole.mp3`)
    await writeFile(
      whole,
      Buffer.from(
        await (
          await client.narrationAudio(gameId, {
            key: step.key,
            count: step.actions.length
          })
        ).arrayBuffer()
      )
    )
    const cut = join(dir, `${index}.mp3`)
    const made = spawnSync(
      'ffmpeg',
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        whole,
        ...(span.seconds == null ? [] : ['-t', span.seconds.toFixed(2)]),
        '-c:a',
        'libmp3lame',
        '-b:a',
        '64k',
        '-ar',
        '24000',
        '-ac',
        '1',
        '-y',
        cut
      ],
      { stdio: 'inherit' }
    )
    assert.equal(made.status, 0, 'ffmpeg cut nothing')
    files.push(cut)
  }
  const list = join(dir, 'list.txt')
  await writeFile(list, files.map(file => `file '${file}'`).join('\n'))
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
      path
    ],
    { stdio: 'inherit' }
  )
  assert.equal(joined.status, 0, 'ffmpeg joined nothing')
  return keys
}

/**
 * Keeps every request the page makes in its resource timing buffer: the
 * app's client holds its own copy of `fetch`, so a wrapper would see none.
 */
const RESOURCE_LOG = `
  performance.setResourceTimingBufferSize(100000);
  return true;
`

/** The page's narration requests so far: each step key and count, with its time. */
const NARRATION_REQUESTS = `
  return performance.getEntriesByType('resource')
    .map(entry => ({ entry, found: /\\/narrations\\/([^?]+)\\?count=(\\d+)/.exec(entry.name) }))
    .filter(({ found }) => found != null)
    .map(({ entry, found }) => ({ t: Math.round(performance.timeOrigin + entry.startTime), key: found[1], count: Number(found[2]) }));
`

interface NarrationRequest {
  t: number
  key: string
  count: number
}

async function rewindAnnouncer(m: Device): Promise<void> {
  const out = await artifactsDir()
  await signInWeb(m, LEAGUE)
  await openReplay(m, FINAL)
  await evalJson<boolean>(m, MEDIA_LOG)
  await evalJson<boolean>(m, CARD_LOG)
  await evalJson<boolean>(m, RESOURCE_LOG)
  const started = Date.now()
  await m.tapOn({ id: 'replay-speaker' })
  await m.assertVisible({ text: 'Turn announcer off' })
  // Through the 1st, read aloud, to two sentences into the top of the 2nd.
  const ended = await cardUntil(
    m,
    'the end of the 1st',
    text => text.includes('End of the 1st'),
    480000
  )
  const endedAt = (await cards(m)).findLast(card => card.text === ended)!.t
  const deadline = Date.now() + 120000
  let second: MediaEvent | undefined
  for (;;) {
    const plays = (await mediaEvents(m)).filter(
      event =>
        event.type === 'play' &&
        event.t > endedAt &&
        !event.card.includes('End of the 1st')
    )
    if (plays.length >= 2) {
      second = plays[1]
      break
    }
    assert.ok(Date.now() < deadline, 'no second sentence in the 2nd')
    await wait(100)
  }
  await wait(1000)
  const words = await tapRewind(m)
  assert.ok(words.text.startsWith('Rewind to top of second'), words.text)
  // The rewound steps read again: three more sentences.
  for (;;) {
    const plays = (await mediaEvents(m)).filter(
      event => event.type === 'play' && event.t > words.t
    )
    if (plays.length >= 3) break
    assert.ok(Date.now() < deadline + 120000, 'nothing read after the tap')
    await wait(200)
  }
  await m.tapOn({ id: 'replay-speaker' })
  const events = await mediaEvents(m)
  const requests = await evalJson<NarrationRequest[]>(m, NARRATION_REQUESTS)
  assert.ok(
    requests.some(request => request.t > words.t),
    'no narration request seen after the tap'
  )
  const stopped = events.find(
    event =>
      event.type === 'pause' &&
      event.src === second.src &&
      event.t >= words.t - 100 &&
      event.t <= words.t + 800
  )
  assert.ok(stopped != null, 'the tap did not stop the sentence')
  const after = events.filter(
    event => event.type === 'play' && event.t > words.t
  )
  const firstOfSecond = events.find(
    event =>
      event.type === 'play' &&
      event.t > endedAt &&
      !event.card.includes('End of the 1st')
  )!
  assert.equal(
    after[0].card.split('·')[0].slice(0, 30),
    firstOfSecond.card.split('·')[0].slice(0, 30),
    'the half was not read again from its first sentence'
  )
  assert.ok(
    after.every(event => !event.card.includes('End of the 1st')),
    'the sentence before the half was read again'
  )
  const { timeline, narrations } = await narratedGame(FINAL)
  const endKey = timeline.steps.find(step =>
    (narrations.get(step.key)?.text ?? '').includes('End of the 1st')
  )!.key
  assert.ok(
    requests.every(request => request.t <= words.t || request.key !== endKey),
    'the sentence before the half was fetched again'
  )
  const spans = playedSpans(events.filter(event => event.t >= endedAt - 50))
  const keys = await heardAudio(FINAL, spans, join(out, 'rewind-announcer.mp3'))
  const at = (t: number): string =>
    `${((t - started) / 1000).toFixed(2).padStart(7)}s`
  const lines = [
    '$ REPLAY_SCENARIO=rewindAnnouncer node -r sucrase/register src/app/replay/replay.e2e.ts',
    `# the tap: ${at(words.t).trim()}, two sentences into the top of the 2nd: ${words.text}`,
    `# the step before the half, the end of the 1st: ${endKey}; requested after the tap: no; read after the tap: no`,
    "# the announcer's element:",
    ...events.map(
      event =>
        `${at(event.t)}  ${event.type.padEnd(6)} ${event.src.slice(-8)}  card: ${event.card}`
    ),
    '# narration requests from the page (step key, count):',
    ...requests.map(
      request =>
        `${at(request.t)}  GET narrations/${request.key}?count=${request.count}${request.t > words.t ? '   (after the tap)' : ''}`
    ),
    `# heard from the end of the 1st on, in order (cut where stopped): ${keys.map((key, i) => `${key}${spans[i].seconds == null ? '' : ` (${spans[i].seconds.toFixed(2)} s)`}`).join(' ')} -> rewind-announcer.mp3`
  ]
  await writeFile(join(out, 'rewind-announcer.log'), `${lines.join('\n')}\n`)
  console.log(lines.slice(1, 3).concat(lines.slice(-1)).join('\n'))
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
    else if (scenario === 'live') await live(daemon)
    else if (scenario === 'liveAnnouncer') await liveAnnouncer(daemon)
    else if (scenario === 'finalAnnouncer')
      await finalAnnouncer((m = await attachWeb(daemon)))
    else if (scenario === 'noAnnouncer')
      await noAnnouncer((m = await attachWeb(daemon)))
    else if (scenario === 'controls') await controls(daemon)
    else if (scenario === 'rewind') await rewind(daemon)
    else if (scenario === 'rewindLive') await rewindLive(daemon)
    else if (scenario === 'rewindAnnouncer')
      await rewindAnnouncer((m = await attachWeb(daemon)))
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
