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

/** The season's set the Hawks follow: Mandatory Play on, two sits. */
const SEASON_RULES = rules({ mandatoryPlay: true, maxSitsPerGame: 2 })

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
    const order = [
      'MANDATORY PLAY',
      'TOTAL DEFENSIVE PLAYING TIME',
      'INFIELD AND OUTFIELD',
      'SITTING AND BENCH EQUITY',
      'POSITION LIMITS AND ROTATION',
      'PITCHER AND CATCHER',
      'BATTING ORDER',
      'Season Tracking'
    ].map(heading => text().indexOf(heading))
    expect(order.every(at => at >= 0)).equals(true)
    expect([...order].sort((a, b) => a - b)).deep.equals(order)
    expect(disabled('Mandatory Play')).equals(false)
    await press('Mandatory Play')
    await press('9')
    await save()
    expect(f.saved).deep.equals([
      [
        { kind: 'season', id: 'sea1' },
        {
          playingTimeRules: rules({
            mandatoryPlay: true,
            defensiveOutsRequired: 9
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
    expect(on('Mandatory Play')).equals(true)
    expect(stepped('Max Sits Per Game: 2')).equals('2')
    for (const label of [
      'Mandatory Play',
      'Must Be Consecutive',
      'Stricter Minimum Innings',
      'Require Minimum Infield',
      'Enforce Sitting Limits',
      'Increase Max Sits Per Game',
      'Continuous Batting Order'
    ])
      expect(disabled(label), label).equals(true)
    expect(
      window.getComputedStyle(
        control('Mandatory Play').closest('[aria-disabled="true"]')!
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
    expect(disabled('Mandatory Play')).equals(false)
    expect(disabled('Must Be Consecutive')).equals(false)
    expect(on('Mandatory Play')).equals(true)
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
    expect(disabled('Mandatory Play')).equals(true)
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
    expect(on('Mandatory Play')).equals(false)
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
    await press('Mandatory Play')
    expect(disabled('Save')).equals(false)
    // Back where it started, there is again nothing to save.
    await press('Mandatory Play')
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
    expect(on('Mandatory Play')).equals(true)

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
    expect(disabled('Mandatory Play')).equals(false)
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
        'Mandatory Play',
        [
          'Defensive Outs Required',
          'Must Be Consecutive',
          'Reduced Requirement for Large Rosters',
          'Apply in Shortened Games'
        ]
      ],
      [
        'Stricter Minimum Innings',
        [
          'Increase Minimum Full Innings',
          'Must Complete By Inning',
          'Count Partial Innings'
        ]
      ],
      [
        'Require Minimum Infield',
        [
          'Increase Infield Innings Required',
          'P',
          'Catcher Counts as Infield',
          'Must Complete Infield By Inning',
          'Must Play Both Infield and Outfield',
          'Starting P/C Exempt from Infield/Outfield Mins'
        ]
      ],
      [
        'Require Minimum Outfield',
        [
          'Increase Outfield Innings Required',
          'Must Complete Outfield By Inning',
          'Must Play Both Infield and Outfield',
          'Starting P/C Exempt from Infield/Outfield Mins'
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
      ['Catcher Inning Limit', ['Decrease At most 4 innings catching']],
      [
        'Catcher Blocks Pitching Same Day',
        ['Also block if catcher catches any part of 4th inning']
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
    // The large-roster pair needs Mandatory Play and Reduced Requirement.
    const large = ['Increase When ≥ 15 players present', 'Require only 3 outs']
    await press('Mandatory Play')
    for (const child of large) expect(disabled(child), child).equals(true)
    await press('Reduced Requirement for Large Rosters')
    for (const child of large) expect(disabled(child), child).equals(false)
    await press('Mandatory Play')
    for (const child of large) expect(disabled(child), child).equals(true)
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

    // The label carries the value: "When ≥ 15 players present".
    await press('Mandatory Play')
    await press('Reduced Requirement for Large Rosters')
    for (let i = 0; i < 11; i++)
      await press(`Increase ${/When ≥ (\d+) players present/.exec(text())![0]}`)
    expect(text()).includes('When ≥ 25 players present')
    expect(disabled('Increase When ≥ 25 players present')).equals(true)
    await press('Catcher Inning Limit')
    expect(disabled('Increase At most 4 innings catching')).equals(true)
    await press('Decrease At most 4 innings catching')
    expect(disabled('Decrease At most 3 innings catching')).equals(true)
    await save()
    expect(f.saved[0][1].playingTimeRules).deep.include({
      maxSitsPerGame: 3,
      maxInningsPerPosition: 'unlimited',
      rotateEvery: 2,
      largeRosterPlayers: 25,
      catcherMaxInnings: 3
    })
  })

  it('chooses a long choice from rows, a short one from the pill, and infield positions by check', async function () {
    const f = fake(detail('season', null, null))
    await open('season', f)
    await press('Stricter Minimum Innings')
    expect(control('Must Complete By Inning').textContent).includes(
      'By end of game'
    )
    await press('Must Complete By Inning')
    // The sheet marks what the row holds.
    expect(control('By end of game').getAttribute('aria-selected')).equals(
      'true'
    )
    expect(control('By 4th').getAttribute('aria-selected')).equals('false')
    await press('By 4th')
    expect(control('Must Complete By Inning').textContent).includes('By 4th')
    // The same one again changes nothing.
    await press('Must Complete By Inning')
    await press('By 4th')
    await press('Any appearance')
    expect(control('Full only').getAttribute('aria-checked')).equals('false')
    await press('Full only')
    expect(control('Full only').getAttribute('aria-checked')).equals('true')
    await press('Require Minimum Infield')
    await press('C')
    await press('C')
    await press('1B')
    await save()
    expect(f.saved[0][1].playingTimeRules).deep.include({
      minimumInningsBy: 4,
      countPartialInnings: 'fullOnly',
      infieldPositions: ['P', 'C', '2B', 'SS', '3B']
    })
  })

  it('keeps Season Tracking collapsed, with its note, until its header is pressed', async function () {
    const f = fake(detail('season', null, null))
    await open('season', f)
    expect(text()).includes('Soft warnings only. These never turn red.')
    expect(text()).not.includes('Track Season Infield Balance')
    expect(control('Season Tracking').getAttribute('aria-expanded')).equals(
      'false'
    )
    await press('Season Tracking')
    expect(control('Season Tracking').getAttribute('aria-expanded')).equals(
      'true'
    )
    for (const row of [
      'Track Season Infield Balance',
      'Rotate Leadoff Spot',
      'Show “Must Play Next” Suggestions'
    ])
      expect(disabled(row), row).equals(false)
    await press('Rotate Leadoff Spot')
    await press('Season Tracking')
    expect(text()).not.includes('Rotate Leadoff Spot')
    await save()
    expect(f.saved[0][1].playingTimeRules?.rotateLeadoff).equals(true)
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
    await press('Mandatory Play')
    await save()
    expect(text()).includes('The rules could not be saved')
    expect(events).deep.equals([])
    await press('Cancel')
    expect(events).deep.equals(['cancelled'])
  })
})
