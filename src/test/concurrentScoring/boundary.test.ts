import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { PlayFolder } from '../../common/scoring/document'
import type { StoredGame } from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { after, ball, game, TEAMS } from '../scoringGames'
import { ConcurrentScoringRig } from './concurrentScoring'
import type { E2eContext, FixtureManifest } from './context'

describe('concurrent scoring saved-play checks', function () {
  this.timeout(10000)
  let directory: string
  let rig: ConcurrentScoringRig
  let inspections: number
  beforeEach(async function () {
    directory = await mkdtemp(join(tmpdir(), 'scoring-boundary-'))
    inspections = 0
    const context: Pick<E2eContext, 'artifact' | 'checkpoint'> = {
      artifact: name => join(directory, name),
      checkpoint: async (_id, options) => {
        await options.readBack()
      }
    }
    rig = new ConcurrentScoringRig(context as E2eContext)
    const fixture: FixtureManifest = {
      world: 'concurrent-scoring',
      nonce: 'boundary',
      accounts: {},
      ids: { game: 'g1' }
    }
    rig.fixture = fixture
    rig.clients.push({ m: {}, page: null }, { m: {}, page: null })
    rig.savedSummary = () => 'matching score'
    rig.summary = async () => {
      inspections++
      return 'matching score'
    }
  })
  afterEach(async function () {
    await rm(directory, { recursive: true, force: true })
  })
  const play = { about: { atBatIndex: 0 } }
  const stored: StoredGame = {
    plays: [play as StoredGame['plays'][number]],
    currentPlay: null
  }
  const offline = (): HttpError => new HttpError('offline', 'Connection lost')
  const reader = (read: () => Promise<StoredGame>): TeamStationClient => {
    const client: Pick<TeamStationClient, 'gameEvents'> = { gameEvents: read }
    return client as TeamStationClient
  }

  it('retries a lost read and still checks both screens and the saved play', async function () {
    let reads = 0
    rig.api = reader(async () => {
      if (++reads === 1) throw offline()
      return stored
    })
    await rig.boundary(0, 1)
    assert.equal(reads, 3)
    assert.equal(inspections, 3)
    const proof = JSON.parse(
      await readFile(join(directory, 'play-1.json'), 'utf8')
    )
    assert.deepEqual(proof.events, stored)
  })

  it('does not retry an authorization failure', async function () {
    let reads = 0
    const error = new HttpError('forbidden', 'No longer authorized')
    rig.api = reader(async () => {
      reads++
      throw error
    })
    await assert.rejects(rig.boundary(0, 1), error)
    assert.equal(reads, 1)
    assert.equal(inspections, 0)
  })

  it('waits for a reopened retained row to complete again before freezing the oracle', async function () {
    const current = { about: { atBatIndex: 0 } }
    const reopened: StoredGame = {
      plays: stored.plays,
      currentPlay: current as StoredGame['currentPlay']
    }
    let reads = 0
    rig.api = reader(async () => (++reads === 1 ? reopened : stored))
    rig.savedSummary = events =>
      events.currentPlay == null ? 'matching score' : 'undone score'
    await rig.boundary(0, 1)
    assert.equal(reads, 3)
    assert.equal(inspections, 3)
    const proof = JSON.parse(
      await readFile(join(directory, 'play-1.json'), 'utf8')
    )
    assert.deepEqual(proof.events, stored)
  })

  it('counts a retained reopened row as unfinished for an Undo boundary', async function () {
    const current = { about: { atBatIndex: 0 } }
    rig.api = reader(async () => ({
      plays: stored.plays,
      currentPlay: current as StoredGame['currentPlay']
    }))
    await rig.boundary(0, 0)
    assert.equal(inspections, 3)
  })

  it('compares the latest saved revision when Undo keeps the same completed count', async function () {
    const current = { about: { atBatIndex: 1 } }
    const intermediate: StoredGame = {
      plays: stored.plays,
      currentPlay: current as StoredGame['currentPlay']
    }
    let reads = 0
    rig.api = reader(async () => (++reads === 1 ? intermediate : stored))
    rig.savedSummary = events =>
      events.currentPlay == null ? 'matching score' : 'intermediate undo score'
    await rig.boundary(0, 1)
    assert.equal(reads, 2)
    const proof = JSON.parse(
      await readFile(join(directory, 'play-1.json'), 'utf8')
    )
    assert.deepEqual(proof.events, stored)
  })

  it('rejects a completed count that changes before the screen inspection', async function () {
    let reads = 0
    rig.api = reader(async () =>
      ++reads === 1 ? stored : { plays: [], currentPlay: null }
    )
    await assert.rejects(
      rig.boundary(0, 1),
      /Expected 1 completed saved plays; got 0/
    )
    assert.equal(reads, 2)
  })

  it('fails after the retry also loses its connection', async function () {
    let reads = 0
    rig.api = reader(async () => {
      reads++
      throw offline()
    })
    await assert.rejects(rig.boundary(0, 1), /Connection lost/)
    assert.equal(reads, 2)
    assert.equal(inspections, 0)
  })

  it('does not replenish the retry after a successful stale read', async function () {
    let reads = 0
    rig.api = reader(async () => {
      reads++
      if (reads === 1 || reads === 3) throw offline()
      return reads === 2 ? { plays: [], currentPlay: null } : stored
    })
    await assert.rejects(rig.boundary(0, 1), /Connection lost/)
    assert.equal(reads, 3)
    assert.equal(inspections, 0)
  })

  it('rejects a retry whose successful response arrives after the deadline', async function () {
    const originalNow = Date.now
    let now = originalNow()
    let reads = 0
    Date.now = () => now
    try {
      rig.api = reader(async () => {
        if (++reads === 1) {
          now += 14800
          throw offline()
        }
        now += 201
        return stored
      })
      await assert.rejects(rig.boundary(0, 1), /deadline expired/)
      assert.equal(reads, 2)
      assert.equal(inspections, 0)
    } finally {
      Date.now = originalNow
    }
  })

  it('bounds a retry that never returns by the remaining deadline', async function () {
    const originalNow = Date.now
    let now = originalNow()
    let reads = 0
    Date.now = () => now
    try {
      rig.api = reader(async () => {
        if (++reads === 1) {
          now += 14800
          throw offline()
        }
        return await new Promise(() => {})
      })
      await assert.rejects(rig.boundary(0, 1), /deadline expired/)
      assert.equal(reads, 2)
      assert.equal(inspections, 0)
    } finally {
      Date.now = originalNow
    }
  })

  it('rejects two equally stale screens despite the expected saved play count', async function () {
    rig.api = reader(async () => stored)
    rig.summary = async () => 'old score'
    await assert.rejects(rig.boundary(0, 1), /differ from saved game/)
  })

  it('replays saved actions independently of both screen summaries', async function () {
    const initial = game()
    const setup = setupOf(initial)
    rig.savedContext = { gamePk: 'g1', teams: TEAMS, setup }
    rig.savedSummary = ConcurrentScoringRig.prototype.savedSummary.bind(rig)
    const old = rig.savedSummary({ plays: [], currentPlay: null })
    const state = after(initial, ball)
    const saved: StoredGame = {
      plays: [],
      currentPlay: new PlayFolder(state).current(
        state.liveData.plays.currentPlay,
        { setupBefore: setup, actions: [ball] }
      )
    }
    const expected = rig.savedSummary(saved)
    assert.match(
      expected,
      /Visitors 0 · Hosts 0 · Top 1st · 1 balls 0 strikes 0 outs · Pitches 1/
    )
    assert.match(expected, /Batter Player 1 right handed · Pitcher Player 1/)
    assert.match(
      expected,
      /first base empty · second base empty · third base empty/
    )
    assert.notEqual(expected, old)
    rig.api = reader(async () => saved)
    rig.summary = async () => old
    await assert.rejects(rig.boundary(0, 0), /differ from saved game/)
  })

  it('keeps the original save deadline when a read loses its connection', async function () {
    const originalNow = Date.now
    let now = originalNow()
    let reads = 0
    Date.now = () => now
    try {
      rig.api = reader(async () => {
        reads++
        now += 15000
        throw offline()
      })
      await assert.rejects(rig.boundary(0, 1), /Connection lost/)
      assert.equal(reads, 1)
      assert.equal(inspections, 0)
    } finally {
      Date.now = originalNow
    }
  })

  it('still fails a mismatched observer after the read recovers', async function () {
    let reads = 0
    rig.api = reader(async () => {
      if (++reads === 1) throw offline()
      return stored
    })
    rig.summary = async index => (index === 0 ? 'new score' : 'old score')
    await assert.rejects(rig.boundary(0, 1), /Scorer states differ/)
    assert.equal(reads, 3)
  })
})
