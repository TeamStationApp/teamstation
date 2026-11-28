import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import type { StoredGame } from '../../common/scoring/session'
import {
  asImported,
  finalGame,
  inProgressGame,
  REPLAY_TEAMS
} from '../../test/replayGameFixture'
import {
  type HalfInning,
  type PitchRow,
  type PlayLine,
  playsStream
} from './playsStream'

const TEAMS = { away: REPLAY_TEAMS.away, home: REPLAY_TEAMS.home }

function stream(
  plays: GumboPlay[],
  options: { currentPlay?: CurrentPlay | null; final?: boolean } = {}
): HalfInning[] {
  return playsStream({
    plays,
    currentPlay: options.currentPlay ?? null,
    ...TEAMS,
    final: options.final ?? true
  })
}

function lines(halves: HalfInning[]): PlayLine[] {
  return halves.flatMap(half => half.lines)
}

function lineAt(halves: HalfInning[], atBatIndex: number): PlayLine {
  const line = lines(halves).find(one => one.atBatIndex === atBatIndex)
  if (line == null) throw new Error(`no line ${atBatIndex}`)
  return line
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

type Events = Array<Record<string, any>>

function eventsOf(play: GumboPlay): Events {
  return play.playEvents as Events
}

/** A lineup change stored as a play of its own, ahead of a first pitch. */
function change(
  atBatIndex: number,
  inning: number,
  halfInning: 'top' | 'bottom',
  extra: Record<string, unknown> = {}
): GumboPlay {
  return {
    about: { atBatIndex, inning, halfInning, isComplete: true },
    result: { eventType: 'pitching_substitution', awayScore: 0, homeScore: 0 },
    count: { outs: 0 },
    ...extra
  } as unknown as GumboPlay
}

/** The plays after `from`, moved up one at-bat to make room. */
function shifted(plays: GumboPlay[], from: number): GumboPlay[] {
  return plays.map(play => {
    if (play.about.atBatIndex < from || play.about.atBatIndex === 9999)
      return play
    const moved = copy(play)
    moved.about.atBatIndex += 1
    return moved
  })
}

describe('the plays stream', function () {
  let final: StoredGame
  let live: StoredGame

  before(async function () {
    final = await finalGame()
    live = await inProgressGame()
  })

  it('gives no halves for a game with no plays', function () {
    expect(stream([])).deep.equals([])
    expect(stream([], { final: false })).deep.equals([])
  })

  it('groups the plays by half-inning in play order, labelled, with the team at bat', function () {
    const halves = stream(final.plays)
    expect(
      halves.map(half => [half.key, half.label, half.battingTeam])
    ).deep.equals([
      ['top-1', 'Top 1st', 'Harbor Hawks'],
      ['bottom-1', 'Bottom 1st', 'Valley Pines'],
      ['top-2', 'Top 2nd', 'Harbor Hawks'],
      ['bottom-2', 'Bottom 2nd', 'Valley Pines'],
      ['top-3', 'Top 3rd', 'Harbor Hawks']
    ])
    expect(halves[1].inning).equals(1)
    expect(halves[1].half).equals('bottom')
  })

  it('gives one line per turn at bat, oldest first, and none for the final score', function () {
    const all = lines(stream(final.plays))
    expect(all.map(line => line.atBatIndex)).deep.equals(
      Array.from({ length: 21 }, (_, index) => index)
    )
    expect(all.every(line => !line.inProgress)).equals(true)
    expect(all[0].batter).deep.equals({ gumboId: 9101, name: 'Juan Soto' })
  })

  it('leaves out a play with no half-inning', function () {
    const plays = copy(final.plays)
    plays[0].about.halfInning = null
    expect(lines(stream(plays))[0].atBatIndex).equals(1)
  })

  it('says each play from its credits, with the trajectory after the first clause', function () {
    const halves = stream(final.plays)
    expect(lineAt(halves, 2).sentence).equals(
      'Anthony Rizzo singles on a line drive. Juan Soto steals a base. Juan Soto scores.'
    )
    expect(lineAt(halves, 9).sentence).equals(
      'Luis Garcia singles on a ground ball.'
    )
    expect(lineAt(halves, 19).sentence).equals(
      'Out, Rowan Pell (2B) on a pop up.'
    )
    // No ball in play, so no trajectory.
    expect(lineAt(halves, 0).sentence).equals('Juan Soto walks.')
    expect(lineAt(halves, 1).sentence).equals(
      'Tyler Glasnow strikes out the batter.'
    )
  })

  it('says a bunt as a bunt, and leaves out a trajectory it has no words for', function () {
    const plays = copy(final.plays)
    const bunt = eventsOf(plays[9]).findLast(e => e.details?.isInPlay === true)
    bunt!.hitData.trajectory = 'bunt_grounder'
    const odd = eventsOf(plays[13]).findLast(e => e.details?.isInPlay === true)
    odd!.hitData.trajectory = 'sideways'
    const halves = stream(plays)
    expect(lineAt(halves, 9).sentence).equals('Luis Garcia singles on a bunt.')
    expect(lineAt(halves, 13).sentence).equals('Max Muncy singles.')
  })

  it('says the play’s type, with its trajectory, when nobody is credited', function () {
    const plays = copy(final.plays)
    plays[9].credits = []
    expect(lineAt(stream(plays), 9).sentence).equals('Single on a ground ball.')
  })

  it('gives the outs after the play and the pitcher', function () {
    const halves = stream(final.plays)
    expect([lineAt(halves, 0).outs, lineAt(halves, 0).pitcher]).deep.equals([
      0,
      'Tyler Glasnow'
    ])
    expect([lineAt(halves, 3).outs, lineAt(halves, 3).pitcher]).deep.equals([
      3,
      'Tyler Glasnow'
    ])
    expect([lineAt(halves, 7).outs, lineAt(halves, 7).pitcher]).deep.equals([
      3,
      'Luis Gil'
    ])
  })

  it('gives the score after a scoring play, and none after any other', function () {
    const halves = stream(final.plays)
    expect(lineAt(halves, 2).score).equals('Harbor Hawks 1, Valley Pines 0')
    expect(lineAt(halves, 14).score).equals('Harbor Hawks 2, Valley Pines 3')
    expect(lineAt(halves, 0)).not.to.have.property('score')
    expect(lineAt(halves, 5)).not.to.have.property('score')
  })

  it('lists the pitches in order with the call and the count after each', function () {
    expect(lineAt(stream(final.plays), 0).rows).deep.equals([
      { kind: 'pitch', pitchNumber: 1, call: 'Ball', balls: 1, strikes: 0 },
      { kind: 'pitch', pitchNumber: 2, call: 'Ball', balls: 2, strikes: 0 },
      {
        kind: 'pitch',
        pitchNumber: 3,
        call: 'Called Strike',
        balls: 2,
        strikes: 1
      },
      { kind: 'pitch', pitchNumber: 4, call: 'Ball', balls: 3, strikes: 1 },
      { kind: 'pitch', pitchNumber: 5, call: 'Ball', balls: 4, strikes: 1 }
    ])
  })

  it('reads a call from the description when there is no call, and numbers an unnumbered pitch', function () {
    const plays = copy(final.plays)
    const first = eventsOf(plays[0])[0]
    delete first.details.call
    first.details.description = 'Pitchout'
    delete first.pitchNumber
    const row = lineAt(stream(plays), 0).rows[0] as PitchRow
    expect([row.pitchNumber, row.call]).deep.equals([1, 'Pitchout'])
  })

  it('gives the speed and the pitch type when the pitch has them, and leaves them out when not', function () {
    const plays = copy(final.plays)
    const first = eventsOf(plays[0])[0]
    first.pitchData = { startSpeed: 71.4 }
    first.details.type = { code: 'FF', description: 'Four-Seam Fastball' }
    const rows = lineAt(stream(plays), 0).rows as PitchRow[]
    expect(rows[0].speed).equals(71.4)
    expect(rows[0].pitchType).equals('Four-Seam Fastball')
    expect(rows[1]).not.to.have.any.keys('speed', 'pitchType')
  })

  it('reads the exit velocity from the in-play pitch, never from the play', function () {
    const plays = copy(final.plays)
    const inPlay = eventsOf(plays[4]).findLast(
      e => e.details?.isInPlay === true
    )
    inPlay!.hitData.launchSpeed = 94.2
    ;(plays[4] as Record<string, unknown>).hitData = { launchSpeed: 101 }
    ;(plays[13] as Record<string, unknown>).hitData = { launchSpeed: 99 }
    // A speed on a pitch not put in play is no exit velocity.
    eventsOf(plays[4])[0].hitData = { launchSpeed: 80 }
    const halves = stream(plays)
    const rows = lineAt(halves, 4).rows as PitchRow[]
    expect(rows.map(row => row.exitVelocity)).deep.equals([undefined, 94.2])
    expect(
      (lineAt(halves, 13).rows as PitchRow[]).some(
        row => row.exitVelocity != null
      )
    ).equals(false)
  })

  it('puts an action among the pitches where it happened', function () {
    const plays = copy(final.plays)
    eventsOf(plays[0]).splice(2, 0, {
      type: 'action',
      isPitch: false,
      details: { description: 'Mound visit.', eventType: 'mound_visit' }
    })
    // Markers and events with nothing to say are not rows.
    eventsOf(plays[0]).push(
      { type: 'inning_ended', isPitch: false, details: { description: 'x' } },
      { type: 'action', isPitch: false, details: {} },
      null as unknown as Record<string, any>
    )
    const halves = stream(plays)
    expect(
      lineAt(halves, 0).rows.map(row =>
        row.kind === 'pitch' ? row.pitchNumber : row.description
      )
    ).deep.equals([1, 2, 'Mound visit.', 3, 4, 5])
    expect(
      lineAt(halves, 2).rows.map(row =>
        row.kind === 'pitch' ? row.pitchNumber : row.description
      )
    ).deep.equals([1, 'Juan Soto steals second.', 2])
  })

  it('folds a lineup change into the next at-bat of its half', function () {
    const plays = shifted(final.plays, 5)
    plays.push(
      change(5, 1, 'bottom', {
        playEvents: [
          {
            type: 'action',
            isPitch: false,
            details: { description: 'Luis Gil replaces Gerrit Cole.' }
          }
        ]
      })
    )
    const halves = stream(plays)
    expect(lines(halves).map(line => line.atBatIndex)).not.to.include(5)
    expect(lineAt(halves, 6).rows[0]).deep.equals({
      kind: 'event',
      description: 'Luis Gil replaces Gerrit Cole.'
    })
    expect(lineAt(halves, 6).rows[1].kind).equals('pitch')
    expect(lineAt(halves, 4).rows.every(row => row.kind === 'pitch')).equals(
      true
    )
  })

  it('folds a lineup change into the at-bat in progress', function () {
    const current = copy(live.currentPlay!)
    current.about.atBatIndex += 1
    const plays = [
      ...live.plays,
      change(13, 2, 'bottom', {
        result: {
          eventType: 'offensive_substitution',
          description: 'Rowan Pell pinch-hits.'
        }
      })
    ]
    const halves = stream(plays, { currentPlay: current, final: false })
    const last = halves[halves.length - 1].lines.at(-1)!
    expect(last.inProgress).equals(true)
    expect(last.rows[0]).deep.equals({
      kind: 'event',
      description: 'Rowan Pell pinch-hits.'
    })
  })

  it('puts a lineup change with nothing after it in its half onto the half’s last line', function () {
    const plays = shifted(final.plays, 8)
    plays.push(change(8, 1, 'bottom'))
    const halves = stream(plays)
    expect(lineAt(halves, 7).rows.at(-1)).deep.equals({
      kind: 'event',
      description: 'Pitching change.'
    })
    // The next half starts clean.
    expect(lineAt(halves, 9).rows[0].kind).equals('pitch')
  })

  it('puts two lineup changes in a row, at the end of the game, onto the last line', function () {
    const plays = [
      ...final.plays,
      change(21, 3, 'top', {
        result: { eventType: 'defensive_switch', description: 'One.' }
      }),
      change(22, 3, 'top', {
        result: { eventType: 'defensive_switch', description: 'Two.' }
      })
    ]
    const rows = lineAt(stream(plays), 20).rows
    expect(rows.slice(-2)).deep.equals([
      { kind: 'event', description: 'One.' },
      { kind: 'event', description: 'Two.' }
    ])
  })

  it('drops a lineup change in a half with no turn at bat', function () {
    const plays = [...final.plays, change(21, 3, 'bottom')]
    const halves = stream(plays)
    expect(halves.map(half => half.key)).not.to.include('bottom-3')
    expect(lineAt(halves, 20).rows.every(row => row.kind === 'pitch')).equals(
      true
    )
  })

  it('shows an imported play with no pitches as a line that does not open', function () {
    const halves = stream(final.plays.map(asImported))
    const line = lineAt(halves, 2)
    expect(line.rows).deep.equals([])
    expect(line.expandable).equals(false)
    expect(line.sentence).equals(
      'Anthony Rizzo singles. Juan Soto steals a base. Juan Soto scores.'
    )
    expect(line.outs).equals(1)
    expect(line.pitcher).equals('Tyler Glasnow')
    expect(lineAt(stream(final.plays), 2).expandable).equals(true)
  })

  it('ends with the at-bat in progress and its pitches so far', function () {
    const halves = stream(live.plays, {
      currentPlay: live.currentPlay,
      final: false
    })
    const last = halves[halves.length - 1]
    expect(last.key).equals('bottom-2')
    const line = last.lines[last.lines.length - 1]
    expect(line).deep.equals({
      atBatIndex: 13,
      batter: { gumboId: 9205, name: 'Max Muncy' },
      sentence: 'Max Muncy batting, 1-0, 0 outs',
      outs: 0,
      pitcher: 'Luis Gil',
      rows: [
        {
          kind: 'event',
          description:
            'Giancarlo Stanton remains in the game as the center fielder.'
        },
        { kind: 'pitch', pitchNumber: 1, call: 'Ball', balls: 1, strikes: 0 }
      ],
      expandable: true,
      inProgress: true
    })
  })

  it('says one out in the singular, and an at-bat with no pitch yet does not open', function () {
    const current = copy(live.currentPlay!) as Record<string, any>
    current.count = { balls: 0, strikes: 0, outs: 1 }
    current.playEvents = []
    const halves = stream(live.plays, {
      currentPlay: current as CurrentPlay,
      final: false
    })
    const line = halves.at(-1)!.lines.at(-1)!
    expect(line.sentence).equals('Max Muncy batting, 0-0, 1 out')
    expect(line.expandable).equals(false)
  })

  it('starts a new half for the at-bat in progress, and ignores one with no half', function () {
    const current = copy(live.currentPlay!)
    current.about.inning = 3
    current.about.halfInning = 'top'
    const plays = live.plays.filter(play => play.about.atBatIndex < 13)
    const halves = stream(plays, { currentPlay: current, final: false })
    expect(halves.map(half => half.key)).deep.equals([
      'top-1',
      'bottom-1',
      'top-2',
      'top-3'
    ])
    // The 2nd's top has ended now that the 3rd has begun.
    expect(halves[2].summary).not.equals(undefined)
    expect(halves[3].summary).equals(undefined)

    const nowhere = copy(live.currentPlay!)
    nowhere.about.halfInning = null
    const without = stream(live.plays, { currentPlay: nowhere, final: false })
    expect(lines(without).some(line => line.inProgress)).equals(false)
  })

  it('sums up each half that has ended, and not the one still being played', function () {
    const halves = stream(live.plays, {
      currentPlay: live.currentPlay,
      final: false
    })
    expect(halves.map(half => half.summary)).deep.equals([
      { runs: 1, hits: 1, errors: 0, leftOnBase: 0 },
      { runs: 1, hits: 1, errors: 0, leftOnBase: 0 },
      { runs: 1, hits: 1, errors: 1, leftOnBase: 1 },
      undefined
    ])
  })

  it('sums up the last half once the game is final', function () {
    const halves = stream(final.plays)
    expect(halves.map(half => half.summary)).deep.equals([
      { runs: 1, hits: 1, errors: 0, leftOnBase: 0 },
      { runs: 1, hits: 1, errors: 0, leftOnBase: 0 },
      { runs: 1, hits: 1, errors: 1, leftOnBase: 1 },
      { runs: 2, hits: 2, errors: 0, leftOnBase: 0 },
      { runs: 0, hits: 0, errors: 0, leftOnBase: 0 }
    ])
    expect(stream(final.plays, { final: false }).at(-1)!.summary).equals(
      undefined
    )
  })

  it('leaves a figure the line score cannot say out of the summary', function () {
    const halves = stream(final.plays.map(asImported))
    // Imported plays list no runners left on base.
    expect(halves[0].summary).deep.equals({ runs: 1, hits: 1, errors: 0 })
    expect(halves[0].summary).not.to.have.property('leftOnBase')
  })
})
