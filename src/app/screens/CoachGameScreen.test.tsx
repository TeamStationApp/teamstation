import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BackHandler, Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asRosterEntry,
  type GameDetail,
  type GameLineupsResponse,
  type GamePlansResponse,
  type Health,
  type Lineup,
  type RosterEntry,
  type SaveLineupsBody,
  type SidePlan,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type { GamePlan, PlanCell } from '../../common/gamePlan'
import type { GameSocketEvent } from '../../common/gameSocket'
import { EMPTY_PLAN_SAME_DAY } from '../../common/planWarnings'
import { DEFAULT_PLAYING_TIME_RULES } from '../../common/playingTimeRules'
import {} from '../../common/scoring/gumbo'
import { ScoringSession } from '../../common/scoring/session'
import {
  copyState,
  type GameState,
  isPosition,
  POSITIONS,
  setupOf
} from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { confirmedChatAgeHooks } from '../../test/chatAgeTesting'
import {
  dictatingHealth,
  type FakeDictation,
  fakeDictation
} from '../../test/dictationFakes'
import { candidate } from '../../test/fakeCandidateClient'
import { measureBoxes } from '../../test/measureBoxes'
import { completeMotions } from '../../test/scoringHelpers'
import { App } from '../App'
import {
  currentRoute,
  showRoute,
  useBrowserBack
} from '../navigation/useAddressBar'
import {
  addDevelopmentPlayer,
  createDevelopmentSession,
  startingSetup,
  teamsOf
} from '../scoring/developmentSession'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import type { GameChanges } from '../scoring/rosterLive'
import { initialScoringState, scoringReducer } from '../scoring/scoringMachine'
import { DevelopmentScoringSource, memoryStore } from '../scoring/scoringSource'
import { ThemeProvider } from '../theme/ThemeContext'
import { battingOrders, CoachGameScreen, lineupsBody } from './CoachGameScreen'
import { GameScreen } from './GameScreen'

let root: Root | undefined
let host: HTMLElement | undefined
const originalFetch = globalThis.fetch

afterEach(async function () {
  await act(async () => {
    try {
      root?.unmount()
    } catch {
      // A sheet's portal can go before its root; the page is torn down.
    }
  })
  root = undefined
  host?.remove()
  host = undefined
  globalThis.fetch = originalFetch
})

const node = (label: string, role?: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    role == null
      ? `[aria-label="${label}"]`
      : `[aria-label="${label}"][role="${role}"]`
  )
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
}
async function click(label: string, role?: string): Promise<void> {
  const found = node(label, role)
  expect(found, label).not.equals(null)
  await act(async () => {
    found!.click()
  })
  await settle()
}
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const saveDisabled = (): boolean =>
  node('Save Rosters')?.getAttribute('aria-disabled') === 'true'

/** Nine players a side, fielding P to RF in batting order. */
function roster(teamId: string): RosterEntry[] {
  const first = teamId === 'away' ? 101 : 201
  return POSITIONS.map((position, i) =>
    asRosterEntry({
      userId: userIdOfGumbo(first + i),
      gumboId: first + i,
      shortName: `${teamId === 'away' ? 'Owl' : 'Hawk'} ${i + 1}`,
      jersey: String(i + 1),
      positions: [position],
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
    })
  )
}

const NO_LINEUP: Lineup = {
  batters: [],
  defense: Object.fromEntries(
    POSITIONS.map(position => [position, null])
  ) as Lineup['defense']
}
function lineups(digest: string, held: boolean): GameLineupsResponse {
  const side = (
    teamId: string,
    teamName: string
  ): GameLineupsResponse['home'] => ({
    teamId,
    teamName,
    start: null,
    changes: [],
    current: held ? NO_LINEUP : null
  })
  return {
    away: side('away', 'Owls'),
    home: side('home', 'Hawks'),
    digest
  }
}

const NO_DICTATION: Health = {
  status: 'ok',
  version: '',
  database: 'ok',
  migrations: 0,
  dictation: false,
  dictationModels: []
}

/** His side's plan as `GET /games/:gameId/plans` answers it, none saved. */
const HOME_PLAN: SidePlan = {
  teamId: 'home',
  plan: null,
  rules: null,
  sameDay: EMPTY_PLAN_SAME_DAY
}

/** The server, as the screen asks it things: what it was asked, and sent. */
interface Server {
  client: TeamStationClient
  saved: SaveLineupsBody[]
  /** Each game plan saved, and every save of either kind in order. */
  savedPlans: GamePlan[]
  writes: string[]
  plans: GamePlansResponse
  reads: { events: number; boxScore: number; lineups: number }
  game: GameDetail
  answer: (body: SaveLineupsBody) => Promise<GameLineupsResponse>
}
function server(game: Partial<GameDetail> = {}): Server {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const held: Server = {
    client,
    saved: [],
    savedPlans: [],
    writes: [],
    plans: { away: null, home: HOME_PLAN },
    reads: { events: 0, boxScore: 0, lineups: 0 },
    game: {
      ...gameFixture,
      canScore: false,
      coachSides: ['home'],
      assignedRoles: { away: ['coach'], home: ['coach'] },
      ...game
    },
    answer: async () => lineups('mine', true)
  }
  client.game = async () => held.game
  client.roster = async teamId => roster(teamId)
  client.defaultLineup = async () => ({
    lineup: null,
    fromGameId: null,
    setAt: null
  })
  client.gameEvents = async () => {
    held.reads.events++
    return { plays: [], currentPlay: null }
  }
  client.gameLineups = async () => {
    held.reads.lineups++
    return lineups('first', false)
  }
  client.boxScore = async () => {
    held.reads.boxScore++
    return { batting: [], pitching: [], stats: undefined }
  }
  client.health = async () => NO_DICTATION
  client.saveLineups = async (_gameId, body) => {
    held.saved.push(body)
    held.writes.push('lineups')
    return await held.answer(body)
  }
  client.gamePlans = async () => held.plans
  client.saveGamePlan = async (_gameId, teamId, plan) => {
    held.savedPlans.push(plan)
    held.writes.push('plan')
    const side = { ...HOME_PLAN, ...held.plans.home, teamId, plan }
    held.plans = { ...held.plans, home: side }
    return side
  }
  return held
}

/** The game socket, as a test sends to it. */
class FakeChanges implements GameChanges {
  readonly listeners = new Set<(event: GameSocketEvent) => void>()
  subscribe(
    _gameId: string,
    listener: (event: GameSocketEvent) => void
  ): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async emit(event: GameSocketEvent): Promise<void> {
    await act(async () => {
      for (const listener of [...this.listeners]) listener(event)
    })
    await settle()
  }

  async change(kind: 'lineups' | 'playEdits', digest = ''): Promise<void> {
    const event = {
      type: 'change',
      gameId: 'g1',
      kind,
      at: '2026-10-12T12:00:00Z',
      data: { digest }
    }
    await this.emit(event as unknown as GameSocketEvent)
  }

  /** A save of a team's game plan, announced. */
  async plans(teamId: string): Promise<void> {
    await this.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'plans',
      at: '2026-10-12T12:00:00Z',
      data: { teamId }
    } as unknown as GameSocketEvent)
  }
}

async function render(element: React.ReactElement): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <GestureHandlerRootView>{element}</GestureHandlerRootView>
      </ThemeProvider>
    )
  })
  await settle()
}

async function coach(
  held: Server,
  props: Partial<React.ComponentProps<typeof CoachGameScreen>> = {}
): Promise<{ exits: () => number }> {
  let exits = 0
  await render(
    <CoachGameScreen
      client={held.client}
      gameId="g1"
      teamId="home"
      onExit={() => {
        exits++
      }}
      {...props}
    />
  )
  await waitFor(() => node('Save Rosters') != null, 'the roster screen')
  return { exits: () => exits }
}

/** Takes the first batter out of the lineup: a change staged by hand. */
async function stageChange(): Promise<string> {
  await click('Lineup', 'tab')
  const remove = document.querySelector<HTMLElement>('[aria-label^="Remove "]')
  expect(remove).not.equals(null)
  const label = remove!.getAttribute('aria-label')!
  await act(async () => {
    remove!.click()
  })
  await settle()
  return label
}

/**
 * A game under way, the visitors batting with their leadoff on first, so a
 * pinch runner can be staged. Saving him leaves the setup equal: a courtesy
 * runner keeps the order and the players.
 */
function gameUnderWay(): GameState {
  const initial = initialScoringState(
    createDevelopmentSession(gameFixture, roster('away'), roster('home'))
  )
  const fielder = initial.session.liveData.boxscore.teams.home.defense.RF!
  let live = completeMotions(
    scoringReducer(initial, {
      type: 'DICTATED',
      transcript: 'single to center',
      actions: [
        { type: 'ballInPlay', contact: 'swing', fielder },
        { type: 'result', eventType: 'single' }
      ]
    })
  )
  live = completeMotions(scoringReducer(live, { type: 'CLOSE_PLAY' }))
  return live.session
}

/** One sentence on the coach's microphone, and the server's reply to it. */
async function say(
  fake: FakeDictation,
  transcript: string,
  roster: Array<Record<string, unknown>>
): Promise<void> {
  const pointer = async (type: 'pointerdown' | 'pointerup'): Promise<void> => {
    await act(async () => {
      node('Dictation')!.dispatchEvent(
        new window.MouseEvent(type, { bubbles: true })
      )
    })
  }
  if (node('Dictation')!.getAttribute('aria-pressed') !== 'true') {
    await pointer('pointerdown')
    await pointer('pointerup')
    await waitFor(() => fake.sockets.length > 0, 'the dictation socket')
    await act(async () => {
      fake.socket().open()
    })
    await waitFor(
      () => document.body.textContent!.includes('Push to talk'),
      'dictation ready'
    )
  }
  await pointer('pointerdown')
  const start = fake.socket().frames.at(-1)!
  expect(start.kind).equals('start')
  await act(async () => {
    fake.socket().reply({ kind: 'transcript', id: start.id, text: '…' })
  })
  await pointer('pointerup')
  await act(async () => {
    fake.socket().reply({
      kind: 'actions',
      id: start.id,
      transcript,
      actions: [],
      roster,
      dropped: []
    })
  })
  await settle()
}

describe('Coach Game (U25)', function () {
  // The Shell reads the account's chat age on mount: confirmed here.
  confirmedChatAgeHooks()
  it('keeps availability switches live while a lineup save is still out (U40)', async () => {
    const held = server()
    const save = held.client.saveLineups.bind(held.client)
    let finish!: () => void
    held.client.saveLineups = async (...args) => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return await save(...args)
    }
    await coach(held)
    await click('Roster', 'tab')
    await click('Save Rosters')
    const toggle = (): HTMLInputElement =>
      document.querySelector<HTMLInputElement>(
        `[data-testid="Rostered ${userIdOfGumbo(201)}"] input`
      )!
    expect(toggle().disabled).equals(false)
    await act(async () => {
      finish()
    })
    await settle()
    expect(toggle().disabled).equals(false)
  })

  it('keeps a failed switch unchanged, removes a player on success and restores him unplaced', async () => {
    const guest = asRosterEntry({
      ...roster('home')[0],
      userId: userIdOfGumbo(901),
      gumboId: 901,
      shortName: 'Babe Ruth',
      jersey: '99'
    })
    const held = server({
      guests: { away: [], home: [901] },
      guestPlayers: { away: [], home: [guest] }
    })
    let refuse = true
    const calls: Array<{ side: string; userId: string; rostered: boolean }> = []
    held.client.setRostered = async (_id, body) => {
      calls.push(body)
      if (refuse)
        throw new HttpError('conflict', 'Finish the current play first')
      held.game = {
        ...held.game,
        unrostered: {
          away: [],
          home: body.rostered
            ? []
            : [roster('home').find(row => row.userId === body.userId)!.gumboId!]
        }
      }
      return held.game.unrostered
    }
    await coach(held)
    await click('Roster', 'tab')
    const toggle = (): HTMLInputElement =>
      document.querySelector<HTMLInputElement>(
        `[data-testid="Rostered ${userIdOfGumbo(201)}"] input`
      )!
    expect(
      document.querySelectorAll('input[aria-label="Rostered for this game"]')
    ).length(9)
    expect(toggle().checked).equals(true)
    await act(async () => {
      toggle().click()
    })
    await settle()
    expect(toggle().checked).equals(true)
    expect(document.body.textContent).includes('Finish the current play first')
    expect(node('Remove Hawk 1')).not.equals(null)
    refuse = false
    await act(async () => {
      toggle().click()
    })
    await settle()
    expect(toggle().checked).equals(false)
    expect(node('Remove Hawk 1')).equals(null)
    await click('Lineup', 'tab')
    expect(node('Add Hawk 1 to Lineup')).equals(null)
    await click('Defense', 'tab')
    expect(
      document.querySelector('[data-testid="Defense roster grid"]')!.textContent
    ).not.includes('Hawk 1')
    await click('Roster', 'tab')
    await act(async () => {
      toggle().click()
    })
    await settle()
    expect(toggle().checked).equals(true)
    await click('Lineup', 'tab')
    expect(node('Add Hawk 1 to Lineup')).not.equals(null)
    expect(node('Remove Hawk 1')).equals(null)
    await click('Save Rosters')
    const body = held.saved[0]
    const index = body.players.findIndex(player => player.gumboId === 201)
    expect(index).gte(0)
    expect(body.players.some(player => player.gumboId === 901)).equals(true)
    expect(body.battingOrder).not.includes(index)
    expect(Object.values(body.defense)).not.includes(index)
    expect(calls).deep.equals([
      { side: 'home', userId: userIdOfGumbo(201), rostered: false },
      { side: 'home', userId: userIdOfGumbo(201), rostered: false },
      { side: 'home', userId: userIdOfGumbo(201), rostered: true }
    ])
  })

  it('keeps both of two quick switches when the later one is answered first', async () => {
    const held = server()
    let answerFirst!: () => void
    held.client.setRostered = async (_id, body) => {
      if (body.userId === userIdOfGumbo(201)) {
        await new Promise<void>(resolve => {
          answerFirst = resolve
        })
        return { away: [], home: [201] }
      }
      return { away: [], home: [201, 202] }
    }
    await coach(held)
    await click('Roster', 'tab')
    const toggle = (gumboId: number): HTMLInputElement =>
      document.querySelector<HTMLInputElement>(
        `[data-testid="Rostered ${userIdOfGumbo(gumboId)}"] input`
      )!
    await act(async () => {
      toggle(201).click()
    })
    await settle()
    await act(async () => {
      toggle(202).click()
    })
    await settle()
    // The first change's answer, made before the second, comes last.
    await act(async () => {
      answerFirst()
    })
    await settle()
    expect(toggle(201).checked).equals(false)
    expect(toggle(202).checked).equals(false)
    expect(node('Remove Hawk 2')).equals(null)
  })

  it('undoes only the refused one of two quick switches, keeping the other', async () => {
    const held = server()
    let refuseFirst!: () => void
    held.client.setRostered = async (_id, body) => {
      if (body.userId === userIdOfGumbo(201)) {
        await new Promise<void>(resolve => {
          refuseFirst = resolve
        })
        throw new HttpError('conflict', 'Finish the current play first')
      }
      held.game = {
        ...held.game,
        unrostered: { away: [], home: body.rostered ? [] : [202] }
      }
      return held.game.unrostered
    }
    await coach(held)
    await click('Roster', 'tab')
    const toggle = (gumboId: number): HTMLInputElement =>
      document.querySelector<HTMLInputElement>(
        `[data-testid="Rostered ${userIdOfGumbo(gumboId)}"] input`
      )!
    await act(async () => {
      toggle(201).click()
    })
    await settle()
    await act(async () => {
      toggle(202).click()
    })
    await settle()
    // The second is answered first: the server's lists are shown.
    expect(toggle(202).checked).equals(false)
    await act(async () => {
      refuseFirst()
    })
    await settle()
    expect(document.body.textContent).includes('Finish the current play first')
    // The refused one is back, in his slot; the other stays off.
    expect(toggle(201).checked).equals(true)
    expect(node('Remove Hawk 1')).not.equals(null)
    expect(toggle(202).checked).equals(false)
    expect(node('Remove Hawk 2')).equals(null)
  })

  it("renames a corrected game-only player's account once, before the lineup is saved", async () => {
    const guest = asRosterEntry({
      ...roster('home')[0],
      userId: userIdOfGumbo(901),
      gumboId: 901,
      shortName: 'Babe Ruth',
      nameDetails: {
        firstName: 'Babe',
        lastName: 'Ruth',
        displayName: 'Babe Ruth'
      },
      jersey: '99'
    })
    const held = server({
      guests: { away: [], home: [901] },
      guestPlayers: { away: [], home: [guest] }
    })
    const calls: string[] = []
    const renames: unknown[] = []
    held.client.renameGuestPlayer = async (gameId, userId, name, gumboId) => {
      calls.push('rename')
      renames.push({ gameId, userId, name, gumboId })
      return { ...guest, shortName: `${name.firstName} ${name.lastName}` }
    }
    const answer = held.answer
    held.answer = async body => {
      calls.push('lineups')
      return await answer(body)
    }
    await coach(held)
    await click('Roster', 'tab')
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label*="game-only player"]')!
        .click()
    })
    await settle()
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="First Name"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, 'George')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await click('Save Player')
    await click('Save Rosters')
    await settle()
    expect(renames).deep.equals([
      {
        gameId: 'g1',
        userId: userIdOfGumbo(901),
        name: { firstName: 'George', lastName: 'Ruth' },
        gumboId: 901
      }
    ])
    expect(calls.slice(0, 2)).deep.equals(['rename', 'lineups'])
  })

  it('saves no lineup when the rename is refused, and says why', async () => {
    const guest = asRosterEntry({
      ...roster('home')[0],
      userId: userIdOfGumbo(901),
      gumboId: 901,
      shortName: 'Babe Ruth',
      jersey: '99'
    })
    const held = server({
      guests: { away: [], home: [901] },
      guestPlayers: { away: [], home: [guest] }
    })
    held.client.renameGuestPlayer = async () => {
      throw new HttpError('forbidden', 'This player can sign in')
    }
    await coach(held)
    await click('Roster', 'tab')
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label*="game-only player"]')!
        .click()
    })
    await settle()
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="First Name"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, 'George')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await click('Save Player')
    await click('Save Rosters')
    await settle()
    expect(held.saved).deep.equals([])
    expect(document.body.textContent).includes('This player can sign in')
  })

  this.timeout(20000)

  it('draws its own chevron and his team’s name on the right, over a Box Score pill on its own row above Roster, Lineup, Defense and Plan', async function () {
    const held = server()
    await coach(held)
    expect(node('Back', 'button')).not.equals(null)
    const header = document.querySelector<HTMLElement>(
      '[data-testid="Coach header"] [role="heading"]'
    )!
    expect(header.textContent).equals('Hawks')
    expect(getComputedStyle(header).textAlign).equals('right')
    for (const tab of ['Box Score', 'Roster', 'Lineup', 'Defense', 'Plan'])
      expect(node(tab, 'tab'), tab).not.equals(null)
    // Box Score is a pill of its own, on the row above the other three, and
    // he opens on it with none of them chosen.
    const pill = document.querySelector<HTMLElement>(
      '[data-testid="Box Score pill"]'
    )!
    expect(pill).equals(node('Box Score', 'tab'))
    const tabs = node('Roster', 'tab')!.parentElement!
    expect(tabs.contains(pill)).equals(false)
    expect(
      [...tabs.querySelectorAll('[role="tab"]')].map(tab =>
        tab.getAttribute('aria-label')
      )
    ).deep.equals(['Roster', 'Lineup', 'Defense', 'Plan'])
    expect(
      pill.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    expect(pill.getAttribute('aria-selected')).equals('true')
    for (const tab of ['Roster', 'Lineup', 'Defense', 'Plan'])
      expect(node(tab, 'tab')!.getAttribute('aria-selected'), tab).equals(
        'false'
      )
    expect(tabs.querySelector('[data-testid="Roster selector thumb"]')).equals(
      null
    )
    expect(
      document.querySelector('[data-testid="Roster box score"]')
    ).not.equals(null)
    // His own team alone.
    expect(node('Away Team')).equals(null)
    expect(node('Home Team')).equals(null)
    expect(held.reads.boxScore).equals(1)
    // The game holds no lineup for his side yet: Save is lit as it stands.
    expect(saveDisabled()).equals(false)
    // Lineup takes the choice from the pill.
    await click('Lineup', 'tab')
    expect(node('Lineup', 'tab')!.getAttribute('aria-selected')).equals('true')
    expect(pill.getAttribute('aria-selected')).equals('false')
    expect(
      tabs.querySelector('[data-testid="Roster selector thumb"]')
    ).not.equals(null)
    await click('Box Score', 'tab')
    expect(pill.getAttribute('aria-selected')).equals('true')
    expect(node('Lineup', 'tab')!.getAttribute('aria-selected')).equals('false')
  })

  it('offers Save on his default when a blind save left his side unseen', async function () {
    const held = server()
    const rows = roster('home')
    const person = (
      row: RosterEntry
    ): { gumboId: number; name: string; jersey: string } => ({
      gumboId: row.gumboId!,
      name: row.shortName,
      jersey: row.jersey ?? ''
    })
    const kept: Lineup = {
      batters: [...rows].reverse().map(person),
      defense: Object.fromEntries(
        POSITIONS.map((position, index) => [position, person(rows[index])])
      ) as Lineup['defense']
    }
    held.client.defaultLineup = async () => ({
      lineup: kept,
      fromGameId: 'earlier',
      setAt: '2026-01-01T00:00:00.000Z'
    })
    // The game already holds a lineup, the roster order the other coach stored.
    held.client.gameLineups = async () => {
      held.reads.lineups++
      return lineups('first', true)
    }
    const games = new DevelopmentScoringSource()
    await coach(held, {
      source: {
        open: async (game, away, home) => {
          const session = await games.open(game, away, home)
          const applied = session.apply({
            type: 'lineup',
            kind: 'roster',
            setup: setupOf(session.resumable().state),
            unseen: ['home']
          })
          expect(
            applied.problems,
            JSON.stringify(applied.problems)
          ).deep.equals([])
          await session.flush()
          return session
        }
      }
    })
    // No edit: Save is lit on the default, and saving writes that order.
    expect(saveDisabled()).equals(false)
    await click('Save Rosters')
    expect(held.saved).has.length(1)
    expect(held.saved[0].side).equals('home')
    expect(held.saved[0].players.map(player => player.gumboId)).deep.equals([
      201, 202, 203, 204, 205, 206, 207, 208, 209
    ])
    expect(held.saved[0].battingOrder).deep.equals([8, 7, 6, 5, 4, 3, 2, 1, 0])
  })

  it('shows the lineup being scored after the first pitch, when a blind save left his side unseen', async function () {
    const held = server()
    const rows = roster('home')
    const person = (
      row: RosterEntry
    ): { gumboId: number; name: string; jersey: string } => ({
      gumboId: row.gumboId!,
      name: row.shortName,
      jersey: row.jersey ?? ''
    })
    const kept: Lineup = {
      batters: [...rows].reverse().map(person),
      defense: Object.fromEntries(
        POSITIONS.map((position, index) => [position, person(rows[index])])
      ) as Lineup['defense']
    }
    held.client.defaultLineup = async () => ({
      lineup: kept,
      fromGameId: 'earlier',
      setAt: '2026-01-01T00:00:00.000Z'
    })
    held.client.gameLineups = async () => {
      held.reads.lineups++
      return lineups('first', true)
    }
    const games = new DevelopmentScoringSource()
    await coach(held, {
      source: {
        open: async (game, away, home) => {
          const session = await games.open(game, away, home)
          const applied = session.apply({
            type: 'lineup',
            kind: 'roster',
            setup: setupOf(session.resumable().state),
            unseen: ['home']
          })
          expect(
            applied.problems,
            JSON.stringify(applied.problems)
          ).deep.equals([])
          const pitched = session.apply({ type: 'pitch', call: 'B' })
          expect(
            pitched.problems,
            JSON.stringify(pitched.problems)
          ).deep.equals([])
          await session.flush()
          return session
        }
      }
    })
    const box =
      document.querySelector<HTMLElement>('[data-testid="Coach box score"]')
        ?.textContent ?? ''
    const hawks = box.slice(box.indexOf('Batting — Hawks'))
    expect(hawks.indexOf('Hawk 1'), 'leadoff').greaterThan(-1)
    expect(hawks.indexOf('Hawk 1')).lessThan(hawks.indexOf('Hawk 9'))
    expect(saveDisabled()).equals(true)
    await click('Lineup', 'tab')
    const order =
      document.querySelector<HTMLElement>('[aria-label="Batting lineup"]')
        ?.textContent ?? ''
    expect(order.indexOf('Hawk 1')).lessThan(order.indexOf('Hawk 9'))
    expect(held.saved).deep.equals([])
  })

  it('saves his side’s lineup by who each player is, and stays on the tab', async function () {
    const held = server()
    const games = new DevelopmentScoringSource()
    let session: ScoringSession | undefined
    await coach(held, {
      source: {
        open: async (game, away, home) => {
          session = await games.open(game, away, home)
          return session
        }
      }
    })
    const removed = await stageChange()
    const saveLineups = held.client.saveLineups.bind(held.client)
    // The save is written into the game the screen then reads back, as the
    // server's roster action is.
    held.client.saveLineups = async (gameId, body) => {
      const answer = await saveLineups(gameId, body)
      const live = session!
      const game = copyState(live.resumable().state)
      const team = game.liveData.boxscore.teams[body.side]
      team.battingOrder = body.battingOrder.flatMap(index => {
        const id = team.players[index]
        return id == null ? [] : [id]
      })
      for (const position of POSITIONS) {
        const index = body.defense[position]
        team.defense[position] =
          index == null ? null : (team.players[index] ?? null)
      }
      const applied = live.apply({
        type: 'lineup',
        kind: 'roster',
        setup: setupOf(game)
      })
      expect(applied.problems).deep.equals([])
      await live.flush()
      return answer
    }
    await click('Save Rosters')
    await waitFor(() => node(removed) == null, 'the saved lineup')
    expect(held.saved).has.length(1)
    const body = held.saved[0]
    expect(body.side).equals('home')
    expect(body.base).equals('first')
    expect(body.players.map(player => player.gumboId)).deep.equals([
      201, 202, 203, 204, 205, 206, 207, 208, 209
    ])
    expect(body.players[0]).deep.include({ jersey: '1' })
    expect(body.battingOrder).deep.equals([1, 2, 3, 4, 5, 6, 7, 8])
    expect(body.defense).deep.include({ P: 0, C: 1, RF: 8 })
    expect(node(removed)).equals(null)
    expect(node('Lineup', 'tab')!.getAttribute('aria-selected')).equals('true')
    expect(node('Save Rosters')).not.equals(null)
  })

  it('shows the game’s refusal and keeps the staged change', async function () {
    const held = server()
    held.answer = async () => {
      throw new HttpError('conflict', 'Finish the current play first')
    }
    await coach(held)
    const removed = await stageChange()
    await click('Save Rosters')
    await waitFor(
      () =>
        document.body.textContent!.includes('Finish the current play first'),
      'the refusal'
    )
    expect(node(removed)).equals(null)
    expect(saveDisabled()).equals(false)
    held.answer = async () => {
      throw new Error('offline')
    }
    await click('Save Rosters')
    await waitFor(
      () => document.body.textContent!.includes('Unable to save the lineup'),
      'the failure'
    )
  })

  it('keeps a later save on screen when an earlier one is refused, and reads the server’s lineups', async function () {
    const held = server()
    let refuse!: () => void
    let first = true
    const answer = held.answer
    held.answer = async body => {
      if (first) {
        first = false
        await new Promise<void>(resolve => {
          refuse = resolve
        })
        throw new HttpError('conflict', 'Finish the current play first')
      }
      return await answer(body)
    }
    await coach(held)
    const removed = await stageChange()
    await click('Save Rosters')
    await stageChange()
    await click('Save Rosters')
    await settle()
    await act(async () => {
      refuse()
    })
    await waitFor(
      () =>
        document.body.textContent!.includes('Finish the current play first'),
      'the refusal'
    )
    await settle()
    // The first save's draft is not staged again over the later one: the
    // server's lineups are read in, with the player it removed.
    await waitFor(() => node(removed) != null, 'the server’s lineups')
  })

  it('saves a staged pinch runner onto a clean draft at once, and stages it again when the save is refused', async function () {
    const held = server({ coachSides: ['away'] })
    held.client.health = dictatingHealth
    // After the save lands, a later read of the lineups is the saved one.
    let savedLineup = false
    held.client.gameLineups = async () => {
      held.reads.lineups++
      return lineups(savedLineup ? 'saved' : 'first', savedLineup)
    }
    const fake = fakeDictation()
    const screen = await coach(held, {
      teamId: 'away',
      source: {
        open: async () => {
          // Number 2 is up to bat; the runner comes off the coach's bench.
          const game = copyState(gameUnderWay())
          addDevelopmentPlayer(game, 'away', 9000000, 'Owl 10', '10')
          return ScoringSession.start(memoryStore(), 'g1', game)
        }
      },
      dictation: {
        openSocket: fake.openSocket,
        openMicrophone: fake.openMicrophone,
        tapMs: 0,
        tailMs: 0
      }
    })
    await say(fake, 'Number 10 runs for the runner on first', [
      { type: 'pinchRunner', player: { jersey: '10' }, base: '1B' }
    ])
    expect(node('Dictation chat')).not.equals(null)
    const line = document.querySelector('[data-testid="Roster chat line"]')
    expect(line?.textContent ?? '', document.body.textContent ?? '').includes(
      'runs for'
    )
    expect(saveDisabled()).equals(false)
    held.answer = async () => {
      throw new HttpError('conflict', 'Finish the current play first')
    }
    await click('Save Rosters')
    await waitFor(
      () =>
        document.body.textContent!.includes('Finish the current play first'),
      'the refusal'
    )
    expect(held.saved[0].runners).has.length(1)
    // The refused change is staged again over the game as it was.
    expect(saveDisabled()).equals(false)
    held.answer = async () => {
      savedLineup = true
      return lineups('saved', true)
    }
    await click('Save Rosters')
    await waitFor(() => saveDisabled(), 'a clean draft')
    expect(held.saved[1].runners).has.length(1)
    expect(node('Dictation chat')).equals(null)
    await click('Back')
    expect(screen.exits()).equals(1)
    expect(document.body.textContent).not.includes(
      'Discard unsaved roster changes?'
    )
  })

  it('discards staged changes on Cancel, reads the game again and stays', async function () {
    const held = server()
    const screen = await coach(held)
    const removed = await stageChange()
    expect(saveDisabled()).equals(false)
    const events = held.reads.events
    await click('Cancel')
    await waitFor(() => held.reads.events > events, 'the game read again')
    expect(node(removed)).not.equals(null)
    expect(screen.exits()).equals(0)
  })

  it('asks before leaving with a staged change: Keep editing stays, Discard leaves', async function () {
    const held = server()
    const screen = await coach(held)
    await stageChange()
    await click('Back')
    expect(document.body.textContent).includes(
      'Discard unsaved roster changes?'
    )
    await click('Keep editing')
    expect(screen.exits()).equals(0)
    expect(node('Discard')).equals(null)
    await click('Back')
    await click('Discard')
    expect(screen.exits()).equals(1)
  })

  it('asks on Android’s Back over a staged change, and leaves Back to the shell otherwise', async function () {
    const originalOS = Platform.OS
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored below.
    const originalAdd = BackHandler.addEventListener
    const handlers = new Set<() => boolean | null | undefined>()
    Object.defineProperty(Platform, 'OS', {
      value: 'android',
      configurable: true
    })
    BackHandler.addEventListener = (_event, handler) => {
      const each = (): boolean | null | undefined =>
        handler({ type: 'hardwareBackPress', timeStamp: 0 })
      handlers.add(each)
      return {
        remove: () => {
          handlers.delete(each)
        }
      }
    }
    try {
      const held = server()
      const screen = await coach(held)
      expect(handlers.size).equals(0)
      await stageChange()
      expect(handlers.size).equals(1)
      await act(async () => {
        for (const handler of handlers) expect(handler()).equals(true)
      })
      await settle()
      await click('Discard')
      expect(screen.exits()).equals(1)
    } finally {
      BackHandler.addEventListener = originalAdd
      Object.defineProperty(Platform, 'OS', {
        value: originalOS,
        configurable: true
      })
    }
  })

  it('leaves at once with nothing staged', async function () {
    const held = server()
    const screen = await coach(held)
    await click('Back')
    expect(screen.exits()).equals(1)
  })

  it('returns the browser’s Back to the game’s Box score tab', async function () {
    const routes: unknown[] = []
    function Observer(): null {
      useBrowserBack(route => {
        routes.push(route)
      })
      return null
    }
    showRoute({ name: 'game', gameId: 'g1', tab: 'boxScore' }, true)
    showRoute({ name: 'coachGame', gameId: 'g1', teamId: 'home' })
    const held = server()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <Observer />
          <CoachGameScreen
            client={held.client}
            gameId="g1"
            teamId="home"
            onExit={() => undefined}
          />
        </ThemeProvider>
      )
    })
    await waitFor(() => node('Save Rosters') != null, 'the roster screen')
    await act(async () => {
      window.history.back()
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    await settle()
    expect(currentRoute()).include({
      name: 'game',
      gameId: 'g1',
      tab: 'boxScore'
    })
  })

  it('waits for a persisted game guest before adding it to the coach draft', async () => {
    const held = server()
    const requests: unknown[] = []
    held.client.createGuestPlayer = async (gameId, side, player) => {
      requests.push({ gameId, side, player })
      return {
        ...roster('home')[0],
        userId: userIdOfGumbo(9000001),
        gumboId: 9000001,
        shortName: 'HAWKS A'
      }
    }
    await coach(held)
    await click('Create Player')
    await click('Create Placeholder Player')
    await click('Create')
    expect(requests).has.length(1)
    expect(requests[0]).includes({ gameId: 'g1', side: 'home' })
    expect(document.body.textContent).includes('HAWKS A')
    held.client.gameLineups = async () => lineups('mine', true)
    await click('Save Rosters')
    await waitFor(() => held.saved.length === 1, 'the saved guest')
    expect(held.saved[0].players.map(player => player.gumboId)).includes(
      9000001
    )
  })

  it('creates a team roster player from the coach form', async () => {
    const held = server()
    const sent: unknown[] = []
    held.client.createRosterPlayer = async (teamId, player) => {
      sent.push({ teamId, player })
      return {
        ...roster('home')[0],
        userId: userIdOfGumbo(300),
        gumboId: 300,
        shortName: 'Mookie B'
      }
    }
    await coach(held)
    await click('Create Player')
    for (const [label, value] of [
      ['First Name', 'Mookie'],
      ['Last Name', 'Betts']
    ])
      await act(async () => {
        const input = node(label) as HTMLInputElement
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(input, value)
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    await act(async () => {
      const buttons = document.querySelectorAll<HTMLElement>(
        '[aria-label="Add Player"], [aria-label="Create Player"]'
      )
      buttons[buttons.length - 1].click()
    })
    await settle()
    expect(sent).has.length(1)
    expect(
      (sent[0] as { player: { firstName: string } }).player.firstName
    ).equals('Mookie')
    expect(node('First Name')).equals(null)
    await click('Roster', 'tab')
    held.client.gameLineups = async () => lineups('mine', true)
    await click('Save Rosters')
    await waitFor(
      () => held.saved.length === 1 && saveDisabled(),
      'saved and remounted'
    )
    expect(document.body.textContent).includes('Mookie B')
  })

  it("adds an existing player to the coach's roster and as a pool player", async () => {
    const held = server()
    const sent: unknown[] = []
    const betts = {
      ...roster('home')[0],
      userId: userIdOfGumbo(301),
      gumboId: 301,
      shortName: 'Mookie B'
    }
    held.client.rosterCandidates = async ask => {
      sent.push({ search: ask.teamId, game: ask.gameId })
      return [
        candidate('Mookie Betts', { userId: betts.userId }),
        candidate('Aaron Judge', { userId: userIdOfGumbo(302) })
      ]
    }
    held.client.addExistingRosterPlayer = async (teamId, body) => {
      sent.push({ roster: teamId, body })
      return { entry: betts, noticeId: 'req_1' }
    }
    held.client.addExistingGuest = async (gameId, side, body, teamId) => {
      sent.push({ guest: { gameId, side, teamId }, body })
      return { pendingRequestId: 'req_2' }
    }
    const restore = measureBoxes()
    try {
      await coach(held)
      await click('Roster', 'tab')
      await click('Add Existing Player')
      await click('Choose Mookie B')
      await click('Add to Roster')
      expect(document.body.textContent).includes(
        'Mookie B was added. Their guardians were notified.'
      )
      await click('Add Existing Player')
      // He is on the roster now: the search no longer lists him.
      expect(node('Choose Mookie B')).equals(null)
      await click('Choose Aaron J')
      await click('Add as Pool Player')
      expect(document.body.textContent).includes('This needs approval first.')
      expect(sent).deep.equals([
        { search: 'home', game: 'g1' },
        {
          roster: 'home',
          body: { userId: betts.userId, jersey: null, positions: [] }
        },
        { search: 'home', game: 'g1' },
        {
          guest: { gameId: 'g1', side: 'home', teamId: 'home' },
          body: { userId: userIdOfGumbo(302), jersey: null, positions: [] }
        }
      ])
      // Back out of Add to Roster, then the search.
      for (let sheet = 0; sheet < 2; sheet++)
        await act(async () => {
          const cancels = document.querySelectorAll<HTMLElement>(
            '[aria-label="Cancel"]'
          )
          cancels[cancels.length - 1].click()
        })
      expect(node('Choose Aaron J')).equals(null)
    } finally {
      restore()
    }
  })

  it('edits rostered player settings from coaching and preserves pending lineup changes', async () => {
    const held = server()
    const changed = { ...roster('home')[0], jersey: '42' }
    const writes: unknown[] = []
    held.client.setPlayerSettings = async (teamId, userId, changes) => {
      writes.push({ teamId, userId, changes })
      return changed
    }
    await coach(held)
    const removed = await stageChange()
    await click('Roster', 'tab')
    expect(document.body.textContent).not.includes(
      'Player settings are unavailable'
    )
    const player = document.querySelector<HTMLElement>(
      '[data-testid="Edit roster players"] [aria-label$="edit settings"]'
    )!
    await click(player.getAttribute('aria-label')!)
    await act(async () => {
      const input = node('Jersey number') as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, '42')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await click('Save')
    expect(writes).deep.equals([
      { teamId: 'home', userId: userIdOfGumbo(201), changes: { jersey: '42' } }
    ])
    const cancels = document.querySelectorAll<HTMLElement>(
      '[aria-label="Cancel"]'
    )
    await act(async () => {
      cancels[cancels.length - 1].click()
    })
    await settle()
    expect(document.body.textContent).includes('#42')
    await click('Lineup', 'tab')
    expect(node(removed)).equals(null)
    expect(saveDisabled()).equals(false)
  })

  it('keeps the game writable for a coach: Create Player opens its sheet', async function () {
    const held = server()
    await coach(held)
    await click('Create Player')
    expect(node('First Name')).not.equals(null)
    // The sheet's own Cancel, over the roster screen's.
    const cancels = document.querySelectorAll<HTMLElement>(
      '[aria-label="Cancel"]'
    )
    await act(async () => {
      cancels[cancels.length - 1].click()
    })
    await settle()
    expect(node('First Name')).equals(null)
  })

  it('refreshes coach lineup validation when a peer finishes the pending hit', async function () {
    const held = server()
    const changes = new FakeChanges()
    const store = memoryStore()
    const context = {
      gamePk: 'g1',
      teams: teamsOf(held.game),
      setup: startingSetup(held.game, roster('away'), roster('home'))
    }
    const writer = await ScoringSession.open(store, 'g1', context)
    for (const action of [
      { type: 'lineup', kind: 'roster', setup: context.setup },
      { type: 'ballInPlay', contact: 'swing', fielder: 209 },
      { type: 'result', eventType: 'single' }
    ] as const)
      expect(writer.apply(action).problems).deep.equals([])
    await writer.flush()
    let observer: ScoringSession | undefined
    await coach(held, {
      socket: changes,
      source: {
        open: async () => {
          observer = await ScoringSession.open(store, 'g1', context)
          return observer
        }
      }
    })
    await click('Lineup', 'tab')
    expect(
      writer.apply({ type: 'gameFlow', kind: 'closePlay' }).problems
    ).deep.equals([])
    await writer.flush()
    await changes.change('playEdits')
    await waitFor(
      () =>
        observer!.state.liveData.plays.currentPlay?.matchup.batter.id === 102,
      'the coach to adopt the next batter after the remote hit'
    )
    expect(document.body.textContent).not.includes(
      'Choose a next batter in the lineup who is not already on base.'
    )
    writer.close()
  })

  it('defers play refresh while the coach has a staged edit', async function () {
    const held = server()
    const changes = new FakeChanges()
    await coach(held, { socket: changes })
    const removed = await stageChange()
    const reads = held.reads.events
    await changes.change('playEdits')
    expect(held.reads.events).equals(reads)
    expect(node(removed)).equals(null)
    expect(saveDisabled()).equals(false)
    await click('Cancel')
    await waitFor(() => held.reads.events > reads, 'pending plays after Cancel')
    expect(node(removed)).not.equals(null)
  })

  it('does not adopt a play read that races a coach edit', async function () {
    const held = server()
    const changes = new FakeChanges()
    await coach(held, { socket: changes })
    const original = held.client.gameEvents.bind(held.client)
    let release: (() => void) | undefined
    held.client.gameEvents = async gameId => {
      await new Promise<void>(resolve => {
        release = resolve
      })
      return await original(gameId)
    }
    await changes.change('playEdits')
    await waitFor(() => release != null, 'the delayed play read')
    const removed = await stageChange()
    held.client.gameEvents = original
    await act(async () => {
      release!()
    })
    await settle()
    expect(node(removed)).equals(null)
    expect(saveDisabled()).equals(false)
    await click('Cancel')
    expect(node(removed)).not.equals(null)
  })

  it('retains a play refresh when a coach edit is reversed before its read returns', async function () {
    const held = server()
    const changes = new FakeChanges()
    await coach(held, { socket: changes })
    await click('Lineup', 'tab')
    const original = held.client.gameEvents.bind(held.client)
    let release: (() => void) | undefined
    let reads = 0
    held.client.gameEvents = async gameId => {
      if (++reads === 1)
        await new Promise<void>(resolve => {
          release = resolve
        })
      return await original(gameId)
    }
    await changes.change('playEdits')
    await waitFor(() => release != null, 'the held play read')
    const removals = document.querySelectorAll<HTMLElement>(
      '[aria-label^="Remove "]'
    )
    const label = removals[removals.length - 1].getAttribute('aria-label')!
    await click(label)
    expect(node(label)).equals(null)
    await click(`Add ${label.slice('Remove '.length)} to Lineup`)
    expect(node(label)).not.equals(null)
    await act(async () => {
      release!()
    })
    await waitFor(() => reads >= 2, 'the clean editor to recover its play read')
    expect(held.saved).has.length(0)
  })

  it('retries a failed coach play refresh without another notice', async function () {
    const held = server()
    const changes = new FakeChanges()
    await coach(held, { socket: changes })
    const original = held.client.gameEvents.bind(held.client)
    let attempts = 0
    held.client.gameEvents = async gameId => {
      if (++attempts === 1) throw new Error('Temporary read failure')
      return await original(gameId)
    }
    await changes.change('playEdits')
    await waitFor(() => attempts === 2, 'the failed play read to retry')
    expect(node('Save Rosters')).not.equals(null)
  })

  it('reads again for play notices received during a coach refresh', async function () {
    const held = server()
    const changes = new FakeChanges()
    await coach(held, { socket: changes })
    const original = held.client.gameEvents.bind(held.client)
    let release: (() => void) | undefined
    let reads = 0
    held.client.gameEvents = async gameId => {
      if (++reads === 1)
        await new Promise<void>(resolve => {
          release = resolve
        })
      return await original(gameId)
    }
    await changes.change('playEdits')
    await waitFor(() => release != null, 'the first read to start')
    await changes.change('playEdits')
    expect(reads).equals(1)
    await act(async () => {
      release!()
    })
    await waitFor(() => reads === 2, 'the later notice to be read')
  })

  it('follows another device’s lineups under a clean draft, and warns over a staged one', async function () {
    const held = server()
    const socket = new FakeChanges()
    await coach(held, { socket })
    await waitFor(() => held.reads.lineups >= 2, 'the digest read')
    let events = held.reads.events
    await socket.change('lineups', 'theirs')
    await waitFor(() => held.reads.events > events, 'the game read again')
    await stageChange()
    await socket.change('lineups', 'again')
    await waitFor(
      () => document.querySelector('[data-testid="Roster conflict"]') != null,
      'the warning'
    )
    events = held.reads.events
    await click('Cancel')
    await waitFor(() => held.reads.events > events, 'the game read again')
    expect(document.querySelector('[data-testid="Roster conflict"]')).equals(
      null
    )
  })

  it('lists his whole order on the Box Score before the first pitch, and the opponent’s once the game holds it', async function () {
    const boxText = async (): Promise<string> => {
      const box = document.querySelector<HTMLElement>(
        '[data-testid="Coach box score"]'
      )!
      await waitFor(
        () => (box.textContent ?? '').includes('Batting — Hawks'),
        'his order'
      )
      return box.textContent ?? ''
    }
    const inOrder = (text: string, names: string[]): void => {
      let last = -1
      for (const name of names) {
        const index = text.indexOf(name, last + 1)
        expect(index, name).greaterThan(last)
        last = index
      }
    }
    const hawks = Array.from({ length: 9 }, (unused, i) => `Hawk ${i + 1}`)
    const owls = Array.from({ length: 9 }, (unused, i) => `Owl ${i + 1}`)
    const held = server()
    await coach(held)
    const before = await boxText()
    expect(before.indexOf('The game has not started')).lessThan(
      before.indexOf('Batting — Hawks')
    )
    inOrder(before.slice(before.indexOf('Batting — Hawks')), hawks)
    // The opponent's order is only a guess at his roster until it is held.
    expect(before).not.includes('Batting — Owls')
    expect(before).not.includes('Pitching')
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    held.client.gameLineups = async () => lineups('first', true)
    await coach(held)
    const after = await boxText()
    expect(after.indexOf('Batting — Hawks')).lessThan(
      after.indexOf('Batting — Owls')
    )
    inOrder(after.slice(after.indexOf('Batting — Hawks')), [...hawks, ...owls])
  })

  it('reads the box score again as plays arrive, at most once a period', async function () {
    const held = server()
    const socket = new FakeChanges()
    await coach(held, { socket, boxScoreEveryMs: 400 })
    expect(held.reads.boxScore).equals(1)
    await socket.change('playEdits')
    await socket.change('playEdits')
    await waitFor(() => held.reads.boxScore === 2, 'a second read')
    // The second change waits out the period, and is read once.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(held.reads.boxScore).equals(2)
    await socket.emit({ type: 'resync', gameId: 'g1' })
    await waitFor(() => held.reads.boxScore === 3, 'a third read')
  })

  it('opens on the server’s plays and defaults, never the phone’s stored copy', async function () {
    const held = server()
    // The server's plays reverse his order; the phone's stored copy, older,
    // has no plays at all.
    const store = memoryStore()
    const scored = await ScoringSession.open(store, held.game.id, {
      gamePk: held.game.id,
      teams: teamsOf(held.game),
      setup: startingSetup(held.game, roster('away'), roster('home'))
    })
    const setup = setupOf(scored.resumable().state)
    setup.sides.home.battingOrder.reverse()
    const applied = scored.apply({ type: 'lineup', kind: 'roster', setup })
    expect(applied.problems, JSON.stringify(applied.problems)).deep.equals([])
    await scored.flush()
    const newer = store.games.get(held.game.id)!
    const reads: string[] = []
    const note = (name: string, options?: { storedFirst?: boolean }): void => {
      reads.push(`${name}${options?.storedFirst === true ? ':stored' : ''}`)
    }
    held.client.gameEvents = async (_gameId, options) => {
      held.reads.events++
      note('events', options)
      return options?.storedFirst === true
        ? { plays: [], currentPlay: null }
        : newer
    }
    held.client.defaultLineup = async (_teamId, options) => {
      note('default', options)
      return { lineup: null, fromGameId: null, setAt: null }
    }
    await coach(held)
    await click('Lineup', 'tab')
    const order =
      document.querySelector<HTMLElement>('[aria-label="Batting lineup"]')
        ?.textContent ?? ''
    expect(order.indexOf('Hawk 9'), 'the server’s order').greaterThan(-1)
    expect(order.indexOf('Hawk 9')).lessThan(order.indexOf('Hawk 1'))
    // Read from the server, as every open but the scoring screen's is.
    expect(reads.filter(read => read.endsWith(':stored'))).deep.equals([])
    expect(reads).includes('events')
  })

  it('says so to somebody who does not coach the team, and when the game cannot be read', async function () {
    const held = server({ coachSides: ['away'] })
    await render(
      <CoachGameScreen
        client={held.client}
        gameId="g1"
        teamId="home"
        onExit={() => undefined}
      />
    )
    await waitFor(
      () => document.body.textContent!.includes('Only a head coach'),
      'the refusal'
    )
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    const broken = server()
    broken.client.gameLineups = async () => {
      throw new Error('offline')
    }
    await render(
      <CoachGameScreen
        client={broken.client}
        gameId="g1"
        teamId="home"
        onExit={() => undefined}
      />
    )
    await waitFor(
      () => document.body.textContent!.includes('Unable to load the game'),
      'the failure'
    )
  })
})

describe('the coach’s game plan', function () {
  const cell = (row: number, inning: number): HTMLElement =>
    document.querySelector<HTMLElement>(
      `[data-testid="Plan cell ${row}-${inning}"]`
    )!
  /**
   * A value typed into a plan cell: a click that highlights it, its keys on
   * the grid that holds the focus, then the focus taken away.
   */
  async function type(
    row: number,
    inning: number,
    keys: string[]
  ): Promise<void> {
    await act(async () => {
      cell(row, inning).click()
    })
    await settle()
    const grid = document.querySelector<HTMLElement>(
      '[data-testid="Plan grid"]'
    )!
    for (const key of keys)
      await act(async () => {
        grid.dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true
          })
        )
      })
    await act(async () => {
      grid.blur()
    })
    await settle()
  }
  /** A server whose game already holds his lineup: Save waits for a change. */
  function accepted(): Server {
    const held = server()
    held.client.gameLineups = async () => {
      held.reads.lineups++
      return lineups('first', true)
    }
    held.answer = async () => lineups('mine', true)
    return held
  }
  async function plan(held: Server): Promise<void> {
    await coach(held)
    await click('Plan', 'tab')
    await waitFor(() => cell(1, 1) != null, 'the plan sheet')
  }

  for (const finish of ['Save Rosters', 'Cancel'])
    it(`reads deferred peer scoring after a plan-only ${finish}`, async () => {
      const held = accepted()
      const changes = new FakeChanges()
      await coach(held, { socket: changes })
      await click('Plan', 'tab')
      await waitFor(() => cell(1, 1) != null, 'the plan sheet')
      await type(1, 1, ['c', 'f'])
      const before = held.reads.events
      await changes.change('playEdits')
      expect(held.reads.events).equals(before)
      expect(cell(1, 1).textContent).equals('CF')
      await click(finish)
      await waitFor(() => saveDisabled(), 'the clean plan')
      await waitFor(
        () => held.reads.events > before,
        'deferred scoring refresh'
      )
      expect(held.writes).deep.equals(finish === 'Save Rosters' ? ['plan'] : [])
    })

  it('puts Plan in the pill after Defense, with its Help and no instruction or Choose Next Batter list', async function () {
    const held = server({ coachSides: ['away'] })
    held.plans = { away: { ...HOME_PLAN, teamId: 'away' }, home: null }
    await coach(held, {
      teamId: 'away',
      source: {
        open: async () => {
          // A batter is awaited: the Lineup tab lists who may be next.
          const game = copyState(gameUnderWay())
          const order = game.liveData.boxscore.teams.away.battingOrder
          game.awaitingBatter = {
            teamId: game.gameData.teams.away.id,
            dueIndex: 1,
            duePlayerId: order[1]
          }
          return ScoringSession.start(memoryStore(), 'g1', game)
        }
      }
    })
    const tabs = node('Roster', 'tab')!.parentElement!
    expect(
      [...tabs.querySelectorAll('[role="tab"]')].map(tab =>
        tab.getAttribute('aria-label')
      )
    ).deep.equals(['Roster', 'Lineup', 'Defense', 'Plan'])
    await click('Lineup', 'tab')
    expect(document.body.textContent).includes('Choose Next Batter')
    await click('Plan', 'tab')
    expect(node('Plan', 'tab')!.getAttribute('aria-selected')).equals('true')
    expect(document.body.textContent)
      .not.includes('Drag a player to change the batting order')
      .and.not.includes('Choose Next Batter')
      .and.not.includes('Tap to add to lineup.')
    expect(document.querySelector('[data-testid="Plan help"]')).not.equals(null)
    expect(document.querySelector('[data-testid="Plan sheet"]')).not.equals(
      null
    )
    // The away side's batting order, name then jersey.
    expect(
      document.querySelector('[data-testid="Plan player 1"]')!.textContent
    ).equals('Owl 1 #1')
  })

  it('closes a phone’s picker, and only that, on a tap on the tabs or the bar around the sheet', async function () {
    const originalOS = Platform.OS
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true })
    const backdrop = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        '[data-testid="Plan picker screen backdrop"]'
      )
    const picker = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-testid="Plan field picker"]')
    try {
      await plan(accepted())
      expect(backdrop()).equals(null)
      await act(async () => {
        cell(2, 3).click()
      })
      await settle()
      expect(picker()).not.equals(null)
      // Over the tabs and the footer, as the sheet's own backdrop is over
      // the sheet: a tap there closes the picker and stays on Plan.
      expect(backdrop()!.getAttribute('aria-label')).equals('Close the field')
      await act(async () => {
        backdrop()!.click()
      })
      await settle()
      expect(picker()).equals(null)
      expect(backdrop()).equals(null)
      expect(node('Plan', 'tab')!.getAttribute('aria-selected')).equals('true')
      // Gone with the sheet when the tab changes under an open picker.
      await act(async () => {
        cell(2, 3).click()
      })
      await settle()
      expect(backdrop()).not.equals(null)
      await click('Lineup', 'tab')
      expect(backdrop()).equals(null)
    } finally {
      Object.defineProperty(Platform, 'OS', {
        value: originalOS,
        configurable: true
      })
    }
  })

  it('lights Save for an edited plan and saves the plan alone, and the lineup first when both changed', async function () {
    const held = accepted()
    await plan(held)
    expect(saveDisabled()).equals(true)
    await type(1, 1, ['p'])
    expect(cell(1, 1).textContent).equals('P')
    expect(saveDisabled()).equals(false)
    // A cell put back is no change.
    await type(1, 1, ['Delete'])
    expect(saveDisabled()).equals(true)
    await type(1, 1, ['c', 'f'])
    await click('Save Rosters')
    await waitFor(() => held.savedPlans.length === 1, 'the plan saved')
    expect(held.writes).deep.equals(['plan'])
    const sent = held.savedPlans[0]
    expect(sent.innings).equals(6)
    // A plan holding a position is on.
    expect(sent.enabled).equals(true)
    expect(sent.rows.map(row => row.player.gumboId)).deep.equals([
      201, 202, 203, 204, 205, 206, 207, 208, 209
    ])
    expect(sent.rows[0].cells).deep.equals(['CF', '', '', '', '', ''])
    await waitFor(() => saveDisabled(), 'a clean plan')
    // Both changed: the lineup is saved, then the plan.
    await type(2, 2, ['p'])
    await stageChange()
    await click('Save Rosters')
    await waitFor(() => held.savedPlans.length === 2, 'the plan saved again')
    expect(held.writes).deep.equals(['plan', 'lineups', 'plan'])
    // The lineup alone: no plan is sent.
    await stageChange()
    await click('Save Rosters')
    await waitFor(() => held.writes.length === 4, 'the lineup saved')
    await settle()
    expect(held.writes).deep.equals(['plan', 'lineups', 'plan', 'lineups'])
  })

  it('saves a stored plan again after a reorder alone, its rows in the new order', async function () {
    const held = accepted()
    const hawk = (n: number): GamePlan['rows'][number]['player'] => ({
      gumboId: 200 + n,
      fullName: `Hawk ${n}`,
      jersey: String(n)
    })
    held.plans = {
      away: null,
      home: {
        ...HOME_PLAN,
        plan: {
          enabled: false,
          innings: 6,
          rows: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({
            player: hawk(n),
            cells:
              n === 3 ? ['1B', '', '', '', '', ''] : ['', '', '', '', '', '']
          }))
        }
      }
    }
    await plan(held)
    expect(saveDisabled()).equals(true)
    // Grab Hawk 3, up two, drop: he leads off.
    const third = document.querySelector<HTMLElement>(
      '[aria-label="Reorder Hawk 3"]'
    )!
    for (const key of ['Enter', 'ArrowUp', 'ArrowUp', 'Enter'])
      await act(async () => {
        third.dispatchEvent(
          new window.KeyboardEvent('keydown', { key, bubbles: true })
        )
      })
    await settle()
    expect(cell(1, 1).textContent).equals('1B')
    expect(saveDisabled()).equals(false)
    await click('Save Rosters')
    await waitFor(() => held.savedPlans.length === 1, 'the plan saved')
    expect(held.writes).deep.equals(['lineups', 'plan'])
    const sent = held.savedPlans[0]
    expect(sent.rows.map(row => row.player.gumboId)).deep.equals([
      203, 201, 202, 204, 205, 206, 207, 208, 209
    ])
    expect(sent.rows[0].cells).deep.equals(['1B', '', '', '', '', ''])
  })

  /** His plan stored with Hawk 1 to 9 in `order`, a 1B in Hawk 3's row. */
  function storedPlan(held: Server, order: number[]): void {
    held.plans = {
      away: null,
      home: {
        ...HOME_PLAN,
        plan: {
          enabled: false,
          innings: 6,
          rows: order.map(n => ({
            player: { gumboId: 200 + n, fullName: `Hawk ${n}`, jersey: `${n}` },
            cells:
              n === 3 ? ['1B', '', '', '', '', ''] : ['', '', '', '', '', '']
          }))
        }
      }
    }
  }

  it('opens clean over a plan stored before somebody else reordered the lineup, and saves it in order with his next lineup', async function () {
    const held = accepted()
    // Stored with Hawk 3 leading off; the game now bats Hawk 1 first.
    storedPlan(held, [3, 1, 2, 4, 5, 6, 7, 8, 9])
    const screen = await coach(held)
    await click('Plan', 'tab')
    await waitFor(() => cell(3, 1) != null, 'the plan sheet')
    // His plan's rows follow the game's order, Hawk 3's cells with him.
    expect(cell(3, 1).textContent).equals('1B')
    expect(saveDisabled()).equals(true)
    await click('Back')
    expect(document.body.textContent).not.includes(
      'Discard unsaved roster changes?'
    )
    expect(screen.exits()).equals(1)
    expect(held.writes).deep.equals([])
    // A lineup he does save takes the plan with it, in the order saved.
    await stageChange()
    await click('Save Rosters')
    await waitFor(() => held.savedPlans.length === 1, 'the plan saved')
    expect(held.writes).deep.equals(['lineups', 'plan'])
    expect(held.savedPlans[0].rows[1].player.gumboId).equals(203)
    expect(held.savedPlans[0].rows[1].cells[0]).equals('1B')
  })

  it('swaps a player dropped on a row after the first pitch, his plan row with him, and shows no insertion edge', async function () {
    const held = accepted()
    storedPlan(held, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    await coach(held, {
      source: {
        open: async () =>
          ScoringSession.start(memoryStore(), 'g1', gameUnderWay())
      }
    })
    await click('Plan', 'tab')
    await waitFor(() => cell(3, 1) != null, 'the plan sheet')
    // jsdom lays nothing out: each row and the sheet are told where they
    // are drawn.
    const box = (y: number, height: number): DOMRect =>
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      ({
        x: 0,
        y,
        left: 0,
        top: y,
        width: 400,
        height,
        right: 400,
        bottom: y + height
      }) as DOMRect
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[data-roster-target^="plan-"]')
    ]
    rows.forEach((row, at) => {
      row.getBoundingClientRect = () => box(100 + at * 44, 43)
    })
    document.querySelector<HTMLElement>(
      '[data-testid="Plan sheet area"]'
    )!.getBoundingClientRect = () => box(0, 600)
    rows[0].setPointerCapture = () => undefined
    rows[0].hasPointerCapture = () => false
    const pointer = async (type: string, y: number): Promise<void> => {
      const event = new window.MouseEvent(type, {
        bubbles: true,
        clientX: 60,
        clientY: y,
        button: 0
      })
      Object.defineProperties(event, {
        pointerType: { value: 'mouse' },
        pointerId: { value: 1 }
      })
      await act(async () => {
        rows[0].dispatchEvent(event)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    // Hawk 1, held over the lower half of Hawk 3's row.
    await pointer('pointerdown', 120)
    await pointer('pointermove', 160)
    await pointer('pointermove', 225)
    // Long enough for the row to show where a drop would go.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 120))
    })
    expect(
      document.querySelector('[aria-label="Lineup insertion point"]')
    ).equals(null)
    await pointer('pointerup', 225)
    await settle()
    expect(
      [1, 2, 3].map(
        n =>
          document.querySelector(`[data-testid="Plan player ${n}"]`)!
            .textContent
      )
    ).deep.equals(['Hawk 3 #3', 'Hawk 2 #2', 'Hawk 1 #1'])
    expect([cell(1, 1).textContent, cell(3, 1).textContent]).deep.equals([
      '1B',
      ''
    ])
    await click('Save Rosters')
    await waitFor(() => held.savedPlans.length === 1, 'the plan saved')
    expect(held.writes).deep.equals(['lineups', 'plan'])
    const lineup = held.saved[0]
    expect(
      lineup.battingOrder
        .slice(0, 3)
        .map(index => lineup.players[index].gumboId)
    ).deep.equals([203, 202, 201])
    expect(
      held.savedPlans[0].rows.slice(0, 3).map(row => row.player.gumboId)
    ).deep.equals([203, 202, 201])
    expect(held.savedPlans[0].rows[0].cells[0]).equals('1B')
  })

  it('stays clean when somebody else’s reorder arrives while the plan is open', async function () {
    const held = accepted()
    storedPlan(held, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const changes = new FakeChanges()
    const store = memoryStore()
    const context = (
      game: GameDetail,
      away: RosterEntry[],
      home: RosterEntry[]
    ): Parameters<typeof ScoringSession.open>[2] => ({
      gamePk: 'g1',
      teams: teamsOf(game),
      setup: startingSetup(game, away, home)
    })
    const screen = await coach(held, {
      socket: changes,
      source: {
        open: async (game, away, home) =>
          await ScoringSession.open(store, 'g1', context(game, away, home))
      }
    })
    await click('Plan', 'tab')
    await waitFor(() => cell(1, 1) != null, 'the plan sheet')
    expect(cell(3, 1).textContent).equals('1B')
    expect(saveDisabled()).equals(true)
    await waitFor(() => held.reads.lineups >= 2, 'the digest read')
    // The scorekeeper moves Hawk 3 to lead off, and says so.
    const scorekeeper = await ScoringSession.open(
      store,
      'g1',
      context(held.game, roster('away'), roster('home'))
    )
    const setup = setupOf(scorekeeper.state)
    const order = setup.sides.home.battingOrder
    setup.sides.home.battingOrder = [
      order[2],
      order[0],
      order[1],
      ...order.slice(3)
    ]
    scorekeeper.apply({
      type: 'lineup',
      kind: 'roster',
      setup,
      confirmed: ['away', 'home']
    })
    await scorekeeper.flush()
    await changes.change('lineups', 'theirs')
    await waitFor(() => cell(1, 1)?.textContent === '1B', 'his reorder')
    expect(
      document.querySelector('[data-testid="Plan player 1"]')!.textContent
    ).equals('Hawk 3 #3')
    expect(saveDisabled()).equals(true)
    await click('Back')
    expect(document.body.textContent).not.includes(
      'Discard unsaved roster changes?'
    )
    expect(screen.exits()).equals(1)
    expect(held.writes).deep.equals([])
  })

  it('says how many playing-time warnings a saved plan has', async function () {
    const held = accepted()
    held.plans = {
      away: null,
      home: {
        ...HOME_PLAN,
        rules: {
          ...DEFAULT_PLAYING_TIME_RULES,
          defensivePlayingTime: true,
          measuredIn: 'outs'
        }
      }
    }
    await plan(held)
    expect(document.body.textContent).includes('Not yet 6 defensive outs')
    await type(1, 1, ['p'])
    await type(2, 1, ['p'])
    expect(
      document.querySelector(
        '[data-testid="Plan warning red duplicatePosition"]'
      )
    ).not.equals(null)
    await click('Save Rosters')
    // Its inning 1, two pitchers and the rest blank, benches the Defense
    // tab's other fielders before the first pitch: the notice says so too.
    await waitFor(
      () =>
        document.body.textContent!.includes(
          'Saved. Defense set from the plan’s inning 1. Plan has 1 red and 1 yellow playing-time warnings.'
        ),
      'the warning notice'
    )
    expect(held.savedPlans).has.length(1)
  })

  it('restores the saved plan on Cancel, and asks before leaving an edited one', async function () {
    const held = accepted()
    held.plans = {
      away: null,
      home: {
        ...HOME_PLAN,
        plan: {
          enabled: true,
          innings: 7,
          rows: [
            {
              player: { gumboId: 201, fullName: 'Hawk 1', jersey: '1' },
              cells: ['P', 'P', '', '', '', '', '']
            }
          ]
        }
      }
    }
    await plan(held)
    expect(cell(1, 1).textContent).equals('P')
    expect(cell(1, 7)).not.equals(null)
    await type(1, 1, ['Delete'])
    expect(saveDisabled()).equals(false)
    await click('Back')
    expect(document.body.textContent).includes(
      'Discard unsaved roster changes?'
    )
    await click('Keep editing')
    await click('Cancel')
    await waitFor(() => cell(1, 1)?.textContent === 'P', 'the saved plan')
    expect(saveDisabled()).equals(true)
  })

  describe('a plan saved elsewhere while his is open', function () {
    /** Hawk 1's plan, opening at the cell given. */
    const hawkPlan = (first: PlanCell): GamePlansResponse => ({
      away: null,
      home: {
        ...HOME_PLAN,
        plan: {
          enabled: true,
          innings: 6,
          rows: [
            {
              player: { gumboId: 201, fullName: 'Hawk 1', jersey: '1' },
              cells: [first, '', '', '', '', '']
            }
          ]
        }
      }
    })
    async function opened(
      held: Server
    ): Promise<{ changes: FakeChanges; reads: () => number }> {
      let reads = 0
      held.client.gamePlans = async () => {
        reads++
        return held.plans
      }
      const changes = new FakeChanges()
      await coach(held, { socket: changes })
      await click('Plan', 'tab')
      await waitFor(() => cell(1, 1) != null, 'the plan sheet')
      return { changes, reads: () => reads }
    }

    it('reads it in under a clean plan, for his team and on a resync only', async function () {
      const held = accepted()
      held.plans = hawkPlan('P')
      const { changes, reads } = await opened(held)
      expect(cell(1, 1).textContent).equals('P')
      const before = reads()
      // The other team's save is not his.
      held.plans = hawkPlan('C')
      await changes.plans('away')
      expect(reads()).equals(before)
      expect(cell(1, 1).textContent).equals('P')
      await changes.plans('home')
      await waitFor(() => cell(1, 1)?.textContent === 'C', 'the newer plan')
      expect(saveDisabled()).equals(true)
      held.plans = hawkPlan('SS')
      await changes.emit({ type: 'resync', gameId: 'g1' })
      await waitFor(
        () => cell(1, 1)?.textContent === 'SS',
        'the plan on resync'
      )
      expect(saveDisabled()).equals(true)
      expect(held.writes).deep.equals([])
    })

    it('keeps his edits over it, saves them over it, and Cancel goes back to it', async function () {
      const held = accepted()
      held.plans = hawkPlan('P')
      const { changes } = await opened(held)
      await type(1, 2, ['s'])
      expect(saveDisabled()).equals(false)
      held.plans = hawkPlan('C')
      await changes.plans('home')
      // His draft stands: the first inning as he opened it, his edit kept.
      expect(cell(1, 1).textContent).equals('P')
      expect(cell(1, 2).textContent).equals('SS')
      expect(saveDisabled()).equals(false)
      await click('Cancel')
      await waitFor(
        () => cell(1, 1)?.textContent === 'C',
        'the newer saved plan'
      )
      expect(cell(1, 2).textContent).equals('')
      expect(saveDisabled()).equals(true)
      // Edited again over the newer plan and the plan saved elsewhere once
      // more, his Save is the one stored.
      await type(1, 2, ['l'])
      held.plans = hawkPlan('1B')
      await changes.plans('home')
      expect(cell(1, 1).textContent).equals('C')
      await click('Save Rosters')
      await waitFor(() => held.savedPlans.length === 1, 'the plan save')
      expect(held.savedPlans[0].rows[0].cells.slice(0, 2)).deep.equals([
        'C',
        'LF'
      ])
      expect(held.writes).deep.equals(['plan'])
    })
  })

  describe('his plan’s first inning, before the first pitch', function () {
    /**
     * His plan with Hawk 1 to 9 in batting order, `first` their inning 1
     * column, the rest blank: on when it holds a position, as the server
     * stores it.
     */
    function firstInning(held: Server, first: PlanCell[]): void {
      held.plans = {
        away: null,
        home: {
          ...HOME_PLAN,
          plan: {
            enabled: first.some(isPosition),
            innings: 6,
            rows: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({
              player: {
                gumboId: 200 + n,
                fullName: `Hawk ${n}`,
                jersey: `${n}`
              },
              cells: [first[n - 1] ?? '', '', '', '', '', '']
            }))
          }
        }
      }
    }
    /**
     * An inning 1 column that keeps Hawk 1 to 9 at P to RF, but for the
     * cells given, by Hawk.
     */
    const column = (changes: Record<number, PlanCell> = {}): PlanCell[] =>
      POSITIONS.map((position, at) => changes[at + 1] ?? position)
    /** Hawk 1 and 2 swapped, P and C: the rest keep their positions. */
    const SWAPPED = column({ 1: 'C', 2: 'P' })
    /**
     * Opens his screen over a game that takes each lineup save, as the
     * server's roster action does, so the game read back holds it.
     */
    async function opened(held: Server): Promise<void> {
      const games = new DevelopmentScoringSource()
      let session: ScoringSession | undefined
      const saveLineups = held.client.saveLineups.bind(held.client)
      held.client.saveLineups = async (gameId, body) => {
        const answer = await saveLineups(gameId, body)
        const game = copyState(session!.resumable().state)
        const team = game.liveData.boxscore.teams[body.side]
        for (const position of POSITIONS) {
          const index = body.defense[position]
          team.defense[position] =
            index == null ? null : (team.players[index] ?? null)
        }
        session!.apply({ type: 'lineup', kind: 'roster', setup: setupOf(game) })
        await session!.flush()
        return answer
      }
      await coach(held, {
        source: {
          open: async (game, away, home) => {
            session = await games.open(game, away, home)
            return session
          }
        }
      })
    }
    /** Who the Defense tab shows at each position, by gumbo id. */
    async function shownDefense(): Promise<Record<string, string | null>> {
      await click('Defense', 'tab')
      return Object.fromEntries(
        POSITIONS.map(position => [
          position,
          document
            .querySelector(`[data-roster-target="defense-${position}"]`)!
            .getAttribute('data-roster-player')
        ])
      )
    }
    /** Hawk 1 to 9 at P to RF, but for the positions given. */
    const fielding = (
      changes: Record<string, number> = {}
    ): Record<string, number> => ({
      ...Object.fromEntries(POSITIONS.map((position, i) => [position, i])),
      ...changes
    })

    it('starts the lineup he saves in it, and Defense shows it', async function () {
      const held = accepted()
      firstInning(held, SWAPPED)
      await opened(held)
      await click('Plan', 'tab')
      await waitFor(() => cell(1, 1) != null, 'the plan sheet')
      // An edit to a later inning, so there is something to save.
      await type(1, 2, ['p'])
      await click('Save Rosters')
      await waitFor(() => held.savedPlans.length === 1, 'the plan saved')
      expect(held.writes).deep.equals(['lineups', 'plan'])
      expect(held.saved[0].defense).deep.equals(fielding({ P: 1, C: 0 }))
      expect(held.savedPlans[0].enabled).equals(true)
      await waitFor(() => saveDisabled(), 'a clean screen')
      const shown = await shownDefense()
      expect([shown.P, shown.C, shown.RF]).deep.equals(['202', '201', '209'])
      expect(document.body.textContent).not.includes('not applied')
      expect(document.body.textContent).includes(
        'Saved. Defense set from the plan’s inning 1.'
      )
    })

    /**
     * Drags the fielder at `from` on the Defense tab onto `to`. jsdom lays
     * nothing out, so only `to` is drawn under the pointer.
     */
    async function moveFielder(from: string, to: string): Promise<void> {
      await click('Defense', 'tab')
      const source = document.querySelector(
        `[data-roster-target="defense-${from}"]`
      )!
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const original = HTMLElement.prototype.getBoundingClientRect
      HTMLElement.prototype.getBoundingClientRect = function () {
        const target = this.getAttribute('data-roster-target')
        const x = target == null ? 0 : target === `defense-${to}` ? 200 : -1000
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        return {
          x,
          y: 0,
          left: x,
          top: 0,
          right: x + 400,
          bottom: 800,
          width: 400,
          height: 800
        } as DOMRect
      }
      try {
        for (const [type, x] of [
          ['pointerdown', 0],
          ['pointermove', 250],
          ['pointerup', 250]
        ] as const)
          await act(async () => {
            const event = new window.MouseEvent(type, {
              bubbles: true,
              button: 0,
              clientX: x,
              clientY: 10
            })
            Object.defineProperty(event, 'pointerId', { value: 1 })
            source.dispatchEvent(event)
            await new Promise(resolve =>
              setTimeout(resolve, type === 'pointerdown' ? 520 : 20)
            )
          })
      } finally {
        HTMLElement.prototype.getBoundingClientRect = original
      }
    }

    it('says when his inning 1 puts someone else where he moved a fielder on Defense', async function () {
      const held = server()
      // Hawk 5 plays shortstop in inning 1; Hawk 4 sits.
      firstInning(held, column({ 4: '', 5: 'SS' }))
      await opened(held)
      // He moves Hawk 4 from second to short, Hawk 5 to second.
      await moveFielder('2B', 'SS')
      const moved = await shownDefense()
      expect([moved['2B'], moved.SS]).deep.equals(['205', '204'])
      await click('Save Rosters')
      await waitFor(() => held.saved.length === 1, 'the lineup saved')
      // Hawk 5 is saved at short, as the plan has him; Hawk 4 leaves it.
      const { '2B': second, ...rest } = fielding()
      expect(second).equals(3)
      expect(held.saved[0].defense).deep.equals(rest)
      await waitFor(
        () =>
          document.body.textContent!.includes(
            'Saved. Defense set from the plan’s inning 1.'
          ),
        'the notice'
      )
    })

    it('says when his inning 1 benches a fielder the Defense tab has, leaving his position empty', async function () {
      const held = server()
      // Hawk 4, at second on Defense, sits inning 1, and nobody takes second.
      firstInning(held, column({ 4: '' }))
      await opened(held)
      await click('Save Rosters')
      await waitFor(() => held.saved.length === 1, 'the lineup saved')
      const { '2B': second, ...rest } = fielding()
      expect(second).equals(3)
      expect(held.saved[0].defense).deep.equals(rest)
      await waitFor(
        () =>
          document.body.textContent!.includes(
            'Saved. Defense set from the plan’s inning 1.'
          ),
        'the notice'
      )
    })

    it('says his inning 1 set the defence beside the plan’s warnings', async function () {
      const held = accepted()
      firstInning(held, column({ 4: '', 5: 'SS' }))
      held.plans.home = {
        ...held.plans.home!,
        rules: {
          ...DEFAULT_PLAYING_TIME_RULES,
          defensivePlayingTime: true,
          measuredIn: 'outs'
        }
      }
      await opened(held)
      await moveFielder('2B', 'SS')
      await click('Plan', 'tab')
      await waitFor(() => cell(1, 1) != null, 'the plan sheet')
      await type(9, 2, ['l'])
      await click('Save Rosters')
      await waitFor(() => held.savedPlans.length === 1, 'the plan saved')
      await waitFor(
        () =>
          /Saved\. Defense set from the plan’s inning 1\. Plan has .+ playing-time warnings?\./.test(
            document.body.textContent!
          ),
        'the notice'
      )
    })

    it('says nothing of his inning 1 when it agrees with his Defense edit', async function () {
      const held = server()
      firstInning(held, column({ 4: 'SS', 5: '2B' }))
      await opened(held)
      await moveFielder('2B', 'SS')
      await click('Save Rosters')
      await waitFor(() => held.saved.length === 1, 'the lineup saved')
      expect(held.saved[0].defense).deep.equals(fielding({ '2B': 4, SS: 3 }))
      await settle()
      expect(document.body.textContent).not.includes('Defense set from')
    })

    it('keeps the Defense tab’s defence for a plan with no position in it', async function () {
      const held = server()
      firstInning(
        held,
        column().map((): PlanCell => '')
      )
      await opened(held)
      await click('Save Rosters')
      await waitFor(() => held.saved.length === 1, 'the lineup saved')
      expect(held.saved[0].defense).deep.equals(fielding())
      await settle()
      expect(held.writes).deep.equals(['lineups'])
    })

    it('leaves the defence alone once the game is under way', async function () {
      const held = accepted()
      firstInning(held, SWAPPED)
      await coach(held, {
        source: {
          open: async () =>
            ScoringSession.start(memoryStore(), 'g1', gameUnderWay())
        }
      })
      await click('Plan', 'tab')
      await waitFor(() => cell(1, 1) != null, 'the plan sheet')
      await type(1, 2, ['s'])
      await click('Save Rosters')
      await waitFor(() => held.savedPlans.length === 1, 'the plan saved')
      await settle()
      // The plan alone: no lineup with its first inning is saved.
      expect(held.writes).deep.equals(['plan'])
      const shown = await shownDefense()
      expect([shown.P, shown.C]).deep.equals(['201', '202'])
    })

    it('does not start a column that leaves nobody pitching, and says so', async function () {
      const held = server()
      // Hawk 1 leaves the mound to catch, and nobody takes it.
      firstInning(held, column({ 1: 'C', 2: '1B', 3: '' }))
      await opened(held)
      await click('Save Rosters')
      await waitFor(() => held.saved.length === 1, 'the lineup saved')
      expect(held.saved[0].defense).deep.equals(fielding())
      await waitFor(
        () =>
          document.body.textContent!.includes(
            'Saved. Inning 1 plan not applied: needs a pitcher.'
          ),
        'the notice'
      )
      const shown = await shownDefense()
      expect([shown.P, shown.C]).deep.equals(['201', '202'])
    })

    it('says so beside the plan’s warnings', async function () {
      const held = accepted()
      firstInning(held, column({ 1: 'C', 2: '1B', 3: '' }))
      held.plans.home = {
        ...held.plans.home!,
        rules: {
          ...DEFAULT_PLAYING_TIME_RULES,
          defensivePlayingTime: true,
          measuredIn: 'outs'
        }
      }
      await opened(held)
      await click('Plan', 'tab')
      await waitFor(() => cell(1, 1) != null, 'the plan sheet')
      await type(2, 2, ['c'])
      await click('Save Rosters')
      await waitFor(() => held.savedPlans.length === 1, 'the plan saved')
      expect(held.writes).deep.equals(['plan'])
      await waitFor(
        () =>
          /Saved\. Inning 1 plan not applied: needs a pitcher\. Plan has .+ playing-time warnings?\./.test(
            document.body.textContent!
          ),
        'the notice'
      )
    })
  })

  it('drops a reread of his plan sent before his save and answered after it', async function () {
    const held = accepted()
    const older = held.plans
    // The reread is read before his save commits, and answers after it.
    let answer: (() => void) | undefined
    let reads = 0
    held.client.gamePlans = async () => {
      reads++
      if (reads === 1) return held.plans
      return await new Promise(resolve => {
        answer = () => {
          resolve(older)
        }
      })
    }
    const changes = new FakeChanges()
    await coach(held, { socket: changes })
    await click('Plan', 'tab')
    await waitFor(() => cell(1, 1) != null, 'the plan sheet')
    await changes.plans('home')
    expect(answer).not.equals(undefined)
    await type(1, 2, ['s'])
    await click('Save Rosters')
    await waitFor(() => held.savedPlans.length === 1, 'the plan saved')
    await waitFor(() => saveDisabled(), 'a clean plan')
    await act(async () => {
      answer!()
    })
    await settle()
    // The plan he saved stands, clean: the older answer is not his base.
    expect(cell(1, 2).textContent).equals('SS')
    expect(saveDisabled()).equals(true)
  })

  it('keeps the edited plan when its save fails, and says so', async function () {
    const held = accepted()
    held.client.saveGamePlan = async () => {
      throw new Error('offline')
    }
    await plan(held)
    await type(3, 2, ['s'])
    await click('Save Rosters')
    await waitFor(
      () => document.body.textContent!.includes('Unable to save the lineup'),
      'the failure'
    )
    expect(cell(3, 2).textContent).equals('SS')
    expect(saveDisabled()).equals(false)
  })

  it('says the plan could not be read, and saves none', async function () {
    const held = accepted()
    held.client.gamePlans = async () => {
      throw new Error('offline')
    }
    await coach(held)
    await click('Plan', 'tab')
    expect(document.body.textContent).includes(
      'Unable to load the game plan. Please try again.'
    )
    expect(cell(1, 1)).equals(null)
    expect(saveDisabled()).equals(true)
  })
})

describe('a game swapped under the coach screen', function () {
  // The Shell reads the account's chat age on mount: confirmed here.
  confirmedChatAgeHooks()
  /** The game after the swap: the Owls at home, his Hawks away. */
  const swappedGame = (held: Server): GameDetail => ({
    ...held.game,
    homeTeamId: 'away',
    awayTeamId: 'home',
    homeTeamName: 'Owls',
    awayTeamName: 'Hawks',
    coachSides: ['away']
  })
  const swappedLineups = (digest: string): GameLineupsResponse => {
    const read = lineups(digest, true)
    return {
      home: { ...read.away },
      away: { ...read.home },
      digest
    }
  }
  const notice = async (changes: FakeChanges): Promise<void> => {
    await changes.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'game',
      at: '2026-10-23T12:00:00Z',
      data: {
        status: 'scheduled',
        awayScore: null,
        homeScore: null,
        homeTeamId: 'away',
        awayTeamId: 'home'
      }
    })
  }

  for (const recorded of [false, true])
    it(`saves his lineup and adds his guest on his team’s new side, ${recorded ? 'with' : 'without'} a record`, async function () {
      const held = server()
      const changes = new FakeChanges()
      const store = memoryStore()
      const context = (
        game: GameDetail,
        away: RosterEntry[],
        home: RosterEntry[]
      ): Parameters<typeof ScoringSession.open>[2] => ({
        gamePk: 'g1',
        teams: teamsOf(game),
        setup: startingSetup(game, away, home)
      })
      if (recorded) {
        const seed = await ScoringSession.open(
          store,
          'g1',
          context(held.game, roster('away'), roster('home'))
        )
        seed.apply({
          type: 'lineup',
          kind: 'roster',
          setup: setupOf(seed.state),
          confirmed: ['away', 'home']
        })
        await seed.flush()
      }
      let opens = 0
      await coach(held, {
        socket: changes,
        source: {
          open: async (game, away, home) => {
            opens++
            return await ScoringSession.open(
              store,
              'g1',
              context(game, away, home)
            )
          }
        }
      })
      expect(opens).equals(1)

      held.game = swappedGame(held)
      held.client.gameLineups = async () => swappedLineups('swapped')
      if (recorded) {
        const stored = store.games.get('g1')!
        store.games.set('g1', {
          ...stored,
          currentPlay: {
            ...stored.currentPlay!,
            teamStation: (stored.currentPlay as { teamStation?: unknown })
              .teamStation
          }
        })
      }
      await notice(changes)
      await waitFor(() => opens === 2, 'the game read again')
      await waitFor(() => node('Save Rosters') != null, 'the roster screen')

      const guests: unknown[] = []
      held.client.createGuestPlayer = async (gameId, side, player) => {
        guests.push({ gameId, side, player })
        return {
          ...roster('home')[0],
          userId: userIdOfGumbo(9000002),
          gumboId: 9000002,
          shortName: 'Hawks G'
        }
      }
      await click('Create Player')
      await click('Create Placeholder Player')
      await click('Create')
      expect(guests).has.length(1)
      expect(guests[0]).includes({ gameId: 'g1', side: 'away' })

      held.answer = async () => swappedLineups('mine')
      await click('Save Rosters')
      await waitFor(() => held.saved.length === 1, 'the saved lineup')
      expect(held.saved[0].side).equals('away')
      expect(held.saved[0].players.map(player => player.gumboId)).includes(201)
    })

  it('asks before reading the game again over a staged change', async function () {
    const held = server()
    const changes = new FakeChanges()
    let opens = 0
    const games = new DevelopmentScoringSource()
    await coach(held, {
      socket: changes,
      source: {
        open: async (game, away, home) => {
          opens++
          return await games.open(game, away, home)
        }
      }
    })
    await stageChange()
    held.game = swappedGame(held)
    await notice(changes)
    await waitFor(
      () => document.body.textContent!.includes('Home and away were swapped'),
      'the swap notice'
    )
    expect(opens).equals(1)
    await click('Read the game again')
    await waitFor(() => opens === 2, 'the game read again')
    expect(document.body.textContent).not.includes('Home and away were swapped')
  })

  it('follows a reset: a clean screen reads the game again, and a staged change is asked about first (A9)', async function () {
    const held = server()
    const changes = new FakeChanges()
    let opens = 0
    const games = new DevelopmentScoringSource()
    await coach(held, {
      socket: changes,
      source: {
        open: async (game, away, home) => {
          opens++
          return await games.open(game, away, home)
        }
      }
    })
    const reset = async (generation: number): Promise<void> => {
      held.game = { ...held.game, generation }
      await changes.emit({
        type: 'change',
        gameId: 'g1',
        kind: 'game',
        at: '2026-10-24T12:00:00Z',
        data: {
          status: 'scheduled',
          awayScore: null,
          homeScore: null,
          homeTeamId: held.game.homeTeamId,
          awayTeamId: held.game.awayTeamId,
          generation
        }
      })
    }
    await reset(1)
    await waitFor(() => opens === 2, 'the game read again')
    await stageChange()
    await reset(2)
    await waitFor(
      () => document.body.textContent!.includes('This game was reset.'),
      'the reset notice'
    )
    expect(document.body.textContent).includes(
      'Your unsaved changes are for the plays it deleted'
    )
    expect(opens).equals(2)
    await click('Read the game again')
    await waitFor(() => opens === 3, 'the game read again')
    expect(document.body.textContent).not.includes('This game was reset.')
  })

  /**
   * A source over a game kept in memory with a saved lineup, giving the
   * context for the game's teams as `held` now has them, as the server
   * source does.
   */
  async function recorded(held: Server): Promise<{
    source: NonNullable<React.ComponentProps<typeof CoachGameScreen>['source']>
    opens: () => number
    swap: () => void
  }> {
    const store = memoryStore()
    const context = (
      game: GameDetail,
      away: RosterEntry[],
      home: RosterEntry[]
    ): Parameters<typeof ScoringSession.open>[2] => ({
      gamePk: 'g1',
      teams: teamsOf(game),
      setup: startingSetup(game, away, home)
    })
    const seed = await ScoringSession.open(
      store,
      'g1',
      context(held.game, roster('away'), roster('home'))
    )
    seed.apply({
      type: 'lineup',
      kind: 'roster',
      setup: setupOf(seed.state),
      confirmed: ['away', 'home']
    })
    await seed.flush()
    let opens = 0
    return {
      opens: () => opens,
      source: {
        open: async (game, away, home) => {
          opens++
          return await ScoringSession.open(
            {
              load: async id => ({
                ...(await store.load(id)),
                context: context(
                  held.game,
                  roster(held.game.awayTeamId),
                  roster(held.game.homeTeamId)
                )
              }),
              save: async (id, change) => await store.save(id, change)
            },
            'g1',
            context(game, away, home)
          )
        }
      },
      swap: () => {
        held.game = swappedGame(held)
        held.client.gameLineups = async () => swappedLineups('swapped')
        const stored = store.games.get('g1')!
        store.games.set('g1', {
          ...stored,
          currentPlay: {
            ...stored.currentPlay!,
            teamStation: (stored.currentPlay as { teamStation?: unknown })
              .teamStation
          }
        })
      }
    }
  }

  it('reads the game again when a swap made while the socket was down comes to light on resync', async function () {
    const held = server()
    const changes = new FakeChanges()
    const game = await recorded(held)
    await coach(held, { socket: changes, source: game.source })
    expect(game.opens()).equals(1)
    game.swap()
    await changes.emit({ type: 'resync', gameId: 'g1' })
    await waitFor(() => game.opens() === 2, 'the game read again')
    // Once, though the resync's read and its lineup reload both found it.
    await settle()
    expect(game.opens()).equals(2)
  })

  it('reads the game again when a lineup reload finds another generation, the sides as they were (A9)', async function () {
    const held = server()
    const changes = new FakeChanges()
    const game = await recorded(held)
    await coach(held, { socket: changes, source: game.source })
    await waitFor(() => held.reads.lineups >= 2, 'the digest read')
    expect(game.opens()).equals(1)
    // A reset's lineups notice, before its game notice: the lineups read
    // names the next generation.
    const read = held.client.gameLineups.bind(held.client)
    held.client.gameLineups = async gameId => ({
      ...(await read(gameId)),
      generation: (held.game.generation ?? 0) + 1
    })
    await changes.change('lineups', 'reset')
    await waitFor(() => game.opens() === 2, 'the game read again')
  })

  it('hands a lineup change read after a swap to the swap, never his old side', async function () {
    const held = server()
    const changes = new FakeChanges()
    const game = await recorded(held)
    await coach(held, { socket: changes, source: game.source })
    await waitFor(() => held.reads.lineups >= 2, 'the digest read')
    await stageChange()
    game.swap()
    // The lineups notice arrives before the game's: the staged change is
    // warned over, and Cancel reads the game again.
    await changes.change('lineups', 'swapped')
    await waitFor(
      () => document.querySelector('[data-testid="Roster conflict"]') != null,
      'the warning'
    )
    await click('Cancel')
    await waitFor(
      () =>
        game.opens() === 2 ||
        document.body.textContent!.includes('Home and away were swapped'),
      'the swap taken up'
    )
    expect(held.saved).deep.equals([])
  })
})

describe('a coach’s lineup save', function () {
  // The Shell reads the account's chat age on mount: confirmed here.
  confirmedChatAgeHooks()
  const game = createDevelopmentSession(
    gameFixture,
    roster('away'),
    roster('home')
  )

  it('names each player by who he is, and indexes into them', function () {
    const draft = copyState(game)
    const team = draft.liveData.boxscore.teams.away
    const [first, second] = team.battingOrder
    const body = lineupsBody(draft, 'away', 'd1', second, [
      { base: '2B', player: first },
      // Not his side's: left out.
      { base: '1B', player: draft.liveData.boxscore.teams.home.players[0] }
    ])
    expect(body.side).equals('away')
    expect(body.base).equals('d1')
    expect(body.players[0]).deep.equals({
      gumboId: 101,
      fullName: draft.gameData.players[team.players[0]].fullName,
      jersey: '1'
    })
    expect(body.nextBatter).equals(team.players.indexOf(second))
    expect(body.runners).deep.equals([
      { base: '2B', player: team.players.indexOf(first) }
    ])
    // The other side's batter due is not this side's to name.
    const other = lineupsBody(
      draft,
      'home',
      'd1',
      draft.liveData.boxscore.teams.away.battingOrder[0]
    )
    expect(other.nextBatter).equals(undefined)
    expect(other.runners).equals(undefined)
  })

  it('lists each side’s batting order by who bats, for the box score', function () {
    const draft = copyState(game)
    const made = addDevelopmentPlayer(draft, 'home', 9000000, 'Made Up')
    draft.liveData.boxscore.teams.home.battingOrder.push(made)
    const accounts = [...roster('away'), ...roster('home')].map(row => ({
      ...row,
      userId: userIdOfGumbo(row.gumboId! + 1000)
    }))
    const orders = battingOrders(draft, ['away', 'home'], accounts)
    expect(orders.away!.map(batter => batter.userId)).deep.equals([
      ...[1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109].map(
        userIdOfGumbo
      )
    ])
    expect(orders.away![0]).deep.equals({
      userId: userIdOfGumbo(1101),
      shortName: 'Owl 1',
      gumboId: 101
    })
    expect(orders.home).has.length(10)
    expect(orders.home![9]).deep.equals({
      userId: null,
      shortName: 'Made Up',
      gumboId: made
    })
    // One side's alone.
    expect(Object.keys(battingOrders(draft, ['home']))).deep.equals(['home'])
  })
})

describe('the Coach Game pill', function () {
  // The Shell reads the account's chat age on mount: confirmed here.
  confirmedChatAgeHooks()
  this.timeout(20000)

  async function gameScreen(
    coachSides: Array<'away' | 'home'>
  ): Promise<string[]> {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => ({
      ...gameFixture,
      canScore: false,
      coachSides,
      assignedRoles: { away: ['coach'], home: ['coach'] }
    })
    client.teams = async () => []
    client.boxScore = async () => ({
      batting: [],
      pitching: [],
      stats: undefined
    })
    const opened: string[] = []
    await render(
      <GameScreen
        signedIn
        client={client}
        gameId="g1"
        initialTab="boxScore"
        onCoachGame={teamId => {
          opened.push(teamId)
        }}
      />
    )
    return opened
  }

  it('opens a head coach’s one team straight away', async function () {
    const opened = await gameScreen(['away'])
    await click('Coach')
    expect(opened).deep.equals(['away'])
  })

  it('asks a head coach of both teams which to coach', async function () {
    const opened = await gameScreen(['away', 'home'])
    await click('Coach')
    expect(opened).deep.equals([])
    expect(document.body.textContent).includes('Coach which team?')
    await click('Hawks')
    expect(opened).deep.equals(['home'])
  })
})

describe('Coach Game in the app', function () {
  // The Shell reads the account's chat age on mount: confirmed here.
  confirmedChatAgeHooks()
  this.timeout(30000)

  function fixtureFetch(): void {
    globalThis.fetch = async input => {
      const path = (
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      ).split('?')[0]
      const data = path.endsWith('/auth/me')
        ? { id: userIdOfGumbo(100), displayName: 'Coach', isAdmin: false }
        : path.endsWith('/games/g1/events')
          ? { plays: [], currentPlay: null }
          : path.endsWith('/games/g1/lineups')
            ? lineups('first', false)
            : path.endsWith('/games/g1/box-score')
              ? { batting: [], pitching: [] }
              : path.endsWith('/games/g1')
                ? {
                    ...gameFixture,
                    canScore: false,
                    coachSides: ['home'],
                    assignedRoles: { away: [], home: ['coach'] }
                  }
                : path.endsWith('/default-lineup')
                  ? { lineup: null, fromGameId: null, setAt: null }
                  : path.endsWith('/health')
                    ? NO_DICTATION
                    : path.endsWith('/roster')
                      ? roster(path.includes('/away/') ? 'away' : 'home')
                      : path.endsWith('/live-streams')
                        ? { streams: [] }
                        : []
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  it('opens full screen from the game’s pill, and Back returns to its Box score tab', async function () {
    fixtureFetch()
    showRoute({ name: 'game', gameId: 'g1' }, true)
    await render(<App />)
    await waitFor(() => node('Coach') != null, 'the button')
    await click('Coach')
    expect(currentRoute()).include({
      name: 'coachGame',
      gameId: 'g1',
      teamId: 'home'
    })
    await waitFor(() => node('Save Rosters') != null, 'the roster screen')
    // Its own header, not the app's: no app navigation either.
    expect(node('Schedule')).equals(null)
    await click('Back')
    await settle()
    expect(currentRoute()).include({
      name: 'game',
      gameId: 'g1',
      tab: 'boxScore'
    })
    expect(node('Box score', 'tab')?.getAttribute('aria-selected')).equals(
      'true'
    )
  })

  it('opens from its own address over the game’s Box score', async function () {
    fixtureFetch()
    showRoute({ name: 'coachGame', gameId: 'g1', teamId: 'home' }, true)
    await render(<App />)
    await waitFor(() => node('Save Rosters') != null, 'the roster screen')
    await click('Back')
    await settle()
    expect(currentRoute()).include({ name: 'game', tab: 'boxScore' })
  })
})
