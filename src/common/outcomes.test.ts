import { expect } from 'chai'

import { GUMBO_EVENT_TYPES } from './gumboEventTypes'
import { OUTCOME_BY_TYPE, outcomeName } from './outcomes'

const credit = (role: string): { role: string } => ({ role })

describe('what a player did, on their own page', function () {
  it('names a hit without naming the hitter', function () {
    expect(
      outcomeName({
        eventType: 'single',
        head: 'Single',
        credit: credit('batter')
      })
    ).equals('Single')
    expect(
      outcomeName({
        eventType: 'home_run',
        head: 'Home run',
        credit: credit('batter')
      })
    ).equals('Home run')
  })

  it('says a run was scored, not just `Run`', function () {
    expect(
      outcomeName({
        eventType: 'run',
        head: 'Run',
        credit: credit('runner')
      })
    ).equals('Run scored')
  })

  // The same event type, two opposite sides of the play: the pitcher earned
  // it, the catcher picked up a dropped third strike.
  it('tells the two kinds of strikeout apart by who is credited', function () {
    expect(
      outcomeName({
        eventType: 'strikeout',
        head: 'Strikeout',
        credit: credit('pitcher')
      })
    ).equals('Strikeout pitching')
    expect(
      outcomeName({
        eventType: 'strikeout',
        head: 'Dropped 3rd',
        credit: credit('fielder')
      })
    ).equals('Dropped third strike')
  })

  // The head of the engine's own label, so a base or a kind of out comes
  // through without this file knowing what either is, nor whose names follow.
  it('keeps what the fielding play was, without the chain of names', function () {
    expect(
      outcomeName({
        eventType: 'field_out',
        head: 'Ground out',
        credit: credit('fielder')
      })
    ).equals('Ground out')
    expect(
      outcomeName({
        eventType: 'field_out',
        head: 'Out at 3rd',
        credit: credit('fielder')
      })
    ).equals('Out at 3rd')
    expect(
      outcomeName({
        eventType: 'caught_stealing',
        head: 'Caught stealing 2nd',
        credit: credit('fielder')
      })
    ).equals('Caught stealing 2nd')
  })

  it('never falls through to a raw event type', function () {
    expect(
      outcomeName({ eventType: 'something_new', head: '', credit: null })
    ).equals('Play')
  })
})

describe('outcome names by event type', function () {
  it('has an entry for every stored event type', function () {
    expect(Object.keys(OUTCOME_BY_TYPE).sort()).deep.equals(
      [...GUMBO_EVENT_TYPES].sort()
    )
    for (const eventType of GUMBO_EVENT_TYPES) {
      const name = outcomeName({
        eventType,
        head: 'Head',
        credit: credit('batter')
      })
      const expected = eventType.startsWith('strike')
        ? 'Dropped third strike'
        : (OUTCOME_BY_TYPE[eventType] ?? 'Head')
      expect(name, eventType).equals(expected)
    }
  })

  it('credits a strikeout double play to the pitcher like a strikeout', function () {
    expect(
      outcomeName({
        eventType: 'strikeout_double_play',
        head: '',
        credit: credit('pitcher')
      })
    ).equals('Strikeout pitching')
    expect(outcomeName({ eventType: 'run', head: 'Run', credit: null })).equals(
      'Run scored'
    )
  })

  it('reads a legacy code as the one it is stored as', function () {
    for (const [legacy, listed] of [
      ['catcher_interference', 'catcher_interf'],
      ['manual_placement', 'ts_manual_placement'],
      ['placed_runner', 'runner_placed']
    ]) {
      const named = (eventType: string): string =>
        outcomeName({ eventType, head: 'Head', credit: null })
      expect(named(legacy), legacy).equals(named(listed))
    }
    expect(
      outcomeName({
        eventType: 'strikeout_triple_play',
        head: '',
        credit: credit('pitcher')
      })
    ).equals('Strikeout pitching')
  })
})
