import { loadShaper, type Shaper } from './shaper'
import { tvCodeIn } from './soakSignIn'
import { TILE_NOTICE } from './surfaces/surface'
import {
  type Look,
  type LookTile,
  medianMs,
  spreadMs,
  type TargetedSession,
  type TargetedSetup,
  waitFor,
  type Watcher
} from './targeted'

/**
 * The eight targeted scenarios' steps (`e2e/tests/streaming/targeted/`). Each
 * acts on the synthetic cameras or a watcher, then looks, and records what it
 * saw against what the streaming fixes claim. Times come from the session's
 * clock, so the steps run against a fake session in their unit tests.
 */

const MIN = 60_000
const THREE = ['SynthA', 'SynthB', 'SynthC']
const WATCHERS = ['iphone', 'android', 'ipad', 'chrome'] as const

/** A scenario: what it needs, and its steps. */
export interface TargetedScenario {
  setup: TargetedSetup
  run: (session: TargetedSession) => Promise<void>
}

function tile(look: Look, angle: string): LookTile | undefined {
  return look.tiles?.find(t => t.angle === angle)
}

function others(look: Look, angle: string): LookTile[] {
  return (look.tiles ?? []).filter(t => t.angle !== angle)
}

function moments(tiles: LookTile[]): number[] {
  return tiles.map(t => t.wallMs).filter((at): at is number => at != null)
}

function describe(look: Look): string {
  if (look.tiles == null) return `no tiles (${look.reason ?? 'no answer'})`
  return look.tiles
    .map(
      t =>
        `${t.angle}: ${t.advancing === true ? 'moving' : t.advancing === false ? 'still' : '?'}${t.wallMs == null ? '' : ` @${new Date(t.wallMs).toISOString().slice(11, 23)}`}${t.notice == null ? '' : ` "${t.notice}"`}`
    )
    .join('; ')
}

/**
 * Records a check on a look only where the look can bear it: a player with
 * no tiles, or without the `angle` the check is about, fails; a check that
 * needs clock readings (`read`) and has none is blocked, since the harness
 * could not tell.
 */
async function checkLook(
  session: TargetedSession,
  watcher: Watcher,
  step: string,
  expected: string,
  observed: string,
  look: Look,
  ok: boolean,
  needs: { angle?: string; read?: number[] } = {}
): Promise<void> {
  if ((look.tiles ?? []).length === 0) {
    await session.record.step(watcher, step, expected, observed, 'failed')
  } else if (needs.angle != null && tile(look, needs.angle) == null) {
    await session.record.step(
      watcher,
      step,
      expected,
      `no ${needs.angle} tile; ${observed}`,
      'failed'
    )
  } else if (needs.read?.length === 0) {
    await session.record.step(
      watcher,
      step,
      expected,
      `no tile clock read; ${observed}`,
      'blocked'
    )
  } else {
    await session.record.check(watcher, step, expected, observed, ok)
  }
}

/**
 * Starts `work` now and gives a way to await it later: a rejection that
 * comes meanwhile is kept for that await, never left unheard.
 */
function started(work: PromiseLike<void>): () => Promise<void> {
  const settled = Promise.resolve(work).then(
    () => null,
    (error: unknown) => ({ error })
  )
  return async () => {
    const outcome = await settled
    if (outcome != null) throw outcome.error
  }
}

/** Waits until the session's clock reaches `atMs`. */
async function until(session: TargetedSession, atMs: number): Promise<void> {
  const wait = atMs - session.now()
  if (wait > 0) await session.sleep(wait)
}

/** Waits up to `ms` for every tile to move; gives the last look and whether they did. */
async function untilMoving(
  session: TargetedSession,
  watcher: Watcher,
  ms: number,
  also: (look: Look) => boolean = () => true
): Promise<{ ok: boolean; value: Look }> {
  return await waitFor(
    async () => {
      const look = await session.look(watcher)
      const moving =
        look.tiles != null &&
        look.tiles.length > 0 &&
        look.tiles.every(t => t.advancing === true)
      return { ok: moving && also(look), value: look }
    },
    { timeoutMs: ms, everyMs: 5000, sleep: session.sleep, now: session.now }
  )
}

function pausable(watcher: Watcher): boolean {
  return watcher.surface.togglePause != null
}

/** S06, WEB16, WEB06: a paused seek into a hole, then a skip before the take. */
export const gapSeek: TargetedScenario = {
  setup: { synthetic: THREE, watchers: [...WATCHERS] },
  run: async session => {
    await until(session, session.takeStartMs + 3 * MIN)
    const holeStart = session.now()
    await session.publishers.get('SynthB')!.cut(20)
    const holeEnd = session.now()
    const holeMid = holeStart + (holeEnd - holeStart) / 2
    await session.sleep(2 * MIN)
    for (const watcher of session.watchers) {
      if (!pausable(watcher)) {
        await session.record.step(
          watcher,
          'gap-seek-paused',
          'pause and seek into the hole',
          'the surface cannot pause',
          'blocked'
        )
        continue
      }
      await watcher.surface.togglePause!()
      const landed = await session.seekTo(watcher, holeMid)
      const look = await session.look(watcher)
      const hole = tile(look, 'SynthB')
      const holeShown =
        hole?.notice != null &&
        TILE_NOTICE.test(hole.notice) &&
        (hole.wallMs == null || hole.wallMs <= holeStart + 1000)
      const rest = moments(others(look, 'SynthB'))
      const aligned = rest.every(
        at => landed != null && Math.abs(at - landed) <= 1500
      )
      await checkLook(
        session,
        watcher,
        'gap-seek-paused-in-hole',
        "SynthB shows a notice and no frame past the hole's start; the others hold the hole's middle ± 1.5 s",
        `landed ${landed == null ? 'unread' : new Date(landed).toISOString().slice(11, 23)}; ${describe(look)}`,
        look,
        holeShown && aligned,
        { angle: 'SynthB', read: rest }
      )
      await watcher.surface.togglePause!()
      const resumed = await untilMoving(session, watcher, 30_000)
      await session.record.check(
        watcher,
        'gap-seek-resumed',
        'every tile moves within 30 s of playing again',
        describe(resumed.value),
        resumed.ok
      )
      await session.seekTo(watcher, session.takeStartMs - 5000)
      const early = await session.look(watcher)
      const shown = moments(early.tiles ?? [])
      const beforeTake = shown.some(at => at < session.takeStartMs - 1000)
      const notYet = (early.tiles ?? []).some(
        t => t.wallMs != null && /not recording yet/i.test(t.notice ?? '')
      )
      await checkLook(
        session,
        watcher,
        'gap-seek-before-take',
        'no tile shows a moment before the take, nor "Not recording yet" over footage',
        describe(early),
        early,
        !beforeTake && !notYet,
        { read: shown }
      )
      await watcher.surface.jumpToPresent().catch(() => undefined)
    }
  }
}

/** IPAD15, S05, S08: a camera that ends, then the finished game. */
export const angleEnds: TargetedScenario = {
  setup: { synthetic: THREE, watchers: [...WATCHERS] },
  run: async session => {
    await until(session, session.takeStartMs + 4 * MIN)
    await session.publishers.get('SynthC')!.stop()
    await session.owner.endCamera(
      session.world.world.gameId,
      session.streamId('SynthC')
    )
    const caughtUp = new Map<Watcher, boolean>()
    const last = new Map<Watcher, Look>()
    const end = session.now() + MIN
    while (session.now() < end) {
      for (const watcher of session.watchers) {
        const look = await session.look(watcher)
        last.set(watcher, look)
        if (/catching up/i.test(tile(look, 'SynthC')?.notice ?? ''))
          caughtUp.set(watcher, true)
      }
      await session.sleep(10_000)
    }
    for (const watcher of session.watchers) {
      const look = last.get(watcher)!
      const ended = tile(look, 'SynthC')
      const rest = others(look, 'SynthC')
      await checkLook(
        session,
        watcher,
        'angle-ends',
        'the ended camera says it ended, never "catching up"; the others keep moving',
        `${caughtUp.get(watcher) === true ? 'said catching up; ' : ''}${describe(look)}`,
        look,
        caughtUp.get(watcher) !== true &&
          /ended/i.test(ended?.notice ?? '') &&
          rest.length > 0 &&
          rest.every(t => t.advancing === true),
        { angle: 'SynthC' }
      )
    }
    for (const label of ['SynthA', 'SynthB']) {
      await session.publishers.get(label)!.stop()
      await session.owner.endCamera(
        session.world.world.gameId,
        session.streamId(label)
      )
    }
    const finishedAt = session.now()
    await session.sleep(30_000)
    const middle = session.takeStartMs + (finishedAt - session.takeStartMs) / 2
    for (const watcher of session.watchers) {
      await watcher.surface.relaunch().catch(() => undefined)
      const landed = await session.seekTo(watcher, middle)
      const played = await untilMoving(session, watcher, MIN, look =>
        (look.tiles ?? []).every(t => !/retry/i.test(t.notice ?? ''))
      )
      await session.record.check(
        watcher,
        'finished-game-seek',
        'the finished game seeks to its middle within 2 s and plays on, with no Retry',
        `landed ${landed == null ? 'unread' : `${Math.round((landed - middle) / 100) / 10} s from the middle`}; ${describe(played.value)}`,
        landed != null && Math.abs(landed - middle) <= 2000 && played.ok
      )
    }
  }
}

/** IPAD02, S07: a publisher's outage, live and while rewound. */
export const publisherOutage: TargetedScenario = {
  setup: { synthetic: THREE, watchers: [...WATCHERS] },
  run: async session => {
    const outage = async (step: string, behindMs: number): Promise<void> => {
      const cut = started(session.publishers.get('SynthA')!.cut(45))
      await session.sleep(20_000)
      for (const watcher of session.watchers) {
        const look = await session.look(watcher)
        await checkLook(
          session,
          watcher,
          `${step}-during`,
          'the camera that is out says so, rather than freezing silently',
          describe(look),
          look,
          tile(look, 'SynthA')?.notice != null,
          { angle: 'SynthA' }
        )
      }
      await cut()
      for (const watcher of session.watchers) {
        const back = await untilMoving(session, watcher, 30_000, look => {
          const a = tile(look, 'SynthA')
          const rest = medianMs(moments(others(look, 'SynthA')))
          return (
            a?.wallMs != null &&
            rest != null &&
            Math.abs(a.wallMs - rest) <= 1000
          )
        })
        const rest = medianMs(moments(back.value.tiles ?? []))
        const kept =
          behindMs === 0 ||
          (rest != null && Math.abs(session.now() - behindMs - rest) <= 5000)
        await session.record.check(
          watcher,
          `${step}-after`,
          behindMs === 0
            ? 'within 30 s the camera moves again, within 1 s of the others'
            : 'within 30 s the camera rejoins the rewound moment, 60 s ± 5 s behind live',
          describe(back.value),
          back.ok && kept
        )
      }
    }
    await until(session, session.takeStartMs + 3 * MIN)
    await outage('publisher-outage-live', 0)
    await until(session, session.takeStartMs + 8 * MIN)
    for (const watcher of session.watchers) {
      await session.seekTo(watcher, session.now() - MIN)
    }
    await outage('publisher-outage-rewound', MIN)
  }
}

/** S07–S09: a watcher's own network out for three minutes. */
export function receiverOutage(
  newShaper: (module: string) => Shaper = loadShaper
): TargetedScenario {
  return {
    setup: { synthetic: THREE, watchers: ['iphone', 'android', 'ipad'] },
    run: async session => {
      const conditioner =
        session.shaper == null ? null : newShaper(session.shaper)
      for (const watcher of session.watchers) {
        const ip = session.shapedIps[watcher.role]
        const on =
          conditioner == null || ip == null
            ? null
            : await conditioner.onTestNetwork(ip)
        if (conditioner == null || ip == null || on == null) {
          await session.record.step(
            watcher,
            'receiver-outage',
            'a three-minute network outage on this watcher',
            conditioner == null
              ? "the local settings' soak block names no shaper"
              : ip == null
                ? `no address for ${watcher.role} in soak.shapedIps`
                : `${ip} is not on a test network the conditioner shapes`,
            'blocked'
          )
          continue
        }
        await conditioner.outage(ip, 3 * MIN)
        const back = await untilMoving(session, watcher, 30_000)
        await session.record.check(
          watcher,
          'receiver-outage-playing',
          'within 30 s of the network returning, every tile moves',
          describe(back.value),
          back.ok
        )
        if (!pausable(watcher)) continue
        await session.seekTo(watcher, session.now() - MIN)
        await watcher.surface.togglePause!()
        const held = medianMs(
          moments((await session.look(watcher)).tiles ?? [])
        )
        await conditioner.outage(ip, 3 * MIN)
        const after = await session.look(watcher)
        const still = medianMs(moments(after.tiles ?? []))
        await session.record.check(
          watcher,
          'receiver-outage-paused',
          'paused and rewound before the outage, it is still paused at the same moment ± 2 s after it',
          `held ${held == null ? 'unread' : new Date(held).toISOString().slice(11, 23)}; ${describe(after)}`,
          held != null &&
            still != null &&
            Math.abs(still - held) <= 2000 &&
            (after.tiles ?? []).every(t => t.advancing !== true)
        )
        await watcher.surface.togglePause!()
        const resumed = await untilMoving(session, watcher, 30_000)
        await session.record.check(
          watcher,
          'receiver-outage-resumed',
          'played again, it moves on from where it was held',
          describe(resumed.value),
          resumed.ok
        )
      }
    }
  }
}

/** IPADSYNC08, S10: how far apart the angles are, every minute for 30 minutes. */
export const drift: TargetedScenario = {
  setup: { synthetic: THREE, watchers: [...WATCHERS] },
  run: async session => {
    await session.sleep(2 * MIN)
    const spreads = new Map<Watcher, Array<number | null>>()
    for (let minute = 0; minute <= 30; minute++) {
      for (const watcher of session.watchers) {
        const look = await session.look(watcher)
        const spread = spreadMs(moments(look.tiles ?? []))
        spreads.set(watcher, [...(spreads.get(watcher) ?? []), spread])
      }
      if (minute < 30) await session.sleep(MIN)
    }
    for (const watcher of session.watchers) {
      const all = spreads.get(watcher)!
      const read = all.filter((s): s is number => s != null)
      if (read.length < all.length / 2) {
        await session.record.step(
          watcher,
          'drift',
          'tile clocks read at least half the minutes',
          `read ${read.length} of ${all.length}`,
          'blocked'
        )
        continue
      }
      const worst = Math.max(...read)
      const growth = read[read.length - 1] - read[0]
      await session.record.check(
        watcher,
        'drift',
        'every minute the tiles are within 500 ms of each other, and the spread grows no more than 500 ms',
        `spreads ms: ${all.map(s => (s == null ? '-' : String(s))).join(',')}; worst ${worst}, growth ${growth}`,
        worst <= 500 && growth <= 500
      )
    }
  }
}

/** ANDROID04, IPAD03: a cold start opens the grid with every tile moving, no seek. */
export const coldJoin: TargetedScenario = {
  setup: { synthetic: THREE, watchers: [...WATCHERS] },
  run: async session => {
    for (const watcher of session.watchers) {
      for (let round = 1; round <= 5; round++) {
        await watcher.surface.relaunch()
        const opened = await untilMoving(session, watcher, 20_000)
        await session.record.check(
          watcher,
          `cold-join-${round}`,
          'within 20 s of a cold start every tile moves, without any seek',
          describe(opened.value),
          opened.ok
        )
      }
    }
  }
}

/** Runs in Chrome's page: the text of the camera panel's row for a label. */
export function panelRowScript(label: string): string {
  return `(() => {
    const rows = [...document.querySelectorAll('li, [role="listitem"], [role="row"], div')]
      .filter(el => (el.innerText || '').includes(${JSON.stringify(label)}) && (el.innerText || '').length < 200)
    rows.sort((a, b) => a.innerText.length - b.innerText.length)
    return rows.length === 0 ? null : rows[0].innerText
  })()`
}

/** WEB11: the owner's camera panel reads on after a request that is never answered. */
export const ownerPanel: TargetedScenario = {
  setup: { synthetic: THREE, watchers: ['chrome'], chromeAs: 'owner' },
  run: async session => {
    const chrome = session.watchers.find(w => w.role === 'chrome')!
    if (chrome.cdp == null || chrome.evaluate == null || chrome.open == null) {
      await session.record.step(
        chrome,
        'owner-panel',
        'the owner’s camera panel',
        'no DevTools session',
        'blocked'
      )
      return
    }
    await chrome.open(session.world.links.web)
    await session.sleep(10_000)
    let held: string | null = null
    chrome.cdp.on('Fetch.requestPaused', (event: { requestId: string }) => {
      if (held == null) held = event.requestId
      else
        chrome
          .cdp!.send('Fetch.continueRequest', { requestId: event.requestId })
          .catch(() => undefined)
    })
    await chrome.cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*live-streams*', requestStage: 'Request' }]
    })
    try {
      await session.sleep(15_000)
      await session.publishers.get('SynthC')!.stop()
      await session.owner.endCamera(
        session.world.world.gameId,
        session.streamId('SynthC')
      )
      await session.sleep(75_000)
    } finally {
      if (held != null) {
        await chrome.cdp.send('Fetch.continueRequest', { requestId: held })
      }
      await chrome.cdp.send('Fetch.disable')
    }
    const shown = await waitFor(
      async () => {
        const row = (await chrome.evaluate!(panelRowScript('SynthC'))) as
          string | null
        return { ok: /ended/i.test(row ?? ''), value: row }
      },
      {
        timeoutMs: 30_000,
        everyMs: 5000,
        sleep: session.sleep,
        now: session.now
      }
    )
    await session.record.check(
      chrome,
      'owner-panel-unanswered-read',
      'within 30 s of the held read being answered, the panel shows SynthC ended, without a reload',
      `${held == null ? 'no read was held; ' : ''}row: ${JSON.stringify(shown.value)}`,
      held != null && shown.ok
    )
  }
}

/** TV cold start, TV10, TVSYNC09, S03–S04: the TV with four cameras. */
export const tvCameras: TargetedScenario = {
  setup: {
    synthetic: ['SynthA', 'SynthB', 'SynthC', 'SynthD'],
    watchers: ['tv']
  },
  run: async session => {
    const tv = session.watchers.find(w => w.role === 'tv')!
    const control = tv.tv!
    await control.coldLaunch()
    const started = await waitFor(
      async () => {
        const dump = await control.dump()
        const ready =
          tvCodeIn(dump) != null || /Welcome|tv-page-home/.test(dump)
        return { ok: ready, value: dump }
      },
      {
        timeoutMs: MIN,
        everyMs: 10_000,
        sleep: session.sleep,
        now: session.now
      }
    )
    const shows = started.value.includes('Connecting')
      ? '"Connecting…"'
      : tvCodeIn(started.value) != null
        ? 'its sign-in code'
        : /Welcome|tv-page-home/.test(started.value)
          ? 'its home'
          : 'something else'
    await session.record.check(
      tv,
      'tv-cold-start',
      'within 60 s of a cold launch the TV shows its sign-in code or its home',
      `it shows ${shows}`,
      started.ok
    )
    if (!started.ok) {
      await session.record.step(
        tv,
        'tv-cameras',
        'the TV plays the game',
        'the TV never started',
        'blocked'
      )
      return
    }
    await control.approve()
    await tv.surface.join()
    const first = await session.look(tv)
    await session.record.check(
      tv,
      'tv-cameras-offered',
      'all four cameras are offered',
      describe(first),
      (first.tiles ?? []).length === 4
    )
    await tv.surface.cut('SynthD')
    await tv.surface.skip([10, -10, -10])
    const skipped = await session.look(tv)
    const landed = moments(skipped.tiles ?? [])
    await checkLook(
      session,
      tv,
      'tv-skip-inside',
      'skips keep the bar inside the take: every tile shows a moment between its start and now',
      describe(skipped),
      skipped,
      landed.every(
        at => at >= session.takeStartMs - 1000 && at <= session.now() + 1000
      ),
      { read: landed }
    )
    await session.publishers.get('SynthB')!.cut(45)
    const back = await waitFor(
      async () => {
        const look = await session.look(tv)
        const b = tile(look, 'SynthB')
        return { ok: b != null && b.notice == null, value: look }
      },
      {
        timeoutMs: 30_000,
        everyMs: 5000,
        sleep: session.sleep,
        now: session.now
      }
    )
    await checkLook(
      session,
      tv,
      'tv-publisher-outage',
      'within 30 s of its return the camera shows no notice',
      describe(back.value),
      back.value,
      back.ok,
      { angle: 'SynthB' }
    )
    await session.publishers.get('SynthD')!.stop()
    await session.owner.endCamera(
      session.world.world.gameId,
      session.streamId('SynthD')
    )
    const ended = await waitFor(
      async () => {
        const look = await session.look(tv)
        return {
          ok: /ended/i.test(tile(look, 'SynthD')?.notice ?? ''),
          value: look
        }
      },
      {
        timeoutMs: MIN,
        everyMs: 10_000,
        sleep: session.sleep,
        now: session.now
      }
    )
    await session.record.check(
      tv,
      'tv-camera-ended',
      'the ended camera says it ended',
      describe(ended.value),
      ended.ok
    )
  }
}

/** How long each cut lasts, in turn, until the run ends. */
export const CUT_LADDER_SEC = [4, 8, 16, 32, 64]
/** How soon after the stream returns a watcher should show it again, beyond its own delay. */
export const RECOVER_MS = 5000
/** How long a watcher is given at all, beyond its own delay, before it is said not to recover. */
export const GIVE_UP_MS = 90_000
/** How long after a watcher reaches the camera's return its angles are compared. */
export const ALIGN_AFTER_MS = 10_000
/** How far apart a watcher's angles may be, as the basic soak allows. */
export const ALIGNED_MS = 1000
/** How long a watcher's other angles are waited for to reach the return, beyond its delay. */
export const ALIGN_WAIT_MS = 120_000

/** How far behind the wall clock a look shows `angle`, or null without a clock reading. */
function delayOf(look: Look, angle: string): number | null {
  const shown = tile(look, angle)?.wallMs
  return shown == null ? null : look.atMs - shown
}

/**
 * Waits for a watcher to show `angle` again after its return at `backMs`:
 * moving, and, where its clock reads, a frame from after the return. Gives
 * when that look began, or null when it never did within `giveUpMs`.
 */
async function backAfter(
  session: TargetedSession,
  watcher: Watcher,
  angle: string,
  backMs: number,
  giveUpMs: number
): Promise<{
  seenAtMs: number | null
  last: Look | null
  missedMs: number | null
  grid: boolean
}> {
  const end = session.now() + giveUpMs
  let last: Look | null = null
  // How far past the return the other angles had got in a look that did not
  // show this one back: the measure for a grid, read from its own picture,
  // not from when a slow look happened to land.
  let missedMs: number | null = null
  let grid = false
  while (session.now() < end) {
    const look = await session.look(watcher)
    last = look
    const shown = tile(look, angle)
    const rest = moments(others(look, angle))
    if (rest.length > 0) grid = true
    // Back is moving with a frame from after the return, read off its clock:
    // a watcher whose clock reads (it is only asked of one whose delay was
    // read before the cut) is not back on a picture whose clock is unread.
    if (
      shown?.advancing === true &&
      shown.wallMs != null &&
      shown.wallMs >= backMs
    ) {
      return { seenAtMs: look.atMs, last, missedMs, grid }
    }
    if (rest.length > 0) {
      const past = Math.max(...rest) - backMs
      missedMs = missedMs == null ? past : Math.max(missedMs, past)
    }
    await session.sleep(1000)
  }
  return { seenAtMs: null, last, missedMs, grid }
}

/** How long a watcher with no clock is watched for the cut reaching it. */
export const NO_CLOCK_WATCH_MS = 75_000

/**
 * For a watcher whose clock cannot be read (the TV): watches it from the
 * cut's start, while the stream is away, for the hole reaching it. A stall is
 * the hole; the stream comes back to it `seconds` after the stall begins, and
 * it should move again within 5 s of that. Watched only from the return, a
 * watcher less far behind live than the cut was already stalled, and was
 * timed from the return: up to a whole cut late passed. A watcher that never
 * stalls played through the hole.
 */
async function throughStall(
  session: TargetedSession,
  watcher: Watcher,
  angle: string,
  seconds: number
): Promise<{ late: number | null; observed: string }> {
  const end = session.now() + seconds * 1000 + NO_CLOCK_WATCH_MS
  let stalledAtMs: number | null = null
  // The first of a run of still looks: a stall is two in a row, as one
  // look's motion read can miss. A look without the tile reads nothing.
  let stillAtMs: number | null = null
  let last: Look | null = null
  while (session.now() < end || stalledAtMs != null) {
    const look = await session.look(watcher)
    last = look
    const shown = tile(look, angle)
    const moving = shown?.advancing === true && shown.notice == null
    const still =
      shown != null &&
      !moving &&
      (shown.notice != null || shown.advancing === false)
    if (stalledAtMs == null) {
      if (moving) stillAtMs = null
      else if (still) {
        if (stillAtMs == null) stillAtMs = look.atMs
        else stalledAtMs = stillAtMs
      }
    } else if (moving) {
      const late = Math.max(0, look.atMs - stalledAtMs - seconds * 1000)
      return {
        late,
        observed: `${angle} stalled at the hole and moved again ${(late / 1000).toFixed(1)} s after the stream would have reached it (no clock: timed from the stall)`
      }
    }
    if (
      stalledAtMs != null &&
      look.atMs - stalledAtMs > seconds * 1000 + GIVE_UP_MS
    ) {
      break
    }
    await session.sleep(1000)
  }
  if (stalledAtMs == null) {
    return {
      late: 0,
      observed: `${angle} moved throughout the cut and the ${Math.round(NO_CLOCK_WATCH_MS / 1000)} s after the stream returned (no clock: no stall seen)`
    }
  }
  return {
    late: null,
    observed: `${angle} stalled and not back after ${Math.round((seconds * 1000 + GIVE_UP_MS) / 1000)} s: ${last == null ? 'no look' : describe(last)}`
  }
}

/**
 * Cuts the stream of SynthA, the camera every watcher shows (Safari's too),
 * for 4, 8, 16, 32 and 64 s in turn until the run's minutes are up, and
 * checks every watcher shows it again within 5 s of its return, beyond the
 * watcher's own delay behind live, measured just before each cut. A watcher
 * whose clock cannot be read (the TV) is timed from its stall instead. Ten
 * seconds after a watcher reaches the return in its own picture, a watcher showing several angles must have
 * them within a second of each other: a camera back from a cut must not run
 * ahead of, or behind, the rest.
 */
export function streamCuts(
  minutes: number,
  options: {
    /** Whole ladders to finish however long they take, before the minutes count. */
    fullLadders?: number
  } = {}
): TargetedScenario {
  const rounds = (options.fullLadders ?? 0) * CUT_LADDER_SEC.length
  return {
    setup: {
      synthetic: ['SynthA', 'SynthB', 'SynthC', 'SynthD'],
      watchers: ['iphone', 'android', 'chrome', 'tv', 'safari'],
      safariAngle: 'SynthA',
      leadMs: MIN
    },
    run: async session => {
      const angle = 'SynthA'
      const endMs = session.now() + minutes * MIN
      for (let round = 0; round < rounds || session.now() < endMs; round++) {
        const seconds = CUT_LADDER_SEC[round % CUT_LADDER_SEC.length]
        const before = new Map<Watcher, number | null>()
        await Promise.all(
          session.watchers.map(async watcher => {
            before.set(watcher, delayOf(await session.look(watcher), angle))
          })
        )
        // A watcher with no clock is watched from the cut's start.
        const stalls = new Map(
          session.watchers
            .filter(watcher => before.get(watcher) == null)
            .map(watcher => [
              watcher,
              throughStall(session, watcher, angle, seconds)
            ])
        )
        // Handled at once: a failed cut is the scenario's failure, not an unheard watch's.
        for (const stall of stalls.values()) stall.catch(() => undefined)
        await session.publishers.get(angle)!.cut(seconds)
        const backMs = session.now()
        await Promise.all(
          session.watchers.map(async watcher => {
            const delay = before.get(watcher) ?? null
            const step = `cut-${seconds}s-${round + 1}`
            const expected = `after a ${seconds} s cut the camera is shown again within ${RECOVER_MS / 1000} s of its return`
            if (delay == null) {
              // Watched since the cut's start (`stalls`).
              const { late, observed } = await stalls.get(watcher)!
              await session.record.check(
                watcher,
                step,
                expected,
                observed,
                late != null && late <= RECOVER_MS
              )
              return
            }
            const { seenAtMs, last, missedMs, grid } = await backAfter(
              session,
              watcher,
              angle,
              backMs,
              GIVE_UP_MS + delay
            )
            // A grid is judged by its other angles: how far past the return
            // they had got while this one was not back. A single picture
            // (Safari's) by the time it was seen, less its delay.
            const late =
              seenAtMs == null
                ? null
                : grid
                  ? Math.max(0, missedMs ?? 0)
                  : seenAtMs - backMs - delay
            const observed =
              late == null
                ? `${angle} not back after ${Math.round((GIVE_UP_MS + delay) / 1000)} s: ${last == null ? 'no look' : describe(last)}`
                : grid
                  ? missedMs == null || missedMs <= 0
                    ? `${angle} back before the other angles reached the stream's return`
                    : `${angle} back; the other angles had got ${(missedMs / 1000).toFixed(1)} s past the stream's return without it`
                  : `${angle} back ${(late / 1000).toFixed(1)} s after the stream, beyond the ${(delay / 1000).toFixed(1)} s it ran behind`
            // A single picture (Safari's) keeps the 5 s only while its
            // cushion lasts: a cut longer than the delay it had left runs it
            // dry, and it takes as long as the player needs (Paul's
            // decision; #322). It is then asked only to come back.
            const outlasted = !grid && delay < seconds * 1000
            await session.record.check(
              watcher,
              step,
              outlasted
                ? `after a ${seconds} s cut, longer than the ${(delay / 1000).toFixed(1)} s of cushion left, the camera is shown again`
                : expected,
              outlasted && late != null
                ? `${observed} (cushion used up: not held to ${RECOVER_MS / 1000} s)`
                : observed,
              late != null && (outlasted || late <= RECOVER_MS)
            )
          })
        )
        // Ten seconds after each watcher reaches the return in its own
        // picture: one running behind live is still before it at first, and
        // a grid can fall further behind during the cut than it ran before
        // it, so its other angles are read until they show that moment.
        const alignStart = session.now()
        await Promise.all(
          session.watchers.map(async watcher => {
            const delay = before.get(watcher) ?? 0
            await session.sleep(
              Math.max(0, backMs + delay - alignStart) + ALIGN_AFTER_MS
            )
            const until = session.now() + ALIGN_WAIT_MS
            let look = await session.look(watcher)
            const reached = (seen: Look): boolean =>
              others(seen, angle).some(
                t => t.wallMs != null && t.wallMs >= backMs + ALIGN_AFTER_MS
              )
            // One picture (Safari's) has no other angles to wait for.
            while (
              moments(others(look, angle)).length > 0 &&
              !reached(look) &&
              session.now() < until
            ) {
              await session.sleep(2000)
              look = await session.look(watcher)
            }
            // A still angle is looked at once more before it counts: one
            // look's motion read can miss on a phone, and an angle truly
            // left still is still on the next.
            const stillIn = (seen: Look): LookTile[] =>
              (seen.tiles ?? []).filter(t => t.advancing === false)
            if (stillIn(look).length > 0) {
              await session.sleep(2000)
              look = await session.look(watcher)
            }
            const spread = spreadMs(moments(look.tiles ?? []))
            // One angle (Safari's player) or no clocks (the TV): nothing to align.
            if (spread == null) return
            // An angle left still, with no clock to compare, is not aligned.
            const still = stillIn(look)
            await session.record.check(
              watcher,
              `aligned-after-cut-${seconds}s-${round + 1}`,
              `every angle moves, within ${ALIGNED_MS / 1000} s of each other, ${ALIGN_AFTER_MS / 1000} s after the camera is back`,
              `spread ${Math.round(spread)} ms${still.length > 0 ? `, ${still.map(t => t.angle).join(', ')} still` : ''}: ${describe(look)}`,
              spread <= ALIGNED_MS && still.length === 0
            )
          })
        )
        await session.sleep(10_000)
      }
    }
  }
}
