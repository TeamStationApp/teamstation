import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  maestroDriver,
  placeFielder,
  setTrajectory
} from '../../../e2e/rigs/fieldPointer'
import {
  artifactsDir,
  attachWeb,
  connect,
  type Device,
  required,
  sessionFor,
  shot,
  signInWeb
} from '../../../e2e/rigs/replayKit'
import { TeamStationClient } from '../../common/api'
import { narrateTimeline } from '../../common/replay/narration'
import {
  replayContextOf,
  replayTimelineOf
} from '../../common/replay/replayTimeline'
import { CHEER_GAIN, CROWD_IDLE_GAIN } from './crowdCheer'
import { stepHalfEnds } from './replayGaps'

/**
 * The replay in Chromium at a phone's size, against a server and web build
 * with the replay seed loaded (`src/server/dev/replaySeed.ts`).
 *
 *   REPLAY_SCENARIO=pills REPLAY_PHASE=before|after [REPLAY_PILLS=final,live]
 *     The pills under the final and the in-progress game's hero card.
 *     `before` expects no Replay or Live pill; `after` expects them.
 *
 *   REPLAY_SCENARIO=replay [REPLAY_PITCH_MS=5000]
 *     The final game's replay from its pill: the controls, the pitch pacing
 *     (each pitch held for the node's pitch delay, REPLAY_PITCH_MS),
 *     the first home run, pause and play, the box score's pitchers, the X,
 *     the imported game with nothing to replay, and the wide layout.
 *
 *   REPLAY_SCENARIO=announcer   (the server's `speech` set)
 *     The announcer through the first half-inning: every sentence played as
 *     its step is shown, none over another, pause and play mid-sentence, and
 *     muting silencing it at once; the card's words three lines tall at
 *     every sentence, the newest last. Writes narration-first-half.log, the
 *     served audio, narration-first-half.mp3, and the card's words sliding
 *     in, announcer-scroll.mp4.
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
 *     The replay still offers its volume button, for the field's sounds, and
 *     turning it on asks the server for no sentence: the page requests no
 *     narration, nor does the server's log (REPLAY_API_LOG, when given) show
 *     one.
 *
 *   REPLAY_SCENARIO=controls REPLAY_PHASE=before|after
 *     The replay paused at its first pitch at 402 x 874 and 1024 x 1366:
 *     replay-controls-<phase>.png and box-score-centred-<phase>.png, and at
 *     402 x 874 the box score scrolled to its end, box-score-end-<phase>.png.
 *     `after` also opens it at 393 x 660 and 375 x 667, a phone's browser
 *     with its toolbars (replay-controls-<size>-after.png and
 *     box-score-end-<size>-after.png). It expects the volume button at the
 *     top left and the X at the top right, 48 square; rewind and pause 16
 *     from the bottom and their sides; the canvas from the window's top; on
 *     a tall window the play card, if drawn, ending above the buttons' tops
 *     and the deck at least DECK_MIN tall, and with no card the deck no
 *     taller than DECK_MIN, below the plate; and the box score's last row
 *     above both buttons.
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
 *
 *   REPLAY_SCENARIO=liveInPlay REPLAY_PHASE=before|after
 *     The scorer chooses Single and waits five seconds before placing the
 *     ball while a season member follows; `after` expects nothing on the
 *     viewer's card until the ball is placed. Writes live-in-play-<phase>.mp4.
 *
 *   REPLAY_SCENARIO=scorers   (the server's `speech` set)
 *     The rally game's grand slam names its three runners in one sentence,
 *     and the announcer reads it. Writes scorers-after.mp3.
 *
 *   REPLAY_SCENARIO=board REPLAY_PHASE=before|after
 *     The field scoreboard at 402 x 874 on the scorer's screen for the game
 *     in progress, then after one Ball, and on the final game's replay
 *     paused at its first pitch: scoring-board-<phase>.png and
 *     replay-board-<phase>.png in REPLAY_ARTIFACTS, and the after-one-Ball
 *     scoring-board-<phase>-ball.png in the temporary directory. `after`
 *     shows the batter's and the pitcher's jersey numbers, as `#12`, before
 *     their names. Adds a ball to the scorer's at-bat in progress, so
 *     reseed before another live scenario.
 *
 *   REPLAY_SCENARIO=crowd
 *     The final game's replay with the sound on, to its first home run, past
 *     a minute: the idle crowd's two copies of its file take turns, the
 *     second starting about 20 s after the first, the two playing together
 *     for about 2 s with their gains crossing at equal power (g1² + g2²
 *     within 5% of the idle gain's square, sampled every 100 ms), each
 *     routed once through its own GainNode at volume 1; each play that
 *     cheers plays its sound from the site's root, Judge's strikeout,
 *     Rizzo's single, Torres's double play and Betts's home run, at gains
 *     that rise with the play, each gain on the element's own Web Audio
 *     GainNode with the element at volume 1 and one source per element, and
 *     pause pauses the crowd and the cheers
 *     still sounding, which play plays on. Writes crowd-web.log.
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

/**
 * What the card says now, as a page expression: its newest line, the
 * sentence or the rewind's words, then the detail below the words. The
 * lines said before it stay above in the words area, and are not read.
 */
const CARD_TEXT = `((document.querySelector('[data-testid="replay-play-card-line"]')?.textContent ?? '') + (document.querySelector('[data-testid="replay-play-card-detail"]')?.textContent ?? ''))`

/** Logs every change of the card's text in the page, with its time. */
const CARD_LOG = `
  if (!window.__cards) {
    window.__cards = [];
    let last = null;
    const read = () => {
      const text = ${CARD_TEXT};
      if (text !== last) { last = text; window.__cards.push({ t: Date.now(), text }); }
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
    read();
  }
  return true;
`

const CARD = CARD_TEXT

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

/** The final game's steps, each one's kind and whether it ends a half. */
async function finalSteps(): Promise<{
  kinds: string[]
  halfEnds: boolean[]
}> {
  const client = new TeamStationClient({
    baseUrl: required('REPLAY_API'),
    token: await sessionFor(LEAGUE)
  })
  const [game, stored] = await Promise.all([
    client.game(FINAL),
    client.gameEvents(FINAL)
  ])
  const context = replayContextOf(game, stored)
  assert.ok(context != null, 'no context')
  const timeline = replayTimelineOf(stored, context)
  return {
    kinds: timeline.steps.map(step => step.kind),
    halfEnds: stepHalfEnds(timeline)
  }
}

async function replay(m: Device): Promise<void> {
  await signInWeb(m, LEAGUE)
  await openGame(m, FINAL)
  assert.ok((await pillLabels(m)).includes('Replay'), 'no Replay pill')
  await m.tapOn({ text: 'Replay' })
  await m.assertVisible({ id: 'game-replay', timeout: 20000 })
  await m.assertVisible({ id: 'replay-exit' })
  await m.assertVisible({ id: 'replay-speaker' })
  await m.assertVisible({ id: 'replay-pause' })
  const video = join(await artifactsDir(), 'replay-first-inning-web.mp4')
  const recorder = screenRecorder(m)

  // The steps' pacing: when the card's sentence changes, for eight steps.
  // The announcer is off as the replay opens, so no step waits for speech.
  const pitchMs = Number(process.env.REPLAY_PITCH_MS ?? 5000)
  const { kinds, halfEnds } = await finalSteps()
  await evalJson<boolean>(
    m,
    `
    window.__pacing = [];
    let previous = null;
    new MutationObserver(() => {
      const text = ${CARD};
      if (text !== previous) {
        previous = text;
        window.__pacing.push({ text, at: Date.now() });
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    return true;
  `
  )
  const changes: number[] = []
  let last = await cardUntil(m, 'the card', text => text !== '', 15000)
  assert.ok(last.startsWith('Play ball!'), 'the replay opens on Play ball!')
  await shot(m, 'replay-open')
  while (changes.length < 8) {
    const before = last
    last = await cardUntil(
      m,
      'the next step',
      text => text !== before,
      pitchMs + 15000
    )
    // Timestamp the DOM change itself; 200ms polling can observe two
    // equally spaced pitches with an apparent gap shorter than the slot.
    changes.push(
      await evalJson<number>(
        m,
        `return window.__pacing.findLast(change => change.text === ${JSON.stringify(last)}).at`
      )
    )
  }
  // The n-th change starts the n-th step: a gap is a pitch's when its step
  // is a pitch that does not end a half.
  const gaps = changes.slice(1).map((at, i) => at - changes[i])
  console.log(`step gaps (ms): ${gaps.join(', ')}`)
  const pitchGaps = gaps.filter(
    (gap, i) => kinds[i] === 'pitch' && !halfEnds[i]
  )
  console.log(`pitch gaps (ms): ${pitchGaps.join(', ')}`)
  assert.ok(pitchGaps.length >= 3, `few pitch gaps: ${gaps.join(', ')}`)
  for (const gap of pitchGaps) {
    assert.ok(gap >= pitchMs - 100, `a pitch came after ${gap} ms`)
    assert.ok(gap < pitchMs + 1000, `a pitch held ${gap} ms`)
  }

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
    return { cole: after.indexOf('Gerrit C'), gil: after.indexOf('Luis G'), text: after.slice(0, 200) };
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

  await m.tapOn({ id: 'replay-exit' })
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
  // The play card heads the column, three lines of words tall, and the box
  // score starts just below it.
  const side = await evalJson<boolean>(
    m,
    `
    const deck = document.querySelector('[data-testid="replay-box-score"]').getBoundingClientRect();
    const card = document.querySelector('[data-testid="replay-play-card"]').getBoundingClientRect();
    return deck.left > window.innerWidth / 2 && card.left > window.innerWidth / 2 &&
      card.top < 100 && deck.top >= card.bottom && deck.top < card.bottom + 20;
  `
  )
  assert.ok(side, 'the box score is not beside the field, below the card')
  await shot(m, 'replay-desktop')
}

/**
 * Records the announcer's element in the page: it is never in the document,
 * so its play, pause and end are caught on the element's prototype. The
 * field cues (data URLs) and the crowd's bed and cheers (/crowd-idle-…,
 * /cheer-…) are not the announcer and are left out; the crowd scenario
 * records those itself.
 */
const MEDIA_LOG = `
  if (!window.__narrated) {
    window.__narrated = [];
    const card = () => ${CARD_TEXT};
    const log = (type, el) => {
      const src = String(el.src);
      if (src.startsWith('data:')) return;
      if (/\\/(crowd-idle|cheer)-/.test(src)) return;
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

/**
 * Logs the card's words area at every change: its height, and whether its
 * last line is the newest, the sentence being read.
 */
const WORDS_LOG = `
  if (!window.__words) {
    window.__words = [];
    let last = null;
    const read = () => {
      const words = document.querySelector('[data-testid="replay-play-card-words"]');
      const line = document.querySelector('[data-testid="replay-play-card-line"]');
      if (!words || !line) return;
      const text = line.textContent;
      if (text === last) return;
      last = text;
      const lines = words.firstElementChild?.children ?? [];
      window.__words.push({
        t: Date.now(),
        text,
        height: Math.round(words.getBoundingClientRect().height * 10) / 10,
        lines: lines.length,
        lastIsNewest: lines[lines.length - 1] === line
      });
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
    read();
  }
  return true;
`

interface WordsChange {
  t: number
  text: string
  height: number
  lines: number
  lastIsNewest: boolean
}

async function announcer(m: Device): Promise<void> {
  await signInWeb(m, LEAGUE)
  await m.openBrowser({
    url: `${required('REPLAY_WEB_URL')}/games/${FINAL}/replay`
  })
  await m.assertVisible({ id: 'game-replay', timeout: 20000 })
  await evalJson<boolean>(m, MEDIA_LOG)
  await evalJson<boolean>(m, WORDS_LOG)
  const started = Date.now()
  await m.tapOn({ id: 'replay-speaker' })
  await m.assertVisible({ text: 'Mute game sounds' })
  // The words area through the half: three lines, the new ones sliding in.
  const out = await artifactsDir()
  const recorder = screenRecorder(m)

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
  await recorder.stop(join(out, 'announcer-scroll.mp4'))
  // Every sentence shown in a words area three lines tall, the newest last.
  const words = await evalJson<WordsChange[]>(m, 'return window.__words ?? []')
  assert.ok(words.length >= 5, `few sentences: ${words.length}`)
  for (const change of words) {
    assert.equal(change.height, 60, `the words were ${change.height} tall`)
    assert.ok(change.lastIsNewest, `not the last line: ${change.text}`)
  }
  assert.ok(
    words.some(change => change.lines >= 3),
    'the words never held three sentences'
  )
  await m.tapOn({ id: 'replay-speaker' })
  const mutedAt = Date.now()
  await m.assertVisible({ text: 'Unmute game sounds' })
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
    `# words area: ${words.length} sentences shown, every one 60 tall with the newest last -> announcer-scroll.mp4`,
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

/** How long the stand-in for the idle crowd's file runs: as long as the file. */
const CROWD_STAND_IN_SECONDS = 22

/**
 * Records the crowd's sounds in the page: every play and pause of an `.m4a`
 * element, with its file, whether it is a copy of the idle crowd, its
 * volume, Web Audio gain and muting, and the card at the time. The elements
 * are never in the document, so their prototype is watched. The crowd sets
 * its gains on a GainNode per element, as iPhone Safari ignores `volume`, so
 * the AudioContext's `createMediaElementSource` is watched as well: each
 * element's source count, and the node its source connects to, whose gain
 * is read at each play. Every 100 ms the idle crowd's copies are sampled:
 * each one's state and gain, into `window.__crowdSamples`. The app exposes
 * nothing for this; the test watches the browser's own API, as it does
 * `play`.
 *
 * A Chromium built without AAC cannot decode the idle crowd's `.m4a`, so
 * its copies would never move on and never cross. There, each copy is given
 * a stand-in of the same length the browser can play, 22 s of quiet noise
 * as a WAV, set in place of the file the page asked for, which is what is
 * recorded and fetched.
 */
const CROWD_LOG = `
  if (!window.__crowd) {
    window.__crowd = [];
    window.__crowdElements = [];
    window.__crowdSamples = [];
    const card = () => ${CARD_TEXT};
    const asked = el => String(el.__crowdAsked ?? el.src);
    const isBed = el => /\\/crowd-idle-[^/]*\\.m4a$/.test(asked(el));
    const gainOf = el => el.__crowdGain ? el.__crowdGain.gain.value : null;
    const log = (type, el) => {
      const src = asked(el);
      if (!src.includes('.m4a')) return;
      if (!window.__crowdElements.includes(el)) window.__crowdElements.push(el);
      window.__crowd.push({ type, t: Date.now(), src, bed: isBed(el), muted: el.muted, volume: el.volume, gain: gainOf(el), sources: el.__crowdSources ?? 0, card: card() });
    };
    const aac = document.createElement('audio').canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '';
    window.__crowdStandIn = !aac;
    if (!aac) {
      const seconds = ${CROWD_STAND_IN_SECONDS}, rate = 8000, n = seconds * rate;
      const wav = new DataView(new ArrayBuffer(44 + n));
      const text = (at, value) => { for (let i = 0; i < value.length; i++) wav.setUint8(at + i, value.charCodeAt(i)); };
      text(0, 'RIFF'); wav.setUint32(4, 36 + n, true); text(8, 'WAVEfmt ');
      wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
      wav.setUint32(24, rate, true); wav.setUint32(28, rate, true); wav.setUint16(32, 1, true); wav.setUint16(34, 8, true);
      text(36, 'data'); wav.setUint32(40, n, true);
      for (let i = 0; i < n; i++) wav.setUint8(44 + i, 128 + Math.round((Math.random() - 0.5) * 8));
      const standIn = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        get() { return src.get.call(this); },
        set(value) {
          const url = new URL(String(value), location.href).href;
          if (/\\/crowd-idle-[^/]*\\.m4a$/.test(url)) { this.__crowdAsked = url; value = standIn; }
          src.set.call(this, value);
        }
      });
    }
    setInterval(() => {
      const copies = window.__crowdElements.filter(isBed);
      if (copies.length === 0) return;
      window.__crowdSamples.push({ t: Date.now(), copies: copies.map(el => ({ paused: el.paused, ended: el.ended, time: el.currentTime, gain: gainOf(el), volume: el.volume })) });
    }, 100);
    for (const Context of [window.AudioContext, window.webkitAudioContext]) {
      if (Context == null || Context.prototype.__crowdWatched) continue;
      Context.prototype.__crowdWatched = true;
      const route = Context.prototype.createMediaElementSource;
      Context.prototype.createMediaElementSource = function (el) {
        const source = route.call(this, el);
        el.__crowdSources = (el.__crowdSources ?? 0) + 1;
        const connect = source.connect;
        source.connect = function (to) { el.__crowdGain = to; return connect.apply(this, arguments); };
        return source;
      };
    }
    const proto = HTMLMediaElement.prototype;
    const play = proto.play, pause = proto.pause;
    proto.play = function () { log('play', this); return play.apply(this, arguments); };
    proto.pause = function () { log('pause', this); return pause.apply(this, arguments); };
  }
  return true;
`

/**
 * Whether the browser decodes AAC. A Chromium built without the licensed
 * codecs does not, though Chrome, Safari, Edge and Firefox do: it is asked
 * to play the crowd and cannot, and only what the page asked is checked.
 */
const PLAYS_AAC = `return document.createElement('audio').canPlayType('audio/mp4; codecs="mp4a.40.2"') !== ''`

/**
 * Fetches each sound's file as the page does, into `window.__crowdFiles`:
 * its status and size.
 */
const CROWD_FILES = `
  const files = [...new Set((window.__crowd ?? []).map(event => event.src))];
  window.__crowdFiles = null;
  Promise.all(files.map(async src => {
    const answer = await fetch(src);
    return { src, status: answer.status, bytes: (await answer.arrayBuffer()).byteLength };
  })).then(read => { window.__crowdFiles = read; }, error => { window.__crowdFiles = String(error); });
  return true;
`

/** A sound's file as the page fetched it. */
interface CrowdFile {
  src: string
  status: number
  bytes: number
}

interface CrowdEvent {
  type: 'play' | 'pause'
  t: number
  src: string
  /** Whether it is one of the idle crowd's copies. */
  bed: boolean
  muted: boolean
  volume: number
  /** Its GainNode's gain, if its element was routed through Web Audio. */
  gain: number | null
  /** How many Web Audio sources were made on its element. */
  sources: number
  card: string
}

/** The idle crowd's copies as they stand: each one's file, gain and state. */
const CROWD_BED = `
  const copies = (window.__crowdElements ?? []).filter(el => /\\/crowd-idle-[^/]*\\.m4a$/.test(String(el.__crowdAsked ?? el.src)));
  return copies.map(bed => ({ src: String(bed.__crowdAsked ?? bed.src), loop: bed.loop, volume: bed.volume, gain: bed.__crowdGain ? bed.__crowdGain.gain.value : null, sources: bed.__crowdSources ?? 0, paused: bed.paused, time: bed.currentTime, duration: bed.duration, error: bed.error?.code ?? null }));
`

interface CrowdBed {
  src: string
  loop: boolean
  volume: number
  gain: number | null
  sources: number
  paused: boolean
  time: number
  duration: number
  error: number | null
}

/** The idle crowd's copies, sampled every 100 ms. */
interface CrowdSample {
  t: number
  copies: Array<{
    paused: boolean
    ended: boolean
    time: number
    gain: number | null
    volume: number
  }>
}

async function crowd(m: Device): Promise<void> {
  await signInWeb(m, LEAGUE)
  await m.openBrowser({
    url: `${required('REPLAY_WEB_URL')}/games/${FINAL}/replay`
  })
  await m.assertVisible({ id: 'game-replay', timeout: 20000 })
  await evalJson<boolean>(m, CROWD_LOG)
  const started = Date.now()
  await m.tapOn({ id: 'replay-speaker' })
  await m.assertVisible({ text: 'Mute game sounds' })
  const homer = await cardUntil(
    m,
    'the first home run',
    text => /home run|grand slam/i.test(text),
    180000
  )
  await wait(3000)
  const aac = await evalJson<boolean>(m, PLAYS_AAC)
  const standIn = await evalJson<boolean>(m, 'return window.__crowdStandIn')
  const copies = await evalJson<CrowdBed[]>(m, CROWD_BED)
  assert.equal(copies.length, 2, `${copies.length} copies of the idle crowd`)
  const origin = new URL(required('REPLAY_WEB_URL')).origin
  for (const copy of copies) {
    assert.equal(copy.loop, false, 'a copy of the idle crowd loops')
    // Through Web Audio: its node holds the gain, its element plays at 1.
    assert.equal(
      copy.sources,
      1,
      'a copy of the idle crowd was not routed once'
    )
    assert.equal(
      copy.volume,
      1,
      "a copy of the idle crowd's element is not at 1"
    )
    assert.equal(
      copy.error,
      null,
      `a copy of the idle crowd failed: ${copy.error}`
    )
    assert.match(copy.src, /\/crowd-idle-[^/]*\.m4a$/)
    assert.ok(copy.src.startsWith(`${origin}/crowd-idle-`), copy.src)
  }
  assert.equal(copies[1].src, copies[0].src, 'the copies play different files')
  const length = copies[0].duration
  assert.ok(
    Math.abs(length - 22) < 0.1,
    `the idle crowd's file is ${length} s long`
  )
  // Past a minute, the copies have each played: the crossfades.
  const sounding = copies.filter(copy => !copy.paused)
  assert.ok(sounding.length >= 1, 'no copy of the idle crowd is playing')
  // Where an AudioParam is a 32-bit float, the gains read back rounded.
  const full = CROWD_IDLE_GAIN ** 2
  const samples = await evalJson<CrowdSample[]>(
    m,
    'return window.__crowdSamples ?? []'
  )
  const playingIn = (sample: CrowdSample): number[] =>
    sample.copies.flatMap((copy, i) => (copy.paused || copy.ended ? [] : [i]))
  const power = (sample: CrowdSample): number =>
    sample.copies.reduce(
      (sum, copy) =>
        copy.paused || copy.ended ? sum : sum + (copy.gain ?? 0) ** 2,
      0
    )
  // Each copy's first play out loud, after the tap's muted one.
  const bedEvents = (
    await evalJson<CrowdEvent[]>(m, 'return window.__crowd ?? []')
  ).filter(event => event.bed)
  const startsOf = bedEvents.filter(
    event => event.type === 'play' && !event.muted
  )
  assert.ok(startsOf.length >= 3, `${startsOf.length} starts of the idle crowd`)
  const firstStart = startsOf[0].t
  const secondStart = startsOf[1].t
  const handover = (secondStart - firstStart) / 1000
  assert.ok(
    handover > 19 && handover < 21.5,
    `the second copy started ${handover.toFixed(2)} s after the first`
  )
  // The first overlap: the samples with both copies playing.
  const both = samples.filter(sample => playingIn(sample).length === 2)
  assert.ok(both.length > 0, 'the copies never played together')
  const overlaps: CrowdSample[][] = []
  for (const sample of both) {
    const run = overlaps.at(-1)
    if (run != null && sample.t - run[run.length - 1].t <= 250) run.push(sample)
    else overlaps.push([sample])
  }
  const firstOverlap = overlaps[0]
  const overlapSeconds =
    (firstOverlap[firstOverlap.length - 1].t - firstOverlap[0].t) / 1000 + 0.1
  assert.ok(
    overlapSeconds > 1.6 && overlapSeconds < 2.4,
    `the copies played together for ${overlapSeconds.toFixed(2)} s`
  )
  // Through the overlap, the summed power holds at the idle gain's square.
  const powers = both.map(sample => power(sample) / full)
  const low = Math.min(...powers)
  const high = Math.max(...powers)
  assert.ok(
    low > 0.95 && high < 1.05,
    `the summed power ran ${low.toFixed(3)}–${high.toFixed(3)} of the idle gain's`
  )
  // And the gains crossed: one fell as the other rose.
  const [outgoing, incoming] = [0, 1].map(i =>
    firstOverlap.map(sample => sample.copies[i].gain ?? 0)
  )
  assert.ok(
    outgoing[0] > incoming[0] &&
      outgoing[outgoing.length - 1] < incoming[incoming.length - 1],
    `the gains did not cross: ${outgoing.map(g => g.toFixed(2)).join(' ')} / ${incoming.map(g => g.toFixed(2)).join(' ')}`
  )
  // Alone, a copy plays at the idle gain.
  const alone = samples.filter(
    sample =>
      playingIn(sample).length === 1 &&
      sample.copies[playingIn(sample)[0]].time > 2.5 &&
      sample.copies[playingIn(sample)[0]].time < length - 2.5
  )
  assert.ok(alone.length > 0, 'no copy played alone')
  for (const sample of alone)
    assert.equal(
      sample.copies[playingIn(sample)[0]].gain,
      Math.fround(CROWD_IDLE_GAIN),
      'a copy alone is not at the idle gain'
    )
  // Pause pauses the crowd; play plays it on.
  const asked = async (
    type: 'play' | 'pause',
    since: number
  ): Promise<boolean> =>
    (await evalJson<CrowdEvent[]>(m, 'return window.__crowd ?? []')).some(
      event => event.bed && event.type === type && event.t >= since
    )
  const pausedAt = Date.now()
  let since = pausedAt
  await m.tapOn({ id: 'replay-pause' })
  await wait(500)
  assert.ok(await asked('pause', since), 'pause did not pause the crowd')
  const paused = await evalJson<CrowdBed[]>(m, CROWD_BED)
  assert.ok(
    paused.every(copy => copy.paused),
    'pause left the crowd playing'
  )
  const playedAt = Date.now()
  since = playedAt
  await m.tapOn({ id: 'replay-pause' })
  await wait(500)
  assert.ok(await asked('play', since), 'play did not play the crowd')
  const playing = await evalJson<CrowdBed[]>(m, CROWD_BED)
  assert.ok(
    playing.some(copy => !copy.paused),
    'play left the crowd paused'
  )
  // Every sound is served where the page asks for it.
  await evalJson<boolean>(m, CROWD_FILES)
  let fetched: CrowdFile[] | string | null = null
  for (let i = 0; i < 50 && fetched == null; i++) {
    await wait(100)
    fetched = await evalJson<CrowdFile[] | string | null>(
      m,
      'return window.__crowdFiles ?? null'
    )
  }
  assert.ok(
    Array.isArray(fetched),
    `the sounds were not fetched: ${JSON.stringify(fetched)}`
  )
  const files: CrowdFile[] = fetched
  // The idle crowd and the three sizes of cheer heard before the home run.
  assert.equal(files.length, 4, `${files.length} sounds fetched`)
  for (const file of files) {
    assert.equal(file.status, 200, `${file.src} answered ${file.status}`)
    assert.ok(file.bytes > 10000, `${file.src} is ${file.bytes} bytes`)
  }
  const events = await evalJson<CrowdEvent[]>(m, 'return window.__crowd ?? []')
  // Each cheer as it started: playing on after the pause plays the cheers
  // still sounding again, which are not new ones.
  const cheers = events.filter(
    event => event.type === 'play' && !event.bed && event.t < pausedAt
  )
  // Pause paused the cheers sounding, and play played the same ones on.
  const cheerFiles = (
    type: 'play' | 'pause',
    from: number,
    to: number
  ): string[] =>
    events
      .filter(
        event =>
          event.type === type && !event.bed && event.t >= from && event.t < to
      )
      .map(event => event.src)
      .sort()
  const heldCheers = cheerFiles('pause', pausedAt, playedAt)
  const playedOn = cheerFiles('play', playedAt, playedAt + 500)
  assert.deepEqual(
    playedOn,
    heldCheers,
    'play did not play on the cheers pause held'
  )
  const size = (src: string): string =>
    /\/cheer-([a-z]+)-[^/]*\.m4a$/.exec(src)?.[1] ?? src
  const sizes = cheers.map(event => size(event.src))
  // Judge's strikeout, Rizzo's single, Torres's double play, Betts's homer.
  assert.deepEqual(sizes, ['small', 'small', 'medium', 'huge'])
  for (const cheer of cheers)
    assert.ok(cheer.src.startsWith(`${origin}/cheer-`), cheer.src)
  // Each cheer at its size's gain on its element's node, the element at 1,
  // each element routed once though the pool's are reused.
  for (const cheer of cheers) {
    const name = size(cheer.src) as keyof typeof CHEER_GAIN
    assert.equal(
      cheer.gain,
      Math.fround(CHEER_GAIN[name]),
      `${name} cheer's gain`
    )
    assert.equal(cheer.volume, 1, `${name} cheer's element volume`)
    assert.equal(cheer.sources, 1, `${name} cheer's element sources`)
  }
  const gain = (name: string): number =>
    cheers.find(event => size(event.src) === name)?.gain ?? NaN
  assert.ok(
    gain('small') < gain('medium') && gain('medium') < gain('huge'),
    `gains ${cheers.map(event => event.gain).join(', ')}`
  )
  const out = await artifactsDir()
  const lines = [
    '$ REPLAY_SCENARIO=crowd node -r sucrase/register src/app/replay/replay.e2e.ts',
    "# the crowd's sounds, seconds from turning the sound on:",
    ...events.map(
      event =>
        `${((event.t - started) / 1000).toFixed(2).padStart(7)}s  ${event.type.padEnd(5)} ${event.src.slice(origin.length).padEnd(34)} bed=${event.bed} muted=${event.muted} volume=${event.volume.toFixed(2)} gain=${event.gain?.toFixed(2) ?? '-'} sources=${event.sources}  card: ${event.card}`
    ),
    `# the browser: ${aac ? 'plays AAC' : standIn ? `a Chromium without AAC: the idle crowd's copies played a ${CROWD_STAND_IN_SECONDS} s WAV stand-in for its file, so they moved on and crossed; the cheers were asked for but not heard` : 'a Chromium without AAC'}`,
    "# the idle crowd's first crossfade, sampled every 100 ms (seconds from the sound on: each copy's position and gain, and g1² + g2² over the idle gain's square):",
    ...firstOverlap.map(
      sample =>
        `${((sample.t - started) / 1000).toFixed(2).padStart(7)}s  ${sample.copies.map(copy => `${copy.time.toFixed(2).padStart(5)} s ${(copy.gain ?? 0).toFixed(3)}`).join('  ')}  power ${(power(sample) / full).toFixed(3)}`
    ),
    `# idle crowd: ${copies.length} copies of ${copies[0].src.slice(origin.length)}, ${length.toFixed(2)} s, loop=false, each routed once at volume 1; the second started ${handover.toFixed(2)} s after the first; ${overlaps.length} crossfades seen, the first ${overlapSeconds.toFixed(2)} s long; summed power ${low.toFixed(3)}–${high.toFixed(3)} of ${CROWD_IDLE_GAIN}² across ${both.length} samples in the overlaps; alone at gain ${Math.fround(CROWD_IDLE_GAIN)}; paused with the replay, played again on play`,
    ...files.map(
      file =>
        `# served ${file.src.slice(origin.length)}: ${file.status}, ${file.bytes} bytes`
    ),
    `# cheers: ${sizes.join(', ')} at Web Audio gains ${cheers.map(event => event.gain).join(', ')}, element volume ${cheers.map(event => event.volume).join(', ')}`,
    `# cheers paused with the replay and played on: ${heldCheers.length === 0 ? 'none still sounding' : heldCheers.map(src => size(src)).join(', ')}`,
    `# home run card: ${homer}`
  ]
  await writeFile(join(out, 'crowd-web.log'), `${lines.join('\n')}\n`)
  console.log(lines.slice(-3).join('\n'))
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

/** The scorer records a hit up the middle, at the angle the screen offers. */
async function hit(m: Device, outcome: 'Single' | 'Double'): Promise<void> {
  await tapButton(m, 'Swing in Play')
  await tapButton(m, outcome)
  await untilControl(m, 'Tap or drag a player to where the ball was fielded')
  const field = maestroDriver(m)
  await placeFielder(field, 'CF')
  await setTrajectory(field)
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

/**
 * With no speech on the server, the replay still offers its volume button,
 * and turning it on asks for no sentence.
 */
async function noAnnouncer(m: Device): Promise<void> {
  await signInWeb(m, LEAGUE)
  const log = process.env.REPLAY_API_LOG
  const logged = async (): Promise<number> =>
    log == null ? 0 : (await readFile(log, 'utf8')).length
  await m.openBrowser({
    url: `${required('REPLAY_WEB_URL')}/games/${FINAL}/replay`
  })
  await m.assertVisible({ id: 'game-replay', timeout: 20000 })
  await evalJson<boolean>(m, RESOURCE_LOG)
  await m.assertVisible({ id: 'replay-exit' })
  await m.assertVisible({ id: 'replay-speaker' })
  const before = await logged()
  await m.tapOn({ id: 'replay-speaker' })
  await m.assertVisible({ text: 'Mute game sounds' })
  // Long enough for the next steps' sentences to have been fetched ahead.
  await wait(8000)
  const requests = await evalJson<NarrationRequest[]>(m, NARRATION_REQUESTS)
  assert.deepEqual(requests, [], 'the page asked for a sentence')
  if (log != null) {
    const after = (await readFile(log, 'utf8')).slice(before)
    assert.ok(
      !after.includes('/narrations'),
      'the server was asked for a sentence'
    )
  }
  await shot(m, 'replay-no-announcer')
}

const RALLY = process.env.REPLAY_RALLY ?? 'gam_replaySeedRally'
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

/** The card's newest line: the sentence or the rewind's words. */
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
  const sizes: Array<readonly [string, string, string | null]> = [
    ['402x874', `replay-controls-${phase}`, `box-score-end-${phase}`],
    ['1024x1366', `box-score-centred-${phase}`, null]
  ]
  // A phone's browser with its toolbars: too short for three lines of card.
  if (phase === 'after')
    for (const size of ['393x660', '375x667'])
      sizes.push([
        size,
        `replay-controls-${size}-after`,
        `box-score-end-${size}-after`
      ])
  for (const [size, name, end] of sizes) {
    const m = await attachWeb(daemon, size, `controls${size}`)
    try {
      await signInWeb(m, LEAGUE)
      await openReplay(m, FINAL)
      await evalJson<boolean>(m, CARD_LOG)
      // A window too short for one line of the card draws none: the first
      // pitch is then waited for by the replay's pace.
      await wait(3000)
      const drawn = await evalJson<boolean>(
        m,
        `return document.querySelector('[data-testid="replay-play-card"]') != null`
      )
      if (drawn) await eventsAfter(m, 0, 1, 30000)
      else await wait(6000)
      await m.tapOn({ id: 'replay-pause' })
      await wait(1000)
      await shot(m, name)
      const has = await evalJson<boolean>(
        m,
        `return document.querySelector('[data-testid="replay-rewind"]') != null`
      )
      assert.ok(has, `rewind button on ${phase}`)
      if (phase === 'after') await controlPlaces(m, size)
      if (end != null) await boxScoreEnd(m, phase, end)
    } finally {
      await m.detach()
    }
  }
}

/**
 * Where `after` puts the replay's controls, in a browser with no insets: the
 * volume button at the top left and the X at the top right, both 48 square;
 * rewind at the bottom left and pause at the bottom right, 16 from the
 * bottom and their sides; and the field's canvas from the window's top.
 * On a tall window, the play card, when it is drawn, ends above the buttons'
 * tops, and the deck below it is at least DECK_MIN tall; with no card, the
 * deck starts below the catcher's nameplate. The play card's and
 * the deck's places, and the card's lines, are logged with them.
 */
async function controlPlaces(m: Device, size: string): Promise<void> {
  const places = await evalJson<{
    width: number
    height: number
    rects: Record<
      string,
      { left: number; top: number; right: number; bottom: number } | null
    >
  }>(
    m,
    `const rect = selector => {
      const node = document.querySelector(selector)
      if (node == null) return null
      const { left, top, right, bottom } = node.getBoundingClientRect()
      return { left, top, right, bottom }
    }
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      rects: {
        speaker: rect('[data-testid="replay-speaker"]'),
        exit: rect('[data-testid="replay-exit"]'),
        rewind: rect('[data-testid="replay-rewind"]'),
        pause: rect('[data-testid="replay-pause"]'),
        canvas: rect('[data-testid="replay-field"] canvas') ??
          rect('[data-testid="replay-field"]'),
        card: rect('[data-testid="replay-play-card"]'),
        words: rect('[data-testid="replay-play-card-words"]'),
        deck: rect('[data-testid="replay-deck"]')
      }
    }`
  )
  console.log(`controls ${size}: ${JSON.stringify(places)}`)
  const { width, height, rects } = places
  const at = (name: string): NonNullable<(typeof rects)[string]> => {
    const found = rects[name]
    assert.ok(found != null, `no ${name} at ${size}`)
    return found
  }
  const near = (actual: number, expected: number, what: string): void => {
    assert.ok(
      Math.abs(actual - expected) <= 1,
      `${what} at ${size}: ${actual}, not ${expected}`
    )
  }
  const speaker = at('speaker')
  const exit = at('exit')
  for (const [name, button] of [
    ['the volume button', speaker],
    ['the X', exit]
  ] as const) {
    near(button.right - button.left, 48, `${name}'s width`)
    near(button.bottom - button.top, 48, `${name}'s height`)
    near(button.top, 8, `${name}'s top`)
  }
  near(speaker.left, 8, "the volume button's left")
  // The X ends the field's column: the window, or the window less the box
  // score's column on a wide window or a tablet.
  near(at('canvas').right - exit.right, 8, "the X's right")
  const rewind = at('rewind')
  const pause = at('pause')
  near(rewind.left, 16, "rewind's left")
  near(width - pause.right, 16, "pause's right")
  near(height - rewind.bottom, 16, "rewind's bottom")
  near(height - pause.bottom, 16, "pause's bottom")
  near(at('canvas').top, 0, "the canvas's top")
  const deck = rects.deck
  if (deck == null) return
  // A tall window: with a card, the card ends above the buttons and the box
  // score keeps DECK_MIN; with none, the deck starts below the catcher's
  // nameplate, under DECK_MIN, leaving the plate in view.
  const buttons = Math.min(rewind.top, pause.top)
  const { card, words } = rects
  const lines =
    words == null ? 0 : Math.round((words.bottom - words.top) / LINE_HEIGHT)
  console.log(
    `controls ${size}: card ${card == null ? 'none' : `${card.top}–${card.bottom}, ${lines} lines`}, deck from ${deck.top} (${height - deck.top} tall), buttons from ${buttons}`
  )
  if (card == null)
    assert.ok(
      height - deck.top <= DECK_MIN + 0.5,
      `the deck at ${size} is ${height - deck.top} tall with no card, over ${DECK_MIN}`
    )
  else {
    assert.ok(
      height - deck.top >= DECK_MIN - 0.5,
      `the deck at ${size} is ${height - deck.top} tall, under ${DECK_MIN}`
    )
    assert.ok(
      card.bottom <= buttons,
      `the card at ${size} ends at ${card.bottom}, below the buttons' top ${buttons}`
    )
    assert.ok(
      lines >= 1 && lines <= 3,
      `the card at ${size} has ${lines} lines`
    )
  }
}

/** The replay deck's least height (GameReplayScreen's DECK_MIN). */
const DECK_MIN = 160
/** One line of the card's words (ReplayPlayCard's ANNOUNCER_LINE_HEIGHT). */
const LINE_HEIGHT = 20

/**
 * The box score scrolled to its end: the screenshot `name`, and the last
 * row's bottom against the tops of rewind and pause, which `after` requires
 * it to clear.
 */
async function boxScoreEnd(
  m: Device,
  phase: string,
  name: string
): Promise<void> {
  const edges = await evalJson<{ last: number; buttons: number }>(
    m,
    `const box = document.querySelector('[data-testid="replay-box-score"]')
    box.scrollTop = box.scrollHeight
    const content = box.firstElementChild
    const padding = parseFloat(getComputedStyle(content).paddingBottom)
    const tops = ['replay-rewind', 'replay-pause'].map(id =>
      document.querySelector('[data-testid="' + id + '"]').getBoundingClientRect().top)
    return {
      last: content.getBoundingClientRect().bottom - padding,
      buttons: Math.min(...tops)
    }`
  )
  await wait(500)
  await shot(m, name)
  console.log(
    `${name}: last row bottom ${edges.last}, buttons top ${edges.buttons}`
  )
  if (phase === 'after')
    assert.ok(edges.last <= edges.buttons, 'the last row clears the buttons')
}

async function board(daemon: Parameters<typeof attachWeb>[0]): Promise<void> {
  const phase = required('REPLAY_PHASE')
  const scorer = await attachWeb(daemon, '402x874', 'boardScorer')
  try {
    await signInWeb(scorer, SCORER)
    await scorer.openBrowser({
      url: `${required('REPLAY_WEB_URL')}/games/${LIVE}/score`
    })
    await scorer.assertVisible({ text: 'Ball', timeout: 30000 })
    // The board is drawn in a task after the render that brought it.
    await wait(2000)
    await shot(scorer, `scoring-board-${phase}`)
    await tapButton(scorer, 'Ball')
    await wait(2000)
    const ball = join(tmpdir(), `scoring-board-${phase}-ball.png`)
    await writeFile(ball, await scorer.screenshot())
    console.log(`after one ball: ${ball}`)
  } finally {
    await scorer.detach()
  }
  const m = await attachWeb(daemon, '402x874', 'boardReplay')
  try {
    await signInWeb(m, LEAGUE)
    await openReplay(m, FINAL)
    await evalJson<boolean>(m, CARD_LOG)
    await eventsAfter(m, 0, 1, 30000)
    await m.tapOn({ id: 'replay-pause' })
    await wait(1000)
    await shot(m, `replay-board-${phase}`)
  } finally {
    await m.detach()
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
  await m.assertVisible({ text: 'Mute game sounds' })
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

/**
 * The scorer puts a ball in play while a season member follows: before
 * (`REPLAY_PHASE=before`) only recorded; after, nothing shows until the
 * ball is placed, then the hit and its result.
 */
async function liveInPlay(
  daemon: Parameters<typeof attachWeb>[0]
): Promise<void> {
  const phase = required('REPLAY_PHASE')
  const out = await artifactsDir()
  const log: string[] = [
    `$ REPLAY_SCENARIO=liveInPlay REPLAY_PHASE=${phase} node -r sucrase/register src/app/replay/replay.e2e.ts`
  ]
  const started = Date.now()
  const note = (line: string): void => {
    const entry = `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`
    log.push(entry)
    console.log(entry)
  }
  const viewer = await attachWeb(daemon, '402x874', 'inPlayViewer')
  const scorer = await attachWeb(daemon, '402x874', 'inPlayScorer')
  let recorder: ReturnType<typeof screenRecorder> | undefined
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
    recorder = screenRecorder(viewer)
    await wait(1500)
    await tapButton(scorer, 'Swing in Play')
    await tapButton(scorer, 'Single')
    const chosen = Date.now()
    note('the scorer chooses Single; the ball is not placed yet')
    await wait(5000)
    const meanwhile = (await cards(viewer)).filter(card => card.t > chosen)
    note(
      `while unplaced: ${meanwhile.length === 0 ? 'the card did not change' : meanwhile.map(card => card.text).join(' | ')}`
    )
    // Out to left field, well away from where an unplaced ball is aimed.
    await untilControl(
      scorer,
      'Tap or drag a player to where the ball was fielded'
    )
    const field = maestroDriver(scorer)
    await placeFielder(field, 'LF')
    await setTrajectory(field)
    const accepted = Date.now()
    note('the scorer places the ball in left field and accepts its trajectory')
    const shown = await cardUntil(
      viewer,
      'the single',
      text => text.includes('single'),
      10000
    )
    note(`shown after ${Date.now() - accepted} ms: ${shown}`)
    await wait(6000)
    if (phase === 'after') {
      assert.equal(
        meanwhile.length,
        0,
        'the card changed before the ball was placed'
      )
      assert.ok(shown.includes('left'), `not to left field: ${shown}`)
      assert.ok(Date.now() - accepted < 12000)
    }
  } finally {
    await recorder?.stop(join(out, `live-in-play-${phase}.mp4`))
    await viewer.detach()
    await scorer.detach()
  }
  await writeFile(join(out, `live-in-play-${phase}.log`), `${log.join('\n')}\n`)
}

async function scorers(m: Device): Promise<void> {
  const out = await artifactsDir()
  await signInWeb(m, LEAGUE)
  await openReplay(m, RALLY)
  await evalJson<boolean>(m, MEDIA_LOG)
  await evalJson<boolean>(m, CARD_LOG)
  await m.tapOn({ id: 'replay-speaker' })
  const slam = await cardUntil(
    m,
    'the grand slam',
    text => text.includes('A grand slam!'),
    240000
  )
  console.log(`grand slam card: ${slam}`)
  assert.match(slam, /A grand slam! \w+ \w, \w+ \w and \w+ \w all score!/)
  // Its sentence read to the end.
  const deadline = Date.now() + 30000
  for (;;) {
    const events = await mediaEvents(m)
    const play = events.find(
      event => event.type === 'play' && event.card.includes('A grand slam!')
    )
    if (
      play != null &&
      events.some(
        event =>
          event.src === play.src && event.t > play.t && event.type === 'ended'
      )
    )
      break
    assert.ok(Date.now() < deadline, 'the grand slam was not read to its end')
    await wait(200)
  }
  const all = await cards(m)
  for (const card of all)
    assert.ok(card.text.split('scores!').length < 3, `twice: ${card.text}`)
  const events = await mediaEvents(m)
  const spans = playedSpans(events).filter(span =>
    span.card.includes('A grand slam!')
  )
  assert.equal(spans[0]?.seconds, null, 'the grand slam was cut off')
  await heardAudio(RALLY, spans, join(out, 'scorers-after.mp3'))
  const lines = [
    '$ REPLAY_SCENARIO=scorers node -r sucrase/register src/app/replay/replay.e2e.ts',
    `# the grand slam's card: ${slam}`,
    `# cards in the replay: ${all.length}, none with "scores!" twice`,
    '# heard: the grand slam sentence, played to its end -> scorers-after.mp3'
  ]
  await writeFile(join(out, 'scorers-after-e2e.log'), `${lines.join('\n')}\n`)
  console.log(lines.join('\n'))
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
    else if (scenario === 'board') await board(daemon)
    else if (scenario === 'rewind') await rewind(daemon)
    else if (scenario === 'rewindLive') await rewindLive(daemon)
    else if (scenario === 'rewindAnnouncer')
      await rewindAnnouncer((m = await attachWeb(daemon)))
    else if (scenario === 'liveInPlay') await liveInPlay(daemon)
    else if (scenario === 'crowd') await crowd((m = await attachWeb(daemon)))
    else if (scenario === 'scorers')
      await scorers((m = await attachWeb(daemon)))
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
