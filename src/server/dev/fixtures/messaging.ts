import { sql } from 'kysely'

import { makeId } from '../../../common/ids'
import { createDm } from '../../chat/dms'
import { createTeam } from '../../teams/createTeam'
import {
  createAccount,
  type FixtureAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'
import { splitMailbox } from './address'

const PEOPLE = {
  observer: { first: 'Clayton', last: 'Kershaw' },
  sender: { first: 'Walker', last: 'Buehler' }
}

/** Both are adults by their own word, so the chat's age gate lets them through. */
async function markAdult(
  context: WorldContext,
  account: FixtureAccount
): Promise<void> {
  await context.db
    .updateTable('users')
    .set({ is_adult: true, age_source: 'self', age_set_at: new Date() })
    .where('id', '=', account.userId as never)
    .execute()
}

/**
 * Two adults on one team and the direct conversation between them, under
 * this run's nonce: the chat link and composer scenarios' room. Each chat
 * device is a test's own: their keys are made when a scenario first starts
 * a chat engine for them, so nothing here is encrypted.
 */
export async function runMessaging(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'messaging'
  const observer = await createAccount(
    context,
    world,
    'observer',
    PEOPLE.observer
  )
  const sender = await createAccount(context, world, 'sender', PEOPLE.sender)
  await markAdult(context, observer)
  await markAdult(context, sender)
  const team = await createTeam(
    db,
    { name: `Dodgers ${nonce}`, externalIds: [] },
    { userId: sender.userId, isAdmin: false }
  )
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: observer.userId as never,
      team_id: team.id,
      role: 'member',
      is_player: true
    })
    .execute()
  const { conversationId } = await createDm(db, sender.userId, [
    observer.userId
  ])
  return {
    world,
    nonce,
    accounts: { observer, sender },
    ids: { team: team.id, conversation: conversationId }
  }
}

/** How far back `messaging-dated` moves a post. */
export const DATED_DAYS = 8

/**
 * Moves each post with exactly two files, sent in the last six hours to a
 * `messaging` world's conversation on this mailbox, back `DATED_DAYS` days,
 * so the edit scenario has an original at least a week old. A post's time
 * is the server's, outside what its sender signed, so the move changes
 * nothing else about it.
 */
export async function runMessagingDated(
  context: WorldContext
): Promise<FixtureManifest> {
  const { local, domain } = splitMailbox(context.mailbox)
  const senders = `${local.toLowerCase()}+messaging-%@${domain.toLowerCase()}`
  const moved = await sql<{ id: string }>`
    update chat_messages
    set created_at = created_at - make_interval(days => ${DATED_DAYS})
    where kind = 'post'
      and created_at > now() - interval '6 hours'
      and id in (
        select message_id from chat_message_attachments
        group by message_id having count(*) = 2
      )
      and conversation_id in (
        select c.id from chat_conversations c
        join user_emails e on e.user_id = c.created_by
        where c.kind = 'dm' and lower(e.email) like ${senders}
      )
    returning id
  `.execute(context.db)
  return {
    world: 'messaging-dated',
    nonce: context.nonce,
    accounts: {},
    ids: { moved: moved.rows.map(row => row.id).join(',') }
  }
}
