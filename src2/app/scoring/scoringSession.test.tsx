import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGameDetail,
  asRosterEntry,
  GameStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  applyAction,
  ScoringSession as GameSession
} from '../../common/scoring/session'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  createDevelopmentSession,
  startingSetup,
  teamsOf
} from './developmentSession'
import { CORRECTION_INSTRUCTION } from './InstructionToast'
import { gameFixture } from './isUnscoredGame.test'
import { scoringPreferences } from './scoringPreferences'
import { scoringPreferences as nativePreferences } from './scoringPreferences.native'
import { saveStatusText, ScoringScreen } from './ScoringScreen'
import {
  DevelopmentScoringSource,
  memoryStore,
  type ScoringSource,
  ServerScoringSource
} from './scoringSource'

let root: Root | undefined
// Host replacement is limited to WebGL; controls, state and preferences are real.
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
}
async function mount(
  client: GameStationClient,
  source?: ScoringSource
): Promise<void> {
  await unmount()
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <ScoringScreen
          client={client}
          gameId="g1"
          userId="scorer"
          onExit={() => undefined}
          source={source}
        />
      </ThemeProvider>
    )
  })
}
async function click(label: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(element, label).not.equals(null)
  await act(async () => {
    element?.click()
  })
}
function clientForSwitchHitter(
  bats: 'switch' | 'left' | 'right' = 'switch'
): GameStationClient {
  const client = new GameStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.roster = async team =>
    team === 'away'
      ? [
          asRosterEntry({
            userId: 101,
            shortName: 'Jordan K.',
            jersey: '00',
            positions: ['P'],
            isPlayer: true,
            role: 'member',
            bats
          })
        ]
      : []
  return client
}
afterEach(async function () {
  await unmount()
  HTMLCanvasElement.prototype.getContext = getContext
})
describe('local scoring controls', function () {
  it('uses the game identity, records pitches and rewinds count and pitch count', async function () {
    await mount(clientForSwitchHitter())
    expect(document.body.textContent).includes('Owls 0 · Hawks 0 · Top 1st')
    await click('OK')
    await click('Ball')
    await click('Called Strike')
    await click('Foul Ball')
    expect(document.body.textContent).includes(
      '1 balls 2 strikes 0 outs · Pitches 3'
    )
    await click('Undo Foul Ball')
    await click('Undo Called Strike')
    await click('Undo Ball')
    expect(document.body.textContent).includes(
      '0 balls 0 strikes 0 outs · Pitches 0'
    )
  })
  it('shows help three times per user/device, counts when shown, and honors disable/reset', async function () {
    const client = clientForSwitchHitter()
    for (let appearance = 1; appearance <= 3; appearance++) {
      await mount(client)
      expect(document.body.textContent).includes('Drag hitter to other box')
      expect((await scoringPreferences.read('scorer')).shown).equals(appearance)
      await click('OK')
      expect(document.querySelector('[aria-label="OK"]')).equals(null)
    }
    await mount(client)
    expect(document.querySelector('[aria-label="OK"]')).equals(null)
    await scoringPreferences.write('scorer', { help: false, shown: 0 })
    await mount(client)
    expect(document.querySelector('[aria-label="OK"]')).equals(null)
    await scoringPreferences.write('scorer', { help: true, shown: 0 })
    await mount(client)
    expect(document.querySelector('[aria-label="OK"]')).not.equals(null)
    await click('Ball')
    expect(document.querySelector('[aria-label="OK"]')).equals(null)
  })
  it('reserves the limited batting-side tutorial for switch profiles', async function () {
    for (const side of ['left', 'right'] as const) {
      await scoringPreferences.write('scorer', { help: true, shown: 0 })
      await mount(clientForSwitchHitter(side))
      expect(document.querySelector('[aria-label="OK"]')).equals(null)
      expect((await scoringPreferences.read('scorer')).shown).equals(0)
    }
  })
  it('keeps real team names when roster reads fail and supports a failing replaceable source', async function () {
    const client = clientForSwitchHitter()
    client.roster = async () => {
      throw new Error('unavailable')
    }
    let fail = true
    const store = memoryStore()
    const save = store.save
    store.save = async (gameId, change) => {
      if (fail) throw new HttpError('offline', 'The request never left')
      return await save(gameId, change)
    }
    const source: ScoringSource = {
      open: async (game, away, home) => {
        expect(away).deep.equals([])
        expect(home).deep.equals([])
        return GameSession.start(
          store,
          game.id,
          createDevelopmentSession(game, away, home)
        )
      }
    }
    await mount(client, source)
    expect(document.body.textContent).includes('Owls 0 · Hawks 0')
    expect(document.querySelector('[aria-label="Save status"]')).equals(null)
    await click('Ball')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(
      document.querySelector('[aria-label="Save status"]')?.textContent
    ).equals('Offline — 1 play waiting')
    fail = false
    await click('Ball')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(document.querySelector('[aria-label="Save status"]')).equals(null)
    expect(store.games.get('g1')?.currentPlay).not.equals(null)
    await mount(client, {
      open: async () => {
        throw new Error('bad state')
      }
    })
    expect(document.body.textContent).includes('Unable to load scoring.')
  })
  it('runs the native preference adapter through its platform storage implementation', async function () {
    await nativePreferences.write('native-test', { help: false, shown: 2 })
    expect(await nativePreferences.read('native-test')).deep.equals({
      help: false,
      shown: 2
    })
  })
})

describe('saving from the scoring screen', function () {
  it('says what the save is doing in one line', function () {
    const base = { pending: 0, offline: false, readOnly: false, problem: null }
    expect(saveStatusText(base)).equals(null)
    expect(saveStatusText({ ...base, pending: 2 })).equals('Saving…')
    expect(saveStatusText({ ...base, pending: 1, offline: true })).equals(
      'Offline — 1 play waiting'
    )
    expect(saveStatusText({ ...base, pending: 3, offline: true })).equals(
      'Offline — 3 plays waiting'
    )
    expect(
      saveStatusText({ ...base, pending: 1, problem: 'play 0: bad' })
    ).equals('Not saved: play 0: bad')
    expect(saveStatusText({ ...base, readOnly: true, problem: 'No' })).equals(
      null
    )
  })

  it('goes read-only with the server’s reason when a save is refused', async function () {
    const store = memoryStore()
    store.save = async () => {
      throw new HttpError(
        'forbidden',
        'Only someone who can score this game may change its plays'
      )
    }
    const source: ScoringSource = {
      open: async game =>
        GameSession.start(
          store,
          game.id,
          createDevelopmentSession(game, [], [])
        )
    }
    await mount(clientForSwitchHitter('right'), source)
    await click('Ball')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    const overlay = document.querySelector(
      '[aria-label="Scoring is read-only"]'
    )
    expect(overlay?.textContent).includes(
      'Only someone who can score this game may change its plays'
    )
    // The refused ball is not shown as scored, and nothing more can be.
    expect(document.body.textContent).includes('0 balls')
    expect(document.body.textContent).not.includes('1 balls')
    for (const label of ['Ball', 'Called Strike', 'Swing in Play']) {
      const control = document.querySelector(`[aria-label="${label}"]`)
      expect(
        control?.getAttribute('aria-disabled') === 'true' ||
          (control as { disabled?: boolean } | null)?.disabled === true,
        label
      ).equals(true)
    }
    expect(document.querySelector('[aria-label="Undo Last play"]')).equals(null)
    // The game menu still leaves, but changes nothing.
    await click('Open scoring menu')
    for (const label of [
      'Overrides',
      'End Half Inning',
      'Set Team Rosters',
      'End Game'
    ])
      expect(
        document
          .querySelector(`[aria-label="${label}"]`)
          ?.getAttribute('aria-disabled'),
        label
      ).equals('true')
    expect(
      document
        .querySelector('[aria-label="Exit Current Game"]')
        ?.getAttribute('aria-disabled')
    ).not.equals('true')
  })

  it('offers nothing to finish once a refused Done makes the screen read-only', async function () {
    const store = memoryStore()
    store.save = async () => {
      throw new HttpError('forbidden', 'Not yours')
    }
    const source: ScoringSource = {
      open: async game => {
        let decided = createDevelopmentSession(game, [], [])
        for (const action of [
          { type: 'ballInPlay', contact: 'swing' },
          { type: 'result', eventType: 'single' }
        ] as const)
          decided = applyAction(decided, action).state
        return GameSession.start(store, game.id, decided)
      }
    }
    await mount(clientForSwitchHitter('right'), source)
    expect(document.body.textContent).includes(CORRECTION_INSTRUCTION)
    await click('Finish at-bat')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(
      document.querySelector('[aria-label="Scoring is read-only"]')
    ).not.equals(null)
    expect(document.querySelector('[aria-label="Finish at-bat"]')).equals(null)
    expect(document.body.textContent).not.includes(CORRECTION_INSTRUCTION)
  })

  it('reads the game from the server on the way into the rosters', async function () {
    const store = memoryStore()
    const client = clientForSwitchHitter('right')
    const source: ScoringSource = {
      persistent: true,
      open: async (game, away, home) =>
        await GameSession.open(store, game.id, {
          gamePk: game.id,
          teams: teamsOf(game),
          setup: startingSetup(game, away, home)
        })
    }
    await mount(client, source)
    expect(document.body.textContent).includes('0 balls')
    // Another scorer saves two balls while this screen is open.
    const [away, home] = await Promise.all([
      client.roster(gameFixture.awayTeamId),
      client.roster(gameFixture.homeTeamId)
    ])
    const other = await source.open(gameFixture, away, home)
    other.apply({ type: 'pitch', call: 'B' })
    other.apply({ type: 'pitch', call: 'B' })
    await other.flush()
    expect(document.body.textContent).includes('0 balls')
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(document.querySelector('[aria-label="Save Rosters"]')).not.equals(
      null
    )
    await click('Cancel')
    expect(document.body.textContent).includes('2 balls')
  })

  it('undoes a play scored before the screen opened', async function () {
    const source = new DevelopmentScoringSource()
    const client = clientForSwitchHitter('right')
    const first = await source.open(gameFixture, [], [])
    first.apply({ type: 'pitch', call: 'B' })
    first.apply({ type: 'pitch', call: 'B' })
    await first.flush()
    await mount(client, source)
    expect(document.body.textContent).includes('2 balls')
    await click('Undo Last play')
    expect(document.body.textContent).includes('1 balls')
    await click('Undo Last play')
    expect(document.body.textContent).includes('0 balls')
    expect(document.querySelector('[aria-label="Undo Last play"]')).equals(null)
  })

  it('opens a game saved with a ball in play and no result at the pitch before it', async function () {
    const source = new DevelopmentScoringSource()
    const first = await source.open(gameFixture, [], [])
    first.apply({ type: 'pitch', call: 'B' })
    first.apply({ type: 'ballInPlay', contact: 'swing' })
    await first.flush()
    await mount(clientForSwitchHitter('right'), source)
    expect(document.body.textContent).includes('1 balls')
    expect(document.body.textContent).includes('Pitches 1')
    // Opening it saved nothing…
    const kinds = async (): Promise<string[]> =>
      (await source.open(gameFixture, [], [])).actions.map(
        action => action.type
      )
    expect(await kinds()).deep.equals(['pitch', 'ballInPlay'])
    // …and the scorer's next pitch saves the game from the pitch before.
    await click('Ball')
    expect(document.body.textContent).includes('2 balls')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(await kinds()).deep.equals(['pitch', 'pitch'])
  })

  it('undoes a saved ball in play back to the pitch before it, not to a ball without a result', async function () {
    const source = new DevelopmentScoringSource()
    const first = await source.open(gameFixture, [], [])
    for (const action of [
      { type: 'pitch', call: 'B' },
      { type: 'ballInPlay', contact: 'swing' },
      {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 15,
        location: { x: 5, z: -80 },
        fielder: 17
      },
      { type: 'result', eventType: 'single' },
      { type: 'gameFlow', kind: 'closePlay' }
    ] as const)
      expect(first.apply(action).problems).deep.equals([])
    await first.flush()
    await mount(clientForSwitchHitter('right'), source)
    await click('Undo Last play')
    await click('Undo Last play')
    expect(document.body.textContent).includes('1 balls')
    await click('Ball')
    expect(document.body.textContent).includes('2 balls')
  })

  it('plays the game to the fence the server gives it, 200 feet when it gives none', async function () {
    const fieldOf = (session: {
      state: { gameData: { venue?: { fieldInfo: object } } }
    }): object | undefined => session.state.gameData.venue?.fieldInfo
    const sized = asGameDetail({ ...gameFixture, fenceDistanceFt: 250 })
    const older = asGameDetail({ ...gameFixture, fenceDistanceFt: undefined })
    expect(older.fenceDistanceFt).equals(200)

    const development = new DevelopmentScoringSource()
    expect(fieldOf(await development.open(sized, [], []))).deep.equals({
      leftLine: 250,
      center: 250,
      rightLine: 250
    })
    expect(
      createDevelopmentSession(sized, [], []).gameData.venue?.fieldInfo.center
    ).equals(250)

    const client = new GameStationClient({ baseUrl: '/api/v1' })
    client.gameEvents = async () => ({ plays: [], currentPlay: null })
    const server = new ServerScoringSource(client)
    expect(
      fieldOf(await server.open({ ...sized, id: 'g2' }, [], [])),
      'server'
    ).deep.equals({ leftLine: 250, center: 250, rightLine: 250 })
    expect(fieldOf(await server.open(older, [], []))).deep.equals({
      leftLine: 200,
      center: 200,
      rightLine: 200
    })
  })
})
