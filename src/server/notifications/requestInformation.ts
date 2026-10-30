import { type Kysely, sql } from 'kysely'

import type { GameRequestTerms } from '../../common/gameApprovals'
import type { GroupRef } from '../../common/groupCreation'
import type { PlayerAddTerms, RequestTerms } from '../../common/notifications'
import type { Role } from '../../common/roles'
import type { Database } from '../db/database'
import { isGuardianRequest } from '../groups/guardianLimits'
import { publicNames } from '../groups/playerNamePrivacy'
import type { StoredRequest } from '../groups/requests'
import { shortNamesOf, userNames } from '../users/nameBook'

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
  /**
   * A player add told to a coach standing in for a player with no guardian,
   * which its words say.
   */
  standIn?: boolean
  /** A player add made at once with a notice, rather than asked. */
  madeAtOnce?: boolean
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
  const named = sender == null || sender === '' ? 'An administrator' : sender
  // Not an invitation, so not among `RequestTerms`.
  if ((request.terms as { kind?: string }).kind === 'playerAdd')
    return playerAddWords(
      request.terms as PlayerAddTerms,
      named,
      await shortNamesOf(db, [(request.terms as PlayerAddTerms).userId]),
      metadata,
      await gameDay(db, request.terms as PlayerAddTerms)
    )
  return await rendered(db, request, {
    sender: named,
    organization: metadata?.senderGroupName ?? 'their organization',
    lookups: frozenLookups(db, metadata?.frozen)
  })
}

/** `Oct 30`, the game's own day where it is played. */
export function shortDate(at: Date, timeZone: string): string {
  const options = { month: 'short', day: 'numeric' } as const
  try {
    return at.toLocaleDateString('en-US', { ...options, timeZone })
  } catch {
    // A zone the runtime does not know: the day in UTC.
    return at.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' })
  }
}

/** The day of a pool add's game, `Oct 30`, or null when it has none. */
async function gameDay(
  db: Kysely<Database>,
  terms: PlayerAddTerms
): Promise<string | null> {
  if (terms.mode !== 'pool' || terms.gameId == null) return null
  const game = await db
    .selectFrom('games')
    .select(['start_at', 'timezone'])
    .where('id', '=', terms.gameId)
    .executeTakeFirst()
  return game?.start_at == null ? null : shortDate(game.start_at, game.timezone)
}

/**
 * A player add's words, the player named as they are now. An add made with a
 * notice says only what stays true for as long as the card is kept; whether
 * a Reject still holds is the card's own line.
 */
function playerAddWords(
  terms: PlayerAddTerms,
  sender: string,
  players: ReadonlyMap<string, string>,
  metadata: RequestMetadata | undefined,
  day: string | null
): { title: string; description: string } {
  const short = players.get(terms.userId) ?? ''
  const where =
    terms.mode !== 'pool'
      ? terms.teamName
      : day == null
        ? `${terms.teamName} for one game`
        : `${terms.teamName} for the game on ${day}`
  const because =
    metadata?.standIn === true
      ? ` You're receiving this because ${short} has no guardian on TeamStation.`
      : ''
  return metadata?.madeAtOnce === true
    ? {
        title: `${sender} added ${short} to ${where}`,
        description: `${short} was added ${terms.mode === 'pool' ? 'to play for' : 'to the roster of'} ${terms.teamName}.${because}`
      }
    : {
        title: `${sender} asks to add ${short} to ${where}`,
        description: `${short} joins ${terms.teamName} only if you accept.${because}`
      }
}

/** Who took a player off a roster they were added to. */
export type PlayerRemover = 'self' | 'guardian' | 'coach'

/** What a `playerAddRejected` notice keeps: ids and counts, no person's name. */
export interface PlayerRemovedMetadata {
  teamId: string
  /** The player taken off. */
  userId: string
  teamName: string
  mode: PlayerAddTerms['mode']
  /** Games already played that now read a placeholder for them. */
  games: number
  remover: PlayerRemover
}

const REMOVED_BY: Record<PlayerRemover, string> = {
  self: 'They removed themselves',
  guardian: 'A guardian removed',
  coach: 'A coach of another of their teams removed'
}

/**
 * The words of the notice a team's roster managers get when a player's side
 * rejected an add, `short` the player's short name as it is now.
 */
export function playerRemovedWords(
  metadata: PlayerRemovedMetadata,
  short: string
): { title: string; description: string } {
  const where =
    metadata.mode === 'pool' ? `${metadata.teamName}'s game` : metadata.teamName
  const { games } = metadata
  return {
    title: `${REMOVED_BY[metadata.remover]} ${short} from ${where}`,
    description:
      games === 0
        ? `${short} is no longer on it.`
        : `${short} is no longer on it. ${games === 1 ? 'One game' : `${games} games`} already played now ${games === 1 ? 'reads' : 'read'} a placeholder in their place.`
  }
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
    const short = (
      await publicNames(db, [
        {
          person: player,
          teamId:
            request.sender_scope_type === 'team'
              ? request.sender_scope_id
              : undefined
        }
      ])
    ).get(player.id)!
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
