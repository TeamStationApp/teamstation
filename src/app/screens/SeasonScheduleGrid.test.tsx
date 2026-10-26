import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { ScrollView } from 'react-native'

import type { SetupSeason } from '../../common/seasonScheduling'
import { fill, mount, settle, text, unmount } from '../../test/gameFormDom'
import { hasLabel, tapLabel } from '../../test/venueDom'
import { type GridColumn, SeasonScheduleGrid } from './SeasonScheduleGrid'

const SEASON: SetupSeason = {
  id: 'sea_a',
  name: 'Demo Regular',
  year: 2027,
  timezone: 'UTC',
  participants: 6,
  exhibitionTeams: 0,
  teams: [],
  saved: false,
  settings: {
    fieldSize: '46/60',
    gameMinutes: 120,
    bufferMinutes: 15,
    regularGames: 5,
    exhibitionGames: 2,
    doubleheaders: 'allowed',
    startsOn: '2027-03-01',
    endsOn: '2027-05-31',
    blackouts: ['2027-04-04', '2027-04-11', '2027-05-30'],
    windows: [
      { from: '2027-03-01', hours: [] },
      { from: '2027-04-01', hours: [] }
    ]
  }
}

describe('the season schedule grid', () => {
  afterEach(unmount)

  it('shows a row per season and sends each tap to its editor', async () => {
    const edits: Array<[string, GridColumn]> = []
    const opened: string[] = []
    const saved: unknown[] = []
    await mount(
      <SeasonScheduleGrid
        seasons={[
          SEASON,
          {
            ...SEASON,
            id: 'sea_b',
            name: 'Demo Fall',
            participants: 7,
            exhibitionTeams: 2,
            settings: {
              ...SEASON.settings,
              blackouts: ['2027-04-04'],
              windows: []
            }
          }
        ]}
        onEdit={(seasonId, column) => {
          edits.push([seasonId, column])
        }}
        onSaveNumber={async (...args) => {
          saved.push(args)
          return null
        }}
        onOpenSeason={seasonId => {
          opened.push(seasonId)
        }}
      />
    )
    const headers = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="season-schedule-grid"] div'
      )
    ]
      .map(node => node.textContent)
      .filter(text =>
        ['Game MINS', 'Between MINS', '# Regular', '# Exhibition'].includes(
          text ?? ''
        )
      )
    expect([...new Set(headers)]).deep.equals([
      'Game MINS',
      'Between MINS',
      '# Regular',
      '# Exhibition'
    ])
    // Bare numbers, with no unit.
    expect(hasLabel('Demo Regular Game length in minutes: 120')).equals(true)
    expect(hasLabel('Demo Regular Time between games in minutes: 15')).equals(
      true
    )
    expect(hasLabel('Demo Regular Regular-season games: 5')).equals(true)
    expect(hasLabel('Demo Regular Exhibition games: 2')).equals(true)
    const shown = (seasonId: string, column: string): string =>
      document.querySelector(`[data-testid="grid-cell-${seasonId}-${column}"]`)!
        .textContent!
    expect(shown('sea_a', 'gameMinutes')).equals('120')
    expect(shown('sea_a', 'bufferMinutes')).equals('15')
    expect(hasLabel('Demo Regular Teams: 6 teams')).equals(true)
    expect(text()).not.includes('exh.')
    expect(text()).includes('7 + 2')
    expect(hasLabel('Demo Fall Teams: 7 teams and 2 exhibition teams')).equals(
      true
    )
    expect(hasLabel('Demo Regular Size: T-ball 46/60')).equals(true)
    // No exhibition teams: the exhibition games aren't counted.
    expect(hasLabel('Demo Regular Total games: 15')).equals(true)
    expect(hasLabel('Demo Regular Doubleheaders: Allowed')).equals(true)
    expect(hasLabel('Demo Regular Blackouts: 3 days')).equals(true)
    expect(hasLabel('Demo Regular Windows: 2 periods')).equals(true)
    expect(hasLabel('Demo Fall Blackouts: 1 day')).equals(true)
    expect(hasLabel('Demo Fall Windows: None')).equals(true)
    await tapLabel('Demo Fall Size: T-ball 46/60')
    await tapLabel('Demo Regular Total games: 15')
    await tapLabel('Demo Fall Teams: 7 teams and 2 exhibition teams')
    await tapLabel('Open Demo Fall')
    // The number columns open in place, never through onEdit.
    for (const label of [
      'Demo Fall Time between games in minutes: 15',
      'Demo Regular Exhibition games: 2',
      'Demo Regular Game length in minutes: 120',
      'Demo Regular Regular-season games: 5'
    ]) {
      await tapLabel(label)
      expect(hasLabel(`Edit ${label.replace(/: \d+$/, '')}`)).equals(true)
    }
    expect(edits).deep.equals([
      ['sea_b', 'fieldSize'],
      ['sea_b', 'teams']
    ])
    expect(opened).deep.equals(['sea_b'])
    expect(saved).deep.equals([])
  })

  it('shows a cell’s refusal under the grid', async () => {
    await mount(
      <SeasonScheduleGrid
        seasons={[SEASON]}
        onEdit={() => undefined}
        onSaveNumber={async () => 'Choose a season of this league'}
        onOpenSeason={() => undefined}
      />
    )
    await tapLabel('Demo Regular Game length in minutes: 120')
    await fill('Edit Demo Regular Game length in minutes', '125')
    await act(async () => {
      document.querySelector('input')!.blur()
    })
    await settle(20)
    expect(
      document.querySelector(
        '[data-testid="season-schedule-grid"] [role="alert"]'
      )?.textContent
    ).equals('Choose a season of this league')
  })

  it('lets a tap on another cell through while one has the keyboard', async () => {
    await mount(
      <SeasonScheduleGrid
        seasons={[SEASON]}
        onEdit={() => undefined}
        onSaveNumber={async () => null}
        onOpenSeason={() => undefined}
      />
    )
    await tapLabel('Demo Regular Game length in minutes: 120')
    // The scroll views the open cell's input sits in, innermost first.
    const input = document.querySelector('input')!
    const key = Object.keys(input).find(one => one.startsWith('__reactFiber'))!
    const scrolls: Array<Record<string, unknown>> = []
    for (
      let fiber = (input as unknown as Record<string, Fiber | null>)[key];
      fiber != null;
      fiber = fiber.return
    )
      if (fiber.type === ScrollView) scrolls.push(fiber.memoizedProps ?? {})
    expect(scrolls.length).greaterThan(0)
    expect(scrolls[0].horizontal).equals(true)
    for (const props of scrolls)
      expect(props.keyboardShouldPersistTaps).equals('handled')
  })
})

interface Fiber {
  type: unknown
  memoizedProps: Record<string, unknown> | null
  return: Fiber | null
}
