import type { Emulation } from '../../core/browserCdp'
import type { FixtureManifest } from '../../core/fixtures'
import { iosIsSimulator } from '../../core/prepare'
import { BlockedError } from '../../core/result'
import {
  defineE2e,
  type E2eContext,
  type E2eSpec,
  type WebSession
} from '../../core/spec'
import { setServer } from '../app/setServer'

/**
 * The game plan's tests on any surface: the develop app on an iPhone or
 * iPad simulator, or the web in maestro-d's Chromium. Everything that acts
 * goes through maestro-d; the browser's page is only read.
 */

export const DEVELOP_APP = 'app.teamstation.develop'

/** An iPhone 17 Pro's window, in points: the narrowest the plan is drawn for. */
export const PHONE_WINDOW = { width: 402, height: 874 }

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Node {
  type?: string
  id?: string
  text?: string
  accessibilityText?: string
  bounds?: Rect
  children?: Node[]
}

export function flatten(node: Node): Node[] {
  return [node, ...(node.children ?? []).flatMap(flatten)]
}

export function labelOf(node: Node): string {
  return node.accessibilityText ?? node.text ?? ''
}

/** An element on screen: where it is, and what it reads. */
export interface Found {
  id: string
  bounds: Rect
  label: string
}

export interface CoachApp {
  m: any
  /** The browser's session on the web; undefined in the app. */
  web: WebSession | undefined
  /** Every node on screen, flattened, in maestro-d's normalized hierarchy. */
  nodes: () => Promise<Node[]>
  /** Every element whose test id matches `pattern`, in screen order. */
  findAll: (pattern: RegExp) => Promise<Found[]>
  /** The game page's hero actions, as their buttons read, left to right. */
  heroActions: () => Promise<string[]>
  /** The window, in the hierarchy's units. */
  window: () => Promise<Rect>
  /** The game's own page, from its address. */
  openGame: (gameId: string) => Promise<void>
  /** Coach Game for `teamId`, from its address. */
  openCoach: (gameId: string, teamId: string) => Promise<void>
  /** The team's own page, from its address. */
  openTeam: (teamId: string) => Promise<void>
}

/** A team page's address, as the app and the web route it. */
export function teamPath(teamId: string): string {
  return `/teams/${encodeURIComponent(teamId)}`
}

/**
 * Waits for the game's hero, then closes the RSVP sheet a member who has
 * not replied is shown over the game, if it rises within a few seconds.
 */
async function closeRsvp(m: any, shown: () => Promise<boolean>): Promise<void> {
  await m.assertVisible({ id: 'event-hero', timeout: 60000 })
  for (let i = 0; i < 6; i++) {
    if (await shown()) {
      await m.tapOn({ id: 'settings-pill-button', text: 'Done' })
      await m.waitForAnimationToEnd()
      return
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Whether `inner`'s centre is inside `outer`. */
function within(inner: Rect, outer: Rect): boolean {
  const x = inner.x + inner.width / 2
  const y = inner.y + inner.height / 2
  return (
    x >= outer.x &&
    x <= outer.x + outer.width &&
    y >= outer.y &&
    y <= outer.y + outer.height
  )
}

/** The element whose test id is `id`, or undefined when none is drawn. */
export async function find(
  app: CoachApp,
  id: string
): Promise<Found | undefined> {
  const exact = new RegExp(`^${literal(id)}$`)
  return (await app.findAll(exact))[0]
}

/**
 * Reads the page's test ids, which the web's accessibility tree does not
 * carry. No `??` or `?.` inside: the page has no sucrase helpers.
 */
async function pageFindAll(web: WebSession, pattern: RegExp): Promise<Found[]> {
  return await web.page.evaluate(
    (source: string, flags: string) => {
      const match = new RegExp(source, flags)
      return Array.from(document.querySelectorAll('[data-testid]'))
        .filter(node => match.test(String(node.getAttribute('data-testid'))))
        .map(node => {
          const r = node.getBoundingClientRect()
          const aria = node.getAttribute('aria-label')
          return {
            id: String(node.getAttribute('data-testid')),
            bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
            // No `??` in the page: it has no sucrase helpers.
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            label: aria == null ? String(node.textContent) : aria
          }
        })
    },
    pattern.source,
    pattern.flags
  )
}

/**
 * The attached stack's database URL, for setup that must not go through
 * the API a fault may be breaking. A throwaway stack's database only.
 */
export async function stackDatabaseUrl(ctx: E2eContext): Promise<string> {
  const attached = ctx.stack.attached
  if (attached == null)
    throw new BlockedError('needs an attached stack: --stack <id>')
  const { requireDropletHandle, nodeDatabaseUrl } =
    await import('../../core/dropletStack')
  return nodeDatabaseUrl(requireDropletHandle(attached).databaseUrl)
}

/**
 * Clears the stack's password sign-in limits, which are production's: every
 * sign-in from this machine counts against one address's fifty an hour, and
 * the game plan's scenarios sign in through the form on every run.
 */
export async function clearSignInLimits(ctx: E2eContext): Promise<void> {
  const { Client } = await import('pg')
  const client = new Client({
    connectionString: await stackDatabaseUrl(ctx),
    connectionTimeoutMillis: 15_000
  })
  await client.connect()
  try {
    await client.query(
      "delete from rate_events where scope like 'password.%' or scope like 'passwordParameters.%'"
    )
  } finally {
    await client.end()
  }
}

/**
 * Opens the surface on the stack's origin and signs `role` in through the
 * real password form. The app is installed with `prepare` beforehand; on a
 * simulator it is cleared, pointed at the stack and launched fresh.
 */
export async function openCoachApp(
  ctx: E2eContext,
  role: string,
  web: { size?: { width: number; height: number }; emulation?: Emulation } = {}
): Promise<CoachApp> {
  const origin = ctx.stack.origin
  const size = web.size ?? PHONE_WINDOW
  await clearSignInLimits(ctx)
  if (ctx.surface === 'web-chromium') {
    const session = await ctx.browser(size, web.emulation)
    const { m } = session
    await m.openLink({ link: `${origin}/` })
    await ctx.signIn(role, m)
    const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
    const go = async (path: string): Promise<void> => {
      await m.openLink({ link: `${origin}${path}` })
    }
    return {
      m,
      web: session,
      nodes,
      findAll: async pattern => await pageFindAll(session, pattern),
      heroActions: async () =>
        await session.page.evaluate(() =>
          Array.from(
            document.querySelectorAll(
              '[data-testid="game-hero-actions"] [role="button"]'
            )
          )
            // As drawn: a button hidden by its style is not offered.
            .filter(node => getComputedStyle(node).visibility === 'visible')
            .map(node => String(node.getAttribute('aria-label')))
        ),
      window: async () => ({ x: 0, y: 0, ...size }),
      openGame: async gameId => {
        await go(`/games/${gameId}`)
        await closeRsvp(
          m,
          async () =>
            (await session.page.$('[data-testid="event-rsvp-modal"]')) != null
        )
      },
      openCoach: async (gameId, teamId) => {
        await go(`/games/${gameId}/coach/${teamId}`)
      },
      openTeam: async teamId => {
        await go(teamPath(teamId))
      }
    }
  }
  const udid = ctx.device('device')
  const m = await ctx.attach('device', { platform: 'ios', appId: DEVELOP_APP })
  await m.launchApp({ appId: DEVELOP_APP, clearState: true })
  await setServer({
    platform: 'ios',
    udid,
    appId: DEVELOP_APP,
    origin,
    device: m,
    simulator: iosIsSimulator(udid)
  })
  await ctx.signIn(role, m)
  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const link = async (path: string): Promise<void> => {
    await m.openLink({ link: `teamstation://${path}` })
    // The system asks once before a link opens the app it names.
    if ((await nodes()).some(node => labelOf(node) === 'Open'))
      await m.tapOn({ text: 'Open' })
  }
  const findAll = async (pattern: RegExp): Promise<Found[]> =>
    (await nodes())
      .filter(node => node.bounds != null && pattern.test(node.id ?? ''))
      .map(node => ({
        id: node.id ?? '',
        bounds: node.bounds!,
        label: labelOf(node)
      }))
  return {
    m,
    web: undefined,
    nodes,
    findAll,
    heroActions: async () => {
      // The app's hierarchy is flat: the hero's buttons are those inside it.
      const all = await nodes()
      const hero = all.find(node => node.id === 'game-hero-actions')?.bounds
      if (hero == null) return []
      return all
        .filter(
          node =>
            node.type === 'Button' &&
            node.bounds != null &&
            within(node.bounds, hero)
        )
        .sort((a, b) => a.bounds!.x - b.bounds!.x)
        .map(labelOf)
    },
    window: async () => {
      const root = (await m.hierarchy()) as Node
      if (root.bounds == null) throw new Error('The screen has no bounds')
      return root.bounds
    },
    openGame: async gameId => {
      await link(`/games/${gameId}`)
      await closeRsvp(m, async () =>
        (await nodes()).some(node => node.id === 'event-rsvp-modal')
      )
    },
    openCoach: async (gameId, teamId) => {
      await link(`/games/${gameId}/coach/${teamId}`)
    },
    openTeam: async teamId => {
      await link(teamPath(teamId))
    }
  }
}

/**
 * An x inside the plan's scroll view and right of its cells, where a drag
 * scrolls the sheet.
 */
async function besideTheGrid(app: CoachApp): Promise<number> {
  const scroll = await find(app, 'Plan scroll')
  if (scroll == null) throw new Error('No plan is drawn to scroll')
  const right = scroll.bounds.x + scroll.bounds.width
  const cells = (await app.findAll(/^Plan (cell \d+-\d+|add inning)$/)).map(
    cell => cell.bounds.x + cell.bounds.width
  )
  const last = Math.max(...cells, scroll.bounds.x)
  return Math.round(last < right - 4 ? (last + right) / 2 : right - 2)
}

/** Scrolls the open screen down until `id` is wholly on it, and returns it. */
export async function scrollTo(app: CoachApp, id: string): Promise<Found> {
  if (app.web != null) {
    await app.m.scrollUntilVisible({
      element: { id },
      direction: 'DOWN',
      timeout: 20000
    })
    await app.m.waitForAnimationToEnd()
  }
  const window = await app.window()
  for (let i = 0; i < 8; i++) {
    const found = await find(app, id)
    if (
      found != null &&
      found.bounds.y >= 0 &&
      found.bounds.y + found.bounds.height <= window.height
    )
      return found
    if (app.web != null) break
    // Up the sheet beside its last inning: a drag that starts on a cell
    // moves a player, not the sheet.
    // As a share of the window: maestro-d reads bare numbers as pixels.
    const x = ((await besideTheGrid(app)) / window.width) * 100
    await app.m.swipe({
      start: `${x.toFixed(1)}%, 70%`,
      end: `${x.toFixed(1)}%, 40%`,
      duration: 400
    })
    await app.m.waitForAnimationToEnd()
  }
  throw new Error(`${id} never came wholly into view`)
}

/** The Plan tab of the open Coach Game, its sheet drawn. */
export async function openPlanTab(app: CoachApp): Promise<void> {
  await app.m.assertVisible({ text: 'Save Rosters', timeout: 60000 })
  await app.m.tapOn({ text: 'Plan', timeout: 15000 })
  await app.m.assertVisible({ id: 'Plan cell 1-1', timeout: 15000 })
  await app.m.waitForAnimationToEnd()
}

export type PlanCell = string

/**
 * Saves `cells` as the home team's plan, as its head coach saves it, on the
 * stack's database as a fixture is seeded: an API fault proved by the run
 * breaks what the app reads, not the scenario's setup. Row i is the home
 * lineup's player i + 1, who wears i + 1.
 */
export async function savePlan(
  ctx: E2eContext,
  world: FixtureManifest,
  cells: PlanCell[][]
): Promise<void> {
  // Loaded here: a spec's import has no side effects.
  const { LINEUP_NAMES } = await import('../../../src/server/dev/lineupFixture')
  const { makeDatabase } = await import('../../../src/server/db/database')
  const { saveGamePlan } = await import('../../../src/server/games/gamePlans')
  const { asGamePlan } = await import('../../../src/common/gamePlan')
  // Cleaned as the API cleans a saved plan, so what is seeded could be saved.
  const plan = asGamePlan({
    enabled: true,
    innings: cells[0].length,
    rows: cells.map((row, at) => ({
      player: {
        gumboId: Number(world.ids[`homePlayer${at + 1}`]),
        fullName: LINEUP_NAMES.home[at],
        jersey: String(at + 1)
      },
      cells: row
    }))
  })
  const db = makeDatabase(await stackDatabaseUrl(ctx))
  try {
    const game = await db
      .selectFrom('games')
      .select(['id', 'season_id', 'start_at', 'timezone'])
      .where('id', '=', world.ids.game)
      .executeTakeFirstOrThrow()
    await saveGamePlan(
      db,
      game,
      world.ids.homeTeam,
      plan,
      world.accounts.coach.userId
    )
  } finally {
    await db.destroy()
  }
}

/**
 * Two innings with every position errors can show, and three with none:
 * inning 1 lacks 3B, LF, CF and RF and doubles SS; inning 2 is two DHs and
 * nothing else; inning 3 is whole; inning 4 lacks CF and RF beside two EHs,
 * which are never doubled; inning 5 is empty, which is no error.
 */
export const ERROR_PLAN: PlanCell[][] = [
  ['P', 'DH', 'P', 'EH', ''],
  ['C', 'DH', 'C', 'EH', ''],
  ['1B', '', '1B', 'P', ''],
  ['2B', '', '2B', 'C', ''],
  ['SS', '', '3B', '1B', ''],
  ['SS', '', 'SS', '2B', ''],
  ['', '', 'LF', '3B', ''],
  ['', '', 'CF', 'SS', ''],
  ['', '', 'RF', 'LF', '']
]

export const ERROR_LINES = [
  'Inning 1 is missing players for positions: 3B, LF, CF, and RF',
  'Inning 1 has multiple players assigned to SS',
  'Inning 2 is missing players for positions: P, C, 1B, 2B, 3B, SS, LF, CF, and RF',
  'Inning 2 has multiple players assigned to DH',
  'Inning 4 is missing players for positions: CF and RF'
]

/** Every position in each of five innings, nobody twice. */
export const WHOLE_PLAN: PlanCell[][] = [
  ['P', 'C', '1B', '2B', 'SS'],
  ['C', '1B', '2B', 'SS', '3B'],
  ['1B', '2B', 'SS', '3B', 'LF'],
  ['2B', 'SS', '3B', 'LF', 'CF'],
  ['SS', '3B', 'LF', 'CF', 'RF'],
  ['3B', 'LF', 'CF', 'RF', 'P'],
  ['LF', 'CF', 'RF', 'P', 'C'],
  ['CF', 'RF', 'P', 'C', '1B'],
  ['RF', 'P', 'C', '1B', '2B']
]

/** `text` as a maestro-d pattern that matches it literally. */
export function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A game plan spec: the web in Chromium, and the develop app on an iOS
 * simulator — an iPhone or an iPad, as `--device device=<udid>` names — on
 * an isolated stack seeded with the `coach-game` world.
 */
export function defineCoachSpec(options: {
  id: string
  title: string
  covers: string[]
  minutes: number
  faults: string[]
  scenarios: E2eSpec['scenarios']
}): E2eSpec {
  return defineE2e({
    ...options,
    kind: 'e2e',
    stack: 'isolated',
    fixtures: ['coach-game'],
    exclusive: false,
    surfaces: {
      'web-chromium': { devices: [] },
      'ios-app': {
        devices: [{ role: 'device', needs: ['ios'], hardware: 'none' }]
      }
    },
    services: ['web', 'api'],
    apps: ['teamstation-ios'],
    secrets: [],
    costUsd: 0,
    guards: [],
    manual: false
  })
}
