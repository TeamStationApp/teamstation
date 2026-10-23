import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { Keyboard, Platform } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type {
  GameToReschedule,
  PreviewRequest
} from '../../common/schedulePreviews'
import type {
  ScheduleSettings,
  ScheduleSetup,
  ScheduleSetupChoice,
  SetupField,
  SetupSeason
} from '../../common/seasonScheduling'
import type { VenueSummary } from '../../common/venues'
import { CoverableScene, coverAndReveal } from '../../test/coverableScene'
import {
  fill,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import {
  hasLabel,
  tapLabel,
  tapText,
  venueDetail,
  venueField
} from '../../test/venueDom'
import {
  AutoSchedulerScreen,
  chosenSeasons,
  setupFieldDetail
} from './AutoSchedulerScreen'
import { seasonGameTotal } from './SeasonScheduleGrid'

const SETTINGS: ScheduleSettings = {
  fieldSize: '50/70',
  gameMinutes: 90,
  bufferMinutes: 10,
  regularGames: 3,
  exhibitionGames: 1,
  doubleheaders: 'ifNecessary',
  startsOn: '2027-03-01',
  endsOn: '2027-07-31',
  blackouts: [],
  windows: [
    {
      from: '2027-03-01',
      hours: [{ weekday: 6, start: '08:00', end: '18:00' }]
    }
  ]
}

function season(overrides: Partial<SetupSeason> = {}): SetupSeason {
  return {
    id: 'sea_a',
    name: 'Demo Regular',
    year: 2027,
    timezone: 'America/New_York',
    participants: 7,
    exhibitionTeams: 2,
    teams: [],
    saved: true,
    settings: SETTINGS,
    ...overrides
  }
}

function field(overrides: Partial<SetupField> = {}): SetupField {
  return {
    id: 'fld_one',
    name: 'Field 1',
    venueId: 'ven_demo',
    venueName: 'Example Park',
    sizes: ['50/70'],
    startsOn: null,
    endsOn: null,
    deleted: false,
    ours: true,
    ownerNames: ['Demo League A'],
    ...overrides
  }
}

/** Harbor Diamond, at a venue nobody has claimed. */
const HARBOR_DIAMOND = field({
  id: 'fld_harbor',
  name: 'Harbor Diamond',
  venueId: 'ven_harbor',
  venueName: 'Harbor Field',
  sizes: ['50/70', '60/90'],
  ours: false,
  ownerNames: []
})

const HARBOR: VenueSummary = {
  id: 'ven_harbor',
  placeId: 'harbor-field',
  name: 'Harbor Field',
  address: '1 Demo Way, Demo City',
  owners: [],
  pendingClaim: false,
  claimed: false,
  group: 'unclaimed',
  distanceKm: null
}

function setupOf(overrides: Partial<ScheduleSetup> = {}): ScheduleSetup {
  return {
    leagueId: 'lea_a',
    seasonIds: ['sea_a'],
    fieldIds: ['fld_one'],
    addedFieldIds: [],
    seasons: [
      season(),
      season({
        id: 'sea_c',
        name: 'Demo Fall',
        participants: 4,
        exhibitionTeams: 0,
        saved: false,
        settings: { ...SETTINGS, fieldSize: '55/80', exhibitionGames: 0 }
      })
    ],
    fields: [field()],
    ...overrides
  }
}

function fakeClient(
  first: ScheduleSetup | Error,
  options: {
    failSave?: boolean
    failChoice?: boolean
    existing?: number
    failBuild?: boolean
    listed?: GameToReschedule[]
    /** Fields of other venues, listed once chosen, as the server does. */
    registry?: SetupField[]
    /** What the first settings save waits for before it answers. */
    holdFirstSave?: Promise<void>
    /**
     * What each setup choice waits for before it answers. Its answer has
     * the seasons' first settings, as a choice read before a save would.
     */
    holdChoice?: Promise<void>
  } = {}
): {
  client: TeamStationClient
  /** Each request as it went out: a settings save or a build. */
  sent: Array<'save' | 'build' | 'fieldManager'>
  choices: ScheduleSetupChoice[]
  saves: Array<[string, ScheduleSettings]>
  /** Anything a save sent beyond the season and its settings. */
  extras: unknown[][]
  builds: PreviewRequest[]
} {
  let setup = first instanceof Error ? setupOf() : first
  let reads = 0
  const record = {
    sent: [] as Array<'save' | 'build' | 'fieldManager'>,
    choices: [] as ScheduleSetupChoice[],
    saves: [] as Array<[string, ScheduleSettings]>,
    extras: [] as unknown[][],
    builds: [] as PreviewRequest[],
    client: undefined as unknown as TeamStationClient
  }
  record.client = {
    venues: async () => [HARBOR],
    venue: async () =>
      venueDetail({
        id: 'ven_harbor',
        placeId: 'harbor-field',
        name: 'Harbor Field',
        address: '1 Demo Way, Demo City',
        fields: [
          venueField({
            id: 'fld_harbor',
            name: 'Harbor Diamond',
            sizes: ['50/70', '60/90']
          })
        ]
      }),
    gamesToReschedule: async () => options.listed ?? [],
    buildSchedulePreview: async (
      _leagueId: string,
      request: PreviewRequest
    ) => {
      record.sent.push('build')
      record.builds.push(request)
      if (options.failBuild === true) throw new Error('The engine stopped')
      if (options.existing != null && request.existing == null)
        throw new HttpError(
          'conflict',
          'These seasons already have upcoming games',
          {
            existingGames: options.existing
          }
        )
      return { id: 'spv_one' }
    },
    scheduleSetup: async () => {
      reads++
      if (first instanceof Error && reads === 1) throw first
      return setup
    },
    saveScheduleSetup: async (
      _leagueId: string,
      choice: ScheduleSetupChoice
    ) => {
      record.choices.push(choice)
      await options.holdChoice
      if (options.failChoice === true)
        throw new Error('Choose fields that exist')
      // As the server lists them: the league's own fields, every added
      // one, checked or not, and every chosen one, by venue and field.
      const addedFieldIds = choice.addedFieldIds ?? setup.addedFieldIds
      const known = [...setup.fields, ...(options.registry ?? [])]
        .filter(
          (item, index, all) => all.findIndex(o => o.id === item.id) === index
        )
        .sort((a, b) =>
          a.venueName === b.venueName
            ? a.name.localeCompare(b.name)
            : a.venueName.localeCompare(b.venueName)
        )
      setup = {
        ...setup,
        seasonIds: choice.seasonIds,
        fieldIds: choice.fieldIds,
        addedFieldIds,
        fields: known.filter(
          item =>
            item.ours ||
            choice.fieldIds.includes(item.id) ||
            addedFieldIds.includes(item.id)
        )
      }
      return setup
    },
    saveScheduleSettings: async (
      seasonId: string,
      settings: ScheduleSettings,
      ...extra: unknown[]
    ) => {
      record.sent.push('save')
      record.saves.push([seasonId, settings])
      record.extras.push(extra)
      if (record.saves.length === 1) await options.holdFirstSave
      if (options.failSave === true) throw new Error('')
      return { seasonId, saved: true, settings }
    }
  } as unknown as TeamStationClient
  return record
}

async function show(
  client: TeamStationClient,
  calls: { fieldManager: number; seasons: string[]; builds: number }
): Promise<void> {
  await mount(
    <AutoSchedulerScreen
      client={client}
      leagueId="lea_a"
      leagueName="Demo League A"
      onFieldManager={() => {
        calls.fieldManager++
      }}
      onOpenSeason={seasonId => {
        calls.seasons.push(seasonId)
      }}
      onOpenPreview={() => {
        calls.builds++
      }}
    />
  )
  await settle(50)
}

const buildButton = (): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node => node.textContent === 'Build schedule'
  )!

async function key(name: string): Promise<void> {
  await act(async () => {
    document.querySelector('input')!.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true
      })
    )
  })
  await settle(20)
}

const disabled = (node: HTMLElement): boolean =>
  node.getAttribute('aria-disabled') === 'true'

describe('the Auto-Scheduler setup', () => {
  afterEach(unmount)
  // The viewer is in Pacific Time.
  const zone = process.env.TZ
  before(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  after(() => {
    if (zone == null) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('totals a season’s games', () => {
    expect(seasonGameTotal(season())).equals(10 + 7)
    expect(seasonGameTotal(season({ exhibitionTeams: 0 }))).equals(10)
    expect(chosenSeasons(setupOf()).map(item => item.id)).deep.equals(['sea_a'])
  })

  it('loads after a failure, and shows the grid, warnings and fields', async () => {
    const fake = fakeClient(new Error('down'))
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    expect(text()).includes('could not load')
    await press('Retry')
    await settle(50)
    expect(text()).includes('Demo League A')
    expect(
      hasLabel('Demo Regular Teams: 7 teams and 2 exhibition teams')
    ).equals(true)
    expect(hasLabel('Demo Regular Size: 50/70')).equals(true)
    expect(hasLabel('Demo Regular Total games: 17')).equals(true)
    expect(hasLabel('Demo Regular Doubleheaders: Only if necessary')).equals(
      true
    )
    expect(hasLabel('Demo Regular Dates: Mar 1 – Jul 31')).equals(true)
    expect(hasLabel('Demo Regular Blackouts: None')).equals(true)
    expect(hasLabel('Demo Regular Windows: 1 period')).equals(true)
    expect(text()).includes('an odd number')
    expect(text()).includes('4 for one, 3 for the other')
    expect(disabled(buildButton())).equals(false)
    await tapText('Build schedule')
    await settle(20)
    expect(calls.builds).equals(1)
    await tapLabel('Open the Field Manager')
    await press(
      'Field Manager, Find, claim and set up the venues and fields your league plays on'
    )
    expect(calls.fieldManager).equals(2)
    await tapLabel('Open Demo Regular')
    await tapLabel('Demo Regular Windows: 1 period')
    await tapLabel('Demo Regular Blackouts: None')
    await tapLabel('Demo Regular Teams: 7 teams and 2 exhibition teams')
    expect(calls.seasons).deep.equals(['sea_a', 'sea_a', 'sea_a', 'sea_a'])
  })

  it('chooses seasons and fields, and blocks building without a field of the size', async () => {
    const fake = fakeClient(setupOf())
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Demo Fall')
    await settle(20)
    expect(fake.choices.at(-1)).deep.equals({
      seasonIds: ['sea_a', 'sea_c'],
      fieldIds: ['fld_one'],
      addedFieldIds: []
    })
    expect(text()).includes(
      'Must fix: Demo Fall has no chosen field that sets up as 55/80.'
    )
    expect(disabled(buildButton())).equals(true)
    await tapLabel('Demo Fall')
    await settle(20)
    expect(fake.choices.at(-1)?.seasonIds).deep.equals(['sea_a'])
    expect(disabled(buildButton())).equals(false)
    await tapLabel('Field 1, Example Park')
    await settle(20)
    expect(fake.choices.at(-1)?.fieldIds).deep.equals([])
    expect(disabled(buildButton())).equals(true)
  })

  it('reads the setup again on coming back, so a cell’s save keeps what the season’s screen saved', async () => {
    const fake = fakeClient(setupOf())
    await mount(
      <CoverableScene>
        <AutoSchedulerScreen
          client={fake.client}
          leagueId="lea_a"
          leagueName="Demo League A"
          onFieldManager={() => undefined}
          onOpenSeason={() => undefined}
          onOpenPreview={() => undefined}
        />
      </CoverableScene>
    )
    await settle(50)
    // Windows, on the season's own screen, pushed over this one.
    const blackouts = ['2027-05-01']
    await coverAndReveal(() => {
      fake.client.scheduleSetup = async () =>
        setupOf({
          seasons: [season({ settings: { ...SETTINGS, blackouts } })]
        })
    })
    await settle(50)
    await tapLabel('Demo Regular Game length in minutes: 90')
    await fill('Edit Demo Regular Game length in minutes', '75')
    await key('Enter')
    expect(fake.saves.at(-1)?.[1].gameMinutes).equals(75)
    expect(fake.saves.at(-1)?.[1].blackouts).deep.equals(blackouts)
  })

  it('keeps a cell’s save that lands while that read is on its way', async () => {
    const fake = fakeClient(setupOf())
    await mount(
      <CoverableScene>
        <AutoSchedulerScreen
          client={fake.client}
          leagueId="lea_a"
          leagueName="Demo League A"
          onFieldManager={() => undefined}
          onOpenSeason={() => undefined}
          onOpenPreview={() => undefined}
        />
      </CoverableScene>
    )
    await settle(50)
    let answer: () => void = () => undefined
    await coverAndReveal(() => {
      const read = fake.client.scheduleSetup.bind(fake.client)
      // Read before the cell's save, and answering after it.
      fake.client.scheduleSetup = async leagueId => {
        const found = await read(leagueId)
        await new Promise<void>(resolve => {
          answer = resolve
        })
        return found
      }
    })
    await tapLabel('Demo Regular Game length in minutes: 90')
    await fill('Edit Demo Regular Game length in minutes', '75')
    await key('Enter')
    expect(fake.saves.at(-1)?.[1].gameMinutes).equals(75)
    await act(async () => {
      answer()
    })
    await settle(50)
    expect(hasLabel('Demo Regular Game length in minutes: 75')).equals(true)
  })

  it('edits a size, doubleheaders, a number and the dates from the grid', async () => {
    const fake = fakeClient(setupOf())
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Demo Regular Size: 50/70')
    await press('60/90')
    await settle(20)
    expect(fake.saves.at(-1)?.[1].fieldSize).equals('60/90')
    expect(hasLabel('Demo Regular Size: 60/90')).equals(true)
    await tapLabel('Demo Regular Doubleheaders: Only if necessary')
    await press('Never')
    await settle(20)
    expect(fake.saves.at(-1)?.[1].doubleheaders).equals('never')
    await tapLabel('Demo Regular Game length in minutes: 90')
    await fill('Edit Demo Regular Game length in minutes', '92')
    await key('Enter')
    expect(text()).includes('Game MINS: choose 30 to 600, in 5-minute steps.')
    await fill('Edit Demo Regular Game length in minutes', '')
    await key('Enter')
    expect(text()).includes('Game MINS: choose 30 to 600')
    await fill('Edit Demo Regular Game length in minutes', '75')
    await key('Enter')
    expect(fake.saves.at(-1)?.[1].gameMinutes).equals(75)
    expect(hasLabel('Demo Regular Game length in minutes: 75')).equals(true)
    // Each cell's save sends the season's other settings unchanged.
    await tapLabel('Demo Regular Regular-season games: 3')
    await fill('Edit Demo Regular Regular-season games', '4')
    await key('Tab')
    expect(fake.saves.at(-1)).deep.equals([
      'sea_a',
      {
        ...SETTINGS,
        fieldSize: '60/90',
        doubleheaders: 'never',
        gameMinutes: 75,
        regularGames: 4
      }
    ])
    expect(text()).not.includes('an odd number')
    // Tab opened # Exhibition; Escape leaves it as it was.
    expect(hasLabel('Edit Demo Regular Exhibition games')).equals(true)
    await key('Escape')
    expect(hasLabel('Demo Regular Exhibition games: 1')).equals(true)
    // No dialog opens for a number.
    expect(text()).not.includes('Game length, in minutes')
    await tapLabel('Demo Regular Dates: Mar 1 – Jul 31')
    await tapLabel('2027-03-08')
    await tapLabel('2027-03-20')
    await tapText('Use this range')
    await settle(20)
    expect(fake.saves.at(-1)?.[1]).deep.include({
      startsOn: '2027-03-08',
      endsOn: '2027-03-20'
    })
    await tapLabel('Demo Regular Dates: Mar 8 – Mar 20')
    await tapText('Cancel')
    expect(fake.saves.length).equals(5)
  })

  it('saves and builds a season at the UTC default with no zone, as every other', async () => {
    const fake = fakeClient(
      setupOf({
        seasons: [
          season({ timezone: 'UTC' }),
          season({ id: 'sea_c', name: 'Demo Fall' })
        ],
        seasonIds: ['sea_a', 'sea_c']
      })
    )
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Demo Regular Game length in minutes: 90')
    await fill('Edit Demo Regular Game length in minutes', '75')
    await key('Enter')
    await tapLabel('Demo Regular Regular-season games: 3')
    await fill('Edit Demo Regular Regular-season games', '4')
    await key('Enter')
    await tapLabel('Demo Fall Game length in minutes: 90')
    await fill('Edit Demo Fall Game length in minutes', '80')
    await key('Enter')
    expect(fake.saves.map(([seasonId]) => seasonId)).deep.equals([
      'sea_a',
      'sea_a',
      'sea_c'
    ])
    // A season is only dates: no save or build names a zone.
    expect(fake.extras).deep.equals([[], [], []])
    for (const [, saved] of fake.saves)
      expect(saved).not.have.property('timezone')
    await tapText('Build schedule')
    await settle(20)
    expect(fake.builds).deep.equals([{ mode: 'full' }])
  })

  it('saves a sheet’s choice after a cell’s save still in flight, onto what that save stored', async () => {
    let release = (): void => undefined
    const fake = fakeClient(
      setupOf({ seasons: [season({ timezone: 'UTC' })] }),
      {
        holdFirstSave: new Promise(resolve => {
          release = resolve
        })
      }
    )
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Demo Regular Game length in minutes: 90')
    await fill('Edit Demo Regular Game length in minutes', '75')
    await key('Enter')
    // The cell's save is still on its way when the size is chosen.
    await tapLabel('Demo Regular Size: 50/70')
    await press('60/90')
    await settle(20)
    expect(fake.saves).length(1)
    release()
    await settle(50)
    expect(fake.saves).deep.equals([
      ['sea_a', { ...SETTINGS, gameMinutes: 75 }],
      ['sea_a', { ...SETTINGS, gameMinutes: 75, fieldSize: '60/90' }]
    ])
    expect(fake.extras).deep.equals([[], []])
    expect(hasLabel('Demo Regular Game length in minutes: 75')).equals(true)
    expect(hasLabel('Demo Regular Size: 60/90')).equals(true)
  })

  it('builds only after a cell’s save still in flight, and on what it stored', async () => {
    let release = (): void => undefined
    const fake = fakeClient(setupOf(), {
      holdFirstSave: new Promise(resolve => {
        release = resolve
      })
    })
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Demo Regular Game length in minutes: 90')
    await fill('Edit Demo Regular Game length in minutes', '75')
    await key('Enter')
    // Build is tapped while the cell's save is still on its way.
    expect(disabled(buildButton())).equals(false)
    await tapText('Build schedule')
    await settle(20)
    expect(fake.saves).length(1)
    expect(fake.builds).deep.equals([])
    release()
    await settle(50)
    expect(fake.builds).deep.equals([{ mode: 'full' }])
    expect(calls.builds).equals(1)
  })

  it('checks a build again on what a cell’s save in flight stored', async () => {
    let release = (): void => undefined
    const fake = fakeClient(
      setupOf({
        seasons: [season({ settings: { ...SETTINGS, exhibitionGames: 0 } })]
      }),
      {
        holdFirstSave: new Promise(resolve => {
          release = resolve
        })
      }
    )
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Demo Regular Regular-season games: 3')
    await fill('Edit Demo Regular Regular-season games', '0')
    await key('Enter')
    await tapText('Build schedule')
    await settle(20)
    release()
    await settle(50)
    // No games left to schedule: nothing is built.
    expect(fake.saves.at(-1)?.[1].regularGames).equals(0)
    expect(fake.builds).deep.equals([])
    expect(text()).includes('Must fix: Demo Regular has no games to schedule.')
    expect(disabled(buildButton())).equals(true)
  })

  it('keeps a cell’s save that lands while a choice is on its way, when the choice answers last', async () => {
    let releaseSave = (): void => undefined
    let releaseChoice = (): void => undefined
    const fake = fakeClient(
      setupOf({
        fields: [field(), field({ id: 'fld_two', name: 'Field 2' })]
      }),
      {
        holdFirstSave: new Promise(resolve => {
          releaseSave = resolve
        }),
        holdChoice: new Promise(resolve => {
          releaseChoice = resolve
        })
      }
    )
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Demo Regular Regular-season games: 3')
    await fill('Edit Demo Regular Regular-season games', '8')
    await key('Enter')
    // A field is checked while the cell's save is on its way; the choice
    // reads the old count, and answers after the save.
    await tapLabel('Field 2, Example Park')
    await settle(20)
    expect(fake.choices.at(-1)?.fieldIds).deep.equals(['fld_one', 'fld_two'])
    releaseSave()
    await settle(50)
    expect(hasLabel('Demo Regular Regular-season games: 8')).equals(true)
    releaseChoice()
    await settle(50)
    expect(hasLabel('Demo Regular Regular-season games: 8')).equals(true)
    expect(hasLabel('Demo Regular Total games: 35')).equals(true)
  })

  it('saves a cell still open before a native build or a season’s screen, and goes nowhere when it refuses', async () => {
    // A native tap on a button leaves the cell focused: no blur saves it.
    const was = Platform.OS
    try {
      Platform.OS = 'ios'
      const fake = fakeClient(setupOf(), {
        listed: [
          {
            previewId: 'spv_old',
            gameKey: 'g1',
            gameId: 'gam_1',
            seasonId: 'sea_a',
            homeTeamId: 'tem_hawks',
            awayTeamId: 'tem_owls',
            homeTeamName: 'Demo Hawks',
            awayTeamName: 'Demo Owls',
            startAt: '2027-04-17T14:00:00.000Z',
            endAt: '2027-04-17T15:30:00.000Z',
            timezone: 'America/New_York',
            exhibition: false,
            fieldId: null,
            reason: 'declined'
          }
        ]
      })
      const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
      await show(fake.client, calls)
      await tapLabel('Demo Regular Game length in minutes: 90')
      await fill('Edit Demo Regular Game length in minutes', '75')
      await tapText('Build schedule')
      await settle(50)
      expect(fake.sent).deep.equals(['save', 'build'])
      expect(fake.saves[0][1].gameMinutes).equals(75)
      expect(calls.builds).equals(1)
      // A refused number keeps the cell open, and nothing is built or opened.
      await tapLabel('Demo Regular Game length in minutes: 75')
      await fill('Edit Demo Regular Game length in minutes', '77')
      await tapText('Build schedule')
      await settle(20)
      await tapText('Recalculate just these teams')
      await settle(20)
      await tapLabel('Open Demo Regular')
      await settle(20)
      expect(fake.sent).deep.equals(['save', 'build'])
      expect(text()).includes('Game MINS: choose')
      expect(calls.seasons).deep.equals([])
      // Fixed, it saves before the season's screen opens.
      await fill('Edit Demo Regular Game length in minutes', '80')
      await tapLabel('Open Demo Regular')
      await settle(50)
      expect(fake.sent).deep.equals(['save', 'build', 'save'])
      expect(fake.saves[1][1].gameMinutes).equals(80)
      expect(calls.seasons).deep.equals(['sea_a'])
      // And before a recalculation.
      await tapLabel('Demo Regular Game length in minutes: 80')
      await fill('Edit Demo Regular Game length in minutes', '85')
      await tapText('Recalculate everything')
      await settle(50)
      expect(fake.sent).deep.equals(['save', 'build', 'save', 'save', 'build'])
      expect(fake.saves[2][1].gameMinutes).equals(85)
      expect(calls.builds).equals(2)
    } finally {
      Platform.OS = was
    }
  })

  it('saves a cell still open before either native Field Manager action, and goes nowhere when it refuses', async () => {
    // A native tap on a button leaves the cell focused, and the Field
    // Manager's screen replaces this one with no blur to save it.
    const was = Platform.OS
    try {
      Platform.OS = 'ios'
      const fake = fakeClient(setupOf())
      await mount(
        <AutoSchedulerScreen
          client={fake.client}
          leagueId="lea_a"
          leagueName="Demo League A"
          onFieldManager={() => {
            fake.sent.push('fieldManager')
          }}
          onOpenSeason={() => undefined}
          onOpenPreview={() => undefined}
        />
      )
      await settle(50)
      const row =
        'Field Manager, Find, claim and set up the venues and fields your league plays on'
      // The header's action saves the cell, then opens the Field Manager.
      await tapLabel('Demo Regular Game length in minutes: 90')
      await fill('Edit Demo Regular Game length in minutes', '75')
      await tapLabel('Open the Field Manager')
      await settle(50)
      expect(fake.sent).deep.equals(['save', 'fieldManager'])
      expect(fake.saves[0][1].gameMinutes).equals(75)
      // A refused number keeps the cell open, and neither action leaves.
      await tapLabel('Demo Regular Game length in minutes: 75')
      await fill('Edit Demo Regular Game length in minutes', '77')
      await tapLabel('Open the Field Manager')
      await settle(20)
      await press(row)
      await settle(20)
      expect(fake.sent).deep.equals(['save', 'fieldManager'])
      expect(text()).includes('Game MINS: choose')
      // Fixed, the row saves it before the Field Manager opens.
      await fill('Edit Demo Regular Game length in minutes', '80')
      await press(row)
      await settle(50)
      expect(fake.sent).deep.equals([
        'save',
        'fieldManager',
        'save',
        'fieldManager'
      ])
      expect(fake.saves[1][1].gameMinutes).equals(80)
    } finally {
      Platform.OS = was
    }
  })

  it('scrolls the screen to lift an open cell the phone’s keyboard covers', async () => {
    const was = Platform.OS
    // The web's Keyboard, put back after; it has no metrics.
    const real = Object.getOwnPropertyDescriptors(Keyboard)
    const elements = window.HTMLElement.prototype
    const rect = Object.getOwnPropertyDescriptor(
      elements,
      'getBoundingClientRect'
    )
    try {
      Platform.OS = 'android'
      // The keyboard is up, its top 600 points down the window.
      Object.assign(Keyboard, {
        metrics: () => ({ screenX: 0, screenY: 600, width: 400, height: 300 }),
        isVisible: () => true
      })
      // The screen's scroll view starts 24 points down; the cell sits at 700.
      Object.defineProperty(elements, 'getBoundingClientRect', {
        configurable: true,
        value: function (this: HTMLElement): Partial<DOMRect> {
          return {
            top: this.tagName === 'INPUT' ? 700 : 24,
            left: 0,
            width: 80,
            height: 32
          }
        }
      })
      const fake = fakeClient(setupOf())
      await show(fake.client, { fieldManager: 0, seasons: [], builds: 0 })
      // The outermost scroll view is the screen's own.
      const page = [...document.querySelectorAll('div')].find(
        node => 'scrollResponderScrollNativeHandleToKeyboard' in node
      ) as unknown as Record<string, unknown>
      const asked: unknown[][] = []
      page.scrollResponderScrollNativeHandleToKeyboard = (
        ...args: unknown[]
      ) => {
        asked.push(args)
      }
      await tapLabel('Demo Regular Game length in minutes: 90')
      await settle(20)
      // 16 points clear of the keyboard, counting the scroll view's top.
      expect(asked).deep.equals([
        [document.querySelector('input'), 16 + 24, true]
      ])
    } finally {
      Platform.OS = was
      delete (Keyboard as { metrics?: unknown }).metrics
      Object.defineProperties(Keyboard, real)
      if (rect == null)
        delete (elements as { getBoundingClientRect?: unknown })
          .getBoundingClientRect
      else Object.defineProperty(elements, 'getBoundingClientRect', rect)
    }
  })

  it('adds any field in the registry to the run, and names whose venue it is', async () => {
    const fake = fakeClient(
      setupOf({
        fields: [
          field(),
          field({
            id: 'fld_pier',
            name: 'Pier Diamond',
            venueId: 'ven_pier',
            venueName: 'Pier Park',
            ours: false,
            ownerNames: ['Demo League B']
          })
        ],
        fieldIds: ['fld_one', 'fld_pier'],
        addedFieldIds: ['fld_pier']
      }),
      { registry: [HARBOR_DIAMOND] }
    )
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    // A field of another league's venue names that league.
    expect(text()).includes('50/70 · Pier Park · claimed by Demo League B')
    // The league's own fields show their sizes alone, and can't be removed.
    expect(text()).not.includes('Example Park · ')
    expect(hasLabel('Remove Field 1, Example Park from the list')).equals(false)
    await tapLabel('Add a field to this run')
    await settle(50)
    expect(text()).includes('Choose field')
    await press('Harbor Field, 1 Demo Way, Demo City')
    await settle(20)
    // A field of two sizes is added at once: the run asks for no size.
    await press('Harbor Diamond, 50/70 · 60/90')
    await settle(20)
    expect(text()).not.includes('Choose size')
    expect(document.querySelector('[data-testid="field-picker"]')).equals(null)
    // It joins the run and the fields the setup keeps listed.
    expect(fake.choices.at(-1)).deep.equals({
      seasonIds: ['sea_a'],
      fieldIds: ['fld_one', 'fld_pier', 'fld_harbor'],
      addedFieldIds: ['fld_pier', 'fld_harbor']
    })
    const row = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        '[aria-label="Harbor Diamond, Harbor Field"]'
      )
    // A checked row draws its check mark.
    expect(row()?.textContent).equals(
      '✓Harbor Diamond, Harbor Field50/70 · 60/90 · Harbor Field · unclaimed'
    )
    expect(text()).includes('50/70 · 60/90 · Harbor Field · unclaimed')
    expect(text()).includes('FIELDS FOR THIS RUN3')
    // Adding a field already in the run keeps one of it.
    await tapLabel('Add a field to this run')
    await settle(50)
    await press('Harbor Field, 1 Demo Way, Demo City')
    await settle(20)
    await press('Harbor Diamond, 50/70 · 60/90')
    await settle(20)
    expect(fake.choices.at(-1)).deep.equals({
      seasonIds: ['sea_a'],
      fieldIds: ['fld_one', 'fld_pier', 'fld_harbor'],
      addedFieldIds: ['fld_pier', 'fld_harbor']
    })
    // Unchecking it takes it off the run, and it stays listed, so it can be
    // checked again without a trip through the picker.
    await tapLabel('Harbor Diamond, Harbor Field')
    await settle(20)
    expect(fake.choices.at(-1)).deep.equals({
      seasonIds: ['sea_a'],
      fieldIds: ['fld_one', 'fld_pier'],
      addedFieldIds: ['fld_pier', 'fld_harbor']
    })
    expect(row()?.textContent).equals(
      'Harbor Diamond, Harbor Field50/70 · 60/90 · Harbor Field · unclaimed'
    )
    expect(text()).includes('FIELDS FOR THIS RUN2')
    // So does another league's field, unchecked, in the server's order.
    await tapLabel('Pier Diamond, Pier Park')
    await settle(20)
    expect(fake.choices.at(-1)?.fieldIds).deep.equals(['fld_one'])
    const listed = (): Array<string | null> =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[aria-label$=", Example Park"], [aria-label$=", Harbor Field"], [aria-label$=", Pier Park"]'
        )
      ].map(node => node.getAttribute('aria-label'))
    expect(listed()).deep.equals([
      'Field 1, Example Park',
      'Harbor Diamond, Harbor Field',
      'Pier Diamond, Pier Park'
    ])
    // Leaving the screen and coming back, the setup still lists both.
    await unmount()
    await show(fake.client, calls)
    expect(listed()).deep.equals([
      'Field 1, Example Park',
      'Harbor Diamond, Harbor Field',
      'Pier Diamond, Pier Park'
    ])
    expect(row()?.textContent?.startsWith('✓')).equals(false)
    await tapLabel('Harbor Diamond, Harbor Field')
    await settle(20)
    expect(fake.choices.at(-1)?.fieldIds).deep.equals(['fld_one', 'fld_harbor'])
    expect(row()?.textContent?.startsWith('✓')).equals(true)
    // Remove takes a checked field off the run and off the list.
    await tapLabel('Remove Harbor Diamond, Harbor Field from the list')
    await settle(20)
    expect(fake.choices.at(-1)).deep.equals({
      seasonIds: ['sea_a'],
      fieldIds: ['fld_one'],
      addedFieldIds: ['fld_pier']
    })
    expect(row()).equals(null)
    // And an unchecked one off the list.
    await tapLabel('Remove Pier Diamond, Pier Park from the list')
    await settle(20)
    expect(fake.choices.at(-1)?.addedFieldIds).deep.equals([])
    expect(listed()).deep.equals(['Field 1, Example Park'])
    // Cancelling the picker adds nothing.
    await tapLabel('Add a field to this run')
    await settle(50)
    await tapLabel('Cancel field picker')
    expect(document.querySelector('[data-testid="field-picker"]')).equals(null)
    expect(fake.choices.length).equals(7)
  })

  it('details a run field by whose venue it is', () => {
    expect(setupFieldDetail(field({ sizes: ['46/60', '50/70'] }))).equals(
      '46/60 · 50/70'
    )
    expect(setupFieldDetail(HARBOR_DIAMOND)).equals(
      '50/70 · 60/90 · Harbor Field · unclaimed'
    )
    expect(
      setupFieldDetail(
        field({
          venueName: 'Pier Park',
          ours: false,
          ownerNames: ['Demo League B', 'Demo League C']
        })
      )
    ).equals('50/70 · Pier Park · claimed by Demo League B, Demo League C')
    expect(setupFieldDetail(field({ deleted: true, ours: false }))).equals(
      'Deleted. Uncheck it to leave it out.'
    )
  })

  it('says when a save fails, and leaves a deleted field out of changes', async () => {
    const fake = fakeClient(
      setupOf({
        fieldIds: ['fld_one', 'fld_gone'],
        fields: [
          field(),
          field({ id: 'fld_gone', name: 'Field 2', deleted: true })
        ]
      }),
      { failSave: true }
    )
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    expect(text()).includes('Deleted. Uncheck it to leave it out.')
    await tapLabel('Demo Fall')
    await settle(20)
    expect(fake.choices.at(-1)?.fieldIds).deep.equals(['fld_one'])
    await tapLabel('Demo Regular Game length in minutes: 90')
    await fill('Edit Demo Regular Game length in minutes', '60')
    await key('Enter')
    // The cell stays open with the reason under the grid, and the rest of
    // the screen stays usable.
    expect(
      document.querySelector('[data-testid="season-schedule-grid"]')!
        .textContent
    ).includes('That could not be saved. Try again.')
    expect(hasLabel('Edit Demo Regular Game length in minutes')).equals(true)
    expect(
      disabled(document.querySelector<HTMLElement>('[aria-label="Demo Fall"]')!)
    ).equals(false)
    // A sheet's failure shows at the top of the screen instead.
    await key('Escape')
    await tapLabel('Demo Regular Size: 50/70')
    await press('60/90')
    await settle(20)
    expect(text()).includes('That could not be saved. Try again.')
    expect(hasLabel('Demo Regular Size: 50/70')).equals(true)
  })

  it('names a refused choice, and an empty league', async () => {
    const fake = fakeClient(setupOf(), { failChoice: true })
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Field 1, Example Park')
    await settle(20)
    expect(text()).includes('Choose fields that exist')
    await unmount()
    await show(
      fakeClient(
        setupOf({ seasons: [], fields: [], seasonIds: [], fieldIds: [] })
      ).client,
      calls
    )
    expect(text()).includes('This league has no seasons yet.')
    expect(text()).includes(
      'Add any field in the registry, or claim a venue and add its fields in the Field Manager.'
    )
    expect(text()).not.includes('Your league has no fields yet.')
    expect(text()).includes('Must fix: Choose a season to schedule.')
  })

  it('asks whether to replace or work around existing games, and says when a build fails', async () => {
    const fake = fakeClient(setupOf(), { existing: 2 })
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapText('Build schedule')
    await settle(20)
    expect(text()).includes('These seasons already have 2 upcoming games')
    await press('Work around them')
    await settle(20)
    expect(fake.builds).deep.equals([
      { mode: 'full' },
      { mode: 'full', existing: 'workAround' }
    ])
    expect(calls.builds).equals(1)
    await tapText('Build schedule')
    await settle(20)
    await press('Replace them')
    await settle(20)
    expect(fake.builds.at(-1)).deep.equals({
      mode: 'full',
      existing: 'replace'
    })
    await tapText('Build schedule')
    await settle(20)
    await tapLabel('Close')
    await unmount()
    await show(fakeClient(setupOf(), { failBuild: true }).client, calls)
    await tapText('Build schedule')
    await settle(20)
    expect(text()).includes('The engine stopped')
  })

  it('lists games that need rescheduling, and recalculates their teams or everything', async () => {
    const listed: GameToReschedule[] = [
      {
        previewId: 'spv_old',
        gameKey: 'g1',
        gameId: 'gam_1',
        seasonId: 'sea_a',
        homeTeamId: 'tem_hawks',
        awayTeamId: 'tem_owls',
        homeTeamName: 'Demo Hawks',
        awayTeamName: 'Demo Owls',
        startAt: '2027-04-17T14:00:00.000Z',
        endAt: '2027-04-17T15:30:00.000Z',
        timezone: 'America/New_York',
        exhibition: false,
        fieldId: null,
        reason: 'declined'
      },
      {
        previewId: 'spv_old',
        gameKey: 'g2',
        gameId: null,
        seasonId: 'sea_a',
        homeTeamId: 'tem_foxes',
        awayTeamId: 'tem_hawks',
        homeTeamName: 'Demo Foxes',
        awayTeamName: 'Demo Hawks',
        startAt: '2027-04-24T14:00:00.000Z',
        endAt: null,
        timezone: 'America/New_York',
        exhibition: false,
        fieldId: null,
        reason: 'teamWithdrew'
      }
    ]
    const fake = fakeClient(setupOf(), { listed })
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    expect(text()).includes('NEEDS RESCHEDULING')
    expect(text()).includes('Demo Owls at Demo Hawks')
    expect(text()).includes('Declined')
    expect(text()).includes('A team withdrew')
    // In the viewer's time, naming the zone of the field it was placed in.
    expect(text()).includes(
      'Saturday, April 17, 7:00 AM – 8:30 AM · 10:00 AM EDT at the field'
    )
    await tapText('Recalculate just these teams')
    await settle(20)
    expect(fake.builds.at(-1)).deep.equals({
      mode: 'partial',
      existing: 'replace',
      teamIds: ['tem_hawks', 'tem_owls', 'tem_foxes']
    })
    await tapText('Recalculate everything')
    await settle(20)
    expect(fake.builds.at(-1)).deep.equals({ mode: 'full' })
    expect(calls.builds).equals(2)
  })
})
