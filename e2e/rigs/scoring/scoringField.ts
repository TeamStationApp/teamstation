import type { ScoringAction } from '../../../src/common/scoring/actions'
import type { FixtureManifest } from '../../core/fixtures'
import type { E2eContext } from '../../core/spec'
import {
  type CoachApp,
  flatten,
  labelOf,
  type Node,
  openCoachApp
} from '../coach/coachApp'
import { maestroDriver, placeFielder, setTrajectory } from '../fieldPointer'
import { nativeField } from './nativeField'

/**
 * The scoring screen of the `coach-game` world on either surface, as its
 * scorekeeper: the game seeded through the API to the runners and outs a
 * scenario names, then scored on the field the way a scorer does. Every
 * act goes through maestro-d; on the web the page is only read.
 */

/** The phone's web view held sideways, as the scoring screen is drawn for. */
export const PHONE_LANDSCAPE = { width: 915, height: 412 }

const BALL: ScoringAction = { type: 'pitch', call: 'B' }

/** Four balls: the batter walks to first, pushing any runner forced ahead. */
export const WALK: ScoringAction[] = [BALL, BALL, BALL, BALL]

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export interface ScoringField {
  app: CoachApp
  world: FixtureManifest
  m: any
  web: boolean
  /** Taps the control the screen labels `label`, once it is enabled. */
  tap: (label: string) => Promise<void>
  /** Waits until something on screen reads or is labelled `label`. */
  shown: (label: string | RegExp, timeout?: number) => Promise<void>
  /** Whether something on screen reads or is labelled `label`, now. */
  showing: (label: string | RegExp) => Promise<boolean>
  /**
   * The correction window's countdown as drawn, in whole seconds, and its
   * full length, or null while no window is open.
   */
  countdown: () => Promise<{ now: number; max: number | null } | null>
  /** Who is up, as the scoreboard reads ("Batter …"), or null. */
  batter: () => Promise<string | null>
  /**
   * Scores a hit as a scorer does: Swing in Play, the hit, the center
   * fielder taking the ball a step in front of where he stands, and the
   * trajectory accepted as shown.
   */
  hit: (outcome: 'Single' | 'Double' | 'Triple') => Promise<void>
}

function matches(label: string, wanted: string | RegExp): boolean {
  return typeof wanted === 'string' ? label === wanted : wanted.test(label)
}

/**
 * Seeds the game with `seed` (walks and outs, through the scorer's API
 * session), signs the scorekeeper in and opens the game's Score screen.
 */
export async function openScoringField(
  ctx: E2eContext,
  seed: ScoringAction[]
): Promise<ScoringField> {
  const world = await ctx.fixture('coach-game')
  if (seed.length > 0) {
    const { TeamStationClient } = await import('../../../src/common/api')
    const { signInTestAccount } =
      await import('../../../src/test/passwordFixtures')
    const { scoreWith } = await import('../scoringBrowser')
    const api = `${ctx.stack.origin}/api/v1`
    const client = new TeamStationClient({
      baseUrl: api,
      token: await signInTestAccount(api, world.accounts.scorekeeper)
    })
    await scoreWith(client, world.ids.game, seed)
  }
  const app = await openCoachApp(ctx, 'scorekeeper', { size: PHONE_LANDSCAPE })
  const { m } = app
  const web = app.web != null
  const path = `/games/${world.ids.game}/score`
  if (web) await m.openLink({ link: `${ctx.stack.origin}${path}` })
  else {
    await m.openLink({ link: `teamstation://${path}` })
    // The system asks once before a link opens the app it names.
    if ((await app.nodes()).some(node => labelOf(node) === 'Open'))
      await m.tapOn({ text: 'Open' })
  }

  const nodes = async (): Promise<Array<Node & { value?: string }>> =>
    web ? [] : flatten((await m.hierarchy()) as Node)
  const showing = async (label: string | RegExp): Promise<boolean> => {
    if (web) {
      const pattern =
        typeof label === 'string'
          ? `^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
          : label.source
      return (await app.web!.page.evaluate(
        `(() => { const p = new RegExp(${JSON.stringify(pattern)}); return [...document.querySelectorAll('[aria-label]')].some(n => p.test(n.getAttribute('aria-label')) && n.getClientRects().length > 0) || [...document.querySelectorAll('[aria-live]')].some(n => p.test(n.textContent.trim())) })()`
      )) as boolean
    }
    return (await nodes()).some(
      node =>
        matches(labelOf(node), label) ||
        (node.text != null && matches(node.text, label))
    )
  }
  const shown = async (
    label: string | RegExp,
    timeout = 30000
  ): Promise<void> => {
    const end = Date.now() + timeout
    while (!(await showing(label))) {
      if (Date.now() > end)
        throw new Error(`Timed out waiting for "${String(label)}"`)
      await sleep(250)
    }
  }
  const tap = async (label: string): Promise<void> => {
    if (web)
      await m.tapOn({
        css: `[aria-label="${label}"]:not([aria-disabled="true"])`,
        timeout: 15000
      })
    else {
      const id = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      await m.tapOn({ id, timeout: 15000 })
    }
  }
  const countdown = async (): Promise<{
    now: number
    max: number | null
  } | null> => {
    if (web)
      return (await app.web!.page.evaluate(`(() => {
        const bar = document.querySelector('[aria-label="Time to edit play"]')
        if (bar == null) return null
        return { now: Number(bar.getAttribute('aria-valuenow')), max: Number(bar.getAttribute('aria-valuemax')) }
      })()`)) as { now: number; max: number } | null
    const digits = (await nodes()).find(
      node => labelOf(node) === 'Seconds to edit play'
    )
    if (digits == null) return null
    const text = /\d+/.exec([digits.text, digits.value].join(' '))
    // The app's bar reads only its share of the window: the countdown's
    // first reading is its full length.
    return { now: text == null ? NaN : Number(text[0]), max: null }
  }
  const batter = async (): Promise<string | null> => {
    if (web)
      return (await app.web!.page.evaluate(
        `(() => { const n = [...document.querySelectorAll('[aria-label*="Batter "]')].find(n => n.getClientRects().length > 0); return n == null ? null : (/Batter [^,·]+/.exec(n.getAttribute('aria-label')) || [null])[0] })()`
      )) as string | null
    const found = (await nodes())
      .map(labelOf)
      .map(label => /Batter [^,·]+/.exec(label)?.[0])
      .find(label => label != null)
    return found ?? null
  }
  const hit = async (
    outcome: 'Single' | 'Double' | 'Triple'
  ): Promise<void> => {
    await tap('Swing in Play')
    await tap(outcome)
    await shown(/^Tap or drag a player to where the ball was fielded/)
    if (web) {
      const field = maestroDriver(m)
      await placeFielder(field, 'CF')
      await setTrajectory(field)
      return
    }
    // The app's field has no page: its projection finds the center fielder.
    await sleep(1500)
    const at = (await nativeField(m)).fielder('CF', 5)
    const point = `${Math.round(at.x)},${Math.round(at.y)}`
    await m.dragAndDrop({
      from: { point },
      to: { point: `${Math.round(at.x)},${Math.round(at.y - 12)}` },
      holdDuration: 100,
      duration: 500
    })
    await shown(/^Drag up and down for ball trajectory/)
    await sleep(1000)
    const centre = (await nativeField(m)).rect
    const x = Math.round(centre.x + centre.width / 2)
    const y = Math.round(centre.y + centre.height / 2)
    await m.tapOnPoint({ point: `${x},${y}` })
  }
  await shown('Ball', 90000)
  return {
    app,
    world,
    m,
    web,
    tap,
    shown,
    showing,
    countdown,
    batter,
    hit
  }
}
