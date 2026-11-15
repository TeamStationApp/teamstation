import { type Shaper, shaper as makeShaper } from './shaper'
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
      const aligned = moments(others(look, 'SynthB')).every(
        at => landed != null && Math.abs(at - landed) <= 1500
      )
      await session.record.check(
        watcher,
        'gap-seek-paused-in-hole',
        "SynthB shows a notice and no frame past the hole's start; the others hold the hole's middle ± 1.5 s",
        `landed ${landed == null ? 'unread' : new Date(landed).toISOString().slice(11, 23)}; ${describe(look)}`,
        holeShown && aligned
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
      const beforeTake = moments(early.tiles ?? []).some(
        at => at < session.takeStartMs - 1000
      )
      const notYet = (early.tiles ?? []).some(
        t => t.wallMs != null && /not recording yet/i.test(t.notice ?? '')
      )
      await session.record.check(
        watcher,
        'gap-seek-before-take',
        'no tile shows a moment before the take, nor "Not recording yet" over footage',
        describe(early),
        !beforeTake && !notYet
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
      const ok =
        caughtUp.get(watcher) !== true &&
        (ended == null || /ended/i.test(ended.notice ?? ''))
      await session.record.check(
        watcher,
        'angle-ends',
        'the ended camera says it ended, never "catching up"; the others keep moving',
        `${caughtUp.get(watcher) === true ? 'said catching up; ' : ''}${describe(look)}`,
        ok && others(look, 'SynthC').every(t => t.advancing === true)
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
      const cut = session.publishers.get('SynthA')!.cut(45)
      await session.sleep(20_000)
      for (const watcher of session.watchers) {
        const look = await session.look(watcher)
        const during = tile(look, 'SynthA')
        await session.record.check(
          watcher,
          `${step}-during`,
          'the camera that is out says so, rather than freezing silently',
          describe(look),
          during == null || during.notice != null
        )
      }
      await cut
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
  newShaper: (base: string) => Shaper = base => makeShaper({ base })
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
    await session.record.check(
      tv,
      'tv-skip-inside',
      'skips keep the bar inside the take',
      describe(skipped),
      skipped.tiles != null
    )
    await session.publishers.get('SynthB')!.cut(45)
    const back = await waitFor(
      async () => {
        const look = await session.look(tv)
        return { ok: tile(look, 'SynthB')?.notice == null, value: look }
      },
      {
        timeoutMs: 30_000,
        everyMs: 5000,
        sleep: session.sleep,
        now: session.now
      }
    )
    await session.record.check(
      tv,
      'tv-publisher-outage',
      'within 30 s of its return the camera shows no notice',
      describe(back.value),
      back.ok
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
