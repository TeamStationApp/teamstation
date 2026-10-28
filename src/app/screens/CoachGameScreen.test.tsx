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
  type Health,
  type Lineup,
  type RosterEntry,
  type SaveLineupsBody,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type { GameSocketEvent } from '../../common/gameSocket'
import {} from '../../common/scoring/gumbo'
import { ScoringSession } from '../../common/scoring/session'
import {
  copyState,
  type GameState,
  POSITIONS,
  setupOf
} from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import {
  dictatingHealth,
  type FakeDictation,
  fakeDictation
} from '../../test/dictationFakes'
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

/** The server, as the screen asks it things: what it was asked, and sent. */
interface Server {
  client: TeamStationClient
  saved: SaveLineupsBody[]
  reads: { events: number; boxScore: number; lineups: number }
  game: GameDetail
  answer: (body: SaveLineupsBody) => Promise<GameLineupsResponse>
}
function server(game: Partial<GameDetail> = {}): Server {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const held: Server = {
    client,
    saved: [],
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
    return await held.answer(body)
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

  async change(kind: 'lineups' | 'plays', digest = ''): Promise<void> {
    const event = {
      type: 'change',
      gameId: 'g1',
      kind,
      at: '2026-10-12T12:00:00Z',
      data: { digest }
    }
    await this.emit(event as unknown as GameSocketEvent)
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
  it('disables availability switches until the lineup save finishes refreshing', async () => {
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
    expect(toggle().disabled).equals(true)
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

  it('draws its own chevron and his team’s name on the right, over Box Score, Roster, Lineup and Defense', async function () {
    const held = server()
    await coach(held)
    expect(node('Back', 'button')).not.equals(null)
    const header = document.querySelector<HTMLElement>(
      '[data-testid="Coach header"] [role="heading"]'
    )!
    expect(header.textContent).equals('Hawks')
    expect(getComputedStyle(header).textAlign).equals('right')
    for (const tab of ['Box', 'Roster', 'Lineup', 'Defense'])
      expect(node(tab, 'tab'), tab).not.equals(null)
    expect(node('Box', 'tab')!.getAttribute('aria-selected')).equals('true')
    // His own team alone.
    expect(node('Away Team')).equals(null)
    expect(node('Home Team')).equals(null)
    expect(held.reads.boxScore).equals(1)
    // The game holds no lineup for his side yet: Save is lit as it stands.
    expect(saveDisabled()).equals(false)
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

  it('saves a staged pinch runner onto a clean draft, and keeps the chat when the save is refused', async function () {
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
    expect(node('Dictation chat')).not.equals(null)
    expect(saveDisabled()).equals(false)
    held.answer = async () => {
      savedLineup = true
      return lineups('saved', true)
    }
    await click('Save Rosters')
    await waitFor(() => saveDisabled(), 'a clean draft')
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
    await socket.change('plays')
    await socket.change('plays')
    await waitFor(() => held.reads.boxScore === 2, 'a second read')
    // The second change waits out the period, and is read once.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(held.reads.boxScore).equals(2)
    await socket.emit({ type: 'resync', gameId: 'g1' })
    await waitFor(() => held.reads.boxScore === 3, 'a third read')
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

describe('a game swapped under the coach screen', function () {
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
