import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'

import type { HttpError } from '../../common/errors'
import { type TessWorld, tessWorld } from '../../test/tessFakes'
import { TURN_RUNNING, withTurn } from './turns'

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
      await withTurn(w.h.db, w.userId(101), async () => {
        inside = await claim()
        const error = await refusal(
          withTurn(w.h.db, w.userId(101), async () => 'second')
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
      withTurn(w.h.db, w.userId(101), async () => {
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
      (await refusal(withTurn(w.h.db, w.userId(101), async () => 'held')))
        .status
    ).equals(409)
    await w.h.db
      .updateTable('tess_conversations')
      .set({ turn_until: sql<Date>`now() - interval '1 second'` })
      .execute()
    expect(await withTurn(w.h.db, w.userId(101), async () => 'mine')).equals(
      'mine'
    )
  })

  it('renews the claim while a long turn runs', async () => {
    await withTurn(
      w.h.db,
      w.userId(101),
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
      20
    )
  })
})
