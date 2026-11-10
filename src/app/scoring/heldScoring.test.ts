import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError, updateRequired } from '../../common/errors'
import type { ScoringAction } from '../../common/scoring/actions'
import { type EventStore, ScoringSession } from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { game, TEAMS } from '../../test/scoringGames'
import { holdWhenOutdated, restoreHeld } from './heldScoring'
import type { PreferenceStorage } from './scoringPreferenceStore'
import { memoryStore } from './scoringSource'

const context = { gamePk: 'g1', teams: TEAMS, setup: setupOf(game()) }
const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }

/** A device's storage, in memory. */
function deviceStorage(): PreferenceStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: async key => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value)
    },
    removeItem: async key => {
      items.delete(key)
    }
  }
}

/** A server that refuses every save as too old while `refusing` says so. */
function server(): EventStore & { refusing: boolean; failing: boolean } {
  const stored = memoryStore()
  const store = {
    refusing: false,
    /** Refuses every save as one it cannot store, until told otherwise. */
    failing: false,
    load: stored.load,
    save: async (...args: Parameters<EventStore['save']>) => {
      if (store.refusing)
        throw updateRequired('Update TeamStation to keep scoring games.')
      if (store.failing) throw new HttpError('badRequest', 'play 1: bad')
      return await stored.save(...args)
    }
  }
  return store
}

/** The sides the test's game is scored with. */
const SIDES = { home: TEAMS.home.id, away: TEAMS.away.id }

/** The device's storage settles a write a tick after the change asked. */
const settled = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('plays a build too old to save keeps on the device', function () {
  it('keeps what a refused save held, and plays it on a newer build after the reload', async function () {
    const store = server()
    const storage = deviceStorage()
    const old = await ScoringSession.open(store, 'g1', context)
    holdWhenOutdated(old, storage, 'usr_a')
    old.apply(ball)
    await old.flush()
    store.refusing = true
    old.apply(strike)
    old.apply(strike)
    await old.flush()
    await settled()
    expect(old.outdated).equals(true)
    expect(storage.items.has('scoring.held.usr_a.g1')).equals(true)
    // Reloaded on a build the server takes.
    store.refusing = false
    const reloaded = await ScoringSession.open(store, 'g1', context)
    expect(reloaded.actions).deep.equals([ball])
    expect(await restoreHeld(reloaded, storage, 'usr_a')).equals(2)
    expect(reloaded.actions).deep.equals([ball, strike, strike])
    expect(storage.items.has('scoring.held.usr_a.g1')).equals(false)
    await reloaded.flush()
    expect(reloaded.pending).equals(0)
    const again = await ScoringSession.open(store, 'g1', context)
    expect(again.actions).deep.equals([ball, strike, strike])
  })

  it('keeps nothing while the saves go', async function () {
    const store = server()
    const storage = deviceStorage()
    const session = await ScoringSession.open(store, 'g1', context)
    holdWhenOutdated(session, storage, 'usr_a')
    session.apply(ball)
    await session.flush()
    await settled()
    expect(storage.items.size).equals(0)
    expect(await restoreHeld(session, storage, 'usr_a')).equals(0)
  })

  /** Opens the game the server holds: one ball, saved. */
  async function oneBall(): Promise<{
    store: ReturnType<typeof server>
    session: ScoringSession
  }> {
    const store = server()
    const session = await ScoringSession.open(store, 'g1', context)
    session.apply(ball)
    await session.flush()
    return { store, session }
  }
  const keep = (
    storage: ReturnType<typeof deviceStorage>,
    actions: unknown[]
  ): void => {
    storage.items.set(
      'scoring.held.usr_a.g1',
      JSON.stringify({ ...SIDES, actions, times: actions.map(() => null) })
    )
  }

  it('keeps a log the server has moved past, the only copy of its plays, and plays none of it', async function () {
    const { session } = await oneBall()
    const storage = deviceStorage()
    // Another scorer saved a ball where this log has a strike.
    keep(storage, [strike, strike])
    expect(await restoreHeld(session, storage, 'usr_a')).equals(0)
    expect(session.actions).deep.equals([ball])
    expect(storage.items.has('scoring.held.usr_a.g1')).equals(true)
  })

  it('forgets a log the server holds whole already', async function () {
    const { session } = await oneBall()
    const storage = deviceStorage()
    keep(storage, [ball])
    expect(await restoreHeld(session, storage, 'usr_a')).equals(0)
    expect(storage.items.has('scoring.held.usr_a.g1')).equals(false)
  })

  it('keeps a log this build cannot read, for one that can', async function () {
    const { session } = await oneBall()
    const storage = deviceStorage()
    keep(storage, [ball, { type: 'swing' }])
    expect(await restoreHeld(session, storage, 'usr_a')).equals(0)
    storage.items.set('scoring.held.usr_a.g1', 'not json')
    expect(await restoreHeld(session, storage, 'usr_a')).equals(0)
    expect(storage.items.get('scoring.held.usr_a.g1')).equals('not json')
  })

  it('keeps the log until the plays it holds are saved, and plays them again after a failed save', async function () {
    const { store, session } = await oneBall()
    const storage = deviceStorage()
    keep(storage, [ball, strike])
    store.refusing = true
    expect(await restoreHeld(session, storage, 'usr_a')).equals(1)
    // Refused again: the plays are not on the server, so the log stays.
    expect(storage.items.has('scoring.held.usr_a.g1')).equals(true)
    store.refusing = false
    const again = await ScoringSession.open(store, 'g1', context)
    expect(again.actions).deep.equals([ball])
    expect(await restoreHeld(again, storage, 'usr_a')).equals(1)
    expect(again.actions).deep.equals([ball, strike])
    expect(storage.items.has('scoring.held.usr_a.g1')).equals(false)
  })

  it('plays a log only for the person it was kept for', async function () {
    const { session } = await oneBall()
    const storage = deviceStorage()
    keep(storage, [ball, strike])
    expect(await restoreHeld(session, storage, 'usr_b')).equals(0)
    expect(session.actions).deep.equals([ball])
    expect(storage.items.has('scoring.held.usr_a.g1')).equals(true)
  })

  it('keeps a log scored on another generation of the game, or with its sides the other way round, unplayed', async function () {
    const { session } = await oneBall()
    const storage = deviceStorage()
    for (const scored of [
      { ...SIDES, generation: 7 },
      { home: SIDES.away, away: SIDES.home }
    ]) {
      storage.items.set(
        'scoring.held.usr_a.g1',
        JSON.stringify({ ...scored, actions: [ball, strike], times: [] })
      )
      expect(await restoreHeld(session, storage, 'usr_a')).equals(0)
      expect(session.actions).deep.equals([ball])
      expect(storage.items.has('scoring.held.usr_a.g1')).equals(true)
    }
  })

  it('forgets the log at the first save that holds everything, so an undo after a failed save is not played back', async function () {
    const { store, session } = await oneBall()
    const storage = deviceStorage()
    keep(storage, [ball, strike, strike])
    store.failing = true
    expect(await restoreHeld(session, storage, 'usr_a')).equals(2)
    expect(storage.items.has('scoring.held.usr_a.g1')).equals(true)
    // The scorer takes a strike back; that change saves.
    store.failing = false
    session.undo()
    await session.flush()
    await settled()
    expect(session.pending).equals(0)
    expect(storage.items.has('scoring.held.usr_a.g1')).equals(false)
    const again = await ScoringSession.open(store, 'g1', context)
    expect(await restoreHeld(again, storage, 'usr_a')).equals(0)
    expect(again.actions).deep.equals([ball, strike])
  })

  it('reads the kept actions whatever order their fields were written in', async function () {
    const { session } = await oneBall()
    const storage = deviceStorage()
    keep(storage, [
      { call: 'B', type: 'pitch' },
      { call: 'C', type: 'pitch' }
    ])
    expect(await restoreHeld(session, storage, 'usr_a')).equals(1)
    expect(session.actions).deep.equals([ball, strike])
  })

  it('keeps a change that leaves the log the same length, and nothing once the session is closed', async function () {
    const store = server()
    const storage = deviceStorage()
    const session = await ScoringSession.open(store, 'g1', context)
    holdWhenOutdated(session, storage, 'usr_a')
    store.refusing = true
    session.apply(ball)
    await session.flush()
    await settled()
    const held = (): unknown =>
      (
        JSON.parse(storage.items.get('scoring.held.usr_a.g1')!) as {
          actions: unknown[]
        }
      ).actions
    expect(held()).deep.equals([ball])
    // The ball taken back and a strike called instead: still one action.
    session.undo()
    session.apply(strike)
    await settled()
    expect(held()).deep.equals([strike])
    // Closed for another read of the game: what it does no longer counts.
    session.close()
    storage.items.set(
      'scoring.held.usr_a.g1',
      JSON.stringify({ ...SIDES, actions: [], times: [] })
    )
    session.apply(ball)
    await settled()
    expect(held()).deep.equals([])
  })
})
