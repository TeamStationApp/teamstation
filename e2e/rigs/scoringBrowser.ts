import { appendFileSync, writeFileSync } from 'node:fs'

import { expect } from 'chai'

import * as gameDraft from '../../src/app/screens/gameDraft'
import {
  type Lineup,
  type RosterEntry,
  TeamStationClient
} from '../../src/common/api'
import type { ScoringAction } from '../../src/common/scoring/actions'
import { ScoringSession } from '../../src/common/scoring/session'
import { startingSetup, teamsOf } from '../../src/common/scoring/startingSetup'
import { type GameState, setupOf } from '../../src/common/scoring/state'
import type { FixtureManifest } from '../core/fixtures'
import type { E2eContext, HarnessStackHandle, WebSession } from '../core/spec'

/**
 * What the scoring screen's browser scenarios share: the `lineup-game`
 * world read back into its people and players, each person's API client,
 * scoring through a session as the scorekeeper's device does, setup and
 * read-back SQL on the stack's own database, the `$`-lined artifact logs,
 * and one browser window to drive. Everything that acts on the page goes
 * through maestro-d; the page itself is only read.
 */

export const WIDTH = 1280
export const HEIGHT = 900
/** A phone held sideways. */
export const PHONE_WIDTH = 915
export const PHONE_HEIGHT = 412
export const UNLOADED = 'Unable to load scoring.'
export const UNREAD = 'could not be read back'

export const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** The people of the `lineup-game` world. */
export type Person =
  | 'scorekeeper'
  | 'headCoach'
  | 'assistant'
  | 'awayCoach'
  | 'member'
  | 'teamAdmin'

export interface Player {
  userId: string
  gumboId: number
  name: string
  jersey: string
}

/** A `lineup-game` world, as its manifest names it. */
export interface LineupWorld {
  gameId: string
  seasonId: string
  teams: Record<'home' | 'away', string>
  users: Record<string, { email: string; password: string; userId: string }>
  players: Record<'home' | 'away', Player[]>
}

export function lineupWorld(manifest: FixtureManifest): LineupWorld {
  return {
    gameId: manifest.ids.game,
    seasonId: manifest.ids.season,
    teams: { home: manifest.ids.homeTeam, away: manifest.ids.awayTeam },
    users: manifest.accounts,
    players: JSON.parse(manifest.ids.players) as LineupWorld['players']
  }
}

/** How Game Settings builds a swap: `gameDraft`'s own, or a test's. */
export interface Drafts {
  loadedGameDraft: (...args: any[]) => any
  swapSides: (draft: any) => any
  gameProposalFields: (...args: any[]) => any
}

const DRAFTS: Drafts = gameDraft

/** A person's sign-in, for the API. */
export type SignIn = (
  api: string,
  account: { email: string; password: string }
) => Promise<string>

/**
 * The stack a scenario scores on: its API, each person's session (signed
 * in once: sign-ins are rate limited), its database and the logs.
 */
export class ScoringStack {
  readonly api: string
  private readonly tokens = new Map<string, string>()
  private readonly begun = new Set<string>()

  constructor(
    readonly ctx: E2eContext,
    private readonly signIn: SignIn
  ) {
    this.api = `${ctx.stack.origin}/api/v1`
  }

  /** A fresh lineup game and its people, made for this scenario alone. */
  async lineupGame(file: string | null): Promise<LineupWorld> {
    const world = lineupWorld(await this.ctx.fixture('lineup-game'))
    this.note(
      file,
      `$ # the lineup-game world: game ${world.gameId}, Hosts (home) vs Visitors (away)\n`
    )
    return world
  }

  /** One line of a scenario's log, its request first, as `$` lines. */
  note(file: string | null, line: string): void {
    if (file == null) return
    const path = this.ctx.artifact(file)
    if (this.begun.has(file)) appendFileSync(path, line + '\n')
    else writeFileSync(path, line + '\n')
    this.begun.add(file)
  }

  /** `account`'s API session, signed in the first time it is asked for. */
  async signInAs(account: {
    email: string
    password: string
  }): Promise<string> {
    let token = this.tokens.get(account.email)
    if (token == null) {
      token = await this.signIn(this.api, account)
      this.tokens.set(account.email, token)
    }
    return token
  }

  async tokenOf(world: LineupWorld, who: Person | string): Promise<string> {
    return await this.signInAs(world.users[who])
  }

  async clientOf(
    world: LineupWorld,
    who: Person | string
  ): Promise<TeamStationClient> {
    return this.makeClient(await this.tokenOf(world, who))
  }

  /** An API client for the session `token` names. */
  protected makeClient(token: string): TeamStationClient {
    return new TeamStationClient({ baseUrl: this.api, token })
  }

  /** A statement on the stack's own database: its `$` line, then its rows. */
  async query(
    file: string | null,
    text: string,
    values: unknown[] = []
  ): Promise<Array<Record<string, unknown>>> {
    const control = (this.ctx.stack as HarnessStackHandle).control
    if (control == null) throw new Error('This stack runs no setup SQL')
    const { rows } = await control.sql(text, values)
    this.note(
      file,
      `$ psql -c "${text.replace(/\s+/g, ' ')}"${values.length > 0 ? `  -- ${JSON.stringify(values)}` : ''}\n${JSON.stringify(rows, null, 2)}\n`
    )
    return rows
  }

  /**
   * Scores into the game as the scorekeeper's session does, through the API:
   * the game opens on the teams' default lineups, as the scoring screen's.
   */
  async score(
    world: LineupWorld,
    actions: ScoringAction[] | ((game: GameState) => ScoringAction[])
  ): Promise<ScoringSession> {
    const client = await this.clientOf(world, 'scorekeeper')
    const game = await client.game(world.gameId)
    // An outside opponent has no roster or default to read: none, as the
    // scoring screen takes it.
    const roster = async (teamId: string): Promise<RosterEntry[]> =>
      await client.roster(teamId).catch(() => [])
    const lineup = async (teamId: string): Promise<Lineup | null> =>
      await client
        .defaultLineup(teamId)
        .then(found => found.lineup)
        .catch(() => null)
    const [away, home, awayDefault, homeDefault] = await Promise.all([
      roster(game.awayTeamId),
      roster(game.homeTeamId),
      lineup(game.awayTeamId),
      lineup(game.homeTeamId)
    ])
    const session = await ScoringSession.open(
      {
        load: async id => await client.gameEvents(id),
        save: async (id, change) => await client.saveGameEvents(id, change)
      },
      game.id,
      {
        gamePk: game.id,
        teams: teamsOf(game),
        setup: startingSetup(
          game,
          away,
          home,
          { away: awayDefault, home: homeDefault },
          false
        ),
        fenceDistanceFt: game.fenceDistanceFt
      },
      { requireCurrentSetup: true }
    )
    const list =
      typeof actions === 'function' ? actions(session.state) : actions
    for (const action of list)
      expect(
        session.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
    await session.flush()
    return session
  }

  /** Game Settings' own swap, sent by `who`'s team. */
  async proposeSwap(
    world: LineupWorld,
    who: Person,
    drafts: Drafts = DRAFTS
  ): Promise<{ id: string; status: string }> {
    const { gameProposalFields, loadedGameDraft, swapSides } = drafts
    const client = await this.clientOf(world, who)
    const state = await client.gameScheduling(world.gameId)
    const [home, away] = await Promise.all([
      client.group({ kind: 'team', id: state.game.homeTeamId }),
      client.group({ kind: 'team', id: state.game.awayTeamId })
    ])
    const draft = swapSides(
      loadedGameDraft(
        state,
        {
          group: home.group,
          canManage: home.canManage || home.canManagePeople === true
        },
        {
          group: away.group,
          canManage: away.canManage || away.canManagePeople === true
        }
      )
    )
    const fields = gameProposalFields(
      draft,
      { kind: 'edit', gameId: world.gameId },
      draft.home,
      draft.away,
      state
    )
    return await client.proposeGame({
      ...fields,
      idempotencyKey: `side-swap-${Date.now()}-${Math.random()}`
    })
  }

  /** The swap, proposed by the home head coach and accepted by the away one. */
  async swapGame(
    world: LineupWorld,
    file: string,
    drafts: Drafts = DRAFTS
  ): Promise<void> {
    const proposal = await this.proposeSwap(world, 'headCoach', drafts)
    this.note(
      file,
      `$ POST ${this.api}/game-requests  (home head coach: Swap home and away)\n${JSON.stringify(proposal)}\n`
    )
    if (proposal.status === 'accepted') return
    const accepted = await (
      await this.clientOf(world, 'awayCoach')
    ).decideGameRequest(proposal.id, 'accept')
    this.note(
      file,
      `$ POST ${this.api}/game-requests/${proposal.id}/accept  (away head coach)\n${JSON.stringify(accepted)}\n`
    )
    expect(accepted.status).equals('accepted')
  }

  /** The sides, guests, unrostered players and digest the game holds. */
  async sides(
    file: string | null,
    gameId: string
  ): Promise<Record<string, unknown>> {
    const [row] = await this.query(
      file,
      `select (select name from teams where id = home_team_id) as home,
              (select name from teams where id = away_team_id) as away,
              home_score, away_score, guests, unrostered, lineups_digest,
              "currentPlay"->'matchup'->'batter'->>'fullName' as due_up
         from games where id = $1`,
      [gameId]
    )
    return row
  }
}

/** The scenario's stack, its people signed in through the API's password route. */
export async function scoringStack(ctx: E2eContext): Promise<ScoringStack> {
  // Loaded here: a spec's import has no side effects.
  const { signInTestAccount } = await import('../../src/test/passwordFixtures')
  return new ScoringStack(ctx, signInTestAccount)
}

/** Three roster saves: the defaults confirmed, two batters exchanged, and back. */
export function rosterSaves(state: GameState): ScoringAction[] {
  const setup = setupOf(state)
  const order = setup.sides.away.battingOrder
  const exchanged = {
    ...setup,
    sides: {
      ...setup.sides,
      away: {
        ...setup.sides.away,
        battingOrder: [order[1], order[0], ...order.slice(2)]
      }
    }
  }
  const roster = (s: typeof setup): ScoringAction => ({
    type: 'lineup',
    kind: 'roster',
    setup: s,
    confirmed: ['away', 'home']
  })
  return [roster(setup), roster(exchanged), roster(setup)]
}

/**
 * Taps the page's game audio, before the app loads: every audio context
 * also feeds a stream, and everything played to the speakers is played into
 * it, so `window.__gameAudio` can record what the page sounded, and
 * `window.__gameAudio.peak(from, span)` answers the loudest sample of a
 * stretch of the recording in dB, as FFmpeg's volumedetect reads its
 * max_volume. No ?. or ?? here: sucrase turns them into helpers the page
 * lacks.
 */
export const AUDIO_TAP = `(() => {
  const Base = window.AudioContext
  if (Base == null) return
  const connect = AudioNode.prototype.connect
  window.AudioContext = class extends Base {
    constructor(...args) {
      super(...args)
      this.__tap = this.createMediaStreamDestination()
      // A silent source keeps the stream flowing between sounds, so the
      // recording runs the whole time, quiet stretches included.
      const quiet = this.createConstantSource()
      quiet.offset.value = 0
      quiet.connect(this.__tap)
      quiet.start()
      window.__gameAudioTap = this.__tap
    }
  }
  AudioNode.prototype.connect = function (target, ...rest) {
    const result = connect.call(this, target, ...rest)
    if (target instanceof AudioDestinationNode && target.context.__tap != null)
      connect.call(this, target.context.__tap)
    return result
  }
  let recorder = null
  let recorded = null
  const chunks = []
  window.__gameAudio = {
    start() {
      if (window.__gameAudioTap == null) return false
      chunks.length = 0
      recorder = new MediaRecorder(window.__gameAudioTap.stream)
      recorder.ondataavailable = event => chunks.push(event.data)
      recorder.start(100)
      return true
    },
    stop() {
      return new Promise(resolve => {
        recorder.onstop = async () => {
          const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
          recorded = bytes.buffer.slice(0)
          let text = ''
          for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
          resolve(btoa(text))
        }
        recorder.stop()
      })
    },
    async peak(from, span) {
      const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(recorded.slice(0))
      let max = 0
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        const samples = decoded.getChannelData(c)
        const start = Math.max(0, Math.floor(from * decoded.sampleRate))
        const end = Math.min(samples.length, Math.floor((from + span) * decoded.sampleRate))
        for (let i = start; i < end; i++) max = Math.max(max, Math.abs(samples[i]))
      }
      return max === 0 ? null : 20 * Math.log10(max)
    }
  }
})()`

/** A label's control, its middle, once it holds still and is enabled. */
const CONTROL = `(label) => {
  const node = Array.from(
    document.querySelectorAll('[role="button"],[role="switch"],button')
  ).find(node => {
    const named = node.getAttribute('aria-label')
    const name = named != null && named !== '' ? named : String(node.textContent)
    return name === label || name.startsWith(label + ', ')
  })
  if (node == null || node.getAttribute('aria-disabled') === 'true') return null
  const box = node.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, inside: box.top >= 0 && box.bottom <= window.innerHeight }
}`

/** Where a control's middle is, and whether the window shows it whole. */
interface Point {
  x: number
  y: number
  inside: boolean
}

/** One browser window on the stack's web build, and what scenarios do in it. */
export class Browser {
  readonly errors: string[] = []

  constructor(
    readonly ctx: E2eContext,
    readonly session: WebSession
  ) {
    session.page.on('pageerror', (error: unknown) => {
      this.errors.push(
        error instanceof Error ? String(error.stack) : String(error)
      )
    })
  }

  /** A new window of `size` on the stack, its game audio tapped. */
  static async open(
    ctx: E2eContext,
    size: { width: number; height: number },
    beforeLoad = ''
  ): Promise<Browser> {
    const session = await ctx.browser(size, {
      beforeLoad: `${AUDIO_TAP};${beforeLoad}`,
      observeNetwork: true
    })
    session.page.setDefaultTimeout(30000)
    return new Browser(ctx, session)
  }

  get m(): any {
    return this.session.m
  }

  get page(): WebSession['page'] {
    return this.session.page
  }

  /** The page at `path` on the stack's web build. */
  async go(path: string): Promise<void> {
    await this.m.openLink({ link: `${this.ctx.stack.origin}${path}` })
  }

  /** Signed in as the session `token` names, as the web keeps it. */
  async as(token: string): Promise<void> {
    await this.m.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: encodeURIComponent(token),
          domain: new URL(this.ctx.stack.origin).hostname,
          path: '/'
        }
      ]
    })
  }

  /** The enabled button or switch named `label`, by its label or text, tapped. */
  async tap(label: string): Promise<void> {
    const find = async (): Promise<Point> => {
      const handle = await this.page.waitForFunction(
        `(${CONTROL})(${JSON.stringify(label)})`,
        { timeout: 30000 }
      )
      return (await handle.jsonValue()) as Point
    }
    let point = await find()
    if (!point.inside) {
      // Out of the window: scrolled to its middle, as a finger would.
      await this.m.evalBrowserScript({
        script: `const n = Array.from(document.querySelectorAll('[role="button"],[role="switch"],button')).find(n => { const a = n.getAttribute('aria-label'); const s = a != null && a !== '' ? a : String(n.textContent); return s === ${JSON.stringify(label)} || s.startsWith(${JSON.stringify(label + ', ')}) }); if (n != null) n.scrollIntoView({ block: 'center' })`
      })
      point = await find()
    }
    // A sheet sliding in moves its buttons: tap once the target holds still.
    for (let tries = 0; tries < 20; tries++) {
      await pause(150)
      const next = await find()
      const still =
        Math.abs(next.x - point.x) < 1 && Math.abs(next.y - point.y) < 1
      point = next
      if (still) break
    }
    await this.m.tapOnPoint({
      x: Math.round(point.x),
      y: Math.round(point.y)
    })
  }

  /** What the page says: its text, and its labels, the field's among them. */
  async text(): Promise<string> {
    return (await this.page.evaluate(
      `String(document.body.textContent) + Array.from(document.querySelectorAll('[aria-label]')).map(node => node.getAttribute('aria-label')).join('\\n')`
    )) as string
  }

  async waitText(text: string, timeout = 30000): Promise<void> {
    const literal = JSON.stringify(text)
    await this.page.waitForFunction(
      `String(document.body.textContent).includes(${literal}) || Array.from(document.querySelectorAll('[aria-label]')).some(node => String(node.getAttribute('aria-label')).includes(${literal}))`,
      { timeout }
    )
  }

  /** The window as it is, kept in the run directory as `name`. */
  async capture(name: string): Promise<void> {
    await this.m.waitForAnimationToEnd()
    await this.m.takeScreenshot({ path: this.ctx.artifact(name) })
  }

  /** The enabled button named `label` scrolled to the middle, as a tap leaves it. */
  async showButton(label: string): Promise<void> {
    const literal = JSON.stringify(label)
    const named = `Array.from(document.querySelectorAll('[role="button"]')).find(node => { const a = node.getAttribute('aria-label'); return (a != null && a !== '' ? a : String(node.textContent)) === ${literal} })`
    await this.page.waitForFunction(`${named} != null`, { timeout: 30000 })
    await this.m.evalBrowserScript({
      script: `${named}.scrollIntoView({ block: 'center' })`
    })
  }

  /** The scoring menu's rows, top to bottom. */
  async menuOrder(): Promise<string[]> {
    const rows = [
      'Exit Current Game',
      'Settings',
      'Overrides',
      'End Half Inning',
      'Set Team Rosters',
      'Swap Home and Away',
      'End Game'
    ]
    return (await this.page.evaluate(
      `Array.from(document.querySelectorAll('[aria-label]')).map(node => String(node.getAttribute('aria-label'))).filter(label => ${JSON.stringify(rows)}.includes(label))`
    )) as string[]
  }

  /** The labelled element, read in the page by `read(node)`, or `empty`. */
  private async labelled<T>(label: string, read: string, empty: T): Promise<T> {
    const found = (await this.page.evaluate(
      `(() => { const node = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}); return node == null ? { none: true } : { value: (${read})(node) } })()`
    )) as { none?: true; value?: T }
    return found.none === true ? empty : (found.value as T)
  }

  /** The text of the element labelled `label`, a second line included. */
  async labelText(label: string): Promise<string> {
    return await this.labelled(label, 'node => String(node.textContent)', '')
  }

  async isDisabled(label: string): Promise<boolean> {
    return await this.labelled(
      label,
      "node => node.getAttribute('aria-disabled') === 'true'",
      false
    )
  }

  async has(label: string): Promise<boolean> {
    return await this.labelled(label, '() => true', false)
  }

  /** Whether the labelled switch is on. */
  async switchOn(label: string): Promise<boolean> {
    // react-native's Switch on the web is the labelled checkbox itself.
    return await this.labelled(
      label,
      "node => node instanceof HTMLInputElement ? node.checked : node.getAttribute('aria-checked') === 'true'",
      false
    )
  }

  /** Whether the labelled element is what a tap at its middle reaches. */
  async uncovered(label: string): Promise<boolean> {
    return await this.labelled(
      label,
      'node => { const box = node.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return hit != null && (hit === node || node.contains(hit)) }',
      false
    )
  }

  /** Whether the labelled element lies wholly inside the window. */
  async onScreen(label: string): Promise<boolean> {
    return await this.labelled(
      label,
      'node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight }',
      false
    )
  }

  /** Game Settings: Swap home and away, then Save. */
  async swapInSettings(gameId: string): Promise<void> {
    await this.go(`/games/${gameId}/settings`)
    await this.page.waitForSelector('[aria-label="Swap home and away"]', {
      timeout: 60000
    })
    await this.tap('Swap home and away')
    await this.tap('Save')
  }

  /** The scoring screen for this game, its help dismissed. */
  async scoreGame(gameId: string): Promise<void> {
    await this.go(`/games/${gameId}/score`)
    await this.page.waitForFunction(
      `document.querySelector('[aria-label="Open scoring menu"]') != null || String(document.body.textContent).includes(${JSON.stringify(UNLOADED)})`,
      { timeout: 60000 }
    )
    for (const label of ['OK', 'Close'])
      if (await this.has(label)) await this.tap(label)
  }

  async close(): Promise<void> {
    await this.session.close()
  }
}
