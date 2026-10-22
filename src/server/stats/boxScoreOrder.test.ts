import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GumboPlay } from '../../common/gumboPlay'
import { pitchersInOrder } from './boxScoreOrder'

const cole = 101
const holmes = 102
const weaver = 103
const loaisiga = 104

function play(
  atBatIndex: number,
  pitcher: number | undefined,
  playEvents?: unknown[]
): GumboPlay {
  return {
    about: { atBatIndex, inning: 1, halfInning: 'top' },
    result: { eventType: 'field_out' },
    matchup: pitcher == null ? {} : { pitcher: { id: pitcher } },
    ...(playEvents == null ? {} : { playEvents })
  } as unknown as GumboPlay
}

const pitch = (index: number, player: number): unknown => ({
  index,
  isPitch: true,
  player: { id: player }
})
const change = (index: number, player: number, replaced: number): unknown => ({
  index,
  details: { eventType: 'pitching_substitution' },
  player: { id: player },
  replacedPlayer: { id: replaced }
})

describe('pitchersInOrder', function () {
  it('lists the starter first, however many outs a reliever gets', function () {
    expect(
      pitchersInOrder([
        play(0, cole),
        play(1, cole),
        play(2, holmes, [change(0, holmes, cole), pitch(1, holmes)]),
        play(3, holmes),
        play(4, holmes)
      ])
    ).deep.equals([cole, holmes])
  })

  it('puts a pitcher changed mid at-bat before the one who replaced them', function () {
    expect(
      pitchersInOrder([
        play(0, weaver, [
          pitch(0, cole),
          pitch(1, cole),
          change(2, weaver, cole),
          pitch(3, weaver)
        ])
      ])
    ).deep.equals([cole, weaver])
  })

  it('takes the replaced pitcher from the change when the pitches name nobody', function () {
    expect(
      pitchersInOrder([
        play(0, weaver, [
          { index: 0, isPitch: true },
          change(1, weaver, cole),
          { index: 2, isPitch: true }
        ])
      ])
    ).deep.equals([cole, weaver])
  })

  it('follows several changes in one play in the order they were made', function () {
    expect(
      pitchersInOrder([
        play(0, loaisiga, [
          change(3, loaisiga, holmes),
          pitch(0, cole),
          change(1, holmes, cole),
          pitch(2, holmes),
          pitch(4, loaisiga)
        ])
      ])
    ).deep.equals([cole, holmes, loaisiga])
  })

  it('orders imported plays without pitches by the pitcher of each play', function () {
    expect(
      pitchersInOrder([play(0, weaver), play(1, weaver), play(2, cole)])
    ).deep.equals([weaver, cole])
  })

  it('skips plays and events that name no pitcher', function () {
    expect(
      pitchersInOrder([
        play(0, undefined),
        play(1, undefined, [{ index: 0, isPitch: true, player: 'cole' }]),
        play(2, cole, 'not a list' as unknown as unknown[])
      ])
    ).deep.equals([cole])
  })

  it('answers no pitchers for a game with no plays', function () {
    expect(pitchersInOrder([])).deep.equals([])
  })
})
