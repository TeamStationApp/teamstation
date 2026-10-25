import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'

import type { CurrentPlay } from '../../common/gumboPlay'
import type { Database } from '../db/database'
import { pregameFold, readOnlyStore } from './currentPlay'

/**
 * `pregameFold`'s edges. Its fold of a real pregame is in
 * `routes/events.test.ts` (P4, P5).
 */
describe('the at-bat in progress a reader is answered', function () {
  const shell = {
    about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
    teamStation: { version: 3, setupBefore: {}, actions: [] }
  } as unknown as CurrentPlay
  const game = { home_team_id: 'tem_h', away_team_id: 'tem_a' }
  /** A database that fails at the first query. */
  const broken = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('no database here')
      }
    }
  ) as Kysely<Database>

  it('answers a stored at-bat, or one after stored plays, as it is', async function () {
    const stored = { ...shell, playEvents: [] } as unknown as CurrentPlay
    expect(
      await (
        await pregameFold(
          broken,
          'g1',
          { ...game, currentPlay: stored },
          { plays: [], currentPlay: stored }
        )
      )()
    ).equals(stored)
    expect(
      await (
        await pregameFold(
          broken,
          'g1',
          { ...game, currentPlay: null },
          { plays: [], currentPlay: null }
        )
      )()
    ).equals(null)
  })

  it('answers the pregame as stored when it cannot be folded', async function () {
    expect(
      await (
        await pregameFold(
          broken,
          'g1',
          { ...game, currentPlay: null },
          { plays: [], currentPlay: shell }
        )
      )()
    ).equals(shell)
  })

  it('answers the pregame as stored when its record does not read, reading nothing', async function () {
    const unread = {
      ...shell,
      teamStation: { version: 99, actions: [] }
    } as unknown as CurrentPlay
    const fold = await pregameFold(
      broken,
      'g1',
      { ...game, currentPlay: null },
      { plays: [], currentPlay: unread }
    )
    expect(await fold()).equals(unread)
  })

  it('reads with a store that saves nothing', async function () {
    const store = readOnlyStore({ plays: [], currentPlay: shell })
    expect(await store.load('g1')).deep.equals({
      plays: [],
      currentPlay: shell
    })
    let refused: unknown
    await store
      .save('g1', { plays: [], remove: [] })
      .catch((error: unknown) => {
        refused = error
      })
    expect(String(refused)).contains('A reader saves nothing')
  })
})
