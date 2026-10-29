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
  boxTimeLabel,
  fairnessLine,
  gameTimeLabel,
  SchedulePreviewScreen
} from './SchedulePreviewScreen'

/** Whether the Add game button is on the page. */
function addGameShown(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].some(
    node => node.textContent === 'Add game'
  )
}

/** Whether Recalculate is drawn greyed out. */
function recalculateDisabled(): boolean {
  const button = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(node => node.textContent === 'Recalculate')
  expect(button, 'Recalculate').not.equals(undefined)
  return button!.getAttribute('aria-disabled') === 'true'
}

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

  it('reads a box’s time in the viewer’s zone, with the field’s when it differs', () => {
    const noon = { startAt: '2027-07-01T16:00:00.000Z' }
    // A Los Angeles viewer of a New York field.
    expect(boxTimeLabel(noon, 'America/New_York')).equals(
      '9:00 AM · 12:00 PM EDT at the field'
    )
    // The viewer's own zone, or no field, adds nothing.
    expect(boxTimeLabel(noon, 'America/Los_Angeles')).equals('9:00 AM')
    expect(boxTimeLabel(noon, undefined)).equals('9:00 AM')
    // The field's start on another day names its weekday.
    expect(
      boxTimeLabel({ startAt: '2027-07-02T03:30:00.000Z' }, 'Asia/Tokyo')
    ).equals('8:30 PM · Fri 12:30 PM GMT+9 at the field')
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
    await tapText('Option 2')
    expect(text()).includes('Demo Hawks plays 4 of its 5 games on Saturdays')
    expect(text()).not.includes('What couldn’t be met'.toUpperCase())
  })

  it('lays the games out in weeks, a row for each game on the busiest day', async () => {
    const doubleheader = game('g3', {
      homeTeamId: 'tem_foxes',
      awayTeamId: 'tem_hawks',
      startAt: '2027-04-17T18:00:00.000Z',
      endAt: '2027-04-17T19:30:00.000Z'
    })
    const late = game('g4', {
      startAt: '2027-05-11T23:00:00.000Z',
      endAt: '2027-05-12T00:30:00.000Z'
    })
    const preview = previewOf()
    await show(
      fakeClient({
        ...preview,
        options: [
          {
            ...preview.options[0],
            games: [...preview.options[0].games, doubleheader, late]
          }
        ]
      }).client
    )
    // Week 1 starts on Monday, March 1, the season's first day; the weeks
    // with no game are left out and the rest keep their numbers.
    const weeks = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="preview-week"]')
    ]
    expect(
      weeks.map(
        week =>
          week.querySelector('[data-testid="preview-week-title"]')!.textContent
      )
    ).deep.equals([
      'Week 7 · Apr 12 – Apr 18',
      'Week 8 · Apr 19 – Apr 25',
      'Week 11 · May 10 – May 16'
    ])
    // A header per day, and a second row of boxes for Saturday's second game.
    expect(weeks[0].textContent).includes('Mon · Apr · 12')
    expect(weeks[0].textContent).includes('Sat · Apr · 17')
    // The title and the day headers are the week's head, apart from its rows.
    const weekHead = weeks[0].querySelector(
      '[data-testid="preview-week-head"]'
    )!
    expect(weekHead.textContent).includes('Week 7')
    expect(weekHead.textContent).includes('Sat · Apr · 17')
    expect(weekHead.querySelector('[data-testid="preview-game"]')).equals(null)
    const rows = [
      ...weeks[0].querySelectorAll('[data-testid="preview-week-row"]')
    ]
    expect(rows.length).equals(2)
    expect(
      rows[0].querySelectorAll('[data-testid="preview-game"]').length
    ).equals(1)
    expect(rows[1].textContent).includes('Demo Foxes')
    expect(rows[1].textContent).includes('Demo Hawks @')
    // Each box: the viewer's time with the field's, the field, home and away,
    // and no date of its own.
    const first = rows[0].querySelector<HTMLElement>(
      '[data-testid="preview-game"]'
    )!
    expect(first.textContent).includes('5:00 AM · 8:00 AM EDT at the field')
    expect(first.textContent).includes('XMPL PRK/Field 1 · 50/70')
    // The away team over the home team, names as they are, no Home or Away.
    expect(first.textContent).includes('Demo Owls @Demo Hawks')
    expect(first.textContent).not.includes('Home:')
    expect(first.textContent).not.includes('Apr')
    expect(first.textContent).not.includes('EXH')
    // An exhibition game is tagged.
    expect(weeks[1].textContent).includes('EXH')
    // EXH is at the bottom right, beside the home team.
    const exhibition = weeks[1].querySelector<HTMLElement>(
      '[aria-label="Exhibition"]'
    )!
    expect(exhibition.previousElementSibling!.textContent).equals('Demo Foxes')
    expect(
      exhibition.parentElement!.nextElementSibling!.getAttribute('aria-label')
    ).matches(/^Reject /)
    expect(weeks[1].textContent).includes('Demo Foxes')
    // A Tuesday 4:00 PM game in Los Angeles sits under Tuesday.
    expect(weeks[2].textContent).includes('4:00 PM · 7:00 PM EDT at the field')
  })

  it('filters by season, team and field, the rows following the season', async () => {
    const summer = game('g5', {
      seasonId: 'sea_b',
      homeTeamId: 'tem_bears',
      awayTeamId: 'tem_hawks',
      fieldId: 'fld_two',
      startAt: '2027-06-12T16:00:00.000Z',
      endAt: '2027-06-12T17:30:00.000Z'
    })
    const preview = previewOf()
    await show(
      fakeClient({
        ...preview,
        options: [
          {
            ...preview.options[0],
            games: [...preview.options[0].games, summer]
          }
        ],
        teams: [...preview.teams, { id: 'tem_bears', name: 'Demo Bears' }],
        seasons: [
          ...preview.seasons,
          {
            id: 'sea_b',
            name: 'Demo Summer',
            timezone: 'UTC',
            gameMinutes: 90,
            startsOn: '2027-06-01',
            participants: ['tem_bears', 'tem_hawks'],
            exhibitionTeams: []
          }
        ],
        fields: [
          ...preview.fields,
          {
            id: 'fld_two',
            name: 'TB1',
            venueName: 'Morley Field Sports Complex',
            sizes: ['46/60'],
            timezone: 'America/Los_Angeles'
          }
        ]
      }).client
    )
    const boxes = (): number =>
      document.querySelectorAll('[data-testid="preview-game"]').length
    const tabs = (row: string): string[] =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[aria-label="${row}"] [role="tab"]`
        )
      ].map(tab => tab.textContent!)
    expect(boxes()).equals(3)
    expect(tabs('Seasons')).deep.equals([
      'All seasons',
      'Demo Regular',
      'Demo Summer'
    ])
    expect(tabs('Teams')).deep.equals([
      'All teams',
      'Demo Bears',
      'Demo Foxes',
      'Demo Hawks',
      'Demo Otters',
      'Demo Owls'
    ])
    expect(tabs('Fields')).deep.equals([
      'All fields',
      'MFS/TB1',
      'XMPL PRK/Field 1'
    ])
    // A season offers its own teams, and only the fields its games use.
    await tapText('Demo Summer')
    expect(tabs('Teams')).deep.equals(['All teams', 'Demo Bears', 'Demo Hawks'])
    expect(tabs('Fields')).deep.equals(['All fields', 'MFS/TB1'])
    expect(boxes()).equals(1)
    // Its weeks count from its own first day, Tuesday, June 1.
    expect(text()).includes('Week 2 · Jun 7 – Jun 13')
    // A team and a field narrow it together.
    await tapText('All seasons')
    await tapText('Demo Hawks')
    expect(boxes()).equals(2)
    await tapText('XMPL PRK/Field 1')
    expect(boxes()).equals(1)
    // A season without the chosen field puts the field back to all.
    await tapText('Demo Summer')
    expect(boxes()).equals(1)
    expect(
      document.querySelector('[aria-label="Fields"] [aria-selected="true"]')!
        .textContent
    ).equals('All fields')
    // A team the season does not have goes back to all.
    await tapText('All seasons')
    await tapText('Demo Otters')
    await tapText('Demo Summer')
    expect(
      document.querySelector('[aria-label="Teams"] [aria-selected="true"]')!
        .textContent
    ).equals('All teams')
  })

  it('keeps a filter put back to all when its field gets a game again', async () => {
    const other = game('g5', {
      fieldId: 'fld_two',
      startAt: '2027-05-01T16:00:00.000Z',
      endAt: '2027-05-01T17:30:00.000Z'
    })
    const preview = previewOf()
    const fake = fakeClient({
      ...preview,
      options: [
        { ...preview.options[0], games: [preview.options[0].games[0], other] },
        { ...preview.options[1], games: [preview.options[1].games[0], other] }
      ],
      fields: [
        ...preview.fields,
        {
          id: 'fld_two',
          name: 'TB1',
          venueName: 'Morley Field Sports Complex',
          sizes: ['46/60'],
          timezone: 'America/Los_Angeles'
        }
      ]
    })
    await show(fake.client)
    const chosenField = (): string =>
      document.querySelector('[aria-label="Fields"] [aria-selected="true"]')!
        .textContent!
    // Under a season the Fields row offers only the fields its games use.
    await tapText('Demo Regular')
    await tapText('MFS/TB1')
    expect(chosenField()).equals('MFS/TB1')
    // Rejecting the field's last game puts the row back to all fields.
    await tapLabel(
      document
        .querySelector<HTMLElement>('[aria-label^="Reject "]')!
        .getAttribute('aria-label')!
    )
    await tapText('Reject')
    await settle(20)
    expect(chosenField()).equals('All fields')
    // Another option that uses the field again offers it, at all fields.
    await tapText('Option 2')
    expect(
      [...document.querySelectorAll('[aria-label="Fields"] [role="tab"]')].map(
        tab => tab.textContent
      )
    ).includes('MFS/TB1')
    expect(chosenField()).equals('All fields')
  })

  it('does not reject while a publish is on its way', async () => {
    const fake = fakeClient(previewOf())
    let finish: () => void = () => undefined
    const publish = fake.client.publishSchedulePreview.bind(fake.client)
    fake.client.publishSchedulePreview = async (id, chosen) => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return await publish(id, chosen)
    }
    await show(fake.client)
    await tapText('Publish this option')
    const reject = document.querySelector<HTMLElement>(
      '[aria-label^="Reject "]'
    )!
    expect(reject.getAttribute('aria-disabled')).equals('true')
    finish()
    await settle(20)
    expect(text()).includes('Published schedule')
  })

  it('says when no game matches, and shows fairness one season at a time', async () => {
    const preview = previewOf()
    await show(
      fakeClient({
        ...preview,
        options: [
          {
            ...preview.options[0],
            games: [preview.options[0].games[0]],
            fairness: [
              ...preview.options[0].fairness,
              fairness('tem_bears', { seasonId: 'sea_b' })
            ]
          }
        ],
        seasons: [
          ...preview.seasons,
          {
            id: 'sea_b',
            name: 'Demo Summer',
            timezone: 'UTC',
            gameMinutes: 90,
            startsOn: '2027-06-01',
            participants: ['tem_bears'],
            exhibitionTeams: []
          }
        ],
        teams: [...preview.teams, { id: 'tem_bears', name: 'Demo Bears' }]
      }).client
    )
    await tapText('Demo Otters')
    expect(text()).includes('No games match these filters.')
    await tapText('Fairness')
    expect(addGameShown()).equals(false)
    expect(text()).not.includes('No games match')
    // The first season shows first, then another's pill shows only its rows.
    const rows = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('[aria-label*=": "]')]
        .map(row => row.getAttribute('aria-label')!)
        .filter(row => !row.startsWith('Reject '))
    expect(rows()).deep.equals([
      `Demo Hawks: ${fairnessLine(fairness('tem_hawks'))}`,
      `Demo Otters: ${fairnessLine(preview.options[0].fairness[1])}`
    ])
    await tapText('Demo Summer')
    expect(rows()).deep.equals([
      `Demo Bears: ${fairnessLine(fairness('tem_bears'))}`
    ])
    await tapText('Schedule')
    expect(addGameShown()).equals(true)
  })

  it('confirms a reject, then recalculates once there is an edit, and publishes', async () => {
    const fake = fakeClient(previewOf())
    const opened: string[] = []
    await show(fake.client, opened)
    // Drawn, and greyed out until an edit.
    expect(recalculateDisabled()).equals(true)
    const rejects = [
      ...document.querySelectorAll<HTMLElement>('[aria-label^="Reject "]')
    ]
    expect(rejects.length).equals(2)
    const label = rejects[0].getAttribute('aria-label')!
    expect(label).equals(
      'Reject Demo Owls at Demo Hawks, Saturday, April 17, 5:00 AM – 6:30 AM · 8:00 AM EDT at the field'
    )
    // A 44-point target drawn over the box's top right corner, inside it.
    const target = getComputedStyle(rejects[0])
    expect([
      target.position,
      target.top,
      target.right,
      target.width,
      target.height
    ]).deep.equals(['absolute', '0px', '0px', '44px', '44px'])
    expect(rejects[0].parentElement!.getAttribute('data-testid')).equals(
      'preview-game'
    )
    expect(rejects[0].parentElement!.lastElementChild).equals(rejects[0])
    // Cancel keeps the game.
    await tapLabel(label)
    expect(text()).includes('Reject this game?')
    expect(text()).includes(
      'Recalculate places it again; everything else stays.'
    )
    await tapText('Cancel')
    await settle(20)
    expect(fake.edits).deep.equals([])
    expect(recalculateDisabled()).equals(true)
    // Reject removes it, and Recalculate can run.
    await tapLabel(label)
    await tapText('Reject')
    await settle(20)
    expect(fake.edits).deep.equals([{ option: 0, rejectedGameKeys: ['g1'] }])
    expect(text()).includes('Game rejected.')
    // How many are left to place again stays said, beside Publish.
    expect(text()).includes(
      '1 game rejected. Recalculate to place them again; everything else stays.'
    )
    expect(document.querySelectorAll('[aria-label^="Reject "]').length).equals(
      1
    )
    expect(recalculateDisabled()).equals(false)
    // Another option has no edit of its own.
    await tapText('Option 2')
    expect(recalculateDisabled()).equals(true)
    await tapText('Option 1 · Recommended')
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
    // A published preview is not recalculated.
    expect(recalculateDisabled()).equals(true)
  })

  it('enables Recalculate for an added game, and says a failed reject in its sheet', async () => {
    const added = game('added:0', { startAt: '2027-05-08T14:00:00.000Z' })
    const fake = fakeClient(
      previewOf({
        edits: { option: 0, rejectedGameKeys: [], addedGames: [added] }
      }),
      { failEdit: true }
    )
    await show(fake.client)
    expect(recalculateDisabled()).equals(false)
    await tapLabel(
      document
        .querySelector<HTMLElement>('[aria-label^="Reject "]')!
        .getAttribute('aria-label')!
    )
    await tapText('Reject')
    await settle(20)
    expect(text()).includes('is too close to this one')
    expect(text()).includes('Reject this game?')
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
          { gameKey: 'g2', gameId: 'gam_2', state: 'needsRescheduling' },
          { gameKey: 'added:one', gameId: 'gam_3', state: 'scheduled' }
        ]
      })
    )
    await show(fake.client)
    // An edit to a published preview does not make it recalculable.
    expect(recalculateDisabled()).equals(true)
    const rejects = [
      ...document.querySelectorAll<HTMLElement>('[aria-label^="Reject "]')
    ].map(element => element.getAttribute('aria-label')!)
    // A game already listed for rescheduling has no ✕.
    expect(rejects.length).equals(2)
    expect(text()).includes('Needs rescheduling')
    const owls = rejects.find(
      label => label.includes('Demo Owls') && label.includes('Demo Foxes')
    )
    expect(owls).not.equals(undefined)
    await tapLabel(owls!)
    expect(text()).includes('It is listed for rescheduling.')
    await tapText('Reject')
    await settle(20)
    expect(fake.edits).deep.equals([
      { option: 0, rejectedGameKeys: ['added:one'] }
    ])
    expect(text()).includes('Game rejected. It is listed for rescheduling.')
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
    expect(recalculateDisabled()).equals(true)
    await unmount()
    await show(
      fakeClient(
        previewOf({
          status: 'discarded',
          edits: { option: 0, rejectedGameKeys: ['g1'], addedGames: [] }
        })
      ).client
    )
    expect(text()).includes('replaced by a newer one')
    expect(text()).not.includes('Publish this option')
    // A discarded preview is not recalculated, edited or not.
    expect(recalculateDisabled()).equals(true)
  })
})
