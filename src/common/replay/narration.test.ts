import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  AWAY_PLAYERS,
  finalGame,
  HOME_PLAYERS,
  replayActions,
  replayContext,
  scored
} from '../../test/replayGameFixture'
import {
  after,
  ball,
  close,
  F,
  game,
  single,
  strike,
  walk
} from '../../test/scoringGames'
import type { ScoringAction } from '../scoring/actions'
import { applyAction } from '../scoring/apply'
import type { GameState } from '../scoring/state'
import type { Transition } from '../scoring/transitions'
import {
  direction,
  fit,
  MAX_NARRATION,
  narrateStep,
  narrateTimeline,
  type Narration,
  spoken,
  stepsWithStates
} from './narration'
import { replayTimelineOf } from './replayTimeline'

/** What the announcer says for `actions` taken on `state`, as one step. */
function say(state: GameState, ...actions: ScoringAction[]): Narration {
  let now = state
  const transitions: Transition[] = []
  for (const action of actions) {
    const applied = applyAction(now, action)
    expect(applied.problems, JSON.stringify(action)).deep.equals([])
    transitions.push(...applied.transitions)
    now = applied.state
  }
  return narrateStep(state, { actions }, now, transitions)
}

const inPlay = (
  fielder: number,
  launchAngle: number,
  location: { x: number; z: number }
): Extract<ScoringAction, { type: 'ballInPlay' }> => ({
  type: 'ballInPlay',
  contact: 'swing',
  fielder,
  launchAngle,
  location
})

describe('replay narration of a whole game', function () {
  this.timeout(20000)

  async function narrations(): Promise<Map<string, Narration>> {
    return narrateTimeline(replayTimelineOf(await finalGame(), replayContext()))
  }

  it('calls every pitch with the count, and names each batter on their first pitch', async function () {
    const said = await narrations()
    expect(said.get('0-0')).deep.equals({
      text: 'Juan S steps in. Ball one, one and oh.',
      emphasis: 'calm'
    })
    expect(said.get('0-2')?.text).equals('Called strike one, two and one.')
    expect(said.get('0-4')?.text).equals('Ball four, Juan S walks.')
    expect(said.get('1-3')?.text).equals(
      'Strike three called! Aaron J is out looking.'
    )
    expect(said.get('5-3')?.text).equals(
      'Foul tip, strike three! Freddie F strikes out.'
    )
    expect(said.get('11-4')?.text).equals(
      'Swing and a miss, strike three! Giancarlo S strikes out.'
    )
  })

  it('tells each ball in play, its runners, the score and the end of each half', async function () {
    const said = await narrations()
    expect(said.get('2-1')?.text).equals(
      'Anthony R steps in. Ball one, one and oh. Juan S steals second!'
    )
    expect(said.get('2-3')).deep.equals({
      text: 'Anthony R lines a single to left field. Juan S scores! Harbor Hawks lead one to nothing.',
      emphasis: 'excited'
    })
    expect(said.get('3-2')?.text).equals(
      "Gleyber T grounds into a double play, short to second to first! That's three outs. Middle of the 1st: Harbor Hawks one, Valley Pines nothing."
    )
    expect(said.get('4-2')).deep.equals({
      text: 'Mookie B hits it deep to left-center, that ball is gone! A solo home run. That ties it at one.',
      emphasis: 'excited'
    })
    expect(said.get('6-1')?.text).equals('Shohei O flies out to center.')
    expect(said.get('7-1')?.text).equals(
      'Now pitching for the Harbor Hawks, Luis Gi.'
    )
    expect(said.get('8-1')?.text).equals(
      'Anthony V reaches on an error by the shortstop.'
    )
    expect(said.get('9-1')?.text).equals(
      'Luis Ga steps in. Ball one, one and oh. Wild pitch, Anthony V moves up to second.'
    )
    expect(said.get('10-1')?.text).equals(
      'Jose T lifts a sacrifice fly to center. Anthony V scores! Harbor Hawks lead two to one.'
    )
    expect(said.get('11-1')?.text).equals(
      'Giancarlo S pinch-hits for Harrison B.'
    )
    expect(said.get('13-1')?.text).equals('Giancarlo S moves to center field.')
    expect(said.get('14-1')?.text).equals(
      'Teoscar H drives it to right-center and races around the bases, an inside-the-park home run! Max M scores! Valley Pines lead three to two.'
    )
    expect(said.get('19-1')?.text).equals('Aaron J pops out to second.')
    // The last out is called with excitement and no half's summary; the end
    // of the game has the final word.
    expect(said.get('20-3')).deep.equals({
      text: 'Swing and a miss, strike three! Anthony R strikes out.',
      emphasis: 'excited'
    })
    expect(said.get('9999-1')).deep.equals({
      text: "That's the ballgame! Valley Pines win, three to two.",
      emphasis: 'excited'
    })
  })

  it('walks a long game without copying the plays already finished, and leaves each state as it was', async function () {
    const timeline = replayTimelineOf(await finalGame(), replayContext())
    const steps = [...stepsWithStates(timeline)]
    const last = steps.at(-1)!
    expect(last.after.liveData.plays.allPlays.length).greaterThan(10)
    // Later states hold the first finished play as the same object, copied
    // again only now and then: a game of 200 steps does not copy every
    // finished play at every step.
    const holding = steps
      .map(({ after }) => after.liveData.plays.allPlays[0])
      .filter(play => play != null)
    expect(holding.length).greaterThan(steps.length / 2)
    expect(new Set(holding).size).lessThan(holding.length / 4)
    // Each step's `before` is the game as the previous step left it.
    const snapshot = JSON.stringify(steps[5].after)
    expect(JSON.stringify(steps[6].before)).equals(snapshot)
    expect(JSON.stringify(steps[5].after)).equals(snapshot)
  })

  it('narrates a longer copy of a game on from where the last one ended, keeping every sentence before', async function () {
    const actions = replayActions()
    const context = replayContext()
    const full = replayTimelineOf(await finalGame(), context)
    const whole = narrateTimeline(full)
    for (const count of [12, 40, actions.length - 1]) {
      const shorter = replayTimelineOf(
        await scored(actions.slice(0, count)),
        context
      )
      const earlier = narrateTimeline(shorter)
      const longer = narrateTimeline(full, {
        timeline: shorter,
        narrations: earlier
      })
      expect([...longer], String(count)).deep.equals([...whole])
      // Only the last two steps it had are narrated again, however long the
      // game: every sentence before them is the one already written.
      const kept = shorter.steps.slice(0, -2)
      expect(kept.length).greaterThan(0)
      for (const { key } of kept)
        expect(longer.get(key), key).equals(earlier.get(key))
    }
    // A copy that is not the same game so far is narrated afresh.
    const other = replayTimelineOf(await scored(actions.slice(0, 30)), context)
    const fresh = narrateTimeline(other, {
      timeline: full,
      narrations: whole
    })
    expect([...fresh]).deep.equals([...narrateTimeline(other)])
    expect(fresh.get(other.steps[0].key)).not.equals(
      whole.get(other.steps[0].key)
    )
  })

  it('names players only by first name and last initial, telling two alike apart', async function () {
    const texts = [...(await narrations()).values()].map(said => said.text)
    for (const player of [...AWAY_PLAYERS, ...HOME_PLAYERS])
      for (const text of texts)
        expect(text, player.last).not.match(new RegExp(`\\b${player.last}\\b`))
    expect(texts.join(' ')).includes('Luis Ga').and.includes('Luis Gi')
    for (const text of texts) expect(text.length).lessThanOrEqual(MAX_NARRATION)
  })

  it('narrates a grown step whole, and a ball in play saved before its result as in play', async function () {
    const actions = replayActions()
    const hit = actions.findIndex(action => action.type === 'ballInPlay')
    const early = narrateTimeline(
      replayTimelineOf(await scored(actions.slice(0, hit + 1)), replayContext())
    )
    expect([...early.values()].at(-1)?.text).equals(
      'Anthony R puts it in play to left field.'
    )
    const grown = narrateTimeline(
      replayTimelineOf(await scored(actions.slice(0, hit + 4)), replayContext())
    )
    expect([...grown.values()].at(-1)?.text).equals(
      'Anthony R lines a single to left field. Juan S scores! Harbor Hawks lead one to nothing.'
    )
  })
})

describe('replay narration of single plays', function () {
  it('calls balls, strikes, fouls and the count', function () {
    expect(say(game(), ball).text).equals(
      'Player 1 steps in. Ball one, one and oh.'
    )
    const two = after(game(), strike, strike)
    expect(say(two, { type: 'pitch', call: 'F' }).text).equals(
      'Fouled off, still oh and two.'
    )
    expect(say(after(game(), ball), { type: 'pitch', call: 'S' }).text).equals(
      'Swing and a miss, one and one.'
    )
    expect(say(after(game(), ball), { type: 'pitch', call: 'T' }).text).equals(
      'Foul tip, one and one.'
    )
    expect(say(after(game(), ball), { type: 'pitch', call: 'L' }).text).equals(
      'Bunted foul, one and one.'
    )
  })

  it('calls ball four a walk before the scorer closes it, as a live view first gets it', function () {
    const three = after(game(), ball, ball, ball)
    expect(say(three, ball).text).equals('Ball four, Player 1 walks.')
    // Closed in the same step, as a finished game has it.
    expect(say(three, ball, close).text).equals('Ball four, Player 1 walks.')
  })

  it('says who is hit by a pitch and who is walked on purpose', function () {
    expect(
      say(game(), { type: 'result', eventType: 'hit_by_pitch' }, close).text
    ).equals('Player 1 is hit by a pitch.')
    expect(
      say(game(), { type: 'result', eventType: 'intent_walk' }, close).text
    ).equals('Player 1 is walked intentionally.')
  })

  it('tells hits by how they were struck, and where', function () {
    expect(
      say(game(), inPlay(F.LF, -5, { x: -40, z: -60 }), {
        type: 'result',
        eventType: 'double'
      }).text
    ).equals('Player 1 grounds a double to left field.')
    expect(
      say(game(), inPlay(F.CF, 30, { x: 0, z: -100 }), {
        type: 'result',
        eventType: 'triple'
      }).text
    ).equals('Player 1 lines a triple to center field.')
    expect(
      say(game(), inPlay(F.CF, 40, { x: 2, z: -100 }), {
        type: 'result',
        eventType: 'single'
      }).text
    ).equals('Player 1 singles to center field.')
  })

  it('tells outs by their flight, and a fielder’s choice', function () {
    expect(
      say(game(), inPlay(F.SS, 55, { x: -10, z: -35 }), {
        type: 'result',
        eventType: 'field_out',
        outBy: 'catch'
      }).text
    ).equals('Player 1 pops out to short.')
    expect(
      say(game(), inPlay(F.CF, 20, { x: 0, z: -80 }), {
        type: 'result',
        eventType: 'field_out',
        outBy: 'catch'
      }).text
    ).equals('Player 1 lines out to center.')
    const onFirst = single(game())
    expect(
      say(
        onFirst,
        inPlay(F.SS, -5, { x: -10, z: -30 }),
        { type: 'result', eventType: 'fielders_choice' },
        {
          type: 'runnerMovement',
          runner: 1,
          to: '2B',
          out: true,
          fielders: [F.SS, F['2B']]
        }
      ).text
    ).equals("Player 2 reaches on a fielder's choice to short.")
  })

  it('says a grand slam, and a line drive doubled off', function () {
    let loaded = game()
    for (let i = 0; i < 3; i++) loaded = walk(loaded)
    const slam = say(
      loaded,
      { ...inPlay(F.LF, 30, { x: -40, z: -130 }), homeRunKind: 'out-of-park' },
      { type: 'result', eventType: 'home_run' },
      close
    )
    expect(slam.text).match(
      /^Player 4 hits it deep to left-center, that ball is gone! A grand slam! Player 1 scores!/
    )
    expect(slam.emphasis).equals('excited')
    const doubled = say(
      single(game()),
      inPlay(F.SS, 12, { x: -10, z: -35 }),
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        out: true,
        fielders: [F.SS, F['1B']]
      },
      close
    )
    expect(doubled.text).equals('Player 2 lines into a double play to short!')
  })

  it('tells runner events between pitches', function () {
    const onFirst = single(game())
    expect(
      say(onFirst, {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: 1,
        to: '2B',
        fielders: [F.C, F.SS]
      }).text
    ).equals('Player 1 is caught stealing.')
    expect(
      say(onFirst, {
        type: 'baseRunning',
        kind: 'pickoff',
        runner: 1,
        fielders: [F.P, F['1B']]
      }).text
    ).equals('Player 1 is picked off.')
    expect(
      say(onFirst, {
        type: 'baseRunning',
        kind: 'defensive_indifference',
        runner: 1,
        to: '2B'
      }).text
    ).equals('Player 1 takes second on defensive indifference.')
    expect(
      say(after(onFirst, ball), {
        type: 'batteryEvent',
        kind: 'passed_ball',
        advances: [{ runner: 1, to: '2B' }]
      }).text
    ).equals('Passed ball, Player 1 moves up to second.')
    expect(say(onFirst, { type: 'batteryEvent', kind: 'balk' }).text).match(
      /^Balk/
    )
  })

  it('announces lineup changes', function () {
    const onFirst = single(game())
    const bench = after(onFirst, {
      type: 'lineup',
      kind: 'addPlayer',
      side: 'away',
      player: 30,
      name: 'Bench Runner',
      jersey: '30'
    })
    const added = bench.liveData.boxscore.teams.away.players.at(-1)!
    expect(
      say(bench, {
        type: 'lineup',
        kind: 'pinchRunner',
        side: 'away',
        player: added,
        base: '1B'
      }).text
    ).equals('Bench R comes in to run for Player 1.')
    const homeBench = after(game(), {
      type: 'lineup',
      kind: 'addPlayer',
      side: 'home',
      player: 31,
      name: 'Glove Man',
      jersey: '31'
    })
    const glove = homeBench.liveData.boxscore.teams.home.players.at(-1)!
    expect(
      say(homeBench, {
        type: 'lineup',
        kind: 'substitute',
        side: 'home',
        player: glove,
        replaces: F.SS
      }).text
    ).equals('Glove M comes in for Player 5.')
  })

  it('says a tie at the end, and nothing for a lone close', function () {
    const decided = after(game(), ball, ball, ball, ball)
    expect(say(decided, close)).deep.equals({ text: '', emphasis: 'calm' })
    const tied = say(game(), { type: 'gameFlow', kind: 'endGame' })
    expect(tied.text).equals("That's the ballgame, tied at nothing.")
  })
})

describe('replay narration helpers', function () {
  it('says counts and numbers as an announcer does', function () {
    expect(spoken(0, 'oh')).equals('oh')
    expect(spoken(0)).equals('nothing')
    expect(spoken(3)).equals('three')
    expect(spoken(25)).equals('25')
  })

  it('places a ball by its angle from the plate', function () {
    expect(direction({ x: -100, z: -10 })).equals(
      'foul down the left-field line'
    )
    expect(direction({ x: 100, z: -10 })).equals(
      'foul down the right-field line'
    )
    expect(direction({ x: -60, z: -80 })).equals('left field')
    expect(direction({ x: -25, z: -90 })).equals('left-center')
    expect(direction({ x: 0, z: -90 })).equals('center field')
    expect(direction({ x: 25, z: -90 })).equals('right-center')
    expect(direction({ x: 60, z: -80 })).equals('right field')
  })

  it('keeps whole sentences under the limit', function () {
    const long = 'x'.repeat(200)
    expect(fit([`${long}.`, `${long}.`])).equals(`${long}.`)
    expect(fit(['y'.repeat(300)])).length(MAX_NARRATION)
    expect(fit(['', 'One.', 'Two.'])).equals('One. Two.')
  })
})
