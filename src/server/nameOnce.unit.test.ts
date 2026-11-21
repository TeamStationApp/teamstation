import { expect } from 'chai'
import type { Transaction } from 'kysely'
import { describe, it } from 'mocha'

import { withQueryReplies } from '../test/queryReplies'
import type { Database } from './db/database'
import { nameOnce, withRolesRead } from './db/readOnce'
import { senderName } from './schedule/gameApprovals'

describe('a name read once', () => {
  it('holds one shape for every reader: a missing row is undefined, never a cached row another misreads', async () => {
    await withQueryReplies([['from "seasons"', []]], async db => {
      await withRolesRead(db, async () => {
        // The request's group lookup reads the missing season first.
        expect(await nameOnce(db, 'season', 'sea_gone')).equals(undefined)
        // The sender's name then reads the same cached answer, and says
        // the row is missing rather than failing on `.name`.
        const error = await senderName(db as unknown as Transaction<Database>, {
          kind: 'season',
          id: 'sea_gone'
        }).catch((caught: unknown) => caught)
        expect(error).instanceOf(Error)
        expect(error).not.instanceOf(TypeError)
        expect(String(error)).includes('No season sea_gone')
      })
    })
    await withQueryReplies(
      [['from "teams"', [{ name: 'Demo Hawks' }]]],
      async db => {
        await withRolesRead(db, async () => {
          expect(
            await senderName(db as unknown as Transaction<Database>, {
              kind: 'team',
              id: 'tem_a'
            })
          ).equals('Demo Hawks')
          expect(await nameOnce(db, 'team', 'tem_a')).equals('Demo Hawks')
        })
      }
    )
  })
})
