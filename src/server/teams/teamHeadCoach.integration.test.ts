import { expect } from 'chai'
import { it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { groupFixture } from '../../test/groupFixtures'
import { closeInto } from '../admin/people'
import { teamHeadCoach } from './teamHeadCoach'

it('keeps a merged manager designation only with an existing surviving Coach grant', async () => {
  const f = await groupFixture()
  const closing = userIdOfGumbo(104)
  const keeping = userIdOfGumbo(106)
  try {
    await f.h.db
      .insertInto('scope_roles')
      .values([
        {
          id: 'manager-a',
          user_id: closing,
          scope_type: 'team',
          scope_id: f.teamA,
          role: 'coach',
          is_head_coach: true
        },
        {
          id: 'manager-b',
          user_id: closing,
          scope_type: 'team',
          scope_id: f.teamB,
          role: 'coach',
          is_head_coach: true
        },
        {
          id: 'coach-b',
          user_id: keeping,
          scope_type: 'team',
          scope_id: f.teamB,
          role: 'coach'
        }
      ])
      .execute()
    // The imported survivor acquires sign-in from the account it absorbs.
    await f.h.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', keeping)
      .execute()
    await closeInto(f.h.db, closing, keeping)
    expect(await teamHeadCoach(f.h.db, f.teamA)).equals(undefined)
    expect((await teamHeadCoach(f.h.db, f.teamB))?.userId).equals(keeping)
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select('id')
        .where('user_id', '=', keeping)
        .where('scope_id', '=', f.teamA)
        .execute()
    ).length(0)
    // Redirecting the closed alias leaves its previous survivor and manager grant intact.
    await closeInto(f.h.db, closing, userIdOfGumbo(102))
    expect((await teamHeadCoach(f.h.db, f.teamB))?.userId).equals(keeping)
  } finally {
    await f.h.close()
  }
}).timeout(60000)
