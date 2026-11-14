import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { applyAction, type ScoringSession } from '../../common/scoring/session'
import { scoringSession } from '../../test/scoringSession'
import { shortPlayerNames } from './currentSetup'
import { gameFixture } from './isUnscoredGame.test'
import {
  describeLogSpans,
  describePlay,
  type LogDescriptionCache,
  newLogDescriptionCache
} from './playDescription'
import { readableFor } from './remoteLog'

/**
 * Each at-bat's words with one author throughout, as the remote log tells
 * them: its spans' words in order, one line each.
 */
function summaries(
  session: Pick<ScoringSession, 'state' | 'opening' | 'actions'>,
  cache?: LogDescriptionCache
): Map<number, string> {
  const { readable } = readableFor(session.state)
  const out = new Map<number, string>()
  for (const span of describeLogSpans(
    session.opening,
    session.actions,
    session.actions.map(() => null),
    readable,
    cache
  )) {
    if (span.text == null) continue
    const before = out.get(span.atBatIndex)
    out.set(
      span.atBatIndex,
      before == null ? span.text : `${before}\n${span.text}`
    )
  }
  return out
}

describe('log span descriptions', () => {
  function openingGame(): ReturnType<typeof scoringSession> {
    const game = scoringSession(gameFixture)
    for (const player of Object.values(game.gameData.players))
      player.nameFormat = 'full'
    return game
  }
  function build(
    actions: ScoringAction[],
    opening = openingGame()
  ): {
    state: ReturnType<typeof scoringSession>
    opening: ReturnType<typeof scoringSession>
    actions: ScoringAction[]
  } {
    const state = actions.reduce((game, action) => {
      const applied = applyAction(game, action)
      expect(applied.problems, JSON.stringify(action)).deep.equals([])
      return applied.state
    }, opening)
    return { state, opening, actions }
  }
  function publicOpening(): ReturnType<typeof scoringSession> {
    const game = openingGame()
    const batter = game.liveData.linescore.offense.batter!.id
    const left = game.liveData.linescore.defense.LF!.id
    Object.assign(game.gameData.players[batter], {
      fullName: 'Mike Trout',
      firstName: 'Mike',
      lastName: 'Trout',
      nameFormat: 'full',
      compactName: 'Mike T.'
    })
    Object.assign(game.gameData.players[left], {
      fullName: 'Mookie Betts',
      firstName: 'Mookie',
      lastName: 'Betts',
      nameFormat: 'full',
      compactName: 'Mookie B.'
    })
    return game
  }
  for (const [calls, outcome] of [
    [['B', 'B', 'C', 'B', 'B'], 'walks'],
    [['B', 'C', 'S', 'S'], 'strikes out swinging'],
    [['C', 'B', 'C', 'C'], 'strikes out looking']
  ] as const) {
    it(`shows the pitch sequence only once when the batter ${outcome}`, () => {
      const session = build(
        calls.map(call => ({ type: 'pitch', call })),
        publicOpening()
      )
      const lines = [...summaries(session).values()].join('\n').split('\n')
      expect(lines).has.length(2)
      expect(lines[0]).matches(/^(Ball|Called strike)/)
      expect(lines[1]).equals(`Mike T. ${outcome}`)
      expect(lines.join(' '))
        .not.contains('on ball')
        .and.not.contains('on called strike')
    })
  }
  for (const [trajectory, verb] of [
    ['fly_ball', 'flies out'],
    ['line_drive', 'lines out'],
    ['popup', 'pops out']
  ] as const) {
    it(`uses Undo's ${verb} wording and defensive-field labels despite full-name access`, () => {
      const opening = publicOpening()
      const session = build(
        [
          {
            type: 'ballInPlay',
            contact: 'swing',
            trajectory,
            fielder: opening.liveData.linescore.defense.LF!.id
          },
          { type: 'result', eventType: 'field_out', outBy: 'catch' }
        ],
        opening
      )
      const text = [...summaries(session).values()][0]
      expect(text).contains(`Mike T. ${verb}`).and.contains('Mookie B. (LF)')
      expect(text)
        .not.contains('at the plate')
        .and.not.contains('Mike Trout')
        .and.not.contains('Mookie Betts')
    })
  }
  for (const eventType of ['single', 'double', 'triple', 'home_run'] as const) {
    it(`uses the Undo description for ${eventType}`, () => {
      const session = build([
        { type: 'ballInPlay', contact: 'swing' },
        { type: 'result', eventType }
      ])
      const expected = describePlay(
        session.opening,
        session.actions,
        session.state
      )!
      expect([...summaries(session).values()][0]).equals(
        [expected.primary, expected.secondary].filter(Boolean).join(', ')
      )
    })
  }
  it('retains the pitch sequence and starts a separate ball-in-play line', () => {
    const pitches = (
      ['B', 'S', 'C', 'B', 'F', 'F'] as const
    ).map<ScoringAction>(call => ({ type: 'pitch', call }))
    const before = build(pitches)
    const pitchText = describePlay(
      before.opening,
      pitches,
      before.state
    )!.primary
    expect([...summaries(before).values()]).deep.equals([pitchText])
    const after = build([
      ...pitches,
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'single' }
    ])
    const lines = [...summaries(after).values()][0].split('\n')
    expect(lines[0]).equals(pitchText)
    expect(lines[1]).contains('single')
    expect(lines[1]).not.contains('after ').and.not.contains('ball,')
  })
  it('keeps earlier balls out of a line-out description and retains the relay', () => {
    const opening = openingGame()
    const batter = opening.liveData.linescore.offense.batter!.id
    const shortstop = opening.liveData.linescore.defense.SS!.id
    const first = opening.liveData.linescore.defense['1B']!.id
    const pitches: ScoringAction[] = [
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' }
    ]
    const play: ScoringAction[] = [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'line_drive',
        fielder: shortstop
      },
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      {
        type: 'runnerMovement',
        runner: batter,
        to: '1B',
        out: true,
        fielders: [shortstop, first]
      }
    ]
    const session = build([...pitches, ...play], opening)
    const lines = [...summaries(session).values()][0].split('\n')
    const expected = describePlay(
      build(pitches, opening).state,
      play,
      session.state
    )!
    expect(lines).has.length(2)
    expect(lines[0]).equals('Ball, ball')
    expect(lines[1]).equals(
      [expected.primary, expected.secondary].filter(Boolean).join(', ')
    )
    expect(lines[1]).not.contains('after ').and.not.contains('ball,')
    expect(lines[1]).contains('(SS) to ').and.contains('(1B)')
  })
  it('uses Undo wording for a walk', () => {
    const session = build(
      Array.from({ length: 4 }, () => ({ type: 'pitch', call: 'B' }))
    )
    expect([...summaries(session).values()][0]).contains('walks')
  })
  it('updates the existing play with Undo error credits and compact fielder names', () => {
    const opening = publicOpening()
    const left = opening.liveData.linescore.defense.LF!.id
    const actions: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'field_error' }
    ]
    const before = summaries(build(actions, opening))
    const after = summaries(
      build(
        [...actions, { type: 'fieldingPlay', fielders: [left], error: left }],
        opening
      )
    )
    expect([...after.keys()]).deep.equals([...before.keys()])
    expect([...after.values()][0])
      .contains('Mike T. reaches on an error')
      .and.contains('Mookie B. (LF)')
  })
  it('uses Undo defensive relay descriptions', () => {
    const opening = openingGame()
    const batter = opening.liveData.linescore.offense.batter!.id
    const shortstop = opening.liveData.linescore.defense.SS!.id
    const first = opening.liveData.linescore.defense['1B']!.id
    const session = build(
      [
        { type: 'ballInPlay', contact: 'swing', fielder: shortstop },
        { type: 'result', eventType: 'field_out', outBy: 'throw' },
        {
          type: 'runnerMovement',
          runner: batter,
          to: '1B',
          out: true,
          fielders: [shortstop, first]
        }
      ],
      opening
    )
    const expected = describePlay(opening, session.actions, session.state)!
    expect([...summaries(session).values()][0]).equals(
      [expected.primary, expected.secondary].filter(Boolean).join(', ')
    )
  })
  for (const out of [false, true]) {
    it(`keeps a later runner ${out ? 'out' : 'steal'} separate after Done`, () => {
      const opening = openingGame()
      const batter = opening.liveData.linescore.offense.batter!.id
      const actions: ScoringAction[] = [
        { type: 'ballInPlay', contact: 'swing' },
        { type: 'result', eventType: 'single' }
      ]
      const before = summaries(build(actions, opening))
      const session = build(
        [
          ...actions,
          { type: 'gameFlow', kind: 'closePlay' },
          {
            type: 'baseRunning',
            runner: batter,
            kind: out ? 'caught_stealing' : 'steal',
            to: '2B'
          }
        ],
        opening
      )
      const after = summaries(session)
      expect(after.size).equals(2)
      expect(after.get(0)).equals(before.get(0))
      expect(after.get(1)).contains(
        shortPlayerNames(Object.values(session.state.gameData.players)).get(
          batter
        )!
      )
    })
  }
  it('keeps a removed historical player compact without a current roster label', () => {
    const opening = publicOpening()
    const batter = opening.liveData.linescore.offense.batter!.id
    delete opening.gameData.players[batter].compactName
    const session = build(
      [
        { type: 'ballInPlay', contact: 'swing' },
        { type: 'result', eventType: 'single' }
      ],
      opening
    )
    session.state = {
      ...session.state,
      gameData: {
        ...session.state.gameData,
        players: Object.fromEntries(
          Object.entries(session.state.gameData.players).filter(
            ([id]) => Number(id) !== batter
          )
        )
      }
    }
    const text = summaries(session).get(0)!
    expect(text).contains('Mike T')
    expect(text).not.contains('Mike Trout')
  })
  it('keeps incremental descriptions equivalent across append, Undo and correction', () => {
    const cache: LogDescriptionCache = newLogDescriptionCache()
    const opening = openingGame()
    const actions: ScoringAction[] = [
      { type: 'pitch', call: 'B' },
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'home_run' },
      { type: 'gameFlow', kind: 'closePlay' },
      { type: 'pitch', call: 'C' }
    ]
    for (const length of [1, 3, 4, 5, 3, 5]) {
      const session = build(actions.slice(0, length), opening)
      expect([...summaries(session, cache)]).deep.equals([
        ...summaries(session)
      ])
    }
    const corrected = build(
      [{ type: 'pitch', call: 'S' }, ...actions.slice(1)],
      opening
    )
    expect([...summaries(corrected, cache)]).deep.equals([
      ...summaries(corrected)
    ])
    const replacement = build(actions, openingGame())
    expect([...summaries(replacement, cache)]).deep.equals([
      ...summaries(replacement)
    ])
  })
  it('retains a steal before contact instead of swallowing it into pitch history', () => {
    const opening = openingGame()
    const runner = opening.liveData.linescore.offense.batter!.id
    const session = build(
      [
        { type: 'ballInPlay', contact: 'swing' },
        { type: 'result', eventType: 'single' },
        { type: 'gameFlow', kind: 'closePlay' },
        { type: 'pitch', call: 'B' },
        { type: 'baseRunning', runner, kind: 'steal', to: '2B' },
        { type: 'ballInPlay', contact: 'swing' },
        { type: 'result', eventType: 'single' }
      ],
      opening
    )
    const text = summaries(session).get(1)!
    expect(text).contains('steals second')
    expect(text.split('\n')[0]).equals('Ball')
    expect(text.split('\n').at(-1))
      .contains('single')
      .and.not.contains('after ball')
  })
  it('does not replace a completed play with an event without a current at-bat', () => {
    const opening = openingGame()
    const actions: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'single' },
      { type: 'gameFlow', kind: 'closePlay' }
    ]
    const cache: LogDescriptionCache = newLogDescriptionCache()
    const prior = summaries(build(actions, opening), cache).get(0)
    const session = build(
      [...actions, { type: 'gameFlow', kind: 'endHalf' }],
      opening
    )
    expect(summaries(session, cache).get(0)).equals(prior)
    expect([...summaries(session, cache)]).deep.equals([...summaries(session)])
  })
  it('checks the opening by reference before fingerprinting it', () => {
    const opening = openingGame()
    const actions: ScoringAction[] = [
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' }
    ]
    const cache = newLogDescriptionCache()
    summaries(build(actions, opening), cache)
    const checkpoint = cache.runs!.find(run => run.to === 2)?.after
    expect(checkpoint).not.equals(undefined)
    // The same object never reaches the fingerprint: a stale key is ignored.
    cache.openingKey = 'tampered'
    summaries(build(actions, opening), cache)
    expect(cache.runs!.find(run => run.to === 2)?.after).equals(checkpoint)
    // A reload's identical copy is fingerprinted once and reuses the cache.
    const reread = openingGame()
    summaries(build(actions, reread), cache)
    const kept = cache.runs!.find(run => run.to === 2)?.after
    summaries(build(actions, reread), cache)
    expect(cache.runs!.find(run => run.to === 2)?.after).equals(kept)
    expect(cache.opening).equals(reread)
    // Different content invalidates everything after the opening.
    const changed = openingGame()
    Object.assign(changed.gameData, { profileMarker: 1 })
    summaries(build(actions, changed), cache)
    expect(cache.runs!.find(run => run.to === 2)?.after).not.equals(kept)
  })
  it('keeps cached and fresh descriptions identical over 400 seeded steps', () => {
    let seed = 11
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const opening = openingGame()
    const pool: ScoringAction[] = [
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'F' },
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'single' },
      { type: 'gameFlow', kind: 'closePlay' }
    ]
    const cache = newLogDescriptionCache()
    let log: ScoringAction[] = []
    for (let step = 0; step < 400; step++) {
      const candidate =
        next() < 0.25
          ? log.slice(0, Math.floor(next() * (log.length + 1)))
          : [...log, pool[Math.floor(next() * pool.length)]]
      let state = opening
      let valid = true
      for (const action of candidate) {
        const applied = applyAction(state, action)
        if (applied.problems.length > 0) {
          valid = false
          break
        }
        state = applied.state
      }
      if (!valid) continue
      log = candidate
      const session = {
        state,
        opening: next() < 0.1 ? structuredClone(opening) : opening,
        actions: log
      }
      expect([...summaries(session, cache)]).deep.equals(
        [...summaries(session)],
        `step ${step}`
      )
    }
  })
})
