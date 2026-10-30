import type { Kysely } from 'kysely'

import type { RequestTerms } from '../../common/notifications'
import type { Database } from '../db/database'
import { groupName } from '../invites/grants'

/** A completed action describes its result, without invitation copy. */
export async function completionNotice(
  db: Kysely<Database>,
  terms: Exclude<RequestTerms, { kind: 'guardian' }>
): Promise<string> {
  if (terms.kind === 'game')
    return `Game saved: ${await groupName(db, { kind: 'team', id: terms.game.homeTeamId })} vs ${await groupName(db, { kind: 'team', id: terms.game.awayTeamId })}${terms.game.seasonId == null ? '' : ` in ${await groupName(db, { kind: 'season', id: terms.game.seasonId })}`}`
  if (terms.kind === 'participation')
    return `${await groupName(db, { kind: 'team', id: terms.teamId })} season participation added in ${await groupName(db, { kind: 'season', id: terms.seasonId })}`
  if (terms.kind === 'promotion')
    return `${await groupName(db, { kind: 'team', id: terms.teamId })}: administrator added`
  if (terms.kind === 'membership')
    return `${await groupName(db, { kind: 'team', id: terms.teamId })}: membership approved`
  if (terms.kind === 'videographer')
    return `${await groupName(db, { kind: 'team', id: terms.teamId })}: videographer approved`
  if (terms.kind === 'person')
    return `${await groupName(db, terms.scope)}: access added for ${terms.recipientEmail}`
  const changes = await Promise.all(
    terms.preview.effects.map(
      async effect =>
        `${await groupName(db, effect.parent)} ${effect.operation === 'attach' ? 'added as' : 'removed as'} parent of ${await groupName(db, effect.child)}`
    )
  )
  return changes.length === 0
    ? 'No management connections changed'
    : changes.join('; ')
}
