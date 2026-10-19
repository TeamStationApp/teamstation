import { expect } from 'chai'
import { describe, it } from 'mocha'

import { game } from '../../test/scoringGames'
import { actionFromTagSlots, promptContext } from './actions'
import { recordOf } from './gumbo'
import { upgradeRecord } from './legacyRecord'
import { addPlayer } from './lineup'
import { writtenTag } from './playerTags'
import { asGameSetup, asLegacyGameSetup, setupOf } from './state'

function historical(): ReturnType<typeof asLegacyGameSetup> {
  const { tagOrder, ...setup } = setupOf(game())
  const sessionToSource: Record<number, number | null> = {}
  const sourceToSession: Record<string, number> = {}
  for (const id of tagOrder) {
    const source = 1000000 + id
    setup.players[id].userId = source
    sessionToSource[id] = source
    sourceToSession[`number:${source}`] = id
  }
  setup.sides.home.pitchCounts[10] = 7
  return asLegacyGameSetup({
    ...setup,
    identities: { sessionToSource, sourceToSession, nextId: 19 }
  })
}

describe('historical scoring identities', function () {
  it('rejects corrupt player keys and conflicting legacy player metadata', function () {
    const setupBefore = historical()
    setupBefore.players[1].userId = 42
    expect(() =>
      upgradeRecord({ version: 1, setupBefore, actions: [] })
    ).throws('Conflicting')
    for (const key of ['0', '01', '-1']) {
      const setupBefore = historical()
      Object.assign(setupBefore.identities.sessionToSource, { [key]: 123 })
      expect(() =>
        upgradeRecord({ version: 1, setupBefore, actions: [] })
      ).throws('Ambiguous')
    }
  })

  it('checks every version 2 identity boundary without confusing player ids with indices', function () {
    const clean = setupOf(game())
    expect(asGameSetup(clean).sides.away.battingIndex).equals(0)
    for (const change of [
      (setup: typeof clean) => {
        setup.players[1].id = 0
      },
      (setup: typeof clean) => {
        setup.players[1].userId = 2
      },
      (setup: typeof clean) => {
        setup.tagOrder.push(1)
      },
      (setup: typeof clean) => {
        setup.tagOrder.shift()
      },
      (setup: typeof clean) => {
        setup.sides.away.players.push(0)
      },
      (setup: typeof clean) => {
        setup.sides.away.battingOrder.push(0)
      },
      (setup: typeof clean) => {
        setup.sides.home.defense.P = 0
      },
      (setup: typeof clean) => {
        Object.assign(setup.sides.home.pitchCounts, { '01': 1 })
      }
    ]) {
      const setup = structuredClone(clean)
      change(setup)
      expect(() => asGameSetup(setup)).throws()
    }
  })
  it('converts every player reference while preserving baseball numbers and times', function () {
    const setupBefore = historical()
    const actions = [
      { type: 'ballInPlay', fielder: 14, error: 13, location: { x: 1, z: 2 } },
      { type: 'runnerMovement', runner: 1, fielders: [14, 12], to: '2B' },
      { type: 'lineup', kind: 'roster', setup: setupBefore, nextBatter: 2 },
      { type: 'lineup', kind: 'substitute', player: 3, replaces: 4 },
      { type: 'lineup', kind: 'battingOrder', order: [3, 2, 1] },
      {
        type: 'override',
        batter: 4,
        pitcher: 10,
        bases: [1, null, 2],
        outs: 2
      },
      {
        type: 'result',
        advances: [{ runner: 1, fielders: [10, 11], to: '2B' }]
      }
    ]
    const raw = {
      version: 1,
      setupBefore,
      actions,
      actionTimes: ['time'],
      detail: { note: 'kept' }
    }
    const before = structuredClone(raw)
    const upgraded = upgradeRecord(raw) as typeof raw
    expect(upgraded.version).equals(2)
    const setup = asGameSetup(upgraded.setupBefore)
    expect(Object.keys(setup.players)).deep.equals(
      Array.from({ length: 18 }, (_, i) => String(1000001 + i))
    )
    expect(setup.sides.away.battingOrder).deep.equals([
      1000001, 1000002, 1000003, 1000004, 1000005, 1000006, 1000007, 1000008,
      1000009
    ])
    expect(setup.sides.home.defense.P).equals(1000010)
    expect(setup.sides.home.pitchCounts).deep.equals({ 1000010: 7 })
    expect(upgraded.actions).deep.equals([
      {
        type: 'ballInPlay',
        fielder: 1000014,
        error: 1000013,
        location: { x: 1, z: 2 }
      },
      {
        type: 'runnerMovement',
        runner: 1000001,
        fielders: [1000014, 1000012],
        to: '2B'
      },
      { type: 'lineup', kind: 'roster', setup, nextBatter: 1000002 },
      {
        type: 'lineup',
        kind: 'substitute',
        player: 1000003,
        replaces: 1000004
      },
      {
        type: 'lineup',
        kind: 'battingOrder',
        order: [1000003, 1000002, 1000001]
      },
      {
        type: 'override',
        batter: 1000004,
        pitcher: 1000010,
        bases: [1000001, null, 1000002],
        outs: 2
      },
      {
        type: 'result',
        advances: [{ runner: 1000001, fielders: [1000010, 1000011], to: '2B' }]
      }
    ])
    expect(upgraded.actionTimes).deep.equals(raw.actionTimes)
    expect(upgraded.detail).deep.equals(raw.detail)
    expect(raw).deep.equals(before)
  })

  it('uses the migrated identity for an old add-player action', function () {
    const setupBefore = historical()
    setupBefore.identities.sessionToSource[19] = 9000000
    setupBefore.identities.sourceToSession['number:9000000'] = 19
    const record = recordOf({
      teamStation: {
        version: 1,
        setupBefore,
        actions: [
          { type: 'lineup', kind: 'addPlayer', side: 'away', name: 'Babe Ruth' }
        ]
      }
    })!
    expect(record.actions[0]).includes({ player: 9000000 })
    expect(record.setupBefore.tagOrder.at(-1)).equals(9000000)
  })

  it('refuses null, unsafe, missing and conflicting historical identities', function () {
    for (const value of [null, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const setupBefore = historical()
      setupBefore.identities.sessionToSource[1] = value
      expect(
        recordOf({ teamStation: { version: 1, setupBefore, actions: [] } })
      ).equals(null)
    }
    const setupBefore = historical()
    delete setupBefore.identities.sessionToSource[1]
    expect(() =>
      upgradeRecord({ version: 1, setupBefore, actions: [] })
    ).throws('Unmapped')
    const start = historical()
    const changed = historical()
    changed.identities.sessionToSource[1] = 123
    expect(() =>
      upgradeRecord({
        version: 1,
        setupBefore: start,
        actions: [{ setup: changed }]
      })
    ).throws('Ambiguous')
    expect(() =>
      upgradeRecord({ version: 1, setupBefore: start, actions: [null] })
    ).throws('Invalid historical action')
    expect(() =>
      upgradeRecord({ version: 1, setupBefore: start, actions: null })
    ).throws('Invalid historical actions')
    for (const value of [null, 7, { version: 2 }])
      expect(upgradeRecord(value)).equals(value)
  })
})

describe('persistent dictation tag order', function () {
  it('keeps tags stable when a sparse guest identity is appended', function () {
    const state = game()
    const before = promptContext(state)
    addPlayer(state, 'away', Number.MAX_SAFE_INTEGER, 'Babe Ruth')
    expect(state.meta.tagOrder.slice(0, 18)).deep.equals(
      Array.from({ length: 18 }, (_, i) => i + 1)
    )
    expect(promptContext(state)).contains(writtenTag(0))
    expect(before).contains(writtenTag(0))
    expect(
      actionFromTagSlots(
        {
          type: 'lineup',
          kind: 'substitute',
          side: 'away',
          player: 18,
          replaces: 0
        },
        state.meta.tagOrder
      )
    ).includes({ player: Number.MAX_SAFE_INTEGER, replaces: 1 })
    expect(() =>
      actionFromTagSlots(
        { type: 'lineup', kind: 'substitute', player: 19 },
        state.meta.tagOrder
      )
    ).throws('Unknown player tag')
  })
})
