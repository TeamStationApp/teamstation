import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { DefensiveRosterSheet } from './DefensiveRosterSheet'
import { gameFixture } from './isUnscoredGame.test'
import { POSITIONS } from './scoringTypes'

let root: Root | undefined
const node = (label: string): HTMLElement =>
  document.querySelector(`[aria-label="${label}"]`)!
async function click(label: string): Promise<void> {
  await act(async () => {
    node(label).click()
  })
}
async function mount(
  overrides: Partial<Parameters<typeof DefensiveRosterSheet>[0]> = {}
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <DefensiveRosterSheet
          session={scoringSession(gameFixture)}
          side="home"
          position="P"
          onClose={() => undefined}
          onChoose={() => undefined}
          onRefresh={() => undefined}
          onAddPlayer={async () => undefined}
          onAddPlaceholders={async () => undefined}
          {...overrides}
        />
      </ThemeProvider>
    )
  })
}
describe('defensive roster sheet', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })
  for (const [position, title] of [
    ['P', 'pitcher'],
    ['C', 'catcher'],
    ['1B', 'first base'],
    ['2B', 'second base'],
    ['SS', 'shortstop'],
    ['3B', 'third base'],
    ['LF', 'left field'],
    ['CF', 'center field'],
    ['RF', 'right field']
  ] as const)
    it(`spells out ${position} in its assignment title`, async () => {
      await mount({ position })
      expect(document.body.textContent).includes(`Assign ${title}`)
    })
  it('groups every player once with bench first, fielders-only badges and names before optional jerseys', async () => {
    const session = scoringSession(gameFixture)
    const team = session.liveData.boxscore.teams.home
    const bench = team.defense.P!
    team.defense.P = null
    session.gameData.players[bench].fullName = 'Mookie Betts'
    session.gameData.players[bench].jersey = ' '
    const catcher = team.defense.C!
    session.gameData.players[catcher].fullName = 'Mike Trout'
    session.gameData.players[catcher].jersey = '0'
    const choices: number[] = []
    await mount({
      session,
      onChoose: id => {
        choices.push(id)
      }
    })
    const benchGroup = document.querySelector(
      '[data-testid="Defensive Bench"]'
    )!
    const fieldGroup = document.querySelector(
      '[data-testid="Defensive Fielders"]'
    )!
    expect(benchGroup.compareDocumentPosition(fieldGroup) & 4).equals(4)
    expect(benchGroup.textContent).equals('BenchMookie B')
    expect(
      benchGroup.querySelector('[data-testid^="Defensive position"]')
    ).equals(null)
    expect(fieldGroup.textContent).includes('CMike T #0')
    expect(
      document.querySelectorAll('[data-testid^="Defensive player "]')
    ).has.length(team.players.length)
    expect(
      document.querySelectorAll('[data-testid^="Defensive position "]')
    ).has.length(8)
    await click('Assign P Mookie B')
    await click('Assign P #0 Mike T')
    expect(choices).deep.equals([bench, catcher])
  })
  it('preserves distinct server roster names in tiles and accessible labels without jerseys', async () => {
    const session = scoringSession(gameFixture)
    const team = session.liveData.boxscore.teams.home
    const ids = team.players.slice(0, 2)
    team.players = ids
    for (const slot of POSITIONS) team.defense[slot] = null
    for (const [i, id] of ids.entries())
      session.gameData.players[id] = {
        ...session.gameData.players[id],
        local: false,

        fullName: i === 0 ? 'Luis Ga' : 'Luis Gi',
        jersey: ''
      }
    const choices: number[] = []
    await mount({
      session,
      onChoose: id => {
        choices.push(id)
      }
    })
    const bench = document.querySelector('[data-testid="Defensive Bench"]')!
    expect(bench.textContent).equals('BenchLuis GaLuis Gi')
    expect(node('Assign P Luis G')).equals(null)
    await click('Assign P Luis Ga')
    await click('Assign P Luis Gi')
    expect(choices).deep.equals(ids)
  })
  for (const assigned of [false, true])
    it(`keeps both headers and Create Player with an empty ${assigned ? 'bench' : 'fielders'} section`, async () => {
      const session = scoringSession(gameFixture)
      if (!assigned)
        for (const slot of POSITIONS)
          session.liveData.boxscore.teams.home.defense[slot] = null
      await mount({ session })
      expect(
        document.querySelector('[data-testid="Defensive Bench"]')
      ).not.equals(null)
      expect(
        document.querySelector('[data-testid="Defensive Fielders"]')
      ).not.equals(null)
      expect(node('Create Player')).not.equals(null)
    })
  it('returns from canceled creation to the same selected position and refreshes the roster', async () => {
    let refreshed = 0
    let closed = 0
    await mount({
      position: '1B',
      onRefresh: () => {
        refreshed++
      },
      onClose: () => {
        closed++
      }
    })
    await click('Create Player')
    expect(node('First Name')).not.equals(null)
    await act(async () => {
      ;[...document.querySelectorAll<HTMLElement>('[aria-label="Cancel"]')]
        .at(-1)!
        .click()
    })
    expect(node('First Name')).equals(null)
    expect(document.body.textContent).includes('Assign first base')
    expect(refreshed).equals(1)
    expect(closed).equals(0)
  })
  it('closes the creation stack after adding placeholders and keeps the picker open', async () => {
    const counts: number[] = []
    await mount({
      onAddPlaceholders: async count => {
        counts.push(count)
      }
    })
    await click('Create Player')
    await click('Create Placeholder Player')
    await click('Player count 3')
    await click('Create')
    expect(counts).deep.equals([3])
    expect(node('First Name')).equals(null)
    expect(document.body.textContent).includes('Assign pitcher')
    expect(node('Create Player')).not.equals(null)
  })
  it('disables assignment and creation while refreshing and surfaces a recoverable problem', async () => {
    let choices = 0
    await mount({
      busy: true,
      problem: 'Unable to refresh the game. Please try again.',
      onChoose: () => {
        choices++
      }
    })
    await click('Assign P #1 Player 1')
    await click('Create Player')
    expect(choices).equals(0)
    expect(node('First Name')).equals(null)
    expect(document.body.textContent).includes(
      'Unable to refresh the game. Please try again.'
    )
    expect(document.body.textContent).includes('Refreshing game...')
  })
})
