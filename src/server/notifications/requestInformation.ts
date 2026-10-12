import { type Kysely, sql } from 'kysely'

import type { GroupRef } from '../../common/groupCreation'
import { shortName } from '../../common/names'
import type { RequestTerms } from '../../common/notifications'
import type { Role } from '../../common/roles'
import type { Database } from '../db/database'
import { isGuardianRequest } from '../groups/guardianLimits'
import type { StoredRequest } from '../groups/requests'

export async function titleAndDescription(
  db: Kysely<Database>,
  request: StoredRequest
): Promise<{ title: string; description: string }> {
  const event = await db
    .selectFrom('notification_events')
    .select('metadata')
    .where('source_type', '=', 'groupRequest')
    .where('source_id', '=', request.id)
    .executeTakeFirst()
  const metadata = event?.metadata as
    | {
        senderName?: string
        senderGroupName?: string
        requestTitle?: string
        requestDescription?: string
        gameClassificationIncluded?: boolean
      }
    | undefined
  const terms = request.terms as RequestTerms
  const exhibition = (value?: boolean): string =>
    `Exhibition: ${value === true ? 'On' : 'Off'}`
  if (metadata?.requestTitle != null && metadata.requestDescription != null)
    return {
      title: metadata.requestTitle,
      description:
        metadata.requestDescription +
        (terms.kind === 'game' && metadata.gameClassificationIncluded !== true
          ? ` Proposed ${exhibition(terms.game.exhibition)}.${terms.previous == null ? '' : ` Previous ${exhibition(terms.previous.exhibition)}.`}`
          : '')
    }
  const sender = metadata?.senderName ?? 'An administrator'
  const organization = metadata?.senderGroupName ?? 'their organization'
  const name = async (ref: GroupRef): Promise<string> =>
    (
      await db
        .selectFrom(
          ref.kind === 'league'
            ? 'leagues'
            : ref.kind === 'season'
              ? 'seasons'
              : 'teams'
        )
        .select('name')
        .where('id', '=', ref.id)
        .executeTakeFirst()
    )?.name ?? 'Unavailable group'
  if (terms.kind === 'game') {
    const home = await name({ kind: 'team', id: terms.game.homeTeamId })
    const away = await name({ kind: 'team', id: terms.game.awayTeamId })
    const competition =
      terms.game.seasonId == null
        ? terms.game.outsideTournament == null
          ? 'outside a TeamStation season'
          : `at ${terms.game.outsideTournament}`
        : `in ${await name({ kind: 'season', id: terms.game.seasonId })}`
    const when = async (
      startAt: string,
      seasonId: string | null,
      timezone?: string
    ): Promise<string> => {
      const zone =
        timezone ??
        (seasonId == null
          ? 'UTC'
          : ((
              await db
                .selectFrom('seasons')
                .select('timezone')
                .where('id', '=', seasonId)
                .executeTakeFirst()
            )?.timezone ?? 'UTC'))
      return `${new Intl.DateTimeFormat('en', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(startAt))} (${zone})`
    }
    const prior =
      terms.previous == null
        ? ''
        : ` Previously ${await name({ kind: 'team', id: terms.previous.awayTeamId })} at ${await name({ kind: 'team', id: terms.previous.homeTeamId })}, ${terms.previous.seasonId == null ? 'outside a TeamStation season' : 'in ' + (await name({ kind: 'season', id: terms.previous.seasonId }))}, ${await when(terms.previous.startAt, terms.previous.seasonId, terms.previous.timezone)}${terms.previous.venue == null ? '' : ' at ' + terms.previous.venue}, ${terms.previous.status}, ${exhibition(terms.previous.exhibition)}.`
    return {
      title:
        terms.gameId == null
          ? `${away} invited to game vs. ${home}`
          : `${away} vs. ${home}: ${terms.game.status === 'cancelled' ? 'cancellation' : 'game change'}`,
      description: `${sender} from ${organization} proposed ${away} at ${home} ${competition}, ${await when(terms.game.startAt, terms.game.seasonId, terms.game.timezone)}${terms.game.venue == null ? '' : ' at ' + terms.game.venue}, ${terms.game.status}, ${exhibition(terms.game.exhibition)}.${prior} This changes neither management parents nor season participation.`
    }
  }
  if (terms.kind === 'person') {
    const group = await name(terms.scope)
    const roles = [...(terms.admin ? ['administrator'] : []), ...terms.flags]
    return {
      title: `Invitation to ${group}`,
      description: `${sender} from ${organization} invited you to ${group}. Requested access: ${roles.length === 0 ? 'watching' : roles.join(', ')}. They apply when the address it was sent to is verified, or when you accept.`
    }
  }
  if (terms.kind === 'guardian') {
    const player = await db
      .selectFrom('users')
      .select([
        'id',
        'first_name as firstName',
        'last_name as lastName',
        'display_name as displayName'
      ])
      .where('id', '=', terms.playerUserId)
      .executeTakeFirstOrThrow()
    const short = shortName(player)
    if (isGuardianRequest(request))
      return {
        title: `${sender} asks to be ${short}'s guardian`,
        description: `Approving lets them see ${short}'s teams and manage ${short}'s details.`
      }
    return {
      title: `Be a guardian of ${short}`,
      description:
        request.sender_scope_type == null
          ? `${sender} invited you to be ${short}'s guardian.`
          : `${sender} from ${organization} invited you to be ${short}'s guardian.`
    }
  }
  if (terms.kind === 'participation') {
    const team = await name({ kind: 'team', id: terms.teamId })
    const season = await name({ kind: 'season', id: terms.seasonId })
    const row = await db
      .selectFrom('seasons')
      .select('league_id')
      .where('id', '=', terms.seasonId)
      .executeTakeFirst()
    const league =
      row?.league_id == null
        ? ''
        : `, organized by ${await name({ kind: 'league', id: row.league_id })}`
    return {
      title: `${team} invited to ${season}`,
      description: `${sender} from ${organization} invited ${team} to ${season} (${terms.range.startsOn ?? 'no start date'} to ${terms.range.endsOn ?? 'no end date'})${league}. Competition membership does not share team permissions.`
    }
  }
  if (terms.kind === 'promotion') {
    const team = await name({ kind: 'team', id: terms.teamId })
    return {
      title: `Become administrator of ${team}`,
      description: `${sender} from ${organization} invited you to administer this placeholder team as a full TeamStation team. Existing games and identity are preserved.`
    }
  }
  const action =
    terms.preview.actions.find(action => action.operation === 'attach') ??
    terms.preview.actions[0]
  const child = await name(action.child)
  const parent = await name(action.parent)
  return {
    title: `${child} invited to ${parent}`,
    description: `${sender} from ${organization} requested a management parent relationship. This shares permissions and preserves competition memberships and every game. ${terms.preview.explanation.join(' ')}`
  }
}

/** A role as the inbox names it. */
const ROLE_WORDS: Record<Role, string> = {
  admin: 'Admin',
  coach: 'Coach',
  assistant: 'Assistant',
  scorekeeper: 'Scorekeeper',
  songkeeper: 'Songkeeper',
  videographer: 'Videographer'
}

/** `Coach`, `Coach and Scorekeeper`, `Admin, Coach and Scorekeeper`. */
export function roleList(roles: readonly Role[]): string {
  const words = roles.map(role => ROLE_WORDS[role])
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`
}

/**
 * What a grant's notification says: "Dana Lee added you as Coach of Owls",
 * or "Dana Lee added you to Owls" for a membership alone. Nothing waits for
 * an answer; the notification offers to leave instead.
 */
export function grantInformation(
  actorName: string,
  groupName: string,
  roles: readonly Role[]
): { title: string; description: string } {
  return {
    title:
      roles.length === 0
        ? `${actorName} added you to ${groupName}`
        : `${actorName} added you as ${roleList(roles)} of ${groupName}`,
    description: `You are a member of ${groupName} now. If you don't want to be, leave it here.`
  }
}

/** Freeze display meaning at send time; authority continues to use live IDs. */
export async function snapshotRequestInformation(
  db: Kysely<Database>,
  id: string
): Promise<void> {
  const request = await db
    .selectFrom('group_requests')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  const information = await titleAndDescription(db, request)
  await db
    .updateTable('notification_events')
    .set({
      metadata: sql`metadata || jsonb_build_object('requestTitle', ${information.title}::text, 'requestDescription', ${information.description}::text, 'gameClassificationIncluded', ${(request.terms as RequestTerms).kind === 'game'}::boolean)`
    })
    .where('source_type', '=', 'groupRequest')
    .where('source_id', '=', id)
    .execute()
}
