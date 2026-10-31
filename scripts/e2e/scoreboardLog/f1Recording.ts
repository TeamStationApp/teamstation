/**
 * F1: the live board recorded off this Mac's own display. A headed,
 * full-screen Chromium-family browser plays a game's live stream from the
 * fake broadcaster while a scorer and the override dashboard change the
 * board at known wall times, and `screencapture -v` records the display.
 * The recording is then stepped frame by frame (`f1Measure.ts`).
 *
 *   F1_BROWSER=<full-screen browser wrapper> MAESTRO_D=<daemon> \
 *   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> F1_OUT=<directory> \
 *     node -r sucrase/register scripts/e2e/scoreboardLog/f1Recording.ts sync|grid
 *
 * sync: a stamped 10-minute stream with a 20 s outage at 300 s. Pitches and
 *   overrides before and after it. The page is opened again after the outage
 *   when the live player has stopped, as E8's rig does.
 * grid: an unstamped and a stamped stream of one game. The unstamped angle
 *   alone for about 2 minutes, the live grid of both for about 2 minutes, then
 *   the unstamped angle again through the end of the stream and the switch to
 *   the recording.
 *
 * Everything the measurement needs (T0, the actions, the board's final
 * steps, the page's geometry and its own per-frame log) goes to
 * `<F1_OUT>/<part>.json`. Every video and camera it made is deleted; the
 * game stays. The stream key is covered on the page for as long as it is
 * open, and its rectangles are logged so the conversion can black them out
 * too.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import WebSocket from 'ws'

import * as rig from '../../../e2e/rigs/overlayRig'

const part = process.argv[2]
if (part !== 'sync' && part !== 'grid') throw new Error('Give sync or grid')
const browserBinary = process.env.F1_BROWSER ?? ''
const out = process.env.F1_OUT ?? ''
const daemonName = process.env.MAESTRO_D ?? ''
if (browserBinary === '' || out === '' || daemonName === '')
  throw new Error('F1_BROWSER, F1_OUT and MAESTRO_D are required')
/**
 * The page's size: a 1920x1080 display in full screen, under Brave's tab
 * strip and toolbar (81 px), which full screen keeps.
 */
const SCREEN = process.env.F1_SCREEN ?? '1920x999'

const requireClient =
  process.env.MAESTRO_D_CLIENT_ROOT == null
    ? createRequire(__filename)
    : createRequire(join(process.env.MAESTRO_D_CLIENT_ROOT, 'package.json'))
const { MaestroD } = requireClient('maestro-d')

/** Covers every stream key that shows, again and again: the page re-renders. */
const COVER_KEYS = `
  const cover = () => {
    for (const box of document.querySelectorAll('[aria-label^="Copy the URL for"]')) {
      if (box.querySelector('[data-cover="stream-key"]') != null) continue
      const r = box.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative'
      const sheet = document.createElement('div')
      sheet.textContent = 'stream key hidden'
      sheet.dataset.cover = 'stream-key'
      Object.assign(sheet.style, { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', background: '#e8ebe2', color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '18px sans-serif', zIndex: 2147483647 })
      box.appendChild(sheet)
    }
  }
  cover()
  clearInterval(window.__f1cover)
  window.__f1cover = setInterval(cover, 200)
  return true
`

/**
 * Scrolls the single player's picture to the top of the window, so all of it
 * (the marker is at its bottom) is on the display whatever the page above it
 * grows to. The grid is fixed over the page and needs none.
 */
const SCROLL_PICTURE = `
  const picture = document.querySelector('#root video')
  if (picture != null) {
    // The page scrolls inside the app's own scroll view, not the window.
    const box = picture.getBoundingClientRect()
    if (box.top < 0 || box.bottom > window.innerHeight - 4)
      picture.scrollIntoView({ block: 'start' })
  }
`

/** Where things are, in page pixels, and where the page is on the screen. */
const GEOMETRY = `
  const box = node => { if (node == null) return null; const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
  const videos = [...document.querySelectorAll('video')]
  return {
    now: Date.now(),
    screen: { x: window.screenX, y: window.screenY, outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio, scrollY: window.scrollY },
    videos: videos.map(v => ({ ...box(v), videoW: v.videoWidth, videoH: v.videoHeight, inRoot: v.closest('#root') != null, t: v.currentTime })),
    boards: [...document.querySelectorAll('[data-testid="scoreboard-overlay"]')].map(node => ({ ...box(node), at: node.getAttribute('data-at') })),
    keys: [...document.querySelectorAll('[aria-label^="Copy the URL for"]')].map(box)
  }
`

/** Logs every frame the first `<video>` presents, as E8 does. */
function frameLogger(videoExpr: string): string {
  return `
    const readMarker = ${rig.readMarkerSource()}
    const geometry = ${JSON.stringify(rig.markerGeometry(720))}
    const v = ${videoExpr}
    if (window.__f1 != null) window.__f1.stop = true
    const log = { frames: [], stop: false }
    window.__f1 = log
    const step = (now, meta) => {
      if (log.stop) return
      const board = document.querySelector('[data-testid="scoreboard-overlay"]')
      log.frames.push([Date.now(), readMarker(v, geometry), board == null ? null : Number(board.getAttribute('data-at')), meta.mediaTime])
      v.requestVideoFrameCallback(step)
    }
    v.muted = true
    v.play().catch(() => undefined)
    v.requestVideoFrameCallback(step)
    return true
  `
}

const record: {
  part: string
  t0: number
  screen: string
  actions: Array<{ at: number; what: string }>
  geometry: unknown[]
  pageFrames: Array<{ label: string; frames: unknown }>
  capture: {
    startedAt: number
    seconds: number
    file: string
    parts: Array<{ file: string; startedAt: number; endedAt: number }>
  } | null
  steps: unknown
  vod: unknown
  notes: string[]
  /** When the page was hidden, and shown again, while recording. */
  visibility: Array<{ at: number; state: string }>
  videos: Record<string, string>
} = {
  part,
  t0: 0,
  screen: SCREEN,
  actions: [],
  geometry: [],
  pageFrames: [],
  capture: null,
  steps: null,
  vod: null,
  notes: [],
  visibility: [],
  videos: {}
}
const note = (what: string, detail?: unknown): void => {
  rig.print(what, detail)
  record.notes.push(
    `${new Date().toISOString()} ${what}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`
  )
}
const save = (): void => {
  writeFileSync(join(out, `${part}.json`), JSON.stringify(record))
}

/**
 * Records the display until `seconds` from now; answers when it has
 * finished. `screencapture` stops early on its own at times (another
 * recording of the display started, the display changed); it is started
 * again at once into a new part, and the parts are joined into
 * `<part>.mov`. Each part's start, and the gap before it, is logged.
 */
async function capture(seconds: number): Promise<number> {
  const file = join(out, `${part}.mov`)
  const startedAt = Date.now()
  const until = startedAt + seconds * 1000
  const parts: Array<{ file: string; startedAt: number; endedAt: number }> = []
  record.capture = { startedAt, seconds, file, parts }
  note('recording the display', { seconds })
  while (until - Date.now() > 1000) {
    const one = join(out, `${part}-${parts.length + 1}.mov`)
    const left = Math.round((until - Date.now()) / 1000)
    const begun = Date.now()
    const code = await new Promise<number>(resolve => {
      const child = spawn(
        '/usr/sbin/screencapture',
        ['-v', '-V', String(left), '-x', one],
        {
          stdio: ['ignore', 'inherit', 'inherit']
        }
      )
      child.on('exit', code => {
        resolve(code ?? 1)
      })
    })
    parts.push({ file: one, startedAt: begun, endedAt: Date.now() })
    note('display recording part finished', {
      part: parts.length,
      code,
      seconds: (Date.now() - begun) / 1000
    })
    save()
  }
  if (parts.length === 1) renameSync(parts[0].file, file)
  else {
    const list = join(out, `${part}-parts.txt`)
    writeFileSync(
      list,
      parts.map(one => `file '${one.file}'`).join('\n') + '\n'
    )
    execFileSync(process.env.F1_FFMPEG ?? '/opt/homebrew/bin/ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c',
      'copy',
      file
    ])
  }
  note('display recording finished', { parts: parts.length })
  return 0
}

/**
 * Puts the browser window the daemon launched into full screen, through that
 * browser's own DevTools endpoint: maestro-d sizes the page, not the window.
 * `again` brings that window's full-screen space back to the front, when
 * another window has taken the display: only this browser's own window is
 * touched.
 */
async function fullScreen(again = false): Promise<void> {
  const bin = process.env.MAESTRO_D_BIN ?? 'maestro-d'
  const line = execFileSync(bin, ['ps'])
    .toString()
    .split('\n')
    .find(one => one.split(/\s+/)[0] === daemonName)
  if (line == null) throw new Error(`no daemon ${daemonName}`)
  const table = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='])
    .toString()
    .split('\n')
    .map(one => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(one))
    .filter(one => one != null)
    .map(([, pid, ppid, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      command
    }))
  const under: typeof table = []
  const walk = (pid: number): void => {
    for (const row of table)
      if (row.ppid === pid) {
        under.push(row)
        walk(row.pid)
      }
  }
  walk(Number(line.split(/\s+/)[1]))
  const dirs = new Set(
    under
      .filter(row => !row.command.includes('--type='))
      .map(row => /--user-data-dir=(\S+)/.exec(row.command)?.[1])
      .filter(dir => dir != null)
  )
  let done = 0
  for (const dir of dirs) {
    const [port, path] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8')
      .trim()
      .split('\n')
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    let id = 0
    const send = async (
      method: string,
      params: object = {}
    ): Promise<Record<string, unknown>> =>
      await new Promise((resolve, reject) => {
        const mine = ++id
        const on = (data: Buffer): void => {
          const message = JSON.parse(data.toString()) as {
            id: number
            result: Record<string, unknown>
            error?: unknown
          }
          if (message.id !== mine) return
          socket.off('message', on)
          if (message.error != null)
            reject(new Error(JSON.stringify(message.error)))
          else resolve(message.result)
        }
        socket.on('message', on)
        socket.send(JSON.stringify({ id: mine, method, params }))
      })
    const { targetInfos } = (await send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string }>
    }
    for (const target of targetInfos.filter(one => one.type === 'page')) {
      if (again)
        await send('Target.activateTarget', { targetId: target.targetId })
      const { windowId } = await send('Browser.getWindowForTarget', {
        targetId: target.targetId
      })
      await send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'fullscreen' }
      })
      done++
    }
    socket.close()
  }
  if (done === 0) throw new Error('no browser window to put in full screen')
  // macOS animates into full screen.
  await rig.pause(3000)
}

async function attach(): Promise<rig.Page> {
  const daemon = await MaestroD.connect({ name: daemonName })
  const page = await daemon.attach({
    device: `f1-${part}-${Date.now().toString(36)}`,
    platform: 'web',
    appId: rig.APP,
    stepDelay: 0,
    artifacts: 'on-failure',
    extra: { browser: browserBinary, windowSize: SCREEN, headed: true }
  })
  await page.blockNetwork({
    patterns: ['*fonts.googleapis.com*', '*fonts.gstatic.com*']
  })
  await page.setCookies({
    cookies: [
      {
        name: 'ts_session',
        value: encodeURIComponent(rig.api().token!),
        domain: new URL(rig.API).hostname,
        path: '/'
      }
    ]
  })
  await fullScreen()
  return page
}

async function open(
  page: rig.Page,
  url: string,
  ready: string,
  what: string
): Promise<void> {
  await page.openBrowser({ url })
  await rig.probe(page, COVER_KEYS)
  await rig.until(page, ready, what)
  await rig.probe(page, COVER_KEYS)
  await rig.probe(page, `${SCROLL_PICTURE}; return true`)
  await rig.pause(500)
  const geometry = await rig.probe<{ videos: unknown[] }>(page, GEOMETRY)
  record.geometry.push({ what, ...geometry })
  note(what, { videos: geometry.videos })
}

/**
 * Watches, every 2 s while the display is recorded, that the picture is
 * still whole at the top of the window (`SCROLL_PICTURE`), that the page is
 * still what the display shows (`document.visibilityState`: another window in full
 * screen hides it) and that the API answers. When the page has been hidden
 * for two looks in a row, this browser's own window is brought back to the
 * front. Answers a function that stops watching.
 */
function watchDisplay(page: rig.Page): () => void {
  const watching = { stopped: false }
  let hidden = 0
  let last = ''
  const looking = (async () => {
    while (!watching.stopped) {
      await rig.pause(2000)
      if (watching.stopped) break
      try {
        await page.evalBrowserScript({
          script: `${SCROLL_PICTURE}; return document.visibilityState`,
          output: 'watch'
        })
        const state = String((await page.vars()).watch)
        if (state !== last) {
          record.visibility.push({ at: Date.now(), state })
          if (last !== '') note(`the page is ${state}`)
          last = state
        }
        hidden = state === 'hidden' ? hidden + 1 : 0
        if (hidden === 2) {
          note('another window has the display; bringing this one back')
          await fullScreen(true)
        }
      } catch (error: unknown) {
        note('could not look at the page', String(error))
      }
      try {
        const answer = await fetch(`${rig.API}/time`)
        if (!answer.ok) note('the API answered', answer.status)
      } catch (error: unknown) {
        note('the API does not answer', String(error))
      }
    }
  })()
  looking.catch(() => undefined)
  return () => {
    watching.stopped = true
  }
}

async function frames(page: rig.Page, label: string): Promise<void> {
  const raw = await rig.probe<unknown[]>(
    page,
    `if (window.__f1 == null) return []; window.__f1.stop = true; return window.__f1.frames`
  )
  record.pageFrames.push({ label, frames: raw })
  note(`page frames ${label}`, { count: raw.length })
}

async function sync(gameId: string): Promise<void> {
  const programme = await rig.camera(gameId, 'F1 programme')
  record.videos.programme = programme.videoId
  const show = rig.broadcast(programme.url, [
    '--stamped',
    '--duration',
    '600',
    '--outage',
    '300:20',
    '--lead',
    process.env.F1_LEAD ?? '360'
  ])
  const t0 = await show.t0
  record.t0 = t0
  note('T0', rig.iso(t0))
  const session = await rig.scorer(gameId)
  const desk = await rig.dashboard(gameId)
  const page = await attach()
  const at = async (sec: number): Promise<void> => {
    await rig.pause(t0 + sec * 1000 - Date.now())
  }
  const act = (what: string): void => {
    record.actions.push({ at: Date.now(), what })
    note(what)
  }
  const ball = async (call: 'B' | 'C' | 'S' | 'F'): Promise<void> => {
    const at = rig.pitch(session, call)
    record.actions.push({ at, what: `pitch ${call}` })
    note(`pitch ${call}`, rig.iso(at))
    await session.flush()
  }
  const board = (on: boolean): void => {
    desk.send(JSON.stringify({ type: 'overrides', data: rig.overrides(on) }))
    act(`dashboard ${on ? 'on' : 'off'}`)
  }

  await at(6)
  const url = `${rig.APP}/games/${gameId}?video=${programme.videoId}`
  await open(page, url, rig.PICTURE_READY, 'the live programme shows a picture')
  await rig.probe(page, frameLogger(`document.querySelector('video')`))
  // From here the browser covers the display; it ends after the stream.
  const startAt = Date.now()
  const recorded = capture(Math.round((t0 + 612_000 - startAt) / 1000))
  const unwatch = watchDisplay(page)

  const plan: Array<[number, () => Promise<void> | void]> = [
    [
      30,
      async () => {
        await ball('B')
      }
    ],
    [
      60,
      async () => {
        await ball('C')
      }
    ],
    [
      90,
      () => {
        board(true)
      }
    ],
    [
      120,
      () => {
        board(false)
      }
    ],
    [
      150,
      async () => {
        await ball('B')
      }
    ],
    [
      180,
      async () => {
        await ball('F')
      }
    ],
    [
      210,
      async () => {
        await ball('B')
      }
    ],
    [
      240,
      async () => {
        await ball('S')
      }
    ],
    [
      270,
      async () => {
        await ball('B')
      }
    ],
    [
      350,
      async () => {
        await ball('C')
      }
    ],
    [
      380,
      () => {
        board(true)
      }
    ],
    [
      410,
      () => {
        board(false)
      }
    ],
    [
      440,
      async () => {
        await ball('B')
      }
    ],
    [
      470,
      async () => {
        await ball('B')
      }
    ],
    [
      500,
      async () => {
        await ball('C')
      }
    ],
    [
      530,
      async () => {
        await ball('F')
      }
    ],
    [
      560,
      async () => {
        await ball('B')
      }
    ]
  ]
  let reopened = false
  for (const [sec, run] of plan) {
    if (!reopened && sec > 320) {
      // Two seconds after the publisher is back, as E8 does: has the live
      // player stopped at the outage?
      await at(322)
      const state = await rig.probe<{
        at: number
        ended: boolean
        end: number
        paused: boolean
      }>(
        page,
        `const v = document.querySelector('video'); return { at: v.currentTime, ended: v.ended, paused: v.paused, end: v.buffered.length > 0 ? v.buffered.end(v.buffered.length - 1) : 0 }`
      )
      note('the live player two seconds after the outage', state)
      await rig.pause(8000)
      const later = await rig.probe<{ at: number; ended: boolean }>(
        page,
        `const v = document.querySelector('video'); return { at: v.currentTime, ended: v.ended }`
      )
      note('ten seconds after the outage', later)
      if (later.ended || later.at - state.at < 4) {
        await frames(page, 'before-break')
        act('reopen the page')
        await open(
          page,
          url,
          rig.PICTURE_READY,
          'the programme shows a picture again'
        )
        await rig.probe(page, frameLogger(`document.querySelector('video')`))
      } else note('the live player kept playing; not reopened')
      reopened = true
    }
    await at(sec)
    await run()
  }
  desk.close(1000)
  const code = await show.done
  note('the stream ended', { code })
  await at(612)
  record.geometry.push({
    what: 'end',
    ...(await rig.probe<Record<string, unknown>>(page, GEOMETRY))
  })
  await frames(page, reopened ? 'after-break' : 'whole')
  await recorded
  unwatch()
  await page.detach()
  await rig.endCamera(gameId, programme.videoId)
  await rig.ready(gameId, programme.videoId)
  record.steps = (
    await rig.api().scoreboardTimeline(gameId, { fromMs: t0 - 60_000 })
  ).steps
  record.vod = await rig.videoTimeline(programme.videoId)
}

async function grid(gameId: string): Promise<void> {
  const unstamped = await rig.camera(gameId, 'F1 unstamped')
  const stamped = await rig.camera(gameId, 'F1 stamped')
  record.videos.unstamped = unstamped.videoId
  record.videos.stamped = stamped.videoId
  const duration = 280
  const lead = process.env.F1_LEAD ?? '240'
  const shows = [
    rig.broadcast(unstamped.url, [
      '--duration',
      String(duration),
      '--lead',
      lead
    ]),
    rig.broadcast(stamped.url, [
      '--stamped',
      '--duration',
      String(duration),
      '--lead',
      lead
    ])
  ]
  const t0 = await shows[0].t0
  record.t0 = t0
  note('T0', rig.iso(t0))
  const session = await rig.scorer(gameId)
  const page = await attach()
  const at = async (sec: number): Promise<void> => {
    await rig.pause(t0 + sec * 1000 - Date.now())
  }
  const single = `${rig.APP}/games/${gameId}?video=${unstamped.videoId}`
  const both = `${rig.APP}/games/${gameId}?angles=${unstamped.videoId},${stamped.videoId}&audio=${stamped.videoId}`

  await at(8)
  await open(
    page,
    single,
    rig.PICTURE_READY,
    'the unstamped angle shows a picture'
  )
  await rig.probe(page, frameLogger(`document.querySelector('video')`))
  const startAt = Date.now()
  const recorded = capture(Math.round((t0 + 335_000 - startAt) / 1000))
  const unwatch = watchDisplay(page)
  let pitches = 0
  const pitchAt = async (sec: number): Promise<void> => {
    await at(sec)
    const call = (['B', 'C', 'B', 'F'] as const)[pitches++ % 4]
    const when = rig.pitch(session, call)
    record.actions.push({ at: when, what: `pitch ${call}` })
    note(`pitch ${call}`, rig.iso(when))
    await session.flush()
  }
  for (const sec of [25, 50, 75, 100, 120]) await pitchAt(sec)
  await at(130)
  await frames(page, 'unstamped')
  record.actions.push({ at: Date.now(), what: 'open the live grid' })
  await open(
    page,
    both,
    rig.gridReady(2),
    'both tiles of the live grid show a picture'
  )
  await rig.probe(page, frameLogger(`${rig.GRID_VIDEOS}[1]`))
  for (const sec of [150, 175, 200, 225, 245]) await pitchAt(sec)
  await at(252)
  record.geometry.push({
    what: 'grid',
    ...(await rig.probe<Record<string, unknown>>(page, GEOMETRY))
  })
  await frames(page, 'live-grid')
  record.actions.push({ at: Date.now(), what: 'back to the unstamped angle' })
  await open(page, single, rig.PICTURE_READY, 'the unstamped angle again')
  await rig.probe(page, frameLogger(`document.querySelector('video')`))
  await pitchAt(265)
  const codes = await Promise.all(shows.map(async show => await show.done))
  note('both streams ended', { codes })
  await rig.endCamera(gameId, unstamped.videoId)
  await rig.endCamera(gameId, stamped.videoId)
  record.actions.push({ at: Date.now(), what: 'cameras ended' })
  note('cameras ended')
  await rig.ready(gameId, unstamped.videoId)
  record.actions.push({ at: Date.now(), what: 'unstamped recording ready' })
  note('the unstamped recording is ready')
  await recorded
  unwatch()
  record.geometry.push({
    what: 'end',
    ...(await rig.probe<Record<string, unknown>>(page, GEOMETRY))
  })
  record.notes.push(
    `page src at the end: ${JSON.stringify(
      await rig.probe(
        page,
        `return [...document.querySelectorAll('video')].map(v => ({ src: v.currentSrc.replace(/key=[^&]+/, 'key=…'), t: v.currentTime, paused: v.paused }))`
      )
    )}`
  )
  await frames(page, 'after-end')
  await page.detach()
  await rig.ready(gameId, stamped.videoId)
  record.steps = (
    await rig.api().scoreboardTimeline(gameId, { fromMs: t0 - 60_000 })
  ).steps
}

async function main(): Promise<void> {
  let failed = false
  try {
    const [gameId] = await rig.setUp({
      name: `f1${part}`,
      browser: browserBinary,
      games: 1
    })
    note('game', gameId)
    if (part === 'sync') await sync(gameId)
    else await grid(gameId)
  } catch (error) {
    failed = true
    note('FAILED', String((error as Error)?.stack ?? error))
  } finally {
    save()
    await rig.tearDown().catch((error: unknown) => {
      note('teardown failed', String(error))
    })
    save()
  }
  process.exit(failed ? 1 : 0)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
