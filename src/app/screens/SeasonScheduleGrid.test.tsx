import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import type { SetupSeason } from '../../common/seasonScheduling'
import { mount, unmount } from '../../test/gameFormDom'
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
    await mount(
      <SeasonScheduleGrid
        seasons={[
          SEASON,
          {
            ...SEASON,
            id: 'sea_b',
            name: 'Demo Fall',
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
        onOpenSeason={seasonId => {
          opened.push(seasonId)
        }}
      />
    )
    expect(hasLabel('Demo Regular Teams: 6')).equals(true)
    expect(hasLabel('Demo Regular Size: T-ball 46/60')).equals(true)
    // No exhibition teams: the exhibition games aren't counted.
    expect(hasLabel('Demo Regular Total games: 15')).equals(true)
    expect(hasLabel('Demo Regular Doubleheaders: Allowed')).equals(true)
    expect(hasLabel('Demo Regular Blackouts: 3 days')).equals(true)
    expect(hasLabel('Demo Regular Windows: 2 periods')).equals(true)
    expect(hasLabel('Demo Fall Blackouts: 1 day')).equals(true)
    expect(hasLabel('Demo Fall Windows: None')).equals(true)
    await tapLabel('Demo Fall Between: 15 min')
    await tapLabel('Demo Regular Exhibition: 2')
    await tapLabel('Demo Regular Total games: 15')
    await tapLabel('Open Demo Fall')
    expect(edits).deep.equals([
      ['sea_b', 'bufferMinutes'],
      ['sea_a', 'exhibitionGames']
    ])
    expect(opened).deep.equals(['sea_b'])
  })
})
