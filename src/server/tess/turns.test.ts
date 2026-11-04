import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'

import type { HttpError } from '../../common/errors'
import { type TessWorld, tessWorld } from '../../test/tessFakes'
import { stopTurn, TURN_RUNNING, withTurn } from './turns'

describe("Tess's turns, one at a time", function () {
  this.timeout(30000)
  let w: TessWorld

  before(async () => {
    w = await tessWorld()
  })
  after(async () => {
    await w?.close()
  })
  beforeEach(async () => {
    await w.h.db.deleteFrom('tess_conversations').execute()
  })

  const claim = async (): Promise<{
    turn_owner: string | null
    turn_until: Date | null
  }> =>
    await w.h.db
      .selectFrom('tess_conversations')
      .select(['turn_owner', 'turn_until'])
      .where('user_id', '=', w.userId(101))
      .executeTakeFirstOrThrow()

  const refusal = async (turn: Promise<unknown>): Promise<HttpError> => {
    try {
      await turn
    } catch (error) {
      return error as HttpError
    }
    return expect.fail('the turn ran')
  }

  it('holds the conversation while a turn runs, and lets it go when the turn ends or fails', async () => {
    let inside: Awaited<ReturnType<typeof claim>> | undefined
    expect(
      await withTurn(w.h.db, w.userId(101), undefined, async () => {
        inside = await claim()
        const error = await refusal(
          withTurn(w.h.db, w.userId(101), undefined, async () => 'second')
        )
        expect(error.status).equals(409)
        expect(error.message).equals(TURN_RUNNING)
        return 'first'
      })
    ).equals('first')
    expect(inside?.turn_owner).match(/^[0-9a-f-]{36}$/)
    expect(inside?.turn_until?.getTime()).greaterThan(Date.now())
    expect(await claim()).deep.equals({ turn_owner: null, turn_until: null })

    const failed = await refusal(
      withTurn(w.h.db, w.userId(101), undefined, async () => {
        throw new Error('the model is down')
      })
    )
    expect(failed.message).equals('the model is down')
    expect(await claim()).deep.equals({ turn_owner: null, turn_until: null })
  })

  it('takes over a claim that lapsed, as a worker that died mid-turn leaves it', async () => {
    await w.h.db
      .insertInto('tess_conversations')
      .values({
        user_id: w.userId(101),
        turn_owner: '00000000-0000-4000-8000-000000000001',
        turn_until: sql<Date>`now() + interval '30 seconds'`
      })
      .execute()
    expect(
      (
        await refusal(
          withTurn(w.h.db, w.userId(101), undefined, async () => 'held')
        )
      ).status
    ).equals(409)
    await w.h.db
      .updateTable('tess_conversations')
      .set({ turn_until: sql<Date>`now() - interval '1 second'` })
      .execute()
    expect(
      await withTurn(w.h.db, w.userId(101), undefined, async () => 'mine')
    ).equals('mine')
  })

  it('renews the claim while a long turn runs', async () => {
    await withTurn(
      w.h.db,
      w.userId(101),
      undefined,
      async () => {
        const first = await claim()
        // Lapsed, as far as the row says: renewing brings it back.
        await w.h.db
          .updateTable('tess_conversations')
          .set({ turn_until: sql<Date>`now() - interval '1 second'` })
          .execute()
        while ((await claim()).turn_until!.getTime() < Date.now())
          await new Promise(resolve => setTimeout(resolve, 10))
        expect((await claim()).turn_owner).equals(first.turn_owner)
      },
      { renewMs: 20 }
    )
  })

  const row = async (): Promise<{
    turn_client_id: string | null
    turn_stop: string | null
  }> =>
    await w.h.db
      .selectFrom('tess_conversations')
      .select(['turn_client_id', 'turn_stop'])
      .where('user_id', '=', w.userId(101))
      .executeTakeFirstOrThrow()

  /** Waits for `signal` to abort, or fails after `ms`. */
  const aborted = async (signal: AbortSignal, ms = 2000): Promise<void> => {
    const until = Date.now() + ms
    while (!signal.aborted) {
      if (Date.now() > until) expect.fail('the turn was not stopped')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  it('stops the running turn a stop names, by its client id, and keeps that id on the row while it runs', async () => {
    const answer = await withTurn(
      w.h.db,
      w.userId(101),
      'm-one',
      async signal => {
        expect(await row()).deep.equals({
          turn_client_id: 'm-one',
          turn_stop: null
        })
        expect(signal.aborted).equals(false)
        await stopTurn(w.h.db, w.userId(101), 'm-one')
        await aborted(signal)
        return 'stopped'
      },
      { pollMs: 10 }
    )
    expect(answer).equals('stopped')
    // Released, and the stop that named it is done with.
    expect(await row()).deep.equals({ turn_client_id: null, turn_stop: null })
  })

  it('leaves a turn running when the stop names another client id', async () => {
    await withTurn(
      w.h.db,
      w.userId(101),
      'm-one',
      async signal => {
        await stopTurn(w.h.db, w.userId(101), 'm-other')
        await new Promise(resolve => setTimeout(resolve, 80))
        expect(signal.aborted).equals(false)
      },
      { pollMs: 10 }
    )
    // A stop naming another turn is not this one's to clear.
    expect((await row()).turn_stop).equals('m-other')
  })

  it('stops a turn as it claims when the stop came first, and never stops one without a client id', async () => {
    // No conversation yet: the stop makes one.
    await stopTurn(w.h.db, w.userId(101), 'm-early')
    expect((await row()).turn_stop).equals('m-early')
    await withTurn(w.h.db, w.userId(101), 'm-early', async signal => {
      expect(signal.aborted).equals(true)
    })
    expect((await row()).turn_stop).equals(null)

    // An older app's turn has no id, and no stop names it.
    await stopTurn(w.h.db, w.userId(101), 'm-late')
    await withTurn(
      w.h.db,
      w.userId(101),
      undefined,
      async signal => {
        await new Promise(resolve => setTimeout(resolve, 60))
        expect(signal.aborted).equals(false)
      },
      { pollMs: 10 }
    )
    expect((await row()).turn_stop).equals('m-late')
  })

  it('stops nothing later with a stop naming a turn that has ended, and reads no more once a turn is over', async () => {
    let first: AbortSignal | undefined
    let owner: string | null = null
    await withTurn(
      w.h.db,
      w.userId(101),
      'm-one',
      async signal => {
        first = signal
        owner = (await claim()).turn_owner
      },
      { pollMs: 10 }
    )
    // Too late for the first; the next has an id of its own.
    await stopTurn(w.h.db, w.userId(101), 'm-one')
    await withTurn(
      w.h.db,
      w.userId(101),
      'm-two',
      async signal => {
        await new Promise(resolve => setTimeout(resolve, 60))
        expect(signal.aborted).equals(false)
      },
      { pollMs: 10 }
    )
    // The ended turn's poll stopped with it: a stop naming it now, with the
    // row holding it as the running turn again, is never read.
    await w.h.db
      .updateTable('tess_conversations')
      .set({ turn_owner: owner, turn_stop: 'm-one' })
      .execute()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(first?.aborted).equals(false)
  })
})
