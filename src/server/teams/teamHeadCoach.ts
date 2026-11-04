import type { Kysely } from 'kysely'

import { publicStaffName } from '../../common/publicStaffName'
import { onePerson } from '../admin/people'
import type { Database } from '../db/database'

/** The designated coach's grant and current account, which differ after an account merge. */
export async function teamHeadCoach(
  db: Kysely<Database>,
  teamId: string
): Promise<{ grantUserId: string; userId: string; name: string } | undefined> {
  const row = await db
    .selectFrom('scope_roles')
    .select('user_id')
    .where('scope_id', '=', teamId)
    .where('is_head_coach', '=', true)
    .executeTakeFirst()
  if (row == null) return undefined
  const { userId } = await onePerson(db, row.user_id)
  const user = await db
    .selectFrom('users')
    .select([
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName'
    ])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow()
  return { grantUserId: row.user_id, userId, name: publicStaffName(user) }
}
