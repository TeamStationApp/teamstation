import { type Kysely, sql } from 'kysely'

import type { GameRequestTerms } from '../../common/gameApprovals'
import type { GroupRef } from '../../common/groupCreation'
import { shortName } from '../../common/names'
import type { RequestTerms } from '../../common/notifications'
import type { Role } from '../../common/roles'
import type { Database } from '../db/database'
import { isGuardianRequest } from '../groups/guardianLimits'
import type { StoredRequest } from '../groups/requests'
import { userNames } from '../users/nameBook'

/**
 * The group names and season time zones a request's text read when it was
 * sent, frozen so a later rename does not change what was asked: groups by
 * `<kind>:<id>`, zones by season id. People are never frozen; their names are
 * read from `users`.
 */
export interface FrozenNames {
  groups: Record<string, string>
  zones: Record<string, string>
}

/** How a request's text reads the groups and zones it names. */
interface Lookups {
  group: (ref: GroupRef) => Promise<string>
  zone: (seasonId: string) => Promise<string>
}

/** A group's name and a season's zone as they stand now. */
function liveLookups(db: Kysely<Database>): Lookups {
  return {
    group: async ref =>
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
      )?.name ?? 'Unavailable group',
    zone: async seasonId =>
      (
        await db
          .selectFrom('seasons')
          .select('timezone')
          .where('id', '=', seasonId)
          .executeTakeFirst()
      )?.timezone ?? 'UTC'
  }
}

/** The frozen names first, and the live ones for what was not frozen. */
function frozenLookups(
  db: Kysely<Database>,
  frozen: Partial<FrozenNames> | undefined
): Lookups {
  const live = liveLookups(db)
  return {
    group: async ref =>
      frozen?.groups?.[`${ref.kind}:${ref.id}`] ?? (await live.group(ref)),
    zone: async seasonId =>
      frozen?.zones?.[seasonId] ?? (await live.zone(seasonId))
  }
}

/** Live lookups that keep every answer they gave, to freeze. */
function recordingLookups(db: Kysely<Database>): {
  lookups: Lookups
  frozen: FrozenNames
} {
  const live = liveLookups(db)
  const frozen: FrozenNames = { groups: {}, zones: {} }
  return {
    frozen,
    lookups: {
      group: async ref =>
        (frozen.groups[`${ref.kind}:${ref.id}`] = await live.group(ref)),
      zone: async seasonId =>
        (frozen.zones[seasonId] = await live.zone(seasonId))
    }
  }
}

function eventDetails(terms: GameRequestTerms): string {
  const { game, previous } = terms
  let details = ''
  if (Object.hasOwn(game, 'notes') || Object.hasOwn(previous ?? {}, 'notes')) {
    const proposed = Object.hasOwn(game, 'notes') ? game.notes : previous?.notes
    const cleared =
      Object.hasOwn(game, 'notes') &&
      proposed == null &&
      previous?.notes != null
    details += `\nProposed notes: ${proposed ?? 'Not set'}${cleared ? ' (cleared)' : ''}.`
    if (previous != null)
      details += `\nPrevious notes: ${previous.notes ?? 'Not set'}.`
  }
  if (
    Object.hasOwn(game, 'arrivalTimeDelta') ||
    Object.hasOwn(previous ?? {}, 'arrivalTimeDelta')
  ) {
    const proposed = Object.hasOwn(game, 'arrivalTimeDelta')
      ? game.arrivalTimeDelta
      : previous?.arrivalTimeDelta
    const arrival = (minutes?: number | null): string =>
      minutes == null
        ? 'Not set'
        : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} before start`
    const cleared =
      Object.hasOwn(game, 'arrivalTimeDelta') &&
      proposed == null &&
      previous?.arrivalTimeDelta != null
    details += `\nProposed arrival: ${arrival(proposed)}${cleared ? ' (cleared)' : ''}.`
    if (previous != null)
      details += `\nPrevious arrival: ${arrival(previous.arrivalTimeDelta)}.`
  }
  return details
}

async function scheduleDetails(
  lookups: Lookups,
  terms: GameRequestTerms
): Promise<string> {
  const { game, previous } = terms
  let details = ''
  if (
    Object.hasOwn(game, 'address') ||
    Object.hasOwn(previous ?? {}, 'address')
  ) {
    const proposed = Object.hasOwn(game, 'address')
      ? game.address
      : previous?.address
    const cleared =
      Object.hasOwn(game, 'address') &&
      proposed == null &&
      previous?.address != null
    details += `\nProposed address: ${proposed ?? 'Not set'}${cleared ? ' (cleared)' : ''}.`
    if (previous != null)
      details += `\nPrevious address: ${previous.address ?? 'Not set'}.`
  }
  if (Object.hasOwn(game, 'endAt') || Object.hasOwn(previous ?? {}, 'endAt')) {
    const end = async (
      intent: GameRequestTerms['game'],
      value?: string | null
    ): Promise<string> => {
      if (value == null) return 'Not set (defaults to three hours after start)'
      const zone =
        intent.timezone ??
        (intent.seasonId == null ? 'UTC' : await lookups.zone(intent.seasonId))
      return `${new Intl.DateTimeFormat('en', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))} (${zone})`
    }
    const proposed = Object.hasOwn(game, 'endAt') ? game.endAt : previous?.endAt
    const cleared =
      Object.hasOwn(game, 'endAt') &&
      proposed == null &&
      previous?.endAt != null
    details += `\nProposed end: ${await end(game, proposed)}${cleared ? ' (cleared)' : ''}.`
    if (previous != null)
      details += `\nPrevious end: ${await end(previous, previous.endAt)}.`
  }
  return details
}

/** What a request's notification metadata holds. */
interface RequestMetadata {
  senderGroupName?: string
  frozen?: Partial<FrozenNames>
}

/**
 * A request's title and description, rendered from its terms: the sender's
 * name and the player's are read from `users` now, and the group names and
 * zones are the ones frozen when it was sent (live for any not frozen).
 * `senders` holds the live names a page of requests read for its senders at
 * once (`userNames`); a sender it lacks is read here.
 */
export async function titleAndDescription(
  db: Kysely<Database>,
  request: StoredRequest,
  senders?: ReadonlyMap<string, string>
): Promise<{ title: string; description: string }> {
  const event = await db
    .selectFrom('notification_events')
    .select('metadata')
    .where('source_type', '=', 'groupRequest')
    .where('source_id', '=', request.id)
    .executeTakeFirst()
  const metadata = event?.metadata as RequestMetadata | undefined
  const sender = (
    senders?.has(request.sender_id) === true
      ? senders
      : await userNames(db, [request.sender_id])
  ).get(request.sender_id)
  return await rendered(db, request, {
    sender: sender == null || sender === '' ? 'An administrator' : sender,
    organization: metadata?.senderGroupName ?? 'their organization',
    lookups: frozenLookups(db, metadata?.frozen)
  })
}

/** A request's words, with its sender named and its groups and zones looked up. */
async function rendered(
  db: Kysely<Database>,
  request: StoredRequest,
  words: { sender: string; organization: string; lookups: Lookups }
): Promise<{ title: string; description: string }> {
  const { sender, organization, lookups } = words
  const terms = request.terms as RequestTerms
  const exhibition = (value?: boolean): string =>
    `Exhibition: ${value === true ? 'On' : 'Off'}`
  const name = lookups.group
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
        timezone ?? (seasonId == null ? 'UTC' : await lookups.zone(seasonId))
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
      description: `${sender} from ${organization} proposed ${away} at ${home} ${competition}, ${await when(terms.game.startAt, terms.game.seasonId, terms.game.timezone)}${terms.game.venue == null ? '' : ' at ' + terms.game.venue}, ${terms.game.status}, ${exhibition(terms.game.exhibition)}.${prior} This changes neither management parents nor season participation.${eventDetails(terms)}${await scheduleDetails(lookups, terms)}`
    }
  }
  if (terms.kind === 'membership') {
    const team = await name({ kind: 'team', id: terms.teamId })
    return {
      title: `${sender} requests membership in ${team}`,
      description: `Approving gives ${sender} member access to ${team}, including game videos. It does not grant staff roles.`
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

/**
 * The group names and season zones a request's text reads now: what
 * `snapshotRequestInformation` freezes when it is sent.
 */
export async function frozenNamesOf(
  db: Kysely<Database>,
  request: StoredRequest
): Promise<FrozenNames> {
  const { lookups, frozen } = recordingLookups(db)
  await rendered(db, request, { sender: '', organization: '', lookups })
  return frozen
}

/**
 * Freezes the group names and zones a request's text reads, at send time, so
 * a later rename of a group does not change what was asked. Authority keeps
 * reading live ids, and people's names are read from `users` when it is read.
 */
export async function snapshotRequestInformation(
  db: Kysely<Database>,
  id: string
): Promise<void> {
  const request = await db
    .selectFrom('group_requests')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  const frozen = await frozenNamesOf(db, request)
  await db
    .updateTable('notification_events')
    .set({
      metadata: sql`metadata || jsonb_build_object('frozen', ${JSON.stringify(frozen)}::jsonb)`
    })
    .where('source_type', '=', 'groupRequest')
    .where('source_id', '=', id)
    .execute()
}
