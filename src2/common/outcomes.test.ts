import { expect } from 'chai'

import { outcomeName } from './outcomes'

const credit = (role: string): { role: string } => ({ role })

describe('what a player did, on their own page', function () {
  it('names a hit without naming the hitter', function () {
    expect(
      outcomeName({
        eventType: 'single',
        label: 'Single: Jensen P',
        credit: credit('batter')
      })
    ).equals('Single')
    expect(
      outcomeName({
        eventType: 'home_run',
        label: 'Home run: Harlow P',
        credit: credit('batter')
      })
    ).equals('Home run')
  })

  it('says a run was scored, not just `Run`', function () {
    expect(
      outcomeName({
        eventType: 'run',
        label: 'Run: Harlow P',
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
        label: 'Strikeout: Ava M pitching',
        credit: credit('pitcher')
      })
    ).equals('Strikeout pitching')
    expect(
      outcomeName({
        eventType: 'strikeout',
        label: 'Dropped 3rd: Mia R (C)',
        credit: credit('fielder')
      })
    ).equals('Dropped third strike')
  })

  // The head of the engine's own label, so a base or a kind of out comes
  // through without this file knowing what either is.
  it('keeps what the fielding play was, without the chain of names', function () {
    expect(
      outcomeName({
        eventType: 'field_out',
        label: 'Ground out: Jensen P (SS) to Wesley B (1B)',
        credit: credit('fielder')
      })
    ).equals('Ground out')
    expect(
      outcomeName({
        eventType: 'field_out',
        label: 'Out at 3rd: Mia R (C) to Sam O (3B)',
        credit: credit('fielder')
      })
    ).equals('Out at 3rd')
    expect(
      outcomeName({
        eventType: 'caught_stealing',
        label: 'Caught stealing 2nd: Mia R (C)',
        credit: credit('fielder')
      })
    ).equals('Caught stealing 2nd')
  })

  it('never falls through to a raw event type', function () {
    expect(
      outcomeName({ eventType: 'something_new', label: '', credit: null })
    ).equals('Play')
  })
})
