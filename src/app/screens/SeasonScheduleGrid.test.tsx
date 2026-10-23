import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

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
    fieldSize: 'T-ball',
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
              fieldSize: '46/60',
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
    expect(hasLabel('Demo Regular Game MINS: 120')).equals(true)
    expect(hasLabel('Demo Regular Between MINS: 15')).equals(true)
    expect(hasLabel('Demo Regular # Regular: 5')).equals(true)
    expect(hasLabel('Demo Regular # Exhibition: 2')).equals(true)
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
    // T-ball and 46/60 are two sizes.
    expect(hasLabel('Demo Regular Size: T-ball')).equals(true)
    expect(hasLabel('Demo Fall Size: 46/60')).equals(true)
    // No exhibition teams: the exhibition games aren't counted.
    expect(hasLabel('Demo Regular Total games: 15')).equals(true)
    expect(hasLabel('Demo Regular Doubleheaders: Allowed')).equals(true)
    expect(hasLabel('Demo Regular Blackouts: 3 days')).equals(true)
    expect(hasLabel('Demo Regular Windows: 2 periods')).equals(true)
    expect(hasLabel('Demo Fall Blackouts: 1 day')).equals(true)
    expect(hasLabel('Demo Fall Windows: None')).equals(true)
    await tapLabel('Demo Fall Size: 46/60')
    await tapLabel('Demo Regular Total games: 15')
    await tapLabel('Demo Fall Teams: 7 teams and 2 exhibition teams')
    await tapLabel('Open Demo Fall')
    // The number columns open in place, never through onEdit.
    for (const label of [
      'Demo Fall Between MINS: 15',
      'Demo Regular # Exhibition: 2',
      'Demo Regular Game MINS: 120',
      'Demo Regular # Regular: 5'
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
    await tapLabel('Demo Regular Game MINS: 120')
    await fill('Edit Demo Regular Game MINS', '125')
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
})
