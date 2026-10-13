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
