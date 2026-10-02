import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  after,
  close,
  F,
  game,
  single,
  strikeout,
  walk
} from '../../test/scoringGames'
import {
  FIELD_OUT_NAMES,
  MLB_EVENT_TYPES,
  mlbEventName
} from '../gumbo/reference'
import { asGumboPlay, type GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { documentOf } from './document'
import { type GamePlay, type GameState, setupOf } from './state'

type Destination = 'batter' | '1B' | '2B' | '3B' | 'home'
const move = (runner: number, to: Destination): ScoringAction => ({
  type: 'runnerMovement',
  runner,
  to
})
const out = (
  runner: number,
  to: Destination,
  fielders: number[],
  reason?: Extract<ScoringAction, { type: 'runnerMovement' }>['reason']
): ScoringAction => ({
  type: 'runnerMovement',
  runner,
  to,
  out: true,
  fielders,
  ...(reason == null ? {} : { reason })
})
const result = (
  eventType: Extract<ScoringAction, { type: 'result' }>['eventType'],
  outBy?: 'throw' | 'catch'
): ScoringAction => ({
  type: 'result',
  eventType,
  ...(outBy == null ? {} : { outBy })
})
const batted = (
  fielder: number,
  contact: 'swing' | 'bunt' = 'swing',
  trajectory?: 'ground_ball' | 'line_drive' | 'fly_ball' | 'popup'
): ScoringAction => ({
  type: 'ballInPlay',
  contact,
  fielder,
  ...(trajectory == null ? {} : { trajectory })
})
const steal = (
  kind: 'steal' | 'caught_stealing' | 'pickoff',
  runner: number,
  to?: '2B' | '3B' | 'home',
  fielders?: number[]
): ScoringAction => ({
  type: 'baseRunning',
  kind,
  runner,
  ...(to == null ? {} : { to }),
  ...(fielders == null ? {} : { fielders })
})

/** The last completed play, as it is stored. */
function stored(state: GameState): GumboPlay {
  const play: GamePlay = state.liveData.plays.allPlays.at(-1)!
  return documentOf(state, play, { setupBefore: setupOf(state), actions: [] })
}
/** The stored result, with the fields the checked shape leaves open. */
function resultOf(play: GumboPlay): Record<string, unknown> {
  return play.result
}
function typeOf(state: GameState): string {
  return String(stored(state).result.eventType)
}

interface StoredRunner {
  movement: { isOut: boolean }
  details: { event: string; eventType: string; runner: { fullName: string } }
  credits: Array<{
    credit: string
    position?: { abbreviation: string }
    player: { fullName: string }
  }>
}
function runnersOf(play: GumboPlay): StoredRunner[] {
  return (play.runners ?? []) as unknown as StoredRunner[]
}
interface StoredAction {
  isPitch: boolean
  details: { event: string; eventType: string }
}
function actionsOf(play: GumboPlay): StoredAction[] {
  return ((play.playEvents ?? []) as unknown as StoredAction[]).filter(
    event => !event.isPitch
  )
}
interface StoredCredit {
  eventType: string
  label: string
  credit: { role: string; position: string | null }
}
function creditsOf(play: GumboPlay): StoredCredit[] {
  return (play.credits ?? []) as unknown as StoredCredit[]
}

/** Visitor 1 on first, nobody out. */
const onFirst = (): GameState => walk(game())
/** Visitor 1 on second, nobody out. */
const onSecond = (): GameState =>
  after(game(), batted(F.CF), result('double'), close)
/** Two out, Visitor 3 on first: two strikeouts, then a walk. */
const twoOutOnFirst = (): GameState => walk(strikeout(strikeout(game())))

describe('the result types MLB writes (U15)', function () {
  it('types a runner forced out while the batter reaches as a forceout, and credits its fielders', function () {
    const state = after(
      onFirst(),
      batted(F.SS),
      result('fielders_choice'),
      out(1, '2B', [F.SS, F['2B']]),
      move(2, '1B'),
      close
    )
    const play = stored(state)
    expect(play.result).deep.include({
      eventType: 'force_out',
      event: 'Forceout',
      isOut: true
    })
    expect(creditsOf(play)).deep.equals([
      {
        eventType: 'force_out',
        label: 'Out at 2nd: Player 4 (2B) from Player 5 (SS)',
        teamId: 'home',
        creditUserId: null,
        credit: { name: 'Player 4', role: 'fielder', position: '2B' }
      }
    ])
  })

  it("types a runner put out on no force while the batter reaches as a fielder's choice out, and none put out as a fielder's choice", function () {
    const fcOut = after(
      onSecond(),
      batted(F.SS),
      result('fielders_choice'),
      out(1, '3B', [F.SS, F['3B']]),
      move(2, '1B'),
      close
    )
    expect(stored(fcOut).result).deep.include({
      eventType: 'fielders_choice_out',
      event: 'Fielders Choice Out'
    })
    const nobody = after(
      onFirst(),
      batted(F.SS),
      result('fielders_choice'),
      move(1, '2B'),
      move(2, '1B'),
      close
    )
    expect(stored(nobody).result).deep.include({
      eventType: 'fielders_choice',
      event: 'Fielders Choice',
      isOut: false
    })
  })

  it('types a bunt that moves a runner up with the batter out as a sacrifice bunt, and one that also retires a runner as a sac bunt double play', function () {
    const sac = after(
      onFirst(),
      batted(F.P, 'bunt'),
      result('field_out'),
      out(2, '1B', [F.P, F['1B']]),
      move(1, '2B'),
      close
    )
    expect(stored(sac).result).deep.include({
      eventType: 'sac_bunt',
      event: 'Sac Bunt'
    })
    // Visitors 1 and 2 on second and first: 1 takes third, 2 is forced out.
    const two = after(
      walk(onFirst()),
      batted(F.P, 'bunt'),
      result('field_out'),
      out(3, '1B', [F.P, F['1B']]),
      out(2, '2B', [F['1B'], F.SS]),
      move(1, '3B'),
      close
    )
    expect(stored(two).result).deep.include({
      eventType: 'sac_bunt_double_play',
      event: 'Sac Bunt Double Play'
    })
    // With two out already, a bunt out is no sacrifice.
    const late = after(
      twoOutOnFirst(),
      batted(F.P, 'bunt'),
      result('field_out'),
      out(4, '1B', [F.P, F['1B']]),
      close
    )
    expect(stored(late).result).deep.include({
      eventType: 'field_out',
      event: 'Bunt Groundout'
    })
  })

  it('types a double play that is no ground ball as a double play, and one on a ground ball as a GIDP', function () {
    const doubled = after(
      onFirst(),
      batted(F.SS, 'swing', 'line_drive'),
      result('field_out', 'catch'),
      out(1, '1B', [F.SS, F['1B']]),
      close
    )
    expect(stored(doubled).result).deep.include({
      eventType: 'double_play',
      event: 'Double Play'
    })
    const gidp = after(
      onFirst(),
      batted(F.SS),
      result('field_out'),
      out(2, '1B', [F.SS, F['1B']]),
      out(1, '2B', [F.SS, F['2B']]),
      close
    )
    expect(stored(gidp).result).deep.include({
      eventType: 'grounded_into_double_play',
      event: 'Grounded Into DP'
    })
  })

  it('counts only the outs the play made: a caught stealing before a ground out is no double play', function () {
    const state = after(
      walk(onFirst()),
      steal('caught_stealing', 1, '3B', [F.C, F['3B']]),
      batted(F.SS),
      result('field_out'),
      out(3, '1B', [F.SS, F['1B']]),
      close
    )
    const play = stored(state)
    expect(play.result).deep.include({
      eventType: 'field_out',
      event: 'Groundout',
      isOut: true
    })
    expect(play.about).deep.include({ hasOut: true })
  })

  it('types a caught stealing that ends a play by its base, and credits the catcher', function () {
    const second = after(
      twoOutOnFirst(),
      steal('caught_stealing', 3, '2B', [F.C, F.SS])
    )
    const play = stored(second)
    expect(play.result).deep.include({
      eventType: 'caught_stealing_2b',
      event: 'Caught Stealing 2B',
      isOut: true
    })
    const [runner] = runnersOf(play)
    expect(
      runner.credits.map(c => `${c.position?.abbreviation} ${c.credit}`)
    ).deep.equals(['C f_assist', 'SS f_putout'])
    expect(runner.details).deep.include({
      event: 'Caught Stealing 2B',
      eventType: 'caught_stealing_2b'
    })
    expect(creditsOf(play).map(c => c.label)).deep.equals([
      'Out at 2nd: Player 5 (SS) from Player 2 (C)'
    ])
    const third = after(
      after(twoOutOnFirst(), steal('steal', 3, '2B')),
      steal('caught_stealing', 3, '3B', [F.C, F['3B']])
    )
    expect(typeOf(third)).equals('caught_stealing_3b')
    const home = after(
      after(twoOutOnFirst(), steal('steal', 3, '2B'), steal('steal', 3, '3B')),
      steal('caught_stealing', 3, 'home', [F.P, F.C])
    )
    expect(stored(home).result).deep.include({
      eventType: 'caught_stealing_home',
      event: 'Caught Stealing Home'
    })
  })

  it('types a pickoff that ends a play by its base, stealing or not', function () {
    const picked = after(
      twoOutOnFirst(),
      steal('pickoff', 3, undefined, [F.P, F['1B']])
    )
    expect(stored(picked).result).deep.include({
      eventType: 'pickoff_1b',
      event: 'Pickoff 1B'
    })
    const stealing = after(
      twoOutOnFirst(),
      out(3, '2B', [F.P, F['1B'], F.SS], 'Picked Off')
    )
    expect(stored(stealing).result).deep.include({
      eventType: 'pickoff_caught_stealing_2b',
      event: 'Pickoff Caught Stealing 2B'
    })
  })

  it('stores per-base steals and the placed runner on the runners and actions that made them', function () {
    const state = after(
      single(game()),
      close,
      steal('steal', 1, '2B'),
      steal('steal', 1, '3B'),
      steal('steal', 1, 'home'),
      { type: 'gameFlow', kind: 'placeRunner', runner: 9, base: '2B' },
      ...[batted(F.CF), result('single'), close]
    )
    const play = stored(state)
    expect(
      runnersOf(play)
        .filter(runner => runner.details.eventType !== 'single')
        .map(runner => `${runner.details.eventType} ${runner.details.event}`)
    ).deep.equals([
      'stolen_base_2b Stolen Base 2B',
      'stolen_base_3b Stolen Base 3B',
      'stolen_base_home Stolen Base Home',
      'runner_placed Runner Placed On Base'
    ])
    expect(
      actionsOf(play).map(
        action => `${action.details.eventType} ${action.details.event}`
      )
    ).deep.equals([
      'stolen_base_2b Stolen Base 2B',
      'stolen_base_3b Stolen Base 3B',
      'stolen_base_home Stolen Base Home',
      'runner_placed Runner Placed On Base'
    ])
  })

  it('stores every one of those plays as a play the server accepts', function () {
    const plays = [
      after(
        onFirst(),
        batted(F.SS),
        result('fielders_choice'),
        out(1, '2B', [F.SS, F['2B']]),
        move(2, '1B'),
        close
      ),
      after(
        onFirst(),
        batted(F.P, 'bunt'),
        result('field_out'),
        out(2, '1B', [F.P, F['1B']]),
        move(1, '2B'),
        close
      ),
      after(
        onFirst(),
        batted(F.SS, 'swing', 'line_drive'),
        result('field_out', 'catch'),
        out(1, '1B', [F.SS, F['1B']]),
        close
      ),
      after(twoOutOnFirst(), steal('caught_stealing', 3, '2B', [F.C, F.SS]))
    ].map(stored)
    for (const play of plays)
      expect(asGumboPlay(structuredClone(play))).deep.equals(play)
  })
})

describe('MLB names and outs on the result (U16)', function () {
  it("names each result as MLB's list does, a field out by how it was made", function () {
    const named = (state: GameState): string =>
      String(resultOf(stored(state)).event)
    const caught = (
      trajectory?: 'line_drive' | 'fly_ball' | 'popup',
      contact: 'swing' | 'bunt' = 'swing'
    ): GameState =>
      after(
        game(),
        batted(F.CF, contact, trajectory),
        result('field_out', 'catch'),
        close
      )
    const thrown = (contact: 'swing' | 'bunt'): GameState =>
      after(
        game(),
        batted(F.SS, contact),
        result('field_out'),
        out(1, '1B', [F.SS, F['1B']]),
        close
      )
    expect(
      [
        thrown('swing'),
        thrown('bunt'),
        caught('fly_ball'),
        caught(),
        caught('line_drive'),
        caught('popup'),
        caught('popup', 'bunt'),
        caught('line_drive', 'bunt'),
        caught(undefined, 'bunt'),
        strikeout(game()),
        walk(game()),
        after(game(), result('intent_walk'), close),
        after(game(), result('catcher_interference'), close),
        after(game(), result('hit_by_pitch'), close),
        after(game(), batted(F.CF), result('home_run'), close)
      ].map(named)
    ).deep.equals([
      'Groundout',
      'Bunt Groundout',
      'Flyout',
      'Flyout',
      'Lineout',
      'Pop Out',
      'Bunt Pop Out',
      'Bunt Lineout',
      'Bunt Pop Out',
      'Strikeout',
      'Walk',
      'Intent Walk',
      'Catcher Interference',
      'Hit By Pitch',
      'Home Run'
    ])
  })

  it('names results, runners and actions as the reference feed does', function () {
    const feed = JSON.parse(
      readFileSync('src/common/gumbo/reference/feed776258.json', 'utf8')
    ) as {
      liveData: {
        plays: {
          allPlays: Array<{
            result: { event: string; eventType: string }
            runners: Array<{ details: { event: string; eventType: string } }>
            playEvents: Array<{
              type: string
              details: { event?: string; eventType?: string }
            }>
          }>
        }
      }
    }
    for (const play of feed.liveData.plays.allPlays) {
      const { event, eventType } = play.result
      // A field out is named by how it was made; everything else by the list.
      if (eventType === 'field_out')
        expect(FIELD_OUT_NAMES.has(event), event).equals(true)
      else expect(event, eventType).equals(mlbEventName(eventType))
      for (const runner of play.runners)
        expect(runner.details.event).equals(
          runner.details.eventType === eventType
            ? event
            : mlbEventName(runner.details.eventType)
        )
      for (const action of play.playEvents)
        if (action.type === 'action' && action.details.eventType != null)
          expect(action.details.event).equals(
            mlbEventName(action.details.eventType)
          )
    }
    expect(MLB_EVENT_TYPES.has('field_out')).equals(true)
    // A legacy code by its listed name, the extensions in MLB's style, and
    // an unknown type as TeamStation names it.
    expect(
      [
        'catcher_interference',
        'placed_runner',
        'gs_batter_out',
        'gs_manual_placement',
        'nonsense_type'
      ].map(mlbEventName)
    ).deep.equals([
      'Catcher Interference',
      'Runner Placed On Base',
      'Batter Out',
      'Batter Placed On Base',
      'Play'
    ])
  })

  it('sets isOut and hasOut from the outs, and marks the half and no review', function () {
    const cases: Array<[string, GameState, boolean, boolean]> = [
      ['single', after(single(game()), close), false, false],
      ['strikeout', strikeout(game()), true, true],
      [
        'walk after a caught stealing',
        after(
          onFirst(),
          { type: 'baseRunning', kind: 'caught_stealing', runner: 1 },
          { type: 'pitch', call: 'B' },
          { type: 'pitch', call: 'B' },
          { type: 'pitch', call: 'B' },
          { type: 'pitch', call: 'B' },
          close
        ),
        false,
        true
      ],
      [
        'caught stealing for the third out',
        after(twoOutOnFirst(), steal('caught_stealing', 3, '2B', [F.C, F.SS])),
        true,
        true
      ]
    ]
    for (const [name, state, isOut, hasOut] of cases) {
      const play = stored(state)
      expect(resultOf(play).isOut, name).equals(isOut)
      expect(play.about, name).deep.include({
        hasOut,
        isTopInning: true,
        hasReview: false
      })
    }
    // The home half is no top of an inning.
    const bottom = after(
      strikeout(strikeout(strikeout(game()))),
      // The visitors field: their centre fielder is 8.
      batted(8),
      result('single'),
      close
    )
    expect(stored(bottom).about).deep.include({
      halfInning: 'bottom',
      isTopInning: false
    })
  })
})
