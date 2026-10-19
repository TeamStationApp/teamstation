import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GumboPlay } from '../../common/gumboPlay'
import { mapPlayers, type ScoringAction } from '../../common/scoring/actions'
import { foldPlay } from '../../common/scoring/gumbo'
import { freshGame, newSetup } from '../../common/scoring/lineup'
import { setupOf } from '../../common/scoring/state'
import { after, TEAMS } from '../../test/scoringGames'
import { type ExpandedGameLine, expandedGameStatLines } from './expandedStats'

const teams = { homeTeamId: 'home', awayTeamId: 'away' }
const known = new Set([1, 2, 3, 11, 12, 13])
const pitch = (index: number, code = 'C'): Record<string, unknown> => ({
  index,
  isPitch: true,
  details: { call: { code } }
})
function play(
  type: GumboPlay['result']['eventType'] = 'single',
  over: Partial<GumboPlay> = {}
): GumboPlay {
  const out = type.includes('out')
  return {
    about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
    result: { eventType: type },
    count: { outs: out ? 1 : 0 },
    matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
    playEvents: [pitch(0, out ? 'C' : 'D')],
    runners: [
      {
        movement: { start: null, end: out ? null : '1B', isOut: out },
        details: { runner: { id: 1 }, eventType: type }
      }
    ],
    ...over
  }
}
function lines(plays: GumboPlay[]): Map<number, ExpandedGameLine> {
  const result = expandedGameStatLines(plays, teams, known)
  if (result.kind !== 'lines') throw new Error(result.detail)
  return new Map(result.lines.map(line => [line.gumboId, line]))
}
const movement = (
  type: string,
  id = 1,
  index: number | null = 0,
  out = false
): NonNullable<GumboPlay['runners']>[number] => ({
  movement: { start: '1B', end: out ? null : '2B', isOut: out },
  details: { runner: { id }, eventType: type, playIndex: index }
})

describe('expanded game statistics', function () {
  function recorded(
    pinchRunner: boolean,
    actions: ScoringAction[],
    reverseRunners = false
  ): Map<number, ExpandedGameLine> {
    const away = Array.from({ length: pinchRunner ? 10 : 9 }, (_, i) => 101 + i)
    const home = Array.from({ length: pinchRunner ? 9 : 10 }, (_, i) => 201 + i)
    const setup = newSetup(TEAMS, {
      away: away.map(gumboId => ({ gumboId, shortName: 'Away' })),
      home: home.map(gumboId => ({ gumboId, shortName: 'Home' }))
    })
    setup.sides.away.battingOrder = setup.sides.away.battingOrder.slice(0, 9)
    setup.sides.home.battingOrder = setup.sides.home.battingOrder.slice(0, 9)
    // These scorebook scenarios name slots; translate once to the persisted IDs.
    actions = actions.map(
      action =>
        mapPlayers(action, slot => {
          if (typeof slot !== 'number')
            throw new Error('Expected a scorebook slot')
          const id = setup.tagOrder[slot - 1] ?? (slot === 20 ? 210 : undefined)
          if (id == null) throw new Error('Unknown scorebook slot')
          return id
        }) as ScoringAction
    )
    const state = after(freshGame('g1', TEAMS, setup), ...actions)
    const plays = state.liveData.plays.allPlays.map(play =>
      foldPlay(state, play, { setupBefore: setupOf(state), actions })
    )
    if (reverseRunners) for (const play of plays) play.runners?.reverse()
    const result = expandedGameStatLines(
      plays,
      {
        homeTeamId: TEAMS.home.id,
        awayTeamId: TEAMS.away.id
      },
      new Set([...away, ...home, 210])
    )
    if (result.kind !== 'lines') throw new Error(result.detail)
    return new Map(result.lines.map(line => [line.gumboId, line]))
  }
  const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
  const strikeout: ScoringAction[] = [
    { type: 'pitch', call: 'C' },
    { type: 'pitch', call: 'C' },
    { type: 'pitch', call: 'C' },
    close
  ]
  it('attributes recorded opening-PA pitches and GS to their actual pitchers', function () {
    const result = recorded(false, [
      { type: 'pitch', call: 'B' },
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'home',
        player: 19,
        replaces: 10
      },
      ...strikeout
    ])
    expect(result.get(201)).includes({ pitch_bf: 0, pitch_outs: 0 })
    expect(result.get(201)!.extra).includes({
      appeared: true,
      pitches: 1,
      gs: 1
    })
    expect(result.get(210)).includes({ pitch_bf: 1, pitch_outs: 1 })
    expect(result.get(210)!.extra).includes({
      appeared: true,
      pitches: 3,
      gs: 0
    })
  })
  for (const reverseRunners of [false, true]) {
    it(`handles safe-batter double-play choices (reversed=${reverseRunners})`, function () {
      const single: ScoringAction[] = [
        { type: 'ballInPlay', contact: 'swing', fielder: 17 },
        { type: 'result', eventType: 'single' },
        close
      ]
      const result = recorded(
        false,
        [
          ...single,
          {
            type: 'lineup',
            kind: 'position',
            side: 'home',
            position: 'P',
            player: 14
          },
          ...single,
          { type: 'result', eventType: 'fielders_choice' },
          {
            type: 'runnerMovement',
            runner: 1,
            to: '3B',
            out: true,
            fielders: [15]
          },
          {
            type: 'runnerMovement',
            runner: 2,
            to: '2B',
            out: true,
            fielders: [15, 13]
          },
          { type: 'runnerMovement', runner: 3, to: '1B' },
          close,
          ...strikeout
        ],
        reverseRunners
      )
      expect(result.get(201)!.extra.lob).equals(1)
      expect(result.get(205)!.extra.lob).equals(0)
      expect(result.get(103)!.extra.fc).equals(1)
    })
    it(`retains inherited responsibility through a recorded choice (reversed=${reverseRunners})`, function () {
      const result = recorded(
        false,
        [
          { type: 'ballInPlay', contact: 'swing', fielder: 17 },
          { type: 'result', eventType: 'single' },
          close,
          {
            type: 'lineup',
            kind: 'position',
            side: 'home',
            position: 'P',
            player: 14
          },
          { type: 'result', eventType: 'fielders_choice' },
          {
            type: 'runnerMovement',
            runner: 1,
            to: '2B',
            out: true,
            fielders: [15, 13]
          },
          { type: 'runnerMovement', runner: 2, to: '1B' },
          close,
          ...strikeout,
          ...strikeout
        ],
        reverseRunners
      )
      expect(result.get(201)!.extra.lob).equals(1)
      expect(result.get(205)!.extra.lob).equals(0)
      expect(result.get(102)!.extra.fc).equals(1)
    })
  }
  it('does not count a batter-out double play as a choice', function () {
    const result = recorded(false, [
      { type: 'ballInPlay', contact: 'swing', fielder: 17 },
      { type: 'result', eventType: 'single' },
      close,
      { type: 'result', eventType: 'field_out' },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '2B',
        out: true,
        fielders: [15, 13]
      },
      {
        type: 'runnerMovement',
        runner: 2,
        to: '1B',
        out: true,
        fielders: [13, 12]
      },
      close,
      ...strikeout
    ])
    expect(result.get(102)!.extra.fc).equals(0)
    expect(result.get(201)!.extra.lob).equals(0)
  })
  it('ignores missing or null movements while counting valid runner detail', function () {
    for (const missing of [undefined, null]) {
      const result = lines([
        play('single', {
          runners: [
            ...play().runners!,
            {
              movement: missing,
              details: { runner: { id: 2 }, eventType: 'stolen_base_2b' }
            },
            {
              movement: missing,
              details: { runner: { id: 3 }, eventType: 'caught_stealing_2b' }
            },
            movement('stolen_base_2b')
          ]
        })
      ])
      expect(result.has(2)).equals(false)
      expect(result.has(3)).equals(false)
      expect(result.get(1)!.sb).equals(1)
      expect(result.get(11)!.extra).includes({ pitchSb: 1, pitchCs: 0 })
    }
  })
  for (const thrower of [10, 11]) {
    it(`credits a recorded pickoff to its thrower (fielder=${thrower})`, function () {
      const result = recorded(false, [
        { type: 'ballInPlay', contact: 'swing', fielder: 17 },
        { type: 'result', eventType: 'single' },
        close,
        {
          type: 'baseRunning',
          kind: 'pickoff',
          runner: 1,
          to: '1B',
          fielders: [thrower, 12]
        },
        ...strikeout
      ])
      expect(result.get(101)!.extra.pik).equals(1)
      expect(result.get(201)!.extra.pitchPik).equals(thrower === 10 ? 1 : 0)
    })
    it(`retains CS for a combined recorded pickoff (fielder=${thrower})`, function () {
      const result = recorded(false, [
        { type: 'ballInPlay', contact: 'swing', fielder: 17 },
        { type: 'result', eventType: 'single' },
        close,
        {
          type: 'runnerMovement',
          runner: 1,
          to: '2B',
          out: true,
          fielders: [thrower, 13],
          reason: 'Picked Off'
        },
        ...strikeout
      ])
      expect(result.get(101)!.extra.pik).equals(1)
      expect(result.get(101)!.cs).equals(1)
      expect(result.get(201)!.extra.pitchCs).equals(1)
      expect(result.get(201)!.extra.pitchPik).equals(thrower === 10 ? 1 : 0)
    })
  }
  for (const outcome of ['scores', 'stranded', 'retired'] as const) {
    it(`preserves recorded pitcher LOB when a pinch runner is ${outcome}`, function () {
      const hit = (eventType: 'single' | 'home_run'): ScoringAction[] => [
        { type: 'ballInPlay', contact: 'swing', fielder: 18 },
        { type: 'result', eventType },
        close
      ]
      const retired: ScoringAction[] = [
        { type: 'baseRunning', kind: 'caught_stealing', runner: 10, to: '2B' }
      ]
      const result = recorded(true, [
        ...hit('single'),
        {
          type: 'lineup',
          kind: 'pinchRunner',
          side: 'away',
          base: '1B',
          player: 10
        },
        ...(outcome === 'scores' ? hit('home_run') : []),
        ...(outcome === 'retired' ? retired : []),
        ...strikeout,
        ...strikeout,
        ...(outcome === 'retired' ? [] : strikeout)
      ])
      expect(result.get(201)!.extra.lob).equals(outcome === 'stranded' ? 1 : 0)
    })
  }
  describe('a pinch runner who keeps the batting order (U4c)', function () {
    const hit = (eventType: 'single' | 'home_run'): ScoringAction[] => [
      { type: 'ballInPlay', contact: 'swing', fielder: 18 },
      { type: 'result', eventType },
      close
    ]
    // Away 1 singles off the starter, who leaves for a persisted guest
    // (slot 20, gumbo 210); Away 10 runs for him and keeps the order.
    const ran: ScoringAction[] = [
      ...hit('single'),
      {
        type: 'lineup',
        kind: 'addPlayer',
        side: 'home',
        name: 'Reliever',
        player: 20
      },
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'home',
        player: 20,
        replaces: 11
      },
      { type: 'lineup', kind: 'runner', side: 'away', base: '1B', player: 10 }
    ]
    it('credits him with his run, and the starter keeps the charge', function () {
      const result = recorded(true, [
        ...ran,
        ...hit('home_run'),
        ...strikeout,
        ...strikeout,
        ...strikeout
      ])
      expect(result.get(110)!.r).equals(1)
      expect(result.get(101)!.r).equals(0)
      expect(result.get(102)!.r).equals(1)
      // The guest reliever is charged only the batter's run.
      expect(result.get(201)!.pitch_r).equals(1)
      expect(result.get(201)!.extra.lob).equals(0)
    })
    it('gives him a steal after the swap, and the starter his runner left on', function () {
      const result = recorded(true, [
        ...ran,
        { type: 'baseRunning', kind: 'steal', runner: 10, to: '2B' },
        ...strikeout,
        ...strikeout,
        ...strikeout
      ])
      expect(result.get(110)!.sb).equals(1)
      expect(result.get(101)!.sb).equals(0)
      expect(result.get(201)!.extra.lob).equals(1)
    })
  })
  it('preserves base validation and empty games', function () {
    expect(
      expandedGameStatLines([play('single', { runners: [] })], teams, known)
        .kind
    ).equals('incomplete')
    expect(lines([]).size).equals(0)
    expect(
      lines([
        play('game_advisory', {
          about: { atBatIndex: 0 },
          runners: [],
          matchup: undefined
        })
      ]).size
    ).equals(0)
  })
  it('records reaches on error, choices, first PA, opponent AB and starter', function () {
    for (const type of [
      'field_error',
      'fielders_choice',
      'fielders_choice_out'
    ] as const) {
      const result = lines([play(type)])
      expect(result.get(1)!.extra).includes({
        roe: type === 'field_error' ? 1 : 0,
        fc: type === 'field_error' ? 0 : 1,
        firstPa: 0
      })
      expect(result.get(11)!.extra).includes({
        appeared: true,
        gs: 1,
        pitches: 1,
        pitchAb: 1
      })
    }
  })
  it('uses the terminal called strike and marks missing detail unknown', function () {
    expect(lines([play('strikeout')]).get(11)!.extra.kl).equals(1)
    expect(
      lines([play('strikeout', { playEvents: [pitch(0), pitch(1, 'S')] })]).get(
        11
      )!.extra.kl
    ).equals(0)
    expect(
      lines([play('strikeout', { playEvents: undefined })]).get(11)!.extra
    ).includes({ kl: null, pitches: null })
    expect(
      lines([
        play('strikeout', {
          playEvents: [{ isPitch: true, index: 0, details: { code: 'C' } }]
        })
      ]).get(11)!.extra.kl
    ).equals(1)
    expect(
      lines([play('intent_walk', { playEvents: [] })]).get(11)!.extra
    ).includes({ pitches: 0, pitchAb: 0 })
  })
  it('does not let advisory rows erase the starter or completed-half detail', function () {
    const result = lines([
      play('game_advisory', {
        matchup: undefined,
        runners: [],
        playEvents: [],
        count: undefined
      }),
      play('field_out', {
        about: { atBatIndex: 1, inning: 1, halfInning: 'top' },
        count: { outs: 3 }
      }),
      play('game_advisory', {
        about: { atBatIndex: 2, inning: 1, halfInning: 'top' },
        matchup: undefined,
        runners: [],
        playEvents: [],
        count: undefined
      })
    ])
    expect(result.get(11)!.extra).includes({ gs: 1, lob: 0 })
  })

  it('keeps a pitcher who threw but completed no batter or out', function () {
    const result = lines([
      play('single', {
        matchup: { batter: { id: 1 }, pitcher: { id: 12 } },
        playEvents: [
          pitch(0),
          {
            index: 1,
            details: { eventType: 'pitching_substitution' },
            player: { id: 12 },
            replacedPlayer: { id: 11 }
          },
          pitch(2)
        ]
      })
    ])
    expect(result.get(11)!).includes({
      pitch_bf: 0,
      pitch_outs: 0,
      teamId: 'home'
    })
    expect(result.get(11)!.extra).includes({
      pitches: 1,
      appeared: true,
      gs: 1
    })
    expect(result.get(12)!.extra).includes({ pitches: 1, gs: 0, pitchAb: 1 })
  })
  it('uses the previous pitcher across a mid-PA change and records replaced batter order', function () {
    const result = lines([
      play(),
      play('strikeout', {
        about: { atBatIndex: 1, inning: 1, halfInning: 'top' },
        matchup: { batter: { id: 2 }, pitcher: { id: 12 } },
        runners: [
          {
            movement: { start: null, end: null, isOut: true },
            details: { runner: { id: 2 }, eventType: 'strikeout' }
          }
        ],
        playEvents: [
          pitch(0),
          {
            index: 1,
            details: { eventType: 'pitching_substitution' },
            player: { id: 12 }
          },
          {
            index: 2,
            details: { eventType: 'offensive_substitution' },
            player: { id: 2 },
            replacedPlayer: { id: 3 },
            count: { strikes: 2 }
          },
          pitch(3)
        ]
      })
    ])
    expect(result.get(11)!.extra.pitches).equals(2)
    expect(result.get(3)!.extra.firstPa).equals(1)
  })
  it('counts runner steals, combined pickoff/CS and errors once', function () {
    const stolen = movement('stolen_base_2b')
    const picked = movement('pickoff_caught_stealing_2b', 2, 1, true)
    const result = lines([
      play('stolen_base_2b', {
        runners: [stolen, stolen, picked, movement('pickoff_error_1b', 3, 2)],
        playEvents: []
      })
    ])
    expect(result.get(1)!).includes({ sb: 1, cs: 0 })
    expect(result.get(2)!).includes({ cs: 1 })
    expect(result.get(2)!.extra.pik).equals(1)
    expect(result.get(11)!.extra).includes({
      pitchSb: 1,
      pitchCs: 1,
      pitchPik: 1
    })
  })
  it('attributes runner events before a change and honors explicit pitcher', function () {
    const runner = movement('caught_stealing_2b', 1, 0, true)
    const result = lines([
      play('caught_stealing_2b', {
        matchup: { pitcher: { id: 12 } },
        count: { outs: 1 },
        playEvents: [
          {
            index: 1,
            details: { eventType: 'pitching_substitution' },
            player: { id: 12 },
            replacedPlayer: { id: 11 }
          }
        ],
        runners: [
          runner,
          {
            ...movement('pickoff_1b', 2, null, true),
            details: {
              ...movement('pickoff_1b', 2).details,
              pitcher: { id: 13 }
            }
          }
        ]
      })
    ])
    expect(result.get(11)!.extra.pitchCs).equals(1)
    expect(result.get(13)!.extra.pitchPik).equals(1)
  })
  it('counts battery events once for multiple runners, including standalone actions', function () {
    const result = lines([
      play('wild_pitch', {
        playEvents: [
          { index: 0, details: { eventType: 'wild_pitch' } },
          { index: 1, details: { eventType: 'balk' } }
        ],
        runners: [
          movement('wild_pitch'),
          movement('wild_pitch', 2),
          movement('balk', 1, 1)
        ]
      }),
      play('forced_balk', { runners: [], playEvents: [] })
    ])
    expect(result.get(11)!.extra).includes({ wp: 1, bk: 2 })
  })
  it('deduplicates unindexed battery movement without losing distinct events', function () {
    for (const type of ['wild_pitch', 'balk'] as const) {
      const field = type === 'wild_pitch' ? 'wp' : 'bk'
      const unindexed = movement(type)
      delete unindexed.details!.playIndex
      for (const eventCount of [1, 2]) {
        const result = lines([
          play(type, {
            playEvents: Array.from({ length: eventCount }, (_, index) => ({
              index,
              details: { eventType: type }
            })),
            runners: [unindexed, movement(type, 2, null)]
          })
        ])
        expect(result.get(11)!.extra[field]).equals(eventCount)
      }
      expect(
        lines([
          play(type, {
            playEvents: [],
            runners: [unindexed, movement(type, 2, null)]
          })
        ]).get(11)!.extra[field]
      ).equals(1)
    }
  })
  it('counts stranded inherited runners against their owner and resets each half', function () {
    const result = lines([
      play(),
      play('field_out', {
        about: { atBatIndex: 1, inning: 1, halfInning: 'top' },
        count: { outs: 3 },
        matchup: { batter: { id: 2 }, pitcher: { id: 12 } },
        runners: [
          {
            movement: { start: null, end: null, isOut: true },
            details: { runner: { id: 2 }, eventType: 'field_out' }
          }
        ]
      }),
      play('field_out', {
        about: { atBatIndex: 2, inning: 1, halfInning: 'bottom' },
        count: { outs: 3 },
        matchup: { batter: { id: 1 }, pitcher: { id: 13 } }
      })
    ])
    expect(result.get(11)!.extra.lob).equals(1)
    expect(result.get(12)!.extra.lob).equals(0)
    expect(result.get(13)!.extra).includes({ gs: 1, lob: 0 })
  })
  it('leaves incomplete innings, missing starts and missing runner histories unknown', function () {
    expect(lines([play()]).get(11)!.extra.lob).equals(null)
    expect(
      lines([
        play('field_out', {
          about: { atBatIndex: 5, inning: 3, halfInning: 'top' },
          count: { outs: 3 }
        })
      ]).get(11)!.extra
    ).includes({ gs: null, lob: null })
    expect(
      lines([
        play('other_out', {
          count: { outs: 3 },
          runners: [movement('other_advance')]
        })
      ]).get(11)!.extra.lob
    ).equals(null)
  })
  it('tracks scored runners and ignores unnamed statistical credits', function () {
    const run = {
      movement: { start: '1B', end: 'score', isOut: false },
      details: {
        runner: { id: 1 },
        responsiblePitcher: { id: 11 },
        eventType: 'other_advance',
        earned: true,
        rbi: false
      }
    }
    const result = lines([
      play(),
      play('other_out', { count: { outs: 3 }, runners: [run] })
    ])
    expect(result.get(11)!.extra.lob).equals(0)
    expect(
      lines([
        play('stolen_base_2b', {
          matchup: { pitcher: {} },
          runners: [
            {
              ...movement('stolen_base_2b'),
              details: {
                runner: { fullName: 'Demo Runner' },
                eventType: 'stolen_base_2b'
              }
            }
          ]
        })
      ]).size
    ).equals(0)
  })
})
