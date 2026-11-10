import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import type { TeamStationClient } from '../../common/api'
import {
  DEFAULT_PLAYING_TIME_RULES,
  type PlayingTimeRules
} from '../../common/playingTimeRules'
import { asGroupDetail, type GroupDetail } from '../../common/publicGroups'
import { mount, settle, text, unmount } from '../../test/gameFormDom'
import { PlayingTimeRulesScreen } from './PlayingTimeRulesScreen'

const rules = (changes: Partial<PlayingTimeRules> = {}): PlayingTimeRules => ({
  ...DEFAULT_PLAYING_TIME_RULES,
  ...changes
})

/** The season's set the Hawks follow: Defensive Playing Time on, two sits. */
const SEASON_RULES = rules({ defensivePlayingTime: true, maxSitsPerGame: 2 })

function detail(
  kind: 'season' | 'team',
  own: PlayingTimeRules | null,
  season: PlayingTimeRules | null
): GroupDetail {
  return asGroupDetail({
    group: {
      kind,
      id: kind === 'season' ? 'sea1' : 'tem1',
      name: kind === 'season' ? 'Demo Regular' : 'Demo Hawks',
      imageUrl: null,
      locality: null
    },
    parents: [],
    children: [],
    competingTeams: [],
    participatingSeasons: [],
    games: [],
    staff: [],
    canManage: true,
    nonMemberView: false,
    canViewPrivate: true,
    playingTimeRules: own,
    seasonPlayingTimeRules:
      season == null
        ? null
        : { season: { id: 'sea1', name: 'Demo Regular' }, rules: season }
  })
}

interface Fake {
  client: TeamStationClient
  saved: Array<[unknown, { playingTimeRules?: PlayingTimeRules | null }]>
  fail: { load: boolean; save: boolean }
}
function fake(read: GroupDetail): Fake {
  const saved: Fake['saved'] = []
  const fail = { load: false, save: false }
  const client = {
    group: async () => {
      if (fail.load) throw new Error('The team did not load')
      return read
    },
    updateGroup: async (
      ref: unknown,
      fields: { playingTimeRules?: PlayingTimeRules | null }
    ) => {
      if (fail.save) throw new Error('The rules could not be saved')
      saved.push([ref, fields])
      return read.group
    }
  } as unknown as TeamStationClient
  return { client, saved, fail }
}

async function open(
  kind: 'season' | 'team',
  f: Fake,
  events: string[] = []
): Promise<void> {
  await mount(
    <PlayingTimeRulesScreen
      client={f.client}
      kind={kind}
      id={kind === 'season' ? 'sea1' : 'tem1'}
      onSaved={() => events.push('saved')}
      onCancel={() => events.push('cancelled')}
    />
  )
  await settle(20)
}

/** The control named this, the row a choice row reads as, or a button. */
function control(label: string): HTMLElement {
  const all = [...document.querySelectorAll<HTMLElement>('[aria-label]')]
  const node =
    all.find(one => one.getAttribute('aria-label') === label) ??
    all.find(one => one.getAttribute('aria-label')!.startsWith(label + ', ')) ??
    [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
      one => one.textContent === label
    )
  expect(node, label).not.equals(undefined)
  return node!
}
function disabled(label: string): boolean {
  const node = control(label)
  return (
    (node as HTMLInputElement).disabled ||
    node.closest('[aria-disabled="true"]') != null
  )
}
const on = (label: string): boolean =>
  (control(label) as HTMLInputElement).checked
async function press(label: string): Promise<void> {
  const node = control(label)
  await act(async () => {
    node.click()
  })
  await settle(0)
}
/** The option of a pill row, by the pill's name and the option's label. */
function option(row: string, label: string): HTMLElement {
  const node = document
    .querySelector(`[role="tablist"][aria-label="${row}"]`)
    ?.querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`)
  expect(node, `${row}: ${label}`).not.equals(undefined)
  return node!
}
async function choose(row: string, label: string): Promise<void> {
  const node = option(row, label)
  await act(async () => {
    node.click()
  })
  await settle(0)
}
const chosen = (row: string, label: string): boolean =>
  option(row, label).getAttribute('aria-selected') === 'true'
/** Whether a row, by its control's name, is on the screen at all. */
const shows = (label: string): boolean =>
  document.querySelector(`[aria-label="${label}"]`) != null
/** Where these strings first appear in the screen's text, in order. */
const inOrder = (labels: string[]): void => {
  const at = labels.map(label => text().indexOf(label))
  labels.forEach((label, i) => expect(at[i], label).greaterThanOrEqual(0))
  expect(
    [...at].sort((a, b) => a - b),
    labels.join(' / ')
  ).deep.equals(at)
}
const LARGE = (label: string): string => `${label} (large rosters)`
/** The value a stepper shows between its − and +. */
const stepped = (label: string): string => control(label).textContent ?? ''
const save = async (): Promise<void> => {
  await press('Save')
}

describe('Playing Time Rules screen', function () {
  afterEach(unmount)

  it('says a season’s screen configures the season’s rules, and saves its whole set', async function () {
    const f = fake(detail('season', null, null))
    const events: string[] = []
    await open('season', f, events)
    expect(text()).includes('Playing Time Rules')
    expect(text()).includes(
      'Configures the playing time rules for this season.'
    )
    expect(text()).not.includes('Override season rules')
    // The issue's groups, in its order.
    inOrder([
      'DEFENSIVE PLAYING TIME',
      'INFIELD AND OUTFIELD',
      'SITTING AND BENCH EQUITY',
      'POSITION LIMITS AND ROTATION',
      'PITCHER AND CATCHER',
      'BATTING ORDER'
    ])
    for (const gone of ['MANDATORY PLAY', 'TOTAL DEFENSIVE PLAYING TIME'])
      expect(text(), gone).not.includes(gone)
    expect(disabled('Require Defensive Playing Time')).equals(false)
    await press('Require Defensive Playing Time')
    // Innings is the default unit, the left option; the outs rows wait for
    // Defensive Outs.
    const units = [
      ...document.querySelectorAll(
        '[role="tablist"][aria-label="Playing time measured in"] [role="tab"]'
      )
    ].map(tab => tab.textContent)
    expect(units).deep.equals(['Innings', 'Defensive Outs'])
    expect(chosen('Playing time measured in', 'Innings')).equals(true)
    expect(shows('Defensive Outs Required')).equals(false)
    await choose('Playing time measured in', 'Defensive Outs')
    expect(chosen('Defensive Outs Required', '6')).equals(true)
    await choose('Defensive Outs Required', '9')
    await save()
    expect(f.saved).deep.equals([
      [
        { kind: 'season', id: 'sea1' },
        {
          playingTimeRules: rules({
            defensivePlayingTime: true,
            measuredIn: 'outs',
            outs: { required: 9, consecutive: false }
          })
        }
      ]
    ])
    expect(events).deep.equals(['saved'])
  })

  it('grays a team’s rows at its season’s values until Override is on, then saves the whole set', async function () {
    const f = fake(detail('team', null, SEASON_RULES))
    await open('team', f)
    expect(text()).includes('Configures the playing time rules for this team.')
    expect(on('Override season rules')).equals(false)
    expect(text()).includes('Following Demo Regular')
    // Every row is the season's, and none can be changed.
    expect(on('Require Defensive Playing Time')).equals(true)
    expect(stepped('Max Sits Per Game: 2')).equals('2')
    for (const label of [
      'Require Defensive Playing Time',
      'Reduced Requirement for Large Rosters',
      'Require Minimum Infield',
      'Enforce Sitting Limits',
      'Increase Max Sits Per Game',
      'Continuous Batting Order'
    ])
      expect(disabled(label), label).equals(true)
    expect(
      window.getComputedStyle(
        control('Require Defensive Playing Time').closest(
          '[aria-disabled="true"]'
        )!
      ).opacity
    ).equals('0.4')
    // Following, with nothing changed, there is nothing to save, and a team
    // under its season's rules has no turn-off of its own.
    expect(disabled('Save')).equals(true)
    expect(text()).not.includes('Turn Off Playing Time Rules')

    await press('Override season rules')
    expect(disabled('Save')).equals(false)
    expect(on('Override season rules')).equals(true)
    expect(text()).not.includes('Following Demo Regular')
    expect(disabled('Require Defensive Playing Time')).equals(false)
    expect(disabled('Reduced Requirement for Large Rosters')).equals(false)
    expect(on('Require Defensive Playing Time')).equals(true)
    await press('Enforce Sitting Limits')
    await press('Increase Max Sits Per Game')
    expect(stepped('Max Sits Per Game: 3')).equals('3')
    await save()
    expect(f.saved.at(-1)).deep.equals([
      { kind: 'team', id: 'tem1' },
      {
        playingTimeRules: {
          ...SEASON_RULES,
          enforceSittingLimits: true,
          maxSitsPerGame: 3
        }
      }
    ])

    // Off again, the season's values are back in view, and grayed.
    await press('Override season rules')
    expect(on('Enforce Sitting Limits')).equals(false)
    expect(stepped('Max Sits Per Game: 2')).equals('2')
    expect(disabled('Require Defensive Playing Time')).equals(true)
    // On again, the team starts over from the season's.
    await press('Override season rules')
    expect(on('Enforce Sitting Limits')).equals(false)
  })

  it('opens a team’s own override as it was saved', async function () {
    const own = rules({ continuousBatting: true })
    const f = fake(detail('team', own, SEASON_RULES))
    await open('team', f)
    expect(on('Override season rules')).equals(true)
    expect(on('Continuous Batting Order')).equals(true)
    expect(on('Require Defensive Playing Time')).equals(false)
    expect(disabled('Late Arrivals Added to End')).equals(false)
    expect(text()).not.includes('Turn Off Playing Time Rules')
    // Turning the override off is the change: the team follows again.
    expect(disabled('Save')).equals(true)
    await press('Override season rules')
    await save()
    expect(f.saved).deep.equals([
      [{ kind: 'team', id: 'tem1' }, { playingTimeRules: null }]
    ])
  })

  it('keeps Save off until the draft differs from what the screen opened with', async function () {
    const f = fake(detail('season', null, null))
    await open('season', f)
    // A season with no rules starts from the defaults, which are not saved
    // until something changes, and has no rules to turn off.
    expect(disabled('Save')).equals(true)
    expect(text()).not.includes('Turn Off Playing Time Rules')
    await save()
    expect(f.saved).deep.equals([])
    await press('Require Defensive Playing Time')
    expect(disabled('Save')).equals(false)
    // Back where it started, there is again nothing to save.
    await press('Require Defensive Playing Time')
    expect(disabled('Save')).equals(true)
    await unmount()

    const stored = fake(detail('season', SEASON_RULES, null))
    await open('season', stored)
    expect(disabled('Save')).equals(true)
    await press('Continuous Batting Order')
    expect(disabled('Save')).equals(false)
  })

  it('turns a season’s or team’s own rules off, to none, once confirmed', async function () {
    const inSheet = (label: string): HTMLElement => {
      const sheet = document.querySelector('[aria-label="Confirm change"]')
      expect(sheet, 'confirmation').not.equals(null)
      const node = [
        ...sheet!.querySelectorAll<HTMLElement>('[role="button"]')
      ].find(one => one.textContent === label)
      expect(node, label).not.equals(undefined)
      return node!
    }
    const pressInSheet = async (label: string): Promise<void> => {
      const node = inSheet(label)
      await act(async () => {
        node.click()
      })
      await settle(0)
    }
    const f = fake(detail('season', SEASON_RULES, null))
    const events: string[] = []
    await open('season', f, events)
    await press('Turn Off Playing Time Rules')
    expect(text()).includes('Turn off playing time rules for Demo Regular?')
    // Cancelling the confirmation changes nothing.
    await pressInSheet('Cancel')
    expect(document.querySelector('[aria-label="Confirm change"]')).equals(null)
    expect(f.saved).deep.equals([])
    expect(events).deep.equals([])
    expect(on('Require Defensive Playing Time')).equals(true)

    await press('Turn Off Playing Time Rules')
    await pressInSheet('Turn Off')
    await settle(0)
    expect(f.saved).deep.equals([
      [{ kind: 'season', id: 'sea1' }, { playingTimeRules: null }]
    ])
    expect(events).deep.equals(['saved'])
    await unmount()

    // A team whose seasons have no rules turns its own set off the same way.
    const team = fake(detail('team', rules({ continuousBatting: true }), null))
    const left: string[] = []
    await open('team', team, left)
    await press('Turn Off Playing Time Rules')
    expect(text()).includes('Turn off playing time rules for Demo Hawks?')
    await pressInSheet('Turn Off')
    await settle(0)
    expect(team.saved).deep.equals([
      [{ kind: 'team', id: 'tem1' }, { playingTimeRules: null }]
    ])
    expect(left).deep.equals(['saved'])
  })

  it('lets a team whose seasons have no rules edit its own set, from the defaults', async function () {
    const f = fake(detail('team', null, null))
    await open('team', f)
    expect(text()).not.includes('Override season rules')
    expect(disabled('Require Defensive Playing Time')).equals(false)
    await press('Continuous Batting Order')
    await save()
    expect(f.saved).deep.equals([
      [
        { kind: 'team', id: 'tem1' },
        { playingTimeRules: rules({ continuousBatting: true }) }
      ]
    ])
  })

  it('keeps each dependent row off while the row it depends on is off', async function () {
    const f = fake(detail('season', null, null))
    await open('season', f)
    // Each in turn, from all off: the outfield's two shared rows also come
    // on with the outfield minimum alone.
    const pairs: Array<[string, string[]]> = [
      [
        'Require Defensive Playing Time',
        [
          'Playing time measured in',
          'Reduced Requirement for Large Rosters',
          'Increase Minimum Full Innings',
          'Must Complete by Inning',
          'Count Partial Innings'
        ]
      ],
      [
        'Require Minimum Infield',
        [
          'Increase Infield Innings Required',
          'Pitcher counts as infield',
          'Catcher counts as',
          'Complete infield by inning',
          'Starting pitcher and catcher exempt from minimums'
        ]
      ],
      [
        'Require Minimum Outfield',
        [
          'Increase Outfield Innings Required',
          'Catcher counts as',
          'Complete outfield by inning',
          'Starting pitcher and catcher exempt from minimums'
        ]
      ],
      [
        'Enforce Sitting Limits',
        [
          'No Consecutive Sits',
          'Equal Sitting Order',
          'Increase Max Sits Per Game',
          'Starting Pitcher / Catcher Exempt'
        ]
      ],
      [
        'Limit Innings at One Position',
        ['Increase Max Innings per Position', 'Increase Rotate Every N Innings']
      ],
      [
        'Continuous Batting Order',
        ['Late Arrivals Added to End', 'Departures Skip Without Out']
      ]
    ]
    for (const [parent, children] of pairs) {
      for (const child of children)
        expect(disabled(child), `${child} before ${parent}`).equals(true)
      await press(parent)
      for (const child of children)
        expect(disabled(child), `${child} with ${parent}`).equals(false)
      await press(parent)
      for (const child of children)
        expect(disabled(child), `${child} after ${parent}`).equals(true)
    }
    // The large roster's rows need Defensive Playing Time and Reduced
    // Requirement, in the unit chosen.
    const players = 'Increase Following requirements when ≥ 15 players present'
    const largeInnings = [
      `Increase ${LARGE('Minimum Full Innings')}`,
      LARGE('Must Complete by Inning'),
      LARGE('Count Partial Innings')
    ]
    await press('Require Defensive Playing Time')
    for (const row of [players, ...largeInnings])
      expect(disabled(row), row).equals(true)
    await press('Reduced Requirement for Large Rosters')
    for (const row of [players, ...largeInnings])
      expect(disabled(row), row).equals(false)
    await choose('Playing time measured in', 'Defensive Outs')
    const largeOuts = [
      LARGE('Defensive Outs Required'),
      LARGE('Must Be Consecutive')
    ]
    for (const row of largeOuts) expect(disabled(row), row).equals(false)
    await press('Require Defensive Playing Time')
    for (const row of [players, ...largeOuts])
      expect(disabled(row), row).equals(true)
    // The catcher's rows have no parent.
    expect(disabled('Catcher Inning Limit')).equals(false)
    expect(disabled('Catching Blocks Pitching')).equals(false)
  })

  it('shows the rows of the unit Defensive Playing Time is measured in, its own and a large roster’s', async function () {
    const f = fake(detail('season', null, null))
    await open('season', f)
    const inningsRows = [
      'Minimum Full Innings',
      'Must Complete by Inning',
      'Count Partial Innings'
    ]
    const outsRows = ['Defensive Outs Required', 'Must Be Consecutive']
    // Innings by default: its rows, grayed until the rule is on, then the
    // large roster's toggle and count, then the large roster's own.
    inOrder([
      'Require Defensive Playing Time',
      'Playing time measured in',
      ...inningsRows,
      'Reduced Requirement for Large Rosters',
      'Following requirements when ≥ 15 players present'
    ])
    const large = text().slice(text().indexOf('Following requirements'))
    let after = 0
    for (const row of inningsRows) {
      expect(large.indexOf(row, after), row).greaterThan(after)
      after = large.indexOf(row, after)
    }
    for (const row of [
      'Increase Minimum Full Innings',
      'Must Complete by Inning',
      'Count Partial Innings',
      `Increase ${LARGE('Minimum Full Innings')}`,
      LARGE('Must Complete by Inning'),
      LARGE('Count Partial Innings')
    ])
      expect(shows(row), row).equals(true)
    for (const row of [...outsRows, ...outsRows.map(LARGE)])
      expect(shows(row), row).equals(false)
    expect(text()).includes('Require 2 full innings')
    await press('Require Defensive Playing Time')
    await press('Reduced Requirement for Large Rosters')
    await choose('Must Complete by Inning', '4th')
    expect(text()).includes('Require 2 full innings by the 4th')
    await press('Decrease Minimum Full Innings')
    expect(text()).includes('Require 1 full inning by the 4th')
    await choose('Must Complete by Inning', 'n/a')
    expect(text()).includes('Require 1 full inning')
    await press('Increase Minimum Full Innings')
    expect(text()).includes('Require 2 full innings')
    // The large roster's innings: 1, by its own deadline.
    expect(stepped(`${LARGE('Minimum Full Innings')}: 1`)).equals('1')
    await choose(LARGE('Must Complete by Inning'), '5th')
    await choose(LARGE('Count Partial Innings'), 'Full only')

    // Defensive Outs: the outs rows, 6 by default and 3 for a large roster,
    // in place of the innings rows.
    await choose('Playing time measured in', 'Defensive Outs')
    for (const row of [...outsRows, ...outsRows.map(LARGE)])
      expect(shows(row), row).equals(true)
    for (const row of [
      'Increase Minimum Full Innings',
      'Must Complete by Inning',
      'Count Partial Innings',
      LARGE('Count Partial Innings')
    ])
      expect(shows(row), row).equals(false)
    expect(text()).includes('Require 6 defensive outs')
    expect(chosen('Defensive Outs Required', '6')).equals(true)
    expect(chosen(LARGE('Defensive Outs Required'), '3')).equals(true)
    inOrder([
      'Playing time measured in',
      'Defensive Outs Required',
      'Must Be Consecutive',
      'Reduced Requirement for Large Rosters',
      'Following requirements when ≥ 15 players present'
    ])
    await choose(LARGE('Defensive Outs Required'), '6')
    await press(LARGE('Must Be Consecutive'))
    await press('Increase Following requirements when ≥ 15 players present')
    await save()
    expect(f.saved[0][1].playingTimeRules).deep.include({
      defensivePlayingTime: true,
      measuredIn: 'outs',
      outs: { required: 6, consecutive: false },
      innings: {
        minimum: 2,
        completeBy: 'none',
        countPartial: 'anyAppearance'
      },
      largeRoster: {
        enabled: true,
        players: 16,
        outs: { required: 6, consecutive: true },
        innings: { minimum: 1, completeBy: 5, countPartial: 'fullOnly' }
      }
    })
  })

  it('stops each stepper at its ends, Unlimited and Off included, and saves what it shows', async function () {
    const f = fake(detail('season', null, null))
    await open('season', f)
    await press('Enforce Sitting Limits')
    await press('Limit Innings at One Position')
    await press('Decrease Max Sits Per Game')
    expect(stepped('Max Sits Per Game: 0')).equals('0')
    expect(disabled('Decrease Max Sits Per Game')).equals(true)
    for (let i = 0; i < 4; i++) await press('Increase Max Sits Per Game')
    expect(stepped('Max Sits Per Game: 3')).equals('3')
    expect(disabled('Increase Max Sits Per Game')).equals(true)

    for (let i = 0; i < 3; i++) await press('Increase Max Innings per Position')
    expect(stepped('Max Innings per Position: 6')).equals('6')
    await press('Increase Max Innings per Position')
    expect(stepped('Max Innings per Position: Unlimited')).equals('Unlimited')
    expect(disabled('Increase Max Innings per Position')).equals(true)
    for (let i = 0; i < 5; i++) await press('Decrease Max Innings per Position')
    expect(stepped('Max Innings per Position: 2')).equals('2')
    expect(disabled('Decrease Max Innings per Position')).equals(true)
    for (let i = 0; i < 5; i++) await press('Increase Max Innings per Position')

    expect(stepped('Rotate Every N Innings: Off')).equals('Off')
    expect(disabled('Decrease Rotate Every N Innings')).equals(true)
    await press('Increase Rotate Every N Innings')
    await press('Increase Rotate Every N Innings')
    expect(stepped('Rotate Every N Innings: 2')).equals('2')
    expect(disabled('Increase Rotate Every N Innings')).equals(true)

    // The label carries the value: "… when ≥ 15 players present".
    await press('Require Defensive Playing Time')
    await press('Reduced Requirement for Large Rosters')
    for (let i = 0; i < 11; i++)
      await press(
        `Increase ${/Following requirements when ≥ (\d+) players present/.exec(text())![0]}`
      )
    expect(text()).includes('when ≥ 25 players present')
    expect(
      disabled('Increase Following requirements when ≥ 25 players present')
    ).equals(true)
    for (let i = 0; i < 5; i++) await press('Increase Minimum Full Innings')
    expect(stepped('Minimum Full Innings: 6')).equals('6')
    expect(disabled('Increase Minimum Full Innings')).equals(true)
    await save()
    const saved = f.saved[0][1].playingTimeRules!
    expect(saved).deep.include({
      maxSitsPerGame: 3,
      maxInningsPerPosition: 'unlimited',
      rotateEvery: 2
    })
    expect(saved.largeRoster.players).equals(25)
    expect(saved.innings.minimum).equals(6)
  })

  it('chooses a long choice from rows, and a short one from the pill', async function () {
    const f = fake(detail('season', null, null))
    await open('season', f)
    await press('Enforce Sitting Limits')
    expect(control('Equal Sitting Order').textContent).includes(
      'No 2nd sit until all have sat once'
    )
    await press('Equal Sitting Order')
    // The sheet marks what the row holds.
    expect(
      control('No 2nd sit until all have sat once').getAttribute(
        'aria-selected'
      )
    ).equals('true')
    await press('No 3rd until all have sat twice')
    expect(control('Equal Sitting Order').textContent).includes(
      'No 3rd until all have sat twice'
    )
    // The same one again changes nothing.
    await press('Equal Sitting Order')
    await press('No 3rd until all have sat twice')
    await press('Require Defensive Playing Time')
    expect(chosen('Count Partial Innings', 'Any appearance')).equals(true)
    await choose('Count Partial Innings', 'Full only')
    expect(chosen('Count Partial Innings', 'Full only')).equals(true)
    // The same one again changes nothing.
    await choose('Count Partial Innings', 'Full only')
    await press('Require Minimum Infield')
    await press('Require Minimum Outfield')
    // The pitcher counts as infield until turned off; 1B to 3B always do.
    expect(on('Pitcher counts as infield')).equals(true)
    await press('Pitcher counts as infield')
    expect(chosen('Catcher counts as', 'Infield')).equals(true)
    await choose('Catcher counts as', 'Outfield')
    // Each deadline is 3rd, 4th, 5th or n/a, n/a (none) by default.
    for (const row of [
      'Complete infield by inning',
      'Complete outfield by inning'
    ]) {
      const labels = [
        ...document.querySelectorAll(
          `[role="tablist"][aria-label="${row}"] [role="tab"]`
        )
      ].map(tab => tab.textContent)
      expect(labels, row).deep.equals(['3rd', '4th', '5th', 'n/a'])
      expect(chosen(row, 'n/a'), row).equals(true)
    }
    await choose('Complete infield by inning', '3rd')
    await choose('Complete outfield by inning', '5th')
    // A pill row wraps, its name keeping 120 points beside the pill: on a
    // narrow screen the pill takes its own line, still at the right.
    const row = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Count Partial Innings"]'
    )!.parentElement!
    expect(getComputedStyle(row).flexWrap).equals('wrap')
    expect(getComputedStyle(row).justifyContent).equals('flex-end')
    const name = getComputedStyle(row.firstElementChild!)
    expect([name.flexGrow, name.flexShrink, name.flexBasis]).deep.equals([
      '1',
      '1',
      '120px'
    ])
    // So does a stepper row, − and + moving under the name.
    const stepper = document.querySelector<HTMLElement>(
      '[role="button"][aria-label="Increase Max Sits Per Game"]'
    )!.parentElement!.parentElement!
    expect(getComputedStyle(stepper).flexWrap).equals('wrap')
    expect(getComputedStyle(stepper.firstElementChild!).flexBasis).equals(
      '120px'
    )
    await save()
    expect(f.saved[0][1].playingTimeRules).deep.include({
      equalSittingOrder: 'thirdAfterAll',
      innings: { minimum: 2, completeBy: 'none', countPartial: 'fullOnly' },
      pitcherCountsAsInfield: false,
      catcherCountsAs: 'outfield',
      infieldBy: 3,
      outfieldBy: 5
    })
  })

  it('orders Infield and Outfield’s rows, the exemption last, and describes the sitting exemption', async function () {
    const f = fake(detail('season', null, null))
    await open('season', f)
    inOrder([
      'INFIELD AND OUTFIELD',
      'Require Minimum Infield',
      'Infield Innings Required',
      'Pitcher counts as infield',
      'Catcher counts as',
      'Complete infield by inning',
      'Require Minimum Outfield',
      'Outfield Innings Required',
      'Complete outfield by inning',
      'Starting pitcher and catcher exempt from minimums',
      'SITTING AND BENCH EQUITY',
      'Enforce Sitting Limits',
      'Starting Pitcher / Catcher Exempt',
      'Starting pitcher and catcher may sit with none of the above restrictions.',
      'POSITION LIMITS AND ROTATION',
      'Limit Innings at One Position',
      'Max Innings per Position',
      'Rotate Every N Innings',
      'PITCHER AND CATCHER',
      'Catcher Inning Limit',
      'Catching Blocks Pitching',
      'BATTING ORDER'
    ])
    // The bench note went with the dash.
    expect(text()).not.includes('A dash in the plan')
    // Must Play Both Infield and Outfield is gone: the two minimums say it.
    expect(text()).not.includes('Must Play Both')
  })

  it('limits the catcher at 3, 4, 5 or None, and blocks pitching at 3, 4, 5 or Disable, both off by default', async function () {
    const f = fake(detail('season', null, null))
    await open('season', f)
    for (const label of ['3', '4', '5', 'None'])
      expect(chosen('Catcher Inning Limit', label), label).equals(
        label === 'None'
      )
    for (const label of ['3', '4', '5', 'Disable'])
      expect(chosen('Catching Blocks Pitching', label), label).equals(
        label === 'Disable'
      )
    // Disabled, the subtext names no number; chosen, it names the one.
    expect(text()).includes(
      'After N innings catching, no pitching that calendar day'
    )
    await choose('Catcher Inning Limit', '4')
    await choose('Catching Blocks Pitching', '3')
    expect(text()).includes(
      'After 3 innings catching, no pitching that calendar day'
    )
    expect(text()).not.includes('After N innings')
    await save()
    expect(f.saved[0][1].playingTimeRules).deep.include({
      catcherMaxInnings: 4,
      catcherBlocksPitching: 3
    })
    // No fourth-inning toggle, Shortened Games or Season Tracking.
    for (const gone of [
      'Also block if catcher catches any part of 4th inning',
      'Apply in Shortened Games',
      'Season Tracking',
      'SEASON TRACKING',
      'Track Season Infield Balance',
      'Rotate Leadoff Spot',
      'Must Play Next',
      'Infield Positions',
      'at-bat'
    ])
      expect(text(), gone).not.includes(gone)
  })

  it('says when the rules do not load or save, and Cancel leaves', async function () {
    const failing = fake(detail('season', null, null))
    failing.fail.load = true
    await open('season', failing)
    expect(text()).includes('The team did not load')
    expect(disabled('Save')).equals(true)
    await unmount()

    const f = fake(detail('season', null, null))
    const events: string[] = []
    await open('season', f, events)
    f.fail.save = true
    await press('Require Defensive Playing Time')
    await save()
    expect(text()).includes('The rules could not be saved')
    expect(events).deep.equals([])
    await press('Cancel')
    expect(events).deep.equals(['cancelled'])
  })
})
