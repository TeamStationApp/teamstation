import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asRosterEntry,
  type Lineup,
  type RosterEntry,
  TeamStationClient
} from '../../common/api'
import { ScoringSession } from '../../common/scoring/session'
import { POSITIONS, setupOf } from '../../common/scoring/state'
import { ThemeProvider } from '../theme/ThemeContext'
import { startingSetup, teamsOf } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { ScoringScreen } from './ScoringScreen'
import { memoryStore, type ScoringSource } from './scoringSource'

let root: Root | undefined
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
}
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
}
afterEach(async function () {
  await unmount()
  HTMLCanvasElement.prototype.getContext = getContext
})
async function click(label: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(element, label).not.equals(null)
  await act(async () => {
    element?.click()
  })
  await settle()
}
const order = (): string[] =>
  [...document.querySelectorAll('[aria-label^="Reorder "]')].map(
    node => node.getAttribute('aria-label')?.slice('Reorder '.length) ?? ''
  )

function entries(first: number): RosterEntry[] {
  return Array.from({ length: 9 }, (_, index) =>
    asRosterEntry({
      userId: first + index,
      gumboId: first + index,
      shortName: `Owl ${first + index}`,
      jersey: String(index + 1),
      positions: [],
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
    })
  )
}

/**
 * A scoring screen on a game whose visitors are still the roster order a
 * blind save left, and whose default the scorekeeper can read.
 */
async function openBlind(): Promise<{ session: () => ScoringSession }> {
  const away = entries(101)
  const home = entries(201)
  const setup = startingSetup(gameFixture, away, home)
  const store = memoryStore()
  const seeded = await ScoringSession.open(
    store,
    'g1',
    { gamePk: 'g1', teams: teamsOf(gameFixture), setup },
    { requireCurrentSetup: true }
  )
  const blind = seeded.apply({
    type: 'lineup',
    kind: 'roster',
    setup: setupOf(seeded.state),
    unseen: ['away'],
    confirmed: ['home']
  })
  expect(blind.problems).deep.equals([])
  await seeded.flush()
  const team = seeded.state.liveData.boxscore.teams.away
  const person = (id: number): Lineup['batters'][number] => {
    const player = seeded.state.gameData.players[id]
    return {
      gumboId: player.id,
      name: player.fullName,
      jersey: player.jersey
    }
  }
  const reversed: Lineup = {
    batters: [...team.battingOrder].reverse().map(person),
    defense: Object.fromEntries(
      POSITIONS.map(position => {
        const id = team.defense[position]
        return [position, id == null ? null : person(id)]
      })
    ) as Lineup['defense']
  }
  let opened: ScoringSession | undefined
  const source: ScoringSource = {
    open: async () => {
      opened = await ScoringSession.open(
        store,
        'g1',
        { gamePk: 'g1', teams: teamsOf(gameFixture), setup },
        { requireCurrentSetup: true }
      )
      return opened
    }
  }
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.roster = async () => []
  client.myRoles = async () => {
    throw new Error('none')
  }
  client.defaultLineup = async teamId => {
    if (teamId !== gameFixture.awayTeamId) throw new Error('no default')
    return { lineup: reversed, fromGameId: null, setAt: null }
  }
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
  await settle()
  expect(document.querySelector('[aria-label="Ball"]'), 'loaded').not.equals(
    null
  )
  return { session: () => opened! }
}

describe('a scorekeeper shown a default left unseen', function () {
  it('offers Save on that default and does not write it by opening', async function () {
    const { session } = await openBlind()
    expect(session().actions).length(1)
    await click('Open scoring menu')
    await click('Set Team Rosters')
    const names = order()
    expect(names[0]).includes('Owl 109')
    expect(names[names.length - 1]).includes('Owl 101')
    expect(
      document
        .querySelector('[aria-label="Save Rosters"]')
        ?.getAttribute('aria-disabled')
    ).equals(null)
    await click('Save Rosters')
    const saved = session().actions
    expect(saved).length(2)
    const roster = saved[1]
    expect(roster).includes({ type: 'lineup', kind: 'roster' })
    if (roster.type !== 'lineup' || roster.setup == null)
      throw new Error('roster save')
    expect(roster.confirmed).deep.equals(['away', 'home'])
    const ids = roster.setup.sides.away.battingOrder.map(
      id => roster.setup!.players[id].id
    )
    expect(ids[0]).equals(109)
    expect(ids[ids.length - 1]).equals(101)
  })

  it('scores the first pitch from that default', async function () {
    const { session } = await openBlind()
    expect(session().actions).length(1)
    await click('Ball')
    const added = session().actions.slice(1)
    expect(added.map(action => action.type)).deep.equals(['lineup', 'pitch'])
    const roster = added[0]
    if (roster.type !== 'lineup' || roster.setup == null)
      throw new Error('lineup')
    expect(roster.confirmed).deep.equals(['away'])
    expect(roster.shown).equals(true)
    expect(
      roster.setup.sides.away.battingOrder.map(
        id => roster.setup!.players[id].id
      )[0]
    ).equals(109)
  })
})
