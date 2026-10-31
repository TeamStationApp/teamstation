import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import pg from 'pg'
import type { Page } from 'puppeteer'

import {
  gameProposalFields,
  loadedGameDraft,
  swapSides
} from '../../src/app/screens/gameDraft'
import {
  type Lineup,
  type RosterEntry,
  TeamStationClient
} from '../../src/common/api'
import type { ScoringAction } from '../../src/common/scoring/actions'
import { ScoringSession } from '../../src/common/scoring/session'
import { startingSetup, teamsOf } from '../../src/common/scoring/startingSetup'
import { type GameState, setupOf } from '../../src/common/scoring/state'
import type { LineupFixture } from '../../src/server/dev/lineupFixture'
import { signInTestAccount } from '../../src/test/passwordFixtures'
import type { BrowserSession } from './refinementsMaestro'

/**
 * What the scoring end-to-end drivers share: the local stack's addresses, a
 * fresh lineup fixture and its people's clients, scoring through a session,
 * the `$`-lined artifact logs, and a maestro-d Chromium page to drive.
 */

export const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8190'
export const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9190/api/v1'
export const PASSWORD = process.env.TS_LINEUP_PASSWORD ?? ''
export const WIDTH = 1280
export const HEIGHT = 900
/** A phone held sideways. */
export const PHONE_WIDTH = 915
export const PHONE_HEIGHT = 412
export const UNLOADED = 'Unable to load scoring.'
export const UNREAD = 'could not be read back'

let artifacts: string | undefined
/** Where `note` and `Browser.capture` write; none writes nothing. */
export function writeArtifactsTo(dir: string | undefined): void {
  artifacts = dir
}
export function artifactsDir(): string | undefined {
  return artifacts
}

export type Person = keyof LineupFixture['users']

export const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A command's report on stderr, which ffmpeg writes its measures to. */
export function spawnText(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return `${result.stdout}${result.stderr}`
}

/** The local stack's database, from the API's own config. */
export function databaseUrl(): string {
  const config = JSON.parse(
    readFileSync(resolve('serverConfig.json'), 'utf8')
  ) as { databaseUrl: string }
  return config.databaseUrl
}

/** A new game, its rosters and the people who use it. */
export function lineupFixture(): LineupFixture {
  const out = execFileSync(
    'npm',
    ['run', '--silent', 'lineup-fixture', '--', '--password', PASSWORD],
    { encoding: 'utf8' }
  )
  return JSON.parse(out) as LineupFixture
}

const tokens = new Map<string, string>()
export async function tokenOf(
  fixture: LineupFixture,
  who: Person
): Promise<string> {
  const email = fixture.users[who].email
  let token = tokens.get(email)
  if (token == null) {
    token = await signInTestAccount(API, { email, password: PASSWORD })
    tokens.set(email, token)
  }
  return token
}
export async function clientOf(
  fixture: LineupFixture,
  who: Person
): Promise<TeamStationClient> {
  return new TeamStationClient({
    baseUrl: API,
    token: await tokenOf(fixture, who)
  })
}

/** Logs this run has written, so each starts over on its first line. */
const begun = new Set<string>()

/** One line of a scenario's log, its request first, as `$` lines. */
export async function note(file: string | null, line: string): Promise<void> {
  console.log(`    ${line.split('\n')[0]}`)
  if (artifacts == null || file == null) return
  const write = begun.has(file) ? appendFile : writeFile
  begun.add(file)
  await write(join(artifacts, file), line + '\n')
}

/** A database read for a log: the query on its `$` line, then its rows. */
export async function query(
  file: string | null,
  sql: string,
  values: unknown[] = []
): Promise<Array<Record<string, unknown>>> {
  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    const rows = (await client.query(sql, values)).rows as Array<
      Record<string, unknown>
    >
    await note(
      file,
      `$ psql "$TS_DATABASE" -c "${sql.replace(/\s+/g, ' ')}"${values.length > 0 ? `  -- ${JSON.stringify(values)}` : ''}\n${JSON.stringify(rows, null, 2)}\n`
    )
    return rows
  } finally {
    await client.end()
  }
}

/**
 * Scores into the game as the scorekeeper's session does, through the API:
 * the game opens on the teams' default lineups, as the scoring screen's.
 */
export async function score(
  fixture: LineupFixture,
  actions: ScoringAction[] | ((game: GameState) => ScoringAction[])
): Promise<ScoringSession> {
  const client = await clientOf(fixture, 'scorekeeper')
  const game = await client.game(fixture.gameId)
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
  const list = typeof actions === 'function' ? actions(session.state) : actions
  for (const action of list)
    expect(session.apply(action).problems, JSON.stringify(action)).deep.equals(
      []
    )
  await session.flush()
  return session
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

/** Game Settings' own swap, sent as the home head coach's team. */
export async function proposeSwap(
  fixture: LineupFixture,
  who: Person
): Promise<{ id: string; status: string }> {
  const client = await clientOf(fixture, who)
  const state = await client.gameScheduling(fixture.gameId)
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
    { kind: 'edit', gameId: fixture.gameId },
    draft.home!,
    draft.away!,
    state
  )
  return await client.proposeGame({
    ...fields,
    idempotencyKey: `side-swap-${Date.now()}-${Math.random()}`
  })
}

/** The swap, proposed by the home head coach and accepted by the away one. */
export async function swapGame(
  fixture: LineupFixture,
  file: string
): Promise<void> {
  const proposal = await proposeSwap(fixture, 'headCoach')
  await note(
    file,
    `$ POST ${API}/game-requests  (home head coach: Swap home and away)\n${JSON.stringify(proposal)}\n`
  )
  if (proposal.status === 'accepted') return
  const accepted = await (
    await clientOf(fixture, 'awayCoach')
  ).decideGameRequest(proposal.id, 'accept')
  await note(
    file,
    `$ POST ${API}/game-requests/${proposal.id}/accept  (away head coach)\n${JSON.stringify(accepted)}\n`
  )
  expect(accepted.status).equals('accepted')
}

/** The sides, guests, unrostered players and digest the game holds. */
export async function sides(
  file: string | null,
  gameId: string
): Promise<Record<string, unknown>> {
  const [row] = await query(
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

/**
 * Taps the page's game audio, before the app loads: every audio context
 * also feeds a stream, and everything played to the speakers is played into
 * it, so `window.__gameAudio` can record what the page sounded. No ?. or ??
 * here: sucrase turns them into helpers the page lacks.
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
          let text = ''
          for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
          resolve(btoa(text))
        }
        recorder.stop()
      })
    }
  }
})()`

/** One browser, and what the scenarios do in it. */
export class Browser {
  readonly errors: string[] = []
  constructor(
    readonly session: BrowserSession,
    readonly page: Page
  ) {
    page.evaluateOnNewDocument(AUDIO_TAP).catch(() => undefined)
    page.on('pageerror', (error: unknown) => {
      this.errors.push(
        error instanceof Error ? String(error.stack) : String(error)
      )
    })
  }

  async as(fixture: LineupFixture, who: Person): Promise<void> {
    await this.page.browserContext().setCookie({
      name: 'ts_session',
      value: encodeURIComponent(await tokenOf(fixture, who)),
      domain: new URL(APP).hostname,
      path: '/'
    })
  }

  /** The enabled button or switch named `label`, by its label or text, tapped. */
  async tap(label: string): Promise<void> {
    const find = async (): Promise<{ x: number; y: number }> => {
      const handle = await this.page.waitForFunction(
        (label: string) => {
          const node = Array.from(
            document.querySelectorAll('[role="button"],[role="switch"],button')
          ).find(node => {
            // No ?? here: sucrase turns it into a helper the page lacks.
            const named = node.getAttribute('aria-label')
            const name =
              named != null && named !== '' ? named : String(node.textContent)
            return name === label || name.startsWith(label + ', ')
          })
          if (node == null || node.getAttribute('aria-disabled') === 'true')
            return null
          node.scrollIntoView({ block: 'center' })
          const box = node.getBoundingClientRect()
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        },
        { timeout: 30000 },
        label
      )
      return (await handle.jsonValue()) as { x: number; y: number }
    }
    // A sheet sliding in moves its buttons: tap once the target holds still.
    let point = await find()
    for (let tries = 0; tries < 20; tries++) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const next = await find()
      const still =
        Math.abs(next.x - point.x) < 1 && Math.abs(next.y - point.y) < 1
      point = next
      if (still) break
    }
    await this.session.m.command('tapOnPoint', {
      x: Math.round(point.x),
      y: Math.round(point.y)
    })
  }

  /** What the page says: its text, and its labels, the field's among them. */
  async text(): Promise<string> {
    return await this.page.evaluate(
      () =>
        String(document.body.textContent) +
        Array.from(document.querySelectorAll('[aria-label]'))
          .map(node => node.getAttribute('aria-label'))
          .join('\n')
    )
  }

  async waitText(text: string, timeout = 30000): Promise<void> {
    await this.page.waitForFunction(
      text =>
        String(document.body.textContent).includes(text) ||
        Array.from(document.querySelectorAll('[aria-label]')).some(node =>
          String(node.getAttribute('aria-label')).includes(text)
        ),
      { timeout },
      text
    )
  }

  async capture(name: string): Promise<void> {
    if (artifacts == null) return
    await this.session.m.waitForAnimationToEnd()
    await writeFile(join(artifacts, name), await this.session.m.screenshot())
  }

  /** The enabled button named `label` scrolled to the middle, as a tap leaves it. */
  async showButton(label: string): Promise<void> {
    await this.page.waitForFunction(
      (label: string) => {
        const node = Array.from(
          document.querySelectorAll('[role="button"]')
        ).find(node => {
          const named = node.getAttribute('aria-label')
          const name =
            named != null && named !== '' ? named : String(node.textContent)
          return name === label
        })
        if (node == null) return false
        node.scrollIntoView({ block: 'center' })
        return true
      },
      { timeout: 30000 },
      label
    )
  }

  /** The scoring menu's rows, top to bottom. */
  async menuOrder(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const rows = [
        'Exit Current Game',
        'Settings',
        'Overrides',
        'End Half Inning',
        'Set Team Rosters',
        'Swap Home and Away',
        'End Game'
      ]
      return Array.from(document.querySelectorAll('[aria-label]'))
        .map(node => String(node.getAttribute('aria-label')))
        .filter(label => rows.includes(label))
    })
  }

  /** The text of the element labelled `label`, a second line included. */
  async labelText(label: string): Promise<string> {
    // Plain JavaScript: the page has none of the compiler's helpers.
    return await this.page.evaluate((label: string) => {
      const node = document.querySelector(`[aria-label="${label}"]`)
      return node == null ? '' : String(node.textContent)
    }, label)
  }

  async isDisabled(label: string): Promise<boolean> {
    return await this.page.evaluate((label: string) => {
      const node = document.querySelector(`[aria-label="${label}"]`)
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- sucrase turns ?. into a helper the page lacks
      return node != null && node.getAttribute('aria-disabled') === 'true'
    }, label)
  }

  async has(label: string): Promise<boolean> {
    return (await this.page.$(`[aria-label="${label}"]`)) != null
  }

  /** Whether the labelled switch is on. */
  async switchOn(label: string): Promise<boolean> {
    return await this.page.evaluate((label: string) => {
      // react-native's Switch on the web is the labelled checkbox itself.
      const node = document.querySelector(`[aria-label="${label}"]`)
      return node instanceof HTMLInputElement
        ? node.checked
        : node !== null && node.getAttribute('aria-checked') === 'true'
    }, label)
  }

  /** Whether the labelled element is what a tap at its middle reaches. */
  async uncovered(label: string): Promise<boolean> {
    return await this.page.evaluate((label: string) => {
      const node = document.querySelector(`[aria-label="${label}"]`)
      if (node == null) return false
      const box = node.getBoundingClientRect()
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2
      )
      return hit != null && (hit === node || node.contains(hit))
    }, label)
  }

  /** Whether the labelled element lies wholly inside the window. */
  async onScreen(label: string): Promise<boolean> {
    return await this.page.evaluate((label: string) => {
      const node = document.querySelector(`[aria-label="${label}"]`)
      if (node == null) return false
      const box = node.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= window.innerHeight
    }, label)
  }

  /** Game Settings: Swap home and away, then Save. */
  async swapInSettings(gameId: string): Promise<void> {
    await this.page.goto(`${APP}/games/${gameId}/settings`, {
      waitUntil: 'domcontentloaded'
    })
    await this.page.waitForSelector('[aria-label="Swap home and away"]', {
      timeout: 60000
    })
    await this.tap('Swap home and away')
    await this.tap('Save')
  }

  /** The scoring screen for this game, its help dismissed. */
  async scoreGame(gameId: string): Promise<void> {
    await this.page.goto(`${APP}/games/${gameId}/score`, {
      waitUntil: 'domcontentloaded'
    })
    await this.page.waitForFunction(
      unloaded =>
        document.querySelector('[aria-label="Open scoring menu"]') != null ||
        String(document.body.textContent).includes(unloaded),
      { timeout: 60000 },
      UNLOADED
    )
    for (const label of ['OK', 'Close'])
      if ((await this.page.$(`[aria-label="${label}"]`)) != null)
        await this.tap(label)
  }
}
