import { expect } from 'chai'
import { describe, it } from 'mocha'

import { newSetup } from './lineup'
import { asGameSetup, copyGame, copyState, type GameState } from './state'

const viaJson = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value)) as unknown

/** The same text, keys in the same order, with no value left shared. */
function expectSameAsJson(value: unknown): void {
  const copy = copyState(value)
  expect(JSON.stringify(copy)).equals(JSON.stringify(viaJson(value)))
  expect(copy).deep.equals(viaJson(value))
}

class Dated {
  at = 1
  hidden: undefined = undefined
}

describe('copyState', function () {
  it('copies as JSON does: every shape of plain data', function () {
    for (const value of [
      null,
      true,
      false,
      0,
      1.5,
      -7,
      '',
      'text',
      [],
      {},
      [1, 'a', null, [true, {}]],
      { b: 1, a: { d: [1, 2], c: 'x' }, 10: 'ten', 2: 'two' },
      { nested: { deep: { deeper: [{ deepest: null }] } } }
    ])
      expectSameAsJson(value)
  })

  it('makes what JSON makes of what it cannot write', function () {
    expect(Object.is(copyState(-0), 0)).equals(true)
    expect(Object.is(copyState({ a: -0 }).a, 0)).equals(true)
    expectSameAsJson(Number.NaN)
    expectSameAsJson(Infinity)
    expectSameAsJson(-Infinity)
    expectSameAsJson({ a: Number.NaN, b: Infinity })
    expectSameAsJson({ gone: undefined, kept: 1 })
    expectSameAsJson({ gone: () => 1, also: Symbol('x'), kept: 1 })
    expectSameAsJson([undefined, () => 1, Symbol('x'), 1])
    // eslint-disable-next-line no-sparse-arrays
    expectSameAsJson([1, , 3])
    expect('gone' in copyState({ gone: undefined })).equals(false)
  })

  it('leaves to JSON what plain data does not hold', function () {
    expectSameAsJson(new Date(0))
    expectSameAsJson({ at: new Date(0) })
    expectSameAsJson(new Dated())
    expectSameAsJson({ toJSON: () => ({ written: true }) })
    expectSameAsJson(Object.assign([1], { toJSON: () => 'list' }))
    expectSameAsJson(Object.assign(Object.create(null), { a: 1 }))
    expectSameAsJson(new Map([[1, 2]]))
    const proto = JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}') as object
    const copy = copyState(proto)
    expect(Object.keys(copy)).deep.equals(['__proto__', 'a'])
    expect(Object.getPrototypeOf(copy)).equals(Object.prototype)
    expect((copy as { polluted?: unknown }).polluted).equals(undefined)
  })

  it('refuses what JSON refuses', function () {
    expect(() => {
      copyState(undefined)
    }).to.throw(SyntaxError)
    expect(() => copyState(() => 1)).to.throw(SyntaxError)
    expect(() => copyState(Symbol('x'))).to.throw(SyntaxError)
    expect(() => copyState(BigInt(1))).to.throw(TypeError)
  })

  it('shares nothing with what it copied', function () {
    const original = { list: [{ a: 1 }], record: { b: 2 } }
    const copy = copyState(original)
    copy.list[0].a = 9
    copy.record.b = 9
    expect(original).deep.equals({ list: [{ a: 1 }], record: { b: 2 } })
  })

  it('writes no text for plain data, as a replay copies it once per action', function () {
    const { stringify } = JSON
    let written = 0
    JSON.stringify = ((...args: Parameters<typeof stringify>) => {
      written += 1
      return stringify(...args)
    }) as typeof stringify
    try {
      copyState({ a: [1, 'b', { c: null }], d: { e: true } })
    } finally {
      JSON.stringify = stringify
    }
    expect(written).equals(0)
  })

  it('copies a game as copyGame shares its finished plays', function () {
    const play = { about: { atBatIndex: 0 } }
    const game = {
      gameData: { players: {} },
      liveData: { plays: { allPlays: [play], currentPlay: null } }
    } as unknown as GameState
    const once = copyGame(game)
    const twice = copyGame(once)
    expect(once.liveData.plays.allPlays[0]).not.equals(play)
    expect(twice.liveData.plays.allPlays[0]).equals(
      once.liveData.plays.allPlays[0]
    )
  })
})

describe('reading a setup', function () {
  const setup = newSetup(
    {
      away: { id: 'tem_away', name: 'Away' },
      home: { id: 'tem_home', name: 'Home' }
    },
    {
      away: [{ gumboId: 11, shortName: 'A One' }],
      home: [{ gumboId: 21, shortName: 'H One' }]
    }
  )
  const filled = copyState(setup)
  filled.sides.away.defense.P = 11
  filled.sides.home.defense.P = 21

  it('throws nothing over a value that is not null', function () {
    const RealTypeError = globalThis.TypeError
    let thrown = 0
    globalThis.TypeError = class extends RealTypeError {
      constructor(message?: string) {
        super(message)
        thrown += 1
      }
    } as unknown as TypeErrorConstructor
    try {
      asGameSetup(filled)
    } finally {
      globalThis.TypeError = RealTypeError
    }
    expect(thrown).equals(0)
  })

  it('takes null and a value, and refuses what neither is', function () {
    const open = copyState(filled) as unknown as {
      sides: { away: { defense: { P: unknown } } }
    }
    open.sides.away.defense.P = null
    expect(asGameSetup(open).sides.away.defense.P).equals(null)
    expect(asGameSetup(filled).sides.away.defense.P).equals(11)
    const wrong = copyState(filled) as unknown as {
      sides: { away: { defense: { P: unknown } } }
    }
    wrong.sides.away.defense.P = 'pitcher'
    expect(() => asGameSetup(wrong)).to.throw('Expected a number')
    const absent = copyState(filled) as unknown as {
      sides: { away: { defense: { P?: unknown } } }
    }
    delete absent.sides.away.defense.P
    expect(() => asGameSetup(absent)).to.throw('Expected a number')
  })
})
