import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React from 'react'

import type { TeamStationClient } from '../../common/api'
import type {
  FairnessRow,
  PlannedGame,
  ScheduleOption
} from '../../common/autoScheduler/types'
import { foreignZoneName } from '../../common/eventTime'
import type { AddedGame, SchedulePreview } from '../../common/schedulePreviews'
import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import {
  chooseCalendarDate,
  hasLabel,
  tapLabel,
  tapText
} from '../../test/venueDom'
import {
  fairnessLine,
  gameTimeLabel,
  SchedulePreviewScreen
} from './SchedulePreviewScreen'

function game(key: string, overrides: Partial<PlannedGame> = {}): PlannedGame {
  return {
    key,
    seasonId: 'sea_a',
    homeTeamId: 'tem_hawks',
    awayTeamId: 'tem_owls',
    exhibition: false,
    fieldId: 'fld_one',
    size: '50/70',
    startAt: '2027-04-17T12:00:00.000Z',
    endAt: '2027-04-17T13:30:00.000Z',
    ...overrides
  }
}

function fairness(
  teamId: string,
  overrides: Partial<FairnessRow> = {}
): FairnessRow {
  return {
    teamId,
    seasonId: 'sea_a',
    exhibitionTeam: false,
    regularGames: 4,
    exhibitionGames: 1,
    mornings: 2,
    afternoons: 2,
    evenings: 1,
    weekdays: [0, 1, 0, 0, 0, 0, 4],
    shortestGapDays: 3,
    longestGapDays: 14,
    doubleheaders: 0,
    ...overrides
  }
}

function option(overrides: Partial<ScheduleOption> = {}): ScheduleOption {
  return {
    games: [
      game('g1'),
      game('g2', {
        homeTeamId: 'tem_foxes',
        awayTeamId: 'tem_otters',
        exhibition: true,
        startAt: '2027-04-24T12:00:00.000Z',
        endAt: '2027-04-24T13:30:00.000Z'
      })
    ],
    fairness: [
      fairness('tem_hawks'),
      fairness('tem_otters', {
        exhibitionTeam: true,
        regularGames: 0,
        doubleheaders: 1,
        shortestGapDays: null,
        longestGapDays: null,
        weekdays: [0, 0, 0, 0, 0, 0, 0]
      })
    ],
    reasons: [],
    unmet: [],
    score: [0],
    ...overrides
  }
}

function previewOf(overrides: Partial<SchedulePreview> = {}): SchedulePreview {
  return {
    id: 'spv_one',
    leagueId: 'lea_a',
    mode: 'full',
    existing: 'replace',
    status: 'open',
    createdAt: '2026-10-22T12:00:00.000Z',
    options: [
      option({
        unmet: [
          {
            seasonId: 'sea_a',
            message:
              'every team gets 3 of the 4 requested regular-season games',
            cause: 'not enough 50/70 field time to give every team 4 games'
          }
        ]
      }),
      option({ reasons: ['Demo Hawks plays 4 of its 5 games on Saturdays'] })
    ],
    blocking: null,
    edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
    replacing: 2,
    publishedOption: null,
    publishedAt: null,
    published: [],
    teams: [
      { id: 'tem_hawks', name: 'Demo Hawks' },
      { id: 'tem_owls', name: 'Demo Owls' },
      { id: 'tem_foxes', name: 'Demo Foxes' },
      { id: 'tem_otters', name: 'Demo Otters' }
    ],
    seasons: [
      {
        id: 'sea_a',
        name: 'Demo Regular',
        // The season's stored zone, which no time is read in.
        timezone: 'UTC',
        gameMinutes: 90,
        startsOn: '2027-03-01',
        participants: ['tem_hawks', 'tem_owls', 'tem_foxes'],
        exhibitionTeams: ['tem_otters']
      }
    ],
    fields: [
      {
        id: 'fld_one',
        name: 'Field 1',
        venueName: 'Example Park',
        sizes: ['46/60', '50/70'],
        timezone: 'America/New_York'
      }
    ],
    ...overrides
  }
}

function fakeClient(
  first: SchedulePreview | Error,
  options: { failEdit?: boolean } = {}
): {
  client: TeamStationClient
  edits: Array<{
    option: number
    rejectedGameKeys?: string[]
    addedGames?: AddedGame[]
  }>
  builds: unknown[]
  publishes: number[]
} {
  let current = first instanceof Error ? previewOf() : first
  let reads = 0
  const record = {
    edits: [] as Array<{
      option: number
      rejectedGameKeys?: string[]
      addedGames?: AddedGame[]
    }>,
    builds: [] as unknown[],
    publishes: [] as number[],
    client: undefined as unknown as TeamStationClient
  }
  record.client = {
    schedulePreview: async () => {
      reads++
      if (first instanceof Error && reads === 1) throw first
      return current
    },
    editSchedulePreview: async (
      _id: string,
      edits: {
        option: number
        rejectedGameKeys?: string[]
        addedGames?: AddedGame[]
      }
    ) => {
      record.edits.push(edits)
      if (options.failEdit === true)
        throw new Error(
          'Another game on Field 1 at Example Park is too close to this one.'
        )
      current = {
        ...current,
        edits: {
          option: edits.option,
          rejectedGameKeys: [
            ...current.edits.rejectedGameKeys,
            ...(edits.rejectedGameKeys ?? [])
          ],
          addedGames: [
            ...current.edits.addedGames,
            ...(edits.addedGames ?? []).map((item, index) => ({
              key: `added:${index}`,
              ...item
            }))
          ]
        }
      }
      return current
    },
    buildSchedulePreview: async (_leagueId: string, request: unknown) => {
      record.builds.push(request)
      return { ...current, id: 'spv_two' }
    },
    publishSchedulePreview: async (_id: string, chosen: number) => {
      record.publishes.push(chosen)
      current = {
        ...current,
        status: 'published',
        publishedOption: chosen,
        publishedAt: '2026-10-22T13:00:00.000Z',
        published: [
          { gameKey: 'g1', gameId: 'gam_1', state: 'scheduled' },
          { gameKey: 'g2', gameId: null, state: 'awaiting' }
        ]
      }
      return { preview: current, scheduled: 1, awaiting: 1, removed: 2 }
    }
  } as unknown as TeamStationClient
  return record
}

async function show(
  client: TeamStationClient,
  opened: string[] = []
): Promise<void> {
  await mount(
    <SchedulePreviewScreen
      client={client}
      leagueId="lea_a"
      previewId="spv_one"
      onOpenPreview={id => {
        opened.push(id)
      }}
    />
  )
  await settle(50)
}

describe('a schedule preview', () => {
  afterEach(unmount)
  // The viewer is in Pacific Time; Field 1 is in New York.
  const zone = process.env.TZ
  before(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  after(() => {
    if (zone == null) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('shows a time in the viewer’s zone, naming the field’s zone and start there when it differs', () => {
    expect(
      foreignZoneName(
        '2027-07-01T16:00:00.000Z',
        'America/New_York',
        'America/Los_Angeles'
      )
    ).equals('EDT')
    expect(
      foreignZoneName(
        '2027-01-01T16:00:00.000Z',
        'America/New_York',
        'America/New_York'
      )
    ).equals('')
    const noon = { startAt: '2027-07-01T16:00:00.000Z', endAt: null }
    // A Los Angeles viewer of a New York field.
    expect(gameTimeLabel(noon, 'America/New_York')).equals(
      'Thursday, July 1, 9:00 AM – 12:00 PM · 12:00 PM EDT at the field'
    )
    // A field in the viewer's own zone, or none, adds nothing.
    const range = gameTimeLabel(noon, 'America/Los_Angeles')
    expect(range).equals('Thursday, July 1, 9:00 AM – 12:00 PM')
    expect(gameTimeLabel(noon, undefined)).equals(range)
    // A start on another day there names its weekday.
    expect(
      gameTimeLabel(
        { startAt: '2027-07-02T03:30:00.000Z', endAt: '2027-07-02T05:00:00Z' },
        'Asia/Tokyo'
      )
    ).equals(
      'Thursday, July 1, 8:30 PM – 10:00 PM · Fri 12:30 PM GMT+9 at the field'
    )
    // Read by a New York viewer, the same game names no zone.
    expect(gameTimeLabel(noon, 'America/New_York', 'America/New_York')).equals(
      'Thursday, July 1, 12:00 PM – 3:00 PM'
    )
  })

  it('reads a team’s fairness plainly', () => {
    expect(fairnessLine(fairness('tem_hawks'))).equals(
      '4 regular-season games, 1 exhibition game · Mon 1, Sat 4 · 2 mornings, 2 afternoons, 1 evening · 3–14 days apart'
    )
    expect(
      fairnessLine(
        fairness('tem_otters', {
          exhibitionTeam: true,
          exhibitionGames: 3,
          weekdays: [0, 0, 0, 0, 0, 0, 0],
          shortestGapDays: null,
          longestGapDays: null,
          doubleheaders: 2
        })
      )
    ).equals(
      '3 exhibition games · no days · 2 mornings, 2 afternoons, 1 evening · 2 doubleheaders'
    )
  })

  it('loads after a failure, and shows the options, their reasons and what couldn’t be met', async () => {
    const fake = fakeClient(new Error('down'))
    await show(fake.client)
    expect(text()).includes('could not load')
    await press('Retry')
    await settle(50)
    expect(text()).includes('Option 1 · Recommended')
    expect(text()).includes('replaces 2 upcoming games')
    expect(text()).includes(
      'Demo Regular: every team gets 3 of the 4 requested regular-season games.'
    )
    expect(text()).includes(
      'Why: not enough 50/70 field time to give every team 4 games.'
    )
    expect(text()).includes('Demo Owls at Demo Hawks')
    expect(text()).includes('Demo Otters at Demo Foxes · Exhibition')
    expect(text()).includes('Field 1, Example Park · 50/70')
    // Each row reads in the viewer's time, and names the field's zone.
    expect(text()).includes(
      'Saturday, April 17, 5:00 AM – 6:30 AM · 8:00 AM EDT at the field'
    )
    await tapText('Option 2')
    expect(text()).includes('Demo Hawks plays 4 of its 5 games on Saturdays')
    expect(text()).not.includes('What couldn’t be met'.toUpperCase())
    await tapText('By team')
    expect(text()).includes('DEMO OTTERS')
    await tapText('By field')
    expect(text()).includes('FIELD 1, EXAMPLE PARK')
  })

  it('rejects a game, recalculates, and publishes', async () => {
    const fake = fakeClient(previewOf())
    const opened: string[] = []
    await show(fake.client, opened)
    const rejects = [
      ...document.querySelectorAll<HTMLElement>('[aria-label^="Reject "]')
    ]
    expect(rejects.length).equals(2)
    await tapLabel(rejects[0].getAttribute('aria-label')!)
    await settle(20)
    expect(fake.edits).deep.equals([{ option: 0, rejectedGameKeys: ['g1'] }])
    expect(text()).includes('Game rejected.')
    expect(text()).includes('1 game rejected.')
    await tapText('Recalculate')
    await settle(20)
    expect(fake.builds).deep.equals([
      { mode: 'partial', fromPreviewId: 'spv_one', option: 0 }
    ])
    expect(opened).deep.equals(['spv_two'])
    await tapText('Publish this option')
    await settle(20)
    expect(fake.publishes).deep.equals([0])
    expect(text()).includes(
      '1 game scheduled, 1 game waiting for a team’s approval, 2 games replaced.'
    )
    expect(text()).includes('Published schedule')
    expect(text()).includes('Waiting for approval')
    expect(hasLabel('Publish this option')).equals(false)
  })

  it('lists a game added after publishing with the published ones, to reject like them', async () => {
    const added = game('added:one', {
      homeTeamId: 'tem_owls',
      awayTeamId: 'tem_foxes',
      startAt: '2027-05-08T14:00:00.000Z',
      endAt: '2027-05-08T15:30:00.000Z'
    })
    const fake = fakeClient(
      previewOf({
        status: 'published',
        publishedOption: 0,
        publishedAt: '2026-10-22T13:00:00.000Z',
        edits: { option: 0, rejectedGameKeys: [], addedGames: [added] },
        published: [
          { gameKey: 'g1', gameId: 'gam_1', state: 'scheduled' },
          { gameKey: 'g2', gameId: 'gam_2', state: 'scheduled' },
          { gameKey: 'added:one', gameId: 'gam_3', state: 'scheduled' }
        ]
      })
    )
    await show(fake.client)
    const rejects = [
      ...document.querySelectorAll<HTMLElement>('[aria-label^="Reject "]')
    ].map(element => element.getAttribute('aria-label')!)
    expect(rejects.length).equals(3)
    const owls = rejects.find(
      label => label.includes('Demo Owls') && label.includes('Demo Foxes')
    )
    expect(owls).not.equals(undefined)
    await tapLabel(owls!)
    await settle(20)
    expect(fake.edits).deep.equals([
      { option: 0, rejectedGameKeys: ['added:one'] }
    ])
  })

  it('adds a game by hand, and says when it breaks a rule', async () => {
    const fake = fakeClient(previewOf(), { failEdit: true })
    await show(fake.client)
    await tapText('Add game')
    expect(text()).includes(
      'The date and start are local to the field you choose.'
    )
    await tapLabel('Home: Choose')
    await press('Demo Hawks')
    await tapLabel('Away: Choose')
    await press('Demo Owls')
    await tapLabel('Field: Choose')
    await press('Field 1, Example Park')
    await tapLabel('Size: Choose')
    await press('50/70')
    await tapLabel('Date: Choose')
    await chooseCalendarDate('2027-05-01')
    await tapLabel('Start: Choose')
    await tapLabel('Hour 10')
    await tapLabel('Minute 00')
    await tapLabel('Period AM')
    await tapText('Use time')
    // The note names the field the start is read at.
    expect(text()).includes(
      'The date and start are local to Field 1 at Example Park.'
    )
    expect(text()).not.includes('America/New_York')
    expect(text()).not.includes('Eastern Time')
    await tapLabel('Exhibition game')
    await tapLabel('Season: Demo Regular')
    await press('Demo Regular')
    // Choosing the season again clears its teams.
    await tapLabel('Home: Choose')
    await press('Demo Hawks')
    await tapLabel('Away: Choose')
    await press('Demo Owls')
    await tapText('Add this game')
    await settle(20)
    expect(fake.edits).deep.equals([
      {
        option: 0,
        addedGames: [
          {
            seasonId: 'sea_a',
            homeTeamId: 'tem_hawks',
            awayTeamId: 'tem_owls',
            exhibition: true,
            fieldId: 'fld_one',
            size: '50/70',
            // 10:00 AM in New York, Field 1's zone, though the viewer is
            // in Los Angeles, where it would be 17:00Z.
            startAt: '2027-05-01T14:00:00.000Z',
            endAt: '2027-05-01T15:30:00.000Z'
          }
        ]
      }
    ])
    expect(text()).includes('is too close to this one')
    await tapText('Cancel')
    expect(hasLabel('Home: Demo Hawks')).equals(false)
  })

  it('shows no options and no Publish when no game fits, and a discarded preview', async () => {
    await show(
      fakeClient(
        previewOf({
          options: [],
          blocking: 'not enough 50/70 field time to give every team 30 games'
        })
      ).client
    )
    expect(text()).includes(
      'No schedule fits: not enough 50/70 field time to give every team 30 games.'
    )
    expect(text()).not.includes('Option 1')
    expect(text()).not.includes('Publish this option')
    await unmount()
    await show(fakeClient(previewOf({ status: 'discarded' })).client)
    expect(text()).includes('replaced by a newer one')
    expect(text()).not.includes('Publish this option')
  })
})
