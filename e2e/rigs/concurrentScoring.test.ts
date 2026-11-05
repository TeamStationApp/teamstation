import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import type { E2eContext } from '../core/spec'
import { ConcurrentScoringRig } from './concurrentScoring'

/** Tests the assertions themselves: a broken observer must never pass. */
describe('concurrent scoring observation rig', () => {
  let dir: string
  let rig: ConcurrentScoringRig
  let texts: string[]
  let lineups: string[][]
  let beforeReadback: () => void
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scoring-rig-'))
    texts = ['current', 'current', 'coach']
    lineups = [
      ['Reorder Ada', 'Reorder Bea'],
      ['Reorder Ada', 'Reorder Bea']
    ]
    beforeReadback = () => {}
    const ctx = {
      artifact: (name: string) => join(dir, name),
      checkpoint: async (
        _id: string,
        spec: { readBack: () => Promise<void> }
      ) => {
        beforeReadback()
        await spec.readBack()
      }
    } as unknown as E2eContext
    rig = new ConcurrentScoringRig(ctx)
    for (let i = 0; i < 3; i++)
      rig.clients.push({
        m: { screenshot: async () => Buffer.from('capture') },
        page: null
      })
    rig.text = async index => texts[index]
    rig.summary = async index => texts[index]
    rig.lineup = async index => lineups[index]
    rig.fixture = {
      ids: { game: 'fake-game' },
      world: 'concurrent-scoring',
      nonce: 'test',
      accounts: {}
    }
    rig.api = {
      gameEvents: async () => ({ plays: [{}] })
    } as unknown as typeof rig.api
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('requires the observer to still show the state at the checkpoint', async () => {
    await rig.expectText(1, 'current')
    beforeReadback = () => {
      texts[1] = 'obsolete'
    }
    await assert.rejects(rig.expectText(1, 'current'), /lost current/)
  })
  it('captures and fails a missing observer state with the device and deadline', async () => {
    texts[1] = 'old batter'
    await assert.rejects(
      rig.expectText(1, 'new batter', 0),
      /Client 1.*within 0ms.*old batter/
    )
    assert.equal(
      await readFile(join(dir, 'failed-convergence-1.txt'), 'utf8'),
      'old batter'
    )
  })
  it('rejects a missing client instead of silently checking the author', async () => {
    rig.clients.splice(1)
    await assert.rejects(rig.expectText(1, 'current'))
  })
  it('checks lineup ordering again when the checkpoint reads it', async () => {
    const expected = [...lineups[0]]
    await rig.expectLineup(1, expected)
    beforeReadback = () => {
      lineups[1] = [...expected].reverse()
    }
    await assert.rejects(
      rig.expectLineup(1, expected),
      /lost the acknowledged lineup/
    )
  })
  it('records matching scorer state and the persisted play count', async () => {
    await rig.boundary(0, 1)
    const data = JSON.parse(await readFile(join(dir, 'play-1.json'), 'utf8'))
    assert.equal(data.expected, 'current')
    assert.equal(data.actual, data.expected)
    assert.equal(data.events.plays.length, 1)
  })
  it('does not accept two blank scorer screens as agreement', async () => {
    texts[0] = texts[1] = ''
    await assert.rejects(rig.boundary(0, 1), /Scorer states differ/)
  })
  it('rejects a scorer that becomes stale during checkpoint collection', async () => {
    beforeReadback = () => {
      texts[1] = 'old runner on first'
    }
    await assert.rejects(rig.boundary(0, 1), /Observer lost acknowledged state/)
  })
  it('does not create a success artifact when the API read fails', async () => {
    rig.api.gameEvents = async () => {
      throw new Error('read unavailable')
    }
    await assert.rejects(rig.boundary(0, 1), /read unavailable/)
    await assert.rejects(readFile(join(dir, 'play-1.json')))
  })

  it('moves focus off Undo before accepting a restored trajectory', async () => {
    const keys: string[] = []
    rig.clients[0].m.pressKey = async ({ key }: { key: string }) => {
      keys.push(key)
    }
    rig.clients[0].page = {
      evaluate: async () => keys.length >= 2
    } as unknown as NonNullable<(typeof rig.clients)[0]['page']>
    await rig.trajectory(0)
    assert.deepEqual(keys, ['Tab', 'Tab', 'Enter'])
  })

  it('fails without pressing Enter when the field cannot receive focus', async () => {
    const keys: string[] = []
    rig.clients[0].m.pressKey = async ({ key }: { key: string }) => {
      keys.push(key)
    }
    rig.clients[0].page = {
      evaluate: async () => false
    } as unknown as NonNullable<(typeof rig.clients)[0]['page']>
    await assert.rejects(rig.trajectory(0), /did not reach the field/)
    assert.equal(keys.length, 40)
    assert(!keys.includes('Enter'))
  })
})
