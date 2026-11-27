import { BlockedError } from '../../core/result'
import type { HarnessContext, Surface } from '../../core/spec'
import { clearSignInLimits, serverKeptOnHubPhone } from '../coach/coachApp'

/**
 * The scoring screen on a phone the run was handed: the develop app on an
 * iPhone or an Android phone, or the stack's web build in the phone's own
 * browser. Every step is a maestro-d command on that device; what the
 * server holds is read through its API.
 */

/** The app kind each app surface launches. */
export const APP_OF: Partial<Record<Surface, string>> = {
  'ios-app': 'teamstation-ios',
  'android-app': 'teamstation-android'
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** A node of maestro-d's normalized hierarchy. */
export interface Node {
  id?: string
  type?: string
  text?: string
  value?: string
  accessibilityText?: string
  enabled?: boolean
  visible?: boolean
  bounds?: Bounds
  children?: Node[]
}

export function flatten(node: Node): Node[] {
  return [node, ...(node.children ?? []).flatMap(flatten)]
}

export function labelOf(node: Node): string {
  return node.accessibilityText ?? node.text ?? ''
}

export function centre(b: Bounds): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

export function pointOf(p: { x: number; y: number }): string {
  return `${Math.round(p.x)},${Math.round(p.y)}`
}

export const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export interface PhoneScorer {
  m: any
  platform: 'ios' | 'android'
  /** Whether this is the phone's browser rather than the app. */
  browser: boolean
  nodes: () => Promise<Node[]>
  /** Opens an app path (`/games/<id>/score`) where this surface routes it. */
  open: (path: string) => Promise<void>
}

/** A game's scoring screen, as the app and the web route it. */
export function scorePath(gameId: string, score = true): string {
  return `/games/${encodeURIComponent(gameId)}${score ? '/score' : ''}`
}

/**
 * Signs `account` in on the device in `role`, through the real password
 * form: the app is cleared, pointed at the stack and launched fresh, or the
 * phone's browser opened on the stack's sign-in page.
 */
export async function openPhoneScorer(
  ctx: HarnessContext,
  account: string,
  role = 'device'
): Promise<PhoneScorer> {
  const origin = ctx.stack.origin
  await clearSignInLimits(ctx)
  const kind = APP_OF[ctx.surface]
  let m: any
  if (kind != null) {
    const appId = ctx.app(kind)
    m = ctx.attached(role)
    await m.launchApp({ appId, clearState: true })
    // A clear forgets the server: the link points the app back at the stack.
    await serverKeptOnHubPhone(m, appId, origin)
  } else if (
    ctx.surface === 'web-safari-ios' ||
    ctx.surface === 'web-chrome-android'
  ) {
    m = await ctx.mobileBrowser(role, `${origin}/sign-in`)
  } else {
    throw new BlockedError(`${ctx.surface} is not a phone surface`)
  }
  await ctx.signIn(account, m)
  const browser = kind == null
  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  return {
    m,
    platform:
      ctx.surface === 'android-app' || ctx.surface === 'web-chrome-android'
        ? 'android'
        : 'ios',
    browser,
    nodes,
    open: async path => {
      if (browser) {
        await m.openLink({ link: `${origin}${path}`, browser: true })
        return
      }
      await m.openLink({ link: `teamstation://${path.replace(/^\/+/, '')}` })
      // The system asks once before a link opens the app it names.
      if ((await nodes()).some(node => labelOf(node) === 'Open'))
        await m.tapOn({ text: '^Open$' })
    }
  }
}

/**
 * Presses at `from`, holds `hold` ms, moves to `to` over `duration` ms and
 * lets go: a held drag, as the roster and the field take one.
 */
export async function heldDrag(
  m: any,
  from: { x: number; y: number },
  to: { x: number; y: number },
  hold = 1000,
  duration = 1500
): Promise<void> {
  await m.dragAndDrop({
    from: { point: pointOf(from) },
    to: { point: pointOf(to) },
    holdDuration: hold,
    duration
  })
}

/** A quick vertical swipe at `x`, from `from` to `to`, in screen units. */
export async function flick(
  m: any,
  x: number,
  from: number,
  to: number,
  duration = 250
): Promise<void> {
  await m.swipe({
    start: pointOf({ x, y: from }),
    end: pointOf({ x, y: to }),
    duration
  })
}

/** Whether maestro-d reports the soft keyboard on screen. */
export async function keyboardShown(m: any): Promise<boolean> {
  const answer = (await m.keyboardVisible()) as {
    visible?: boolean
    data?: { visible?: boolean }
  }
  return (answer.data?.visible ?? answer.visible) === true
}

/** Polls `check` until it answers true, or fails with `message`. */
export async function until(
  check: () => Promise<boolean>,
  message: string,
  timeout = 20000,
  every = 250
): Promise<void> {
  const end = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() >= end) throw new Error(message)
    await sleep(every)
  }
}

export interface StackApi {
  token: string
  /** The app's own API client, signed in as the account. */
  client: any
}

/**
 * The stack's API as `account`, through the app's own client, signed in
 * once through the password exchange. `signIn` and `makeClient` are the
 * password fixtures' and the app's own, loaded when called.
 */
export async function apiAs(
  ctx: HarnessContext,
  account: { email: string; password: string },
  signIn?: (base: string, who: typeof account) => Promise<string>,
  makeClient?: (baseUrl: string, token: string) => any
): Promise<StackApi> {
  const baseUrl = `${ctx.stack.origin}/api/v1`
  const exchange =
    signIn ??
    (await import('../../../src/test/passwordFixtures')).signInTestAccount
  const token = await exchange(baseUrl, account)
  if (makeClient != null) return { token, client: makeClient(baseUrl, token) }
  const { TeamStationClient } = await import('../../../src/common/api')
  return { token, client: new TeamStationClient({ baseUrl, token }) }
}

/**
 * The game the server holds, replayed as the app's own scoring session
 * would open it, read-only: what a scenario checks the screen saved.
 * `context` is the world's teams and opening lineups (`ids.context`).
 */
export async function replayStored(
  stored: unknown,
  gameId: string,
  context: string
): Promise<any> {
  const { ScoringSession } = await import('../../../src/common/scoring/session')
  return await ScoringSession.open(
    {
      load: async () => stored as any,
      save: async () => {
        throw new Error('A replay of the stored game saves nothing')
      }
    },
    gameId,
    { gamePk: gameId, ...(JSON.parse(context) as object) } as any,
    { setTimer: () => null, clearTimer: () => undefined }
  )
}

/** What the scenarios compare before and after a gesture. */
export interface Proof {
  open: boolean
  bases: Array<number | null>
  score: number
  count: { balls: number; strikes: number; outs: number } | undefined
  times: string[] | undefined
}

/** A replayed session's open play, runners, visitors' runs, count and times. */
export async function proofOf(session: any): Promise<Proof> {
  const { baseIds } = await import('../../../src/common/scoring/lineup')
  const { storedRecordOf } = await import('../../../src/common/scoring/gumbo')
  const state = session.state
  return {
    open: state.pending != null,
    bases: baseIds(state),
    score: state.liveData.linescore.teams.away.runs,
    count: state.liveData.plays.currentPlay?.count,
    times: storedRecordOf(session.picture().current)?.actionTimes
  }
}
