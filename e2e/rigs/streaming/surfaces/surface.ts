import type { ProbeTile } from '../soakRecords'

/**
 * One interface for every watcher surface. Each action is the viewer's, done through
 * maestro-d (the TV through its remote helper); `probe` looks without touching.
 */

export interface SurfaceProbe {
  /** Null when the surface could not answer at all. */
  tiles: ProbeTile[] | null
  bar: number | null
  foreground: boolean | null
  sessionLost?: boolean
  reason?: string
  screenshots?: string[]
}

export interface SoakSurfaceDriver {
  readonly name: string
  /** Opens the game's multi-angle view with every angle. */
  join: () => Promise<void>
  /** Makes this angle fill the view. */
  cut: (angle: string) => Promise<void>
  /** Drags the bar to a fraction of its length and lets go. */
  scrub: (fraction: number) => Promise<void>
  rapidScrub: (fractions: number[], intervalMs?: number) => Promise<void>
  /** Ten-second steps, −10 or +10 each. */
  skip: (steps?: number[]) => Promise<void>
  slowMotion: (holdMs: number) => Promise<void>
  jumpToPresent: () => Promise<void>
  exitAndReenter: (waitMs?: number) => Promise<void>
  relaunch: () => Promise<void>
  probe: () => Promise<SurfaceProbe>
}

export type Sleep = (ms: number) => Promise<void>

export const realSleep: Sleep = async ms => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export const DEFAULT_SKIPS = [-10, -10, -10, 10, 10]

/** The app's own words for what the drivers look for, from its English strings. */
export const LABELS = {
  openAngles: 'All angles',
  watch: 'Watch',
  close: 'Close',
  back: 'Back ten seconds',
  forward: 'Forward ten seconds',
  jump: 'Jump to present',
  bar: 'Position in the game',
  tapForSound: 'Tap for sound',
  tileSuffix: ' angle'
}

/** Notices a tile can show over its picture. */
export const TILE_NOTICE =
  /catching up|waiting|loading|not recording|stopped|not available|ended|cannot be held/i

/** Runs one schedule event's action on a driver, with the schedule's arguments. */
export async function performAction(
  driver: SoakSurfaceDriver,
  action: string,
  args: Record<string, unknown> = {}
): Promise<void> {
  switch (action) {
    case 'join': {
      await driver.join()
      return
    }
    case 'scrubLeft':
    case 'scrubRight': {
      await driver.scrub(
        Number(args.fraction ?? (action === 'scrubRight' ? 1 : 0.4))
      )
      return
    }
    case 'rapidScrub': {
      await driver.rapidScrub(
        (args.fractions as number[] | undefined) ?? [0.3, 0.6, 0.2, 0.8, 0.5],
        args.intervalMs as number | undefined
      )
      return
    }
    case 'skip': {
      await driver.skip(args.steps as number[] | undefined)
      return
    }
    case 'slowMotion': {
      await driver.slowMotion(Number(args.holdMs ?? 8000))
      return
    }
    case 'cameraCut':
    case 'cameraCutBack': {
      await driver.cut(String(args.angle))
      return
    }
    case 'jumpToPresent': {
      await driver.jumpToPresent()
      return
    }
    case 'exitAndReenter': {
      await driver.exitAndReenter(Number(args.waitSec ?? 10) * 1000)
      return
    }
    case 'relaunch': {
      await driver.relaunch()
      return
    }
    default:
      throw new Error(`no surface action "${action}"`)
  }
}
