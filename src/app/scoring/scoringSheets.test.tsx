import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { TeamStationClient } from '../../common/api'
import { ScoringSession } from '../../common/scoring/session'
import { userIdOfGumbo } from '../../common/userId'
import { mintedRosterEntry } from '../../test/mintedRosterEntry'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { draftOfLocalPlayer, rosterPlayerBody } from './playerDraft'
import {
  RosterDrag as NativeDrag,
  RosterDragGroup as NativeGroup
} from './RosterDrag.native'
import { scoringPreferences } from './scoringPreferences'
import { ScoringScreen } from './ScoringScreen'
import { playerRef } from './scoringSelectors'
import { memoryStore, type ScoringSource } from './scoringSource'
import type { ScoringSessionState } from './scoringTypes'
let root: Root | undefined
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
async function click(label: string): Promise<void> {
  const node = document
    .querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)
    .item(document.querySelectorAll(`[aria-label="${label}"]`).length - 1)
  expect(node, label).not.equals(null)
  await act(async () => {
    node.click()
  })
}
async function keys(label: string, keys: string[]): Promise<void> {
  for (const key of keys)
    for (const type of ['keydown', 'keyup'])
      await act(async () => {
        document
          .querySelector(`[aria-label="${label}"]`)!
          .dispatchEvent(new window.KeyboardEvent(type, { key, bubbles: true }))
      })
}
async function drag(
  sourceSelector: string,
  targetId: string,
  cancel = false,
  after = false
): Promise<void> {
  const source = document.querySelector(sourceSelector)!
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    const target = this.getAttribute('data-roster-target')
    const x = target == null ? 0 : target === targetId ? 200 : -1000
    return {
      x,
      y: 0,
      left: x,
      top: 0,
      right: x + 400,
      bottom: 800,
      width: 400,
      height: 800,
      toJSON: () => ({})
    }
  }
  try {
    for (const [type, x] of [
      ['pointerdown', 0],
      ['pointermove', 250],
      [cancel ? 'pointercancel' : 'pointerup', 250]
    ] as const) {
      await act(async () => {
        const event = new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: after ? 600 : 10
        })
        Object.defineProperty(event, 'pointerId', { value: 1 })
        source.dispatchEvent(event)
        await new Promise(resolve =>
          setTimeout(resolve, type === 'pointerdown' ? 520 : 20)
        )
      })
    }
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
}
async function input(label: string, value: string): Promise<void> {
  const node = document.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`
  )!
  expect(node, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node, value)
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function mount(
  prepare?: (session: ScoringSessionState) => void,
  onStoreWrite?: () => void
): Promise<void> {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.roster = async () => []
  // These player-entry tests act as the roster manager of both teams.
  // Opponent-only guest permissions are exercised in the dedicated suite.
  client.myRoles = async () => ({
    teams: { away: ['scorekeeper'], home: ['scorekeeper'] },
    guardianOf: []
  })
  client.createGuestPlayer = async (_gameId, _side, player) =>
    mintedRosterEntry(player)
  client.createRosterPlayer = async (_teamId, player) =>
    mintedRosterEntry(player)
  const source: ScoringSource = {
    open: async () => {
      const session = scoringSession(gameFixture)
      prepare?.(session)
      const store = memoryStore()
      const save = store.save
      store.save = async (gameId, change) => {
        onStoreWrite?.()
        return await save(gameId, change)
      }
      return ScoringSession.start(store, 'g1', session)
    }
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <ScoringScreen
          client={client}
          gameId="g1"
          source={source}
          userId={12}
          onExit={() => undefined}
        />
      </ThemeProvider>
    )
  })
}
async function menu(label: string): Promise<void> {
  await click('Open scoring menu')
  await click(label)
}
async function unmountSheet(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  HTMLCanvasElement.prototype.getContext = getContext
}
describe('scoring slide-up sheets', function () {
  // Unmount portals before the root DOM hook clears their host elements.
  afterEach(unmountSheet)
  it("renames a corrected game-only player's account before saving the rosters", async function () {
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
    const session = scoringSession(gameFixture)
    const id = session.liveData.boxscore.teams.away.players[0]
    const was = session.gameData.players[id]
    const guestUser = userIdOfGumbo(id)
    const calls: string[] = []
    const renames: unknown[] = []
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => ({
      ...gameFixture,
      guestPlayers: {
        away: [
          {
            ...mintedRosterEntry(rosterPlayerBody(draftOfLocalPlayer(was))),
            userId: guestUser,
            gumboId: id
          }
        ],
        home: []
      }
    })
    client.roster = async () => []
    client.myRoles = async () => ({
      teams: { away: ['scorekeeper'], home: ['scorekeeper'] },
      guardianOf: []
    })
    client.renameGuestPlayer = async (gameId, userId, name, gumboId) => {
      calls.push('rename')
      renames.push({ gameId, userId, name, gumboId })
      return mintedRosterEntry(
        rosterPlayerBody({ ...draftOfLocalPlayer(was), ...name })
      )
    }
    const store = memoryStore()
    const save = store.save
    store.save = async (gameId, change) => {
      calls.push('save')
      return await save(gameId, change)
    }
    const source: ScoringSource = {
      persistent: true,
      open: async () => ScoringSession.start(store, 'g1', session)
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ScoringScreen
            client={client}
            gameId="g1"
            source={source}
            userId={12}
            onExit={() => undefined}
          />
        </ThemeProvider>
      )
    })
    await menu('Set Team Rosters')
    await click('Roster')
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label*="game-only player"]')!
        .click()
    })
    await input('First Name', 'Jose')
    await click('Save Player')
    await click('Save Rosters')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(renames).deep.equals([
      {
        gameId: 'g1',
        userId: guestUser,
        name: {
          firstName: 'Jose',
          lastName: draftOfLocalPlayer(was).lastName
        },
        gumboId: id
      }
    ])
    // One rename, before the setup that shows the new name is saved.
    expect(calls[0]).equals('rename')
    expect(calls.filter(call => call === 'rename')).has.length(1)
    expect(calls).includes('save')
  })

  it('renames nobody for a game kept only on the device', async function () {
    let renamed = 0
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const rename = TeamStationClient.prototype.renameGuestPlayer
    TeamStationClient.prototype.renameGuestPlayer = async () => {
      renamed++
      throw new Error('Not sent')
    }
    try {
      let saves = 0
      await mount(undefined, () => {
        saves++
      })
      await menu('Set Team Rosters')
      await click('Roster')
      await act(async () => {
        document
          .querySelector<HTMLElement>('[aria-label*="game-only player"]')!
          .click()
      })
      await input('First Name', 'Jose')
      await click('Save Player')
      await click('Save Rosters')
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
      })
      expect(renamed).equals(0)
      expect(saves).greaterThan(0)
    } finally {
      TeamStationClient.prototype.renameGuestPlayer = rename
    }
  })

  it('names the teams inside the Away/Home pill and nowhere else', async function () {
    await mount()
    // The scoreboard behind the sheet names the teams too; the sheet adds each
    // name exactly once, inside the pill.
    const count = (name: string): number =>
      document.body.textContent!.split(name).length - 1
    const owls = count('Owls')
    const hawks = count('Hawks')
    await menu('Set Team Rosters')
    try {
      const captions = document.querySelector(
        '[data-testid="Roster selector captions"]'
      )!
      expect(captions.textContent).equals('AwayHome')
      expect(
        document.querySelector('[aria-label="Away Team"]')!.textContent
      ).equals('Owls')
      expect(
        document.querySelector('[aria-label="Home Team"]')!.textContent
      ).equals('Hawks')
      expect(count('Owls') - owls).equals(1)
      expect(count('Hawks') - hawks).equals(1)
      await click('Home Team')
      expect(count('Owls') - owls).equals(1)
      expect(count('Hawks') - hawks).equals(1)
    } finally {
      await click('Cancel')
    }
  })

  it('writes the defense draft only after Save Rosters', async function () {
    this.timeout(10000)
    let writes = 0
    await mount(undefined, () => {
      writes++
    })
    await menu('Set Team Rosters')
    await click('Defense')
    const originalWrites = writes
    await click('Clear P')
    await drag(
      '[data-roster-target="roster"] [data-roster-player="1"]',
      'defense-C'
    )
    await drag(
      '[data-roster-target="roster"] [data-roster-player="2"]',
      'defense-P'
    )
    expect(writes).equals(originalWrites)
    await click('Save Rosters')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(writes).greaterThan(originalWrites)
    await menu('Set Team Rosters')
    await click('Defense')
    expect(
      document.querySelector('[data-roster-target="defense-P"]')!.textContent
    ).includes('Player 2')
    expect(
      document.querySelector('[data-roster-target="defense-C"]')!.textContent
    ).includes('Player 1')
    await click('Cancel')
  })
  it('uses a compact roster shell and drafts field assignment, replacement, clear and cancellation', async function () {
    this.timeout(10000)
    await mount()
    await menu('Set Team Rosters')
    expect(document.querySelector('[role="heading"]')?.textContent).not.equals(
      'Set Team Rosters'
    )
    expect(document.querySelectorAll('[aria-label="Cancel"]')).length(1)
    expect(
      document.querySelector('[aria-label="Create Placeholder Player"]')
    ).equals(null)
    const footer = document.querySelector('[data-testid="Roster footer"]')!
    expect(footer.textContent).includes('Create PlayerSave RostersCancel')
    await click('Defense')
    expect(document.body.textContent).includes(
      'Drag player into position. On touch, hold briefly first.'
    )
    expect(
      document.querySelector('[aria-label="Top-down baseball field"]')
    ).not.equals(null)
    expect(
      document.querySelectorAll('[data-roster-target^="defense-"]')
    ).length(9)
    const grid = document.querySelector<HTMLElement>(
      '[data-testid="Defense roster grid"]'
    )!
    expect(grid.style.flexDirection).equals('row')
    await act(async () => {
      document.querySelector('[data-roster-target="defense-P"]')!.dispatchEvent(
        new window.MouseEvent('pointerout', {
          bubbles: true,
          relatedTarget: document.body
        })
      )
    })
    await click('Clear P')
    const roster = (): string =>
      document.querySelector('[data-roster-target="roster"]')!.textContent!
    expect(roster()).includes('Player 1')
    await drag(
      '[data-roster-target="roster"] [data-roster-player="1"]',
      'defense-C'
    )
    expect(
      document.querySelector('[data-roster-target="defense-C"]')!.textContent
    ).includes('Player 1')
    expect(roster()).not.includes('#1 Player 1')
    expect(roster()).includes('Player 2')
    await click('Clear C')
    await drag(
      '[data-roster-target="roster"] [data-roster-player="2"]',
      'defense-P'
    )
    expect(
      document.querySelector('[data-roster-target="defense-P"]')!.textContent
    ).includes('Player 2')
    await click('Home Team')
    await click('Away Team')
    expect(
      document.querySelector('[data-roster-target="defense-P"]')!.textContent
    ).includes('Player 2')
    await click('Cancel')
    await menu('Set Team Rosters')
    await click('Defense')
    expect(
      document.querySelector('[data-roster-target="defense-P"]')!.textContent
    ).includes('Player 1')
    await click('Cancel')
  })
  it('adds placeholders through player entry while keeping additions in the roster draft', async function () {
    await mount()
    await menu('Set Team Rosters')
    await click('Create Player')
    const more = document.querySelector(
      '[aria-label="Save and Create Another Player"]'
    )!
    const placeholders = document.querySelector(
      '[aria-label="Create Placeholder Player"]'
    )!
    expect(more.compareDocumentPosition(placeholders) & 4).equals(4)
    await click('Create Placeholder Player')
    await click('Player count 3')
    await click('Create')
    expect(document.querySelector('[aria-label="First Name"]')).equals(null)
    expect(
      document.querySelector('[data-roster-target="roster"]')!.textContent
    ).includes('OWLS A')
    await click('Cancel')
    await menu('Set Team Rosters')
    expect(
      document.querySelector('[data-roster-target="roster"]')!.textContent
    ).not.includes('OWLS A')
    await click('Cancel')
  })

  it('lists the roster by jersey number, numbers first and no number last, in both modes', async function () {
    await mount()
    await menu('Set Team Rosters')
    try {
      // Added out of order: the player with no number first.
      for (const [first, last, jersey] of [
        ['Amy', 'Blank', ''],
        ['Zed', 'Ten', '10']
      ]) {
        await click('Create Player')
        await input('First Name', first)
        await input('Last Name', last)
        if (jersey !== '') await input('Jersey Number', jersey)
        await click('Create Player')
      }
      const roster = (): string[] =>
        Array.from(
          document.querySelectorAll(
            '[data-roster-target="roster"] [data-roster-player]'
          )
        ).map(node => node.textContent!.trim())
      const inOrder = (rows: string[]): void => {
        const numbers = rows.map(row => /^#(\d+)/.exec(row)?.[1])
        const numbered = numbers.filter(number => number != null)
        expect(numbers.slice(0, numbered.length)).deep.equals(numbered)
        expect(numbered.map(Number)).deep.equals(
          [...numbered].map(Number).sort((a, b) => a - b)
        )
        expect(rows.at(-1)).includes('Amy')
      }
      const lineup = roster()
      inOrder(lineup)
      expect(lineup.findIndex(row => row.includes('Zed'))).equals(
        lineup.findIndex(row => row.startsWith('#10 '))
      )
      await click('Defense')
      inOrder(roster())
      expect(roster().every(row => lineup.includes(row))).equals(true)
      await click('Lineup')
      // Adding to the lineup puts him last there; the lineup is not sorted.
      await click('Add Zed T to Lineup')
      const last = Array.from(
        document.querySelectorAll(
          '[data-roster-target^="lineup-"][data-roster-player]'
        )
      ).at(-1)!
      expect(last.textContent).includes('Zed')
    } finally {
      await click('Cancel')
    }
  })

  it('edits both lineups and defense, adds created players and commits once with undo', async function () {
    await mount()
    await menu('Set Team Rosters')
    await click('Remove Player 2')
    await click('Add Player 2 to Lineup')
    const vibration = Object.getOwnPropertyDescriptor(navigator, 'vibrate')
    let keyboardCues = 0
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        keyboardCues++
        return false
      }
    })
    try {
      await keys('Reorder Player 2', [' ', 'ArrowUp', 'Escape'])
      expect(document.querySelector('[aria-label="Save Rosters"]')).not.equals(
        null
      )
      expect(
        document.querySelector('[data-roster-target="lineup-8"]')!.textContent
      ).includes('Player 2')
      await keys('Reorder Player 2', [' ', 'ArrowUp', 'Enter'])
      await keys('Reorder Player 2', [' ', 'ArrowDown', 'Enter'])
      expect(keyboardCues).equals(0)
    } finally {
      if (vibration == null) delete (navigator as Partial<Navigator>).vibrate
      else Object.defineProperty(navigator, 'vibrate', vibration)
    }
    await click('Create Player')
    await input('First Name', 'Alex')
    await input('Last Name', 'Rodriguez')
    await click('Create Player')
    await click('Add Alex R to Lineup')
    await click('Defense')
    await click('Clear P')
    expect(
      document
        .querySelector('[aria-label="Save Rosters"]')
        ?.getAttribute('aria-disabled')
    ).not.equals('true')
    await drag(
      '[data-roster-target="roster"] [data-roster-player="1"]',
      'defense-P'
    )
    await click('Home Team')
    expect(document.body.textContent).includes('Hawks')
    await click('Lineup')
    await click('Remove Player 9')
    await click('Away Team')
    await click('Save Rosters')
    expect(
      document.querySelector('[aria-label="Undo Set team roster"]')
    ).not.equals(null)
    await click('Undo Set team roster')
    await menu('Set Team Rosters')
    expect(document.body.textContent).not.includes('Alex R')
    await click('Cancel')
    expect(document.querySelector('[aria-label="Nothing to undo"]')).not.equals(
      null
    )
  })
  it('inserts at row boundaries, adjusts existing indices, and styles numbered roster rows', async function () {
    this.timeout(5000)
    await mount()
    await menu('Set Team Rosters')
    const lineup = (): number[] =>
      Array.from(
        document.querySelectorAll(
          '[data-roster-target^="lineup-"][data-roster-player]'
        )
      ).map(n => Number(n.getAttribute('data-roster-player')))
    await drag('[aria-label="Reorder Player 1"]', 'lineup-2', false, true)
    expect(lineup().slice(0, 3)).deep.equals([2, 3, 1])
    await drag('[aria-label="Reorder Player 1"]', 'lineup-0')
    expect(lineup().slice(0, 3)).deep.equals([1, 2, 3])
    await drag('[aria-label="Reorder Player 1"]', 'lineup-0', false, true)
    expect(lineup().slice(0, 3)).deep.equals([1, 2, 3])
    expect(
      document.querySelector('[data-roster-target="roster"]')!.textContent
    ).not.includes('#1 Player 1')
    await click('Defense')
    expect(
      document.querySelector('[data-roster-target="defense-P"]')!.textContent
    ).includes('P · #1 Player 1')
    expect(
      document.querySelector('[data-roster-target="roster"]')!.textContent
    ).not.includes('#1 Player 1')
    await click('Cancel')
  })
  it('validates override fields and player collisions, then reconciles the chosen half', async function () {
    await mount()
    await menu('Overrides')
    await input('balls', '4')
    expect(
      document
        .querySelector('[aria-label="Apply Override"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    await input('balls', '')
    await input('balls', '3')
    await click('First base')
    await click('Choose First base Player 1')
    expect(document.body.textContent).includes('cannot include the batter')
    await click('First base')
    await click('Choose First base Empty')
    await click('Bottom')
    await click('Batter')
    await click('Choose Batter Player 2')
    await click('Pitcher')
    await click('Choose Pitcher Player 3')
    await input('inning', '2')
    await input('homeScore', '5')
    await input('awayScore', '4')
    await input('outs', '2')
    await input('strikes', '1')
    await click('Apply Override')
    expect(document.body.textContent).includes('Owls 4 · Hawks 5 · Bottom 2nd')
    await click('Undo Override game state')
    expect(document.body.textContent).includes('Owls 0 · Hawks 0 · Top 1st')
    await menu('Overrides')
    await click('Dismiss sheet')
  })
  it('controls device help and confirms half endings, while pending plays disable destructive sheets', async function () {
    await mount()
    await menu('Settings')
    await click('Toggle switch-hitter help')
    await click('Reset shown count')
    expect(await scoringPreferences.read('12')).deep.equals({
      help: false,
      shown: 0
    })
    await click('Done')
    await menu('End Half Inning')
    await click('Cancel')
    expect(document.body.textContent).includes('Top 1st')
    await menu('End Half Inning')
    await click('Confirm End Half Inning')
    expect(document.body.textContent).includes('Bottom 1st')
    await click('Undo End half inning')
    for (let pitch = 0; pitch < 3; pitch++) await click('Called Strike')
    await click('Open scoring menu')
    for (const label of ['Overrides', 'Set Team Rosters', 'End Half Inning'])
      expect(
        document
          .querySelector(`[aria-label="${label}"]`)
          ?.getAttribute('aria-disabled')
      ).equals('true')
    await click('Dismiss scoring menu')
    await menu('Settings')
    await click('Done')
    await menu('Exit Current Game')
    await click('Cancel')
  })
  it('repairs an occupied next batter explicitly through the roster sheet', async function () {
    await mount(session => {
      session.liveData.boxscore.teams.away.battingOrder = [1]
      session.liveData.linescore.offense.first = playerRef(session, 1)
      session.liveData.linescore.offense.batter = null
      session.liveData.plays.currentPlay = null
      session.awaitingBatter = {
        teamId: session.gameData.teams.away.id,
        dueIndex: 0,
        duePlayerId: 1
      }
    })
    expect(document.body.textContent).includes('Next batter is on base')
    await menu('Set Team Rosters')
    await click('Add Player 2 to Lineup')
    await click('Next batter Player 2')
    await click('Save Rosters')
    expect(
      document.querySelector('[aria-label*="Batter Player 2"]')
    ).not.equals(null)
    await click('Undo Set team roster')
    expect(document.body.textContent).includes('Next batter is on base')
    await menu('Overrides')
    await click('First base')
    await click('Choose First base Empty')
    await click('Batter')
    await click('Choose Batter Player 1')
    await click('Apply Override')
    expect(
      document.querySelector('[aria-label*="Batter Player 1"]')
    ).not.equals(null)
  })
  it('cancels roster pointer gestures and commits only a released drop', async function () {
    await mount()
    await menu('Set Team Rosters')
    await click('Remove Player 2')
    const source = document.querySelector<HTMLElement>(
      '[data-roster-target="roster"] [data-roster-player="2"]'
    )!
    const target = document.querySelector<HTMLElement>(
      '[data-roster-target="lineup-0"]'
    )!
    await drag(
      '[data-roster-target="roster"] [data-roster-player="2"]',
      'lineup-0',
      true
    )
    expect(target.textContent).includes('1. #1 Player 1')
    await drag(
      '[data-roster-target="roster"] [data-roster-player="2"]',
      'lineup-0'
    )
    expect(
      document.querySelector('[data-roster-target="lineup-0"]')!.textContent
    ).includes('1. #2 Player 2')
    expect(source.isConnected).equals(false)
    expect(
      document.querySelector(
        '[data-roster-target="roster"] [data-roster-player="2"]'
      )
    ).equals(null)
    await click('Cancel')
  })
  it('enters fielder selection from a tapped outcome and restores ready with Undo', async function () {
    await mount()
    await click('Swing in Play')
    await click('Single')
    expect(document.body.textContent).includes(
      'Tap or drag a player to where the ball was fielded.'
    )
    await click('Undo Single')
    expect(document.body.textContent).includes(
      '0 balls 0 strikes 0 outs · Pitches 0'
    )
  })
  it('mounts and cleans up the native gesture host', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <NativeGroup>
          <NativeDrag>
            <Text>Roster</Text>
          </NativeDrag>
        </NativeGroup>
      )
    })
    expect(host.textContent).equals('Roster')
  })
})

describe('ending the game from the menu', function () {
  afterEach(unmountSheet)
  it('confirms, stores the end, refuses further pitches, and undoes it', async function () {
    await mount()
    await menu('End Game')
    expect(document.body.textContent).includes(
      'End the game at Owls 0, Hawks 0?'
    )
    await click('Confirm End Game')
    expect(document.querySelector('[aria-label="Game over"]')).not.equals(null)
    await click('Ball')
    expect(document.body.textContent).includes('0 balls')
    await click('Undo End game')
    expect(document.querySelector('[aria-label="Game over"]')).equals(null)
    await click('Ball')
    expect(document.body.textContent).includes('1 balls')
  })

  it('keeps End Game off while an at-bat is open', async function () {
    await mount()
    await click('Ball')
    await click('Open scoring menu')
    expect(
      document
        .querySelector('[aria-label="End Game"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
  })
})

describe('the animation switch in settings', function () {
  afterEach(unmountSheet)
  it('turns play animations off and back on', async function () {
    await mount()
    await menu('Settings')
    // A switch, which says whether it is on as a checkbox does.
    const checked = (): boolean | undefined =>
      document.querySelector<HTMLInputElement>(
        '[aria-label="Toggle play animations"]'
      )?.checked
    expect(checked()).equals(true)
    await click('Toggle play animations')
    expect(checked()).equals(false)
    expect((await scoringPreferences.read('12')).animations).equals(false)
    await click('Toggle play animations')
    expect(checked()).equals(true)
    await click('Done')
  })
})
