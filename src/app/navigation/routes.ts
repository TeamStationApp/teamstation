import { safeNext } from '../../common/signInReturn'
import { asUserId, userIdOfGumbo } from '../../common/userId'
import { chatBenchPath } from '../dev/chatBenchPath'

export { safeNext } from '../../common/signInReturn'
/**
 * Every screen has an address.
 *
 * The app was one URL: opening a game changed nothing you could copy, a
 * reload lost your place, and the browser's Back button left the app
 * altogether. The rule now is that **anything somebody could want to link to
 * is on the URL** — which screen, which tab, which filter, which video and
 * where in it — and nothing else is stored anywhere at all.
 *
 * Parsing and building live together so they cannot drift: a route that can be
 * read but not written is a Back button that goes somewhere else.
 */

export type When = 'upcoming' | 'past' | 'all'
type GroupKind = 'league' | 'season' | 'team'
interface GroupRef {
  kind: GroupKind
  id: string
}
interface SettingsContext {
  teamReturn?: { id: string; address: 'team' | 'group'; tab?: string }
}
export interface UmpireScheduleRoute {
  name: 'umpireSchedule'
  id: string
  pill?: 'schedule' | 'leaderboard'
  view?: 'umpire' | 'league'
  priorSeasons?: 'true'
  levels?: string
  days?: string
  from?: string
  to?: string
}
export type CreationRoute =
  | {
      name:
        | 'leagueUmpires'
        | 'umpireNoteTypes'
        | 'umpireTypes'
        | 'umpireLevels'
        | 'umpireRequirements'
      id: string
    }
  | { name: 'umpireRequirementEdit'; id: string; seasonIds: string[] }
  | UmpireScheduleRoute
  | ({ name: 'groupAddPeople'; kind: GroupKind; id: string } & SettingsContext)
  | ({ name: 'groupInvites'; kind: GroupKind; id: string } & SettingsContext)
  /** Team settings' Create Player. */
  | ({ name: 'teamCreatePlayer'; kind: 'team'; id: string } & SettingsContext)
  /** Team settings' Add Player: an existing player onto the roster. */
  | ({ name: 'teamAddPlayer'; kind: 'team'; id: string } & SettingsContext)
  | ({
      name: 'groupLocation'
      kind: 'team' | 'league'
      id: string
    } & SettingsContext)
  /** A season's date range, set from its settings. */
  | { name: 'seasonTimeFrame'; kind: 'season'; id: string }
  | { name: 'nodeAdministration' }
  | { name: 'createGame'; kind: 'team' | 'season'; id: string; gameId?: string }
  | { name: 'gameSettings'; gameId: string }
  | { name: 'promoteExternal'; id: string }
  /** With `follow`, each result can be followed from the list. */
  | { name: 'discover'; kind?: GroupKind; follow?: boolean }
  | { name: 'group'; kind: GroupKind; id: string; tab?: string; when?: When }
  | {
      name: 'groupSettings'
      kind: GroupKind
      id: string
      teamReturn?: { id: string; address: 'team' | 'group'; tab?: string }
    }
  | {
      name: 'createGroup'
      kind: GroupKind
      parent?: GroupRef
      custodian?: GroupRef
    }
  | {
      name: 'groupLink'
      kind: GroupKind
      id: string
      targetKind: GroupKind
      relationship: 'parent' | 'participation'
      direction: 'children' | 'parents'
    }
  | { name: 'notifications' }
  | { name: 'notification'; id: string }
  /** A league's Auto-Scheduler, and its Field Manager. */
  | { name: 'autoScheduler'; leagueId: string }
  | { name: 'fieldManager'; leagueId: string }
  /** One season of a league's next schedule. */
  | { name: 'scheduleSeason'; leagueId: string; seasonId: string }
  /** A preview of a league's schedule. */
  | { name: 'schedulePreview'; leagueId: string; previewId: string }
  /** A venue in the registry, or a Google place not yet in it. */
  | { name: 'venue'; venueId: string }
  | { name: 'venuePlace'; placeId: string }
  | { name: 'venueField'; venueId: string; fieldId: string }

export function isCreationRoute(route: {
  name: string
}): route is CreationRoute {
  return [
    'leagueUmpires',
    'umpireNoteTypes',
    'umpireTypes',
    'umpireLevels',
    'umpireRequirements',
    'umpireRequirementEdit',
    'umpireSchedule',
    'nodeAdministration',
    'discover',
    'group',
    'groupSettings',
    'groupLocation',
    'seasonTimeFrame',
    'groupAddPeople',
    'groupInvites',
    'teamCreatePlayer',
    'teamAddPlayer',
    'createGroup',
    'groupLink',
    'notifications',
    'notification',
    'promoteExternal',
    'createGame',
    'gameSettings',
    'autoScheduler',
    'fieldManager',
    'scheduleSeason',
    'schedulePreview',
    'venue',
    'venuePlace',
    'venueField'
  ].includes(route.name)
}
function groupKind(value: string | null | undefined): value is GroupKind {
  return value === 'league' || value === 'season' || value === 'team'
}

export type Route =
  | CreationRoute
  | { name: 'home' }
  | { name: 'oauthApprove'; uid: string }
  | { name: 'oauthNative'; handle: string }
  | { name: 'scoreGame'; gameId: string }
  | { name: 'scoreOptions'; gameId: string }
  /**
   * Coach Game: a head coach's own team in a game, its box score, roster,
   * lineup and defence, which he saves for it.
   */
  | { name: 'coachGame'; gameId: string; teamId: string }
  /** The game replayed in 3D, or followed live while it is scored. */
  | { name: 'gameReplay'; gameId: string }
  /**
   * DJ Game: both teams' batters and their walk-up songs, on a phone. The
   * web has no music to play, and shows the game instead.
   */
  | { name: 'djGame'; gameId: string }
  /**
   * The override dashboard of a game's scoreboard, for the people who run
   * the game.
   */
  | { name: 'scoreboardOverride'; gameId: string }
  | { name: 'videos'; when: When }
  | { name: 'schedule'; when: When }
  | { name: 'account' }
  | { name: 'teamStationTv'; token?: string }
  /** Create API key, from Account. */
  | { name: 'apiKeyNew' }
  | { name: 'team'; teamId: string; tab?: string }
  /**
   * One player, and what their Stats and Videos tabs are narrowed to.
   *
   * The filters are on the address like everything else, so a parent can send
   * somebody a link to one child's spring rather than to a career total. Each
   * tab has its own, written only beside that tab: `season`/`team`/`year`
   * beside `tab=stats`, `vseason`/`vteam`/`vyear` on Videos, the tab a bare
   * address opens on.
   *
   * `onTeam` is something else: the team the page was opened for — the roster
   * row or the box-score side that was tapped. It is on every tab, the filters
   * never change it, and it is what the Walk-up tab edits the player on, so
   * `walkup` is only a tab at all beside it. Settings edits that team's jersey
   * and positions beside it, and how they bat and throw without it; Teams
   * reads the same either way.
   */
  | {
      name: 'player'
      userId: string
      tab?: 'videos' | 'stats' | 'teams' | 'settings' | 'walkup'
      seasonId?: string
      teamId?: string
      year?: number
      videoSeasonId?: string
      videoTeamId?: string
      videoYear?: number
      onTeam?: string
    }
  | { name: 'season'; seasonId: string; tab?: string; when?: When }
  | { name: 'league'; leagueId: string }
  /**
   * Somebody on a team's, season's or league's people list, as that level
   * sees them: `/teams/:id/people/:userId` and the same for a season or a
   * league.
   */
  | {
      name: 'person'
      kind: 'league' | 'season' | 'team'
      id: string
      userId: string
    }
  | {
      name: 'game'
      gameId: string
      tab?: 'info' | 'boxScore' | 'watch' | 'score'
      videoId?: string
      /** Seconds into the video. The link somebody pastes into a group chat. */
      at?: number
      /**
       * The angles showing at once, in the order they are laid out.
       *
       * On the game's own address rather than a route of its own: the
       * multi-camera view is a state of the game screen, because this app
       * renders only the top of its stack and a separate route would unmount
       * the screen — and its player — on the way in. The order is the layout,
       * so a dragged arrangement is a link somebody can send.
       */
      angles?: string[]
      /** Which angle is heard. */
      audio?: string
      /** Which angle fills the picture. */
      zoom?: string
    }
  | { name: 'signIn'; next?: string }
  /**
   * An invite link, `/i/<code>`.
   *
   * The address PeerTube's invite links already use, kept exactly: the codes
   * on this site were handed out as `tube.gamestation.co/i/demo2026` and are
   * in mailboxes and team sheets that nobody can edit. A screen at the same
   * path is the only way those keep working: the old host now sends every
   * path to the same one on `app.teamstation.app`.
   */
  | { name: 'join'; code: string }
  /**
   * The link from the sign-in e-mail.
   *
   * Loading it does nothing on its own: the page comes up and the app spends
   * the token once it is running, which is what keeps a mail scanner — which
   * follows links and runs no scripts — from burning a sign-in before it is
   * read.
   *
   * `server` is the origin of the server that issued it, which a link mailed
   * to an app's own link host names: the app spends it only against that
   * server. Absent on the web, where the link is the server's own.
   */
  | { name: 'signInLink'; token: string; server?: string }
  | { name: 'chatBench' }
  /** Chat devices: this device's enrolment, the others, and link requests. */
  | { name: 'chatDevices' }
  /** Linking this device to the user's chat keys, or resetting them. */
  | { name: 'chatLink' }
  /** The Chat tab: every chat the person is in. */
  | { name: 'chat' }
  /** Starting a direct message. */
  | { name: 'chatNew' }
  /** One chat. Its id carries the `cnv_` prefix, so no chat is `new`. */
  | { name: 'conversation'; conversationId: string }
  /** A chat's members, safety numbers and approvals. */
  | { name: 'chatMembers'; conversationId: string }
  | { name: 'chatInfo'; conversationId: string }
  /** Reported chat messages, for site administrators. */
  | { name: 'chatReports' }

/** A sign-in link's route, with the issuing server only when the link names one. */
function signInLinkRoute(token: string, server: string | null): Route {
  return server == null || server === ''
    ? { name: 'signInLink', token }
    : { name: 'signInLink', token, server }
}

const WHENS = new Set<string>(['upcoming', 'past', 'all'])

function whenOf(raw: string | null, fallback: When): When {
  return raw != null && WHENS.has(raw) ? (raw as When) : fallback
}

/** A filter's year, or nothing for anything that is not one. */
function yearOf(raw: string | null): number | undefined {
  const year = Number(raw)
  return Number.isInteger(year) && year > 1900 ? year : undefined
}

/** Only the fields that are set, so a bare address reads back bare. */
function present<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

/**
 * `/teams/:id/people/:userId`, a person's profile from that team (or season,
 * or league). The page that used to be at `/teams/:id/manage` is gone: its
 * address opens the group's Settings, where adding people now is. Anything
 * else under a group opens the group.
 */
function personId(raw: string | undefined): string | undefined {
  try {
    if (raw != null && /^[1-9][0-9]*$/.test(raw))
      return userIdOfGumbo(Number(raw))
    return asUserId(raw)
  } catch {
    return undefined
  }
}

function peopleRoute(
  kind: 'league' | 'season' | 'team',
  id: string,
  parts: string[]
): Route {
  if (parts[2] === 'people') {
    const userId = personId(parts[3])
    return userId == null
      ? { name: 'home' }
      : { name: 'person', kind, id, userId }
  }
  if (parts[2] === 'manage') return { name: 'groupSettings', kind, id }
  if (kind === 'team') return { name: 'team', teamId: id }
  if (kind === 'season') return { name: 'season', seasonId: id }
  return { name: 'league', leagueId: id }
}

/** `/games/g1?video=v1&t=734` → the game, the video, and where in it. */
export function parseRoute(path: string, search = ''): Route {
  if (path === '/node') return { name: 'nodeAdministration' }
  const query = new URLSearchParams(search)
  const parts = path.split('/').filter(part => part !== '')
  if (parts.length === 0) return { name: 'home' }
  if (parts[0] === 'groups' && parts[1] === 'league' && parts[2] != null) {
    const id = decodeURIComponent(parts[2])
    if (parts[3] === 'umpires') return { name: 'leagueUmpires', id }
    if (parts[3] === 'umpire-note-types') return { name: 'umpireNoteTypes', id }
    if (parts[3] === 'umpire-types') return { name: 'umpireTypes', id }
    if (parts[3] === 'umpire-levels') return { name: 'umpireLevels', id }
    if (parts[3] === 'umpire-requirements')
      return parts[4] === 'edit'
        ? {
            name: 'umpireRequirementEdit',
            id,
            seasonIds: (query.get('seasons') ?? '').split(',').filter(Boolean)
          }
        : { name: 'umpireRequirements', id }
  }
  if (parts[0] === 'umpires') {
    const id = decodeURIComponent(parts[1] ?? '')
    return {
      name: 'umpireSchedule',
      id,
      pill: query.get('pill') === 'leaderboard' ? 'leaderboard' : 'schedule',
      view: query.get('view') === 'league' ? 'league' : 'umpire',
      ...(query.get('priorSeasons') === 'true'
        ? { priorSeasons: 'true' as const }
        : {}),
      ...Object.fromEntries(
        ['levels', 'days', 'from', 'to'].flatMap(key =>
          query.has(key) ? [[key, query.get(key)!]] : []
        )
      )
    }
  }

  const head = parts[0]
  const id = parts[1]
  switch (head) {
    case 'oauth':
      if (parts.length !== 3) return { name: 'home' }
      if (id === 'approve' && /^[A-Za-z0-9_-]{1,128}$/.test(parts[2]))
        return { name: 'oauthApprove', uid: parts[2] }
      if (id === 'native-approval' && /^[A-Za-z0-9_-]{43}$/.test(parts[2]))
        return { name: 'oauthNative', handle: parts[2] }
      return { name: 'home' }
    case 'discover': {
      const kind = query.get('kind')
      return {
        name: 'discover',
        ...(groupKind(kind) ? { kind } : {}),
        ...(query.get('follow') === '1' ? { follow: true } : {})
      }
    }
    case 'notifications':
      return id == null
        ? { name: 'notifications' }
        : { name: 'notification', id: decodeURIComponent(id) }
    case 'create': {
      if (!groupKind(id)) return { name: 'home' }
      const parentKind = query.get('parentKind')
      const parentId = query.get('parentId')
      const custodianKind = query.get('custodianKind')
      const custodianId = query.get('custodianId')
      return {
        name: 'createGroup',
        kind: id,
        ...(groupKind(parentKind) && parentId != null
          ? { parent: { kind: parentKind, id: parentId } }
          : {}),
        ...(id === 'team' && groupKind(custodianKind) && custodianId != null
          ? { custodian: { kind: custodianKind, id: custodianId } }
          : {})
      }
    }
    case 'groups': {
      if (!groupKind(id) || parts[2] == null) return { name: 'home' }
      const groupId = decodeURIComponent(parts[2])
      if (parts[3] === 'settings') {
        const teamId = query.get('teamId')
        const address = query.get('teamAddress')
        const tab = query.get('teamTab')
        const context: SettingsContext = {
          ...(id === 'team' &&
          teamId != null &&
          teamId !== '' &&
          (address === 'team' || address === 'group')
            ? {
                teamReturn: {
                  id: teamId,
                  address,
                  ...(tab == null ? {} : { tab })
                }
              }
            : {})
        }
        if (parts[4] === 'people')
          return { name: 'groupAddPeople', kind: id, id: groupId, ...context }
        if (parts[4] === 'invites')
          return { name: 'groupInvites', kind: id, id: groupId, ...context }
        if (parts[4] === 'create-player' && id === 'team')
          return { name: 'teamCreatePlayer', kind: id, id: groupId, ...context }
        if (parts[4] === 'add-player' && id === 'team')
          return { name: 'teamAddPlayer', kind: id, id: groupId, ...context }
        if (parts[4] === 'location' && id !== 'season')
          return { name: 'groupLocation', kind: id, id: groupId, ...context }
        if (parts[4] === 'time-frame' && id === 'season')
          return { name: 'seasonTimeFrame', kind: 'season', id: groupId }
        return { name: 'groupSettings', kind: id, id: groupId, ...context }
      }
      if (parts[3] === 'scheduler' && id === 'league')
        return parts[4] === 'fields'
          ? { name: 'fieldManager', leagueId: groupId }
          : parts[4] === 'seasons' && parts[5] != null && parts[5] !== ''
            ? {
                name: 'scheduleSeason',
                leagueId: groupId,
                seasonId: decodeURIComponent(parts[5])
              }
            : parts[4] === 'previews' && parts[5] != null && parts[5] !== ''
              ? {
                  name: 'schedulePreview',
                  leagueId: groupId,
                  previewId: decodeURIComponent(parts[5])
                }
              : { name: 'autoScheduler', leagueId: groupId }
      if (parts[3] === 'invite-administrator' && id === 'team')
        return { name: 'promoteExternal', id: groupId }
      if (parts[3] === 'create-game' && id !== 'league')
        return {
          name: 'createGame',
          kind: id,
          id: groupId,
          ...(query.get('game') == null ? {} : { gameId: query.get('game')! })
        }
      if (parts[3] === 'link') {
        const targetKind = query.get('target')
        if (!groupKind(targetKind))
          return { name: 'group', kind: id, id: groupId }
        return {
          name: 'groupLink',
          kind: id,
          id: groupId,
          targetKind,
          relationship:
            query.get('relationship') === 'participation'
              ? 'participation'
              : 'parent',
          direction:
            query.get('direction') === 'parents' ? 'parents' : 'children'
        }
      }
      return {
        name: 'group',
        kind: id,
        id: groupId,
        ...(query.get('tab') == null ? {} : { tab: query.get('tab')! }),
        ...(query.get('when') == null
          ? {}
          : { when: whenOf(query.get('when'), 'past') })
      }
    }
    case 'videos':
      return { name: 'videos', when: whenOf(query.get('when'), 'past') }
    case 'schedule':
      // Upcoming: a schedule is the question of what is still to come. An
      // address that names past or all still opens on that filter.
      return { name: 'schedule', when: whenOf(query.get('when'), 'upcoming') }
    case 'tv-login': {
      const token = query.get('token')
      return token != null && /^[A-Za-z0-9_-]{43}$/.test(token)
        ? { name: 'teamStationTv', token }
        : { name: 'teamStationTv' }
    }
    case 'account':
      if (parts[1] === 'tv') return { name: 'teamStationTv' }
      if (parts[1] === 'api-keys' && parts[2] === 'new' && parts.length === 3)
        return { name: 'apiKeyNew' }
      return { name: 'account' }
    case 'sign-in':
      return { name: 'signIn', next: safeNext(query.get('next')) }
    case 'i':
      if (id == null) return { name: 'home' }
      return { name: 'join', code: id }
    case 'video-channels':
    case 'c':
      // PeerTube's longer form, `/c/invite/<code>`, which its own sign-in and
      // registration screens redirected through. Read, never written: one
      // address is enough to hand out.
      if (parts[1] !== 'invite' || parts[2] == null) return { name: 'home' }
      return { name: 'join', code: parts[2] }
    case 'signin':
      if (id == null) return { name: 'signIn' }
      return signInLinkRoute(id, query.get('server'))
    case 'players': {
      const userId = personId(id)
      if (userId == null) return { name: 'home' }
      const onTeam = query.get('onTeam') ?? undefined
      const asked = query.get('tab')
      // Walk-up edits the player's song on the team the page was opened for,
      // so without one there is nothing for it to edit, and the page opens on
      // its first tab instead. Settings and Teams mean something either way.
      const tab =
        asked === 'stats' || asked === 'teams' || asked === 'settings'
          ? asked
          : asked === 'walkup' && onTeam != null
            ? asked
            : 'videos'
      const on = onTeam == null ? {} : { onTeam }
      if (tab === 'videos') {
        return {
          name: 'player',
          userId,
          ...present({
            videoSeasonId: query.get('vseason') ?? undefined,
            videoTeamId: query.get('vteam') ?? undefined,
            videoYear: yearOf(query.get('vyear'))
          }),
          ...on
        }
      }
      if (tab !== 'stats') return { name: 'player', userId, tab, ...on }
      return {
        name: 'player',
        userId,
        tab,
        seasonId: query.get('season') ?? undefined,
        teamId: query.get('team') ?? undefined,
        year: yearOf(query.get('year')),
        ...on
      }
    }
    case 'teams':
      if (id == null) return { name: 'home' }
      if (parts[2] != null) return peopleRoute('team', id, parts)
      return { name: 'team', teamId: id, tab: query.get('tab') ?? undefined }
    case 'seasons':
      if (id == null) return { name: 'home' }
      if (parts[2] != null) return peopleRoute('season', id, parts)
      return {
        name: 'season',
        seasonId: id,
        tab: query.get('tab') ?? undefined,
        when:
          query.get('when') == null
            ? undefined
            : whenOf(query.get('when'), 'past')
      }
    case 'venues':
      if (id == null) return { name: 'home' }
      if (id === 'place')
        return parts[2] == null
          ? { name: 'home' }
          : { name: 'venuePlace', placeId: decodeURIComponent(parts[2]) }
      if (parts[2] === 'fields' && parts[3] != null)
        return {
          name: 'venueField',
          venueId: decodeURIComponent(id),
          fieldId: decodeURIComponent(parts[3])
        }
      return { name: 'venue', venueId: decodeURIComponent(id) }
    case 'leagues':
      if (id == null) return { name: 'home' }
      if (parts[2] != null) return peopleRoute('league', id, parts)
      return { name: 'league', leagueId: id }
    case 'games': {
      if (id == null) return { name: 'home' }
      if (parts[2] === 'settings')
        return { name: 'gameSettings', gameId: decodeURIComponent(id) }
      if (parts[2] === 'score') return { name: 'scoreGame', gameId: id }
      if (parts[2] === 'replay') return { name: 'gameReplay', gameId: id }
      if (parts[2] === 'dj') return { name: 'djGame', gameId: id }
      if (parts[2] === 'coach' && parts[3] != null)
        return { name: 'coachGame', gameId: id, teamId: parts[3] }
      // Keep existing scoring-choice links opening the standalone page.
      if (
        parts[2] === 'score-game' ||
        (parts[2] == null && query.get('tab') === 'score')
      ) {
        return { name: 'scoreOptions', gameId: id }
      }
      if (parts[2] === 'scoreboard-override') {
        return { name: 'scoreboardOverride', gameId: id }
      }
      const at = Number(query.get('t'))
      // Empty entries dropped, and capped at four: the address is somewhere
      // anybody can type, and the view draws four tiles at most.
      const angles = (query.get('angles') ?? '')
        .split(',')
        .map(one => one.trim())
        .filter(one => one !== '')
        .slice(0, 4)
      const audio = query.get('audio')
      const zoom = query.get('zoom')
      // Spread rather than a key set to `undefined`: a game address with no
      // angles on it parses to exactly what it always did, key for key.
      return {
        name: 'game',
        gameId: id,
        tab:
          query.get('tab') === 'boxScore'
            ? 'boxScore'
            : query.get('tab') === 'score'
              ? 'score'
              : query.get('tab') === 'info'
                ? 'info'
                : query.get('tab') === 'watch' ||
                    query.has('video') ||
                    query.has('t') ||
                    angles.length > 0
                  ? 'watch'
                  : undefined,
        videoId: query.get('video') ?? undefined,
        at: Number.isFinite(at) && at > 0 ? at : undefined,
        ...(angles.length > 0 ? { angles } : {}),
        ...(angles.length > 0 && audio != null ? { audio } : {}),
        ...(angles.length > 0 && zoom != null ? { zoom } : {})
      }
    }
    case 'chat':
      if (id == null) return { name: 'chat' }
      if ((parts[2] === 'members' || parts[2] === 'info') && parts[3] == null) {
        if (id === 'devices' || id === 'link' || id === 'new') {
          return { name: 'home' }
        }
        return parts[2] === 'info'
          ? { name: 'chatInfo', conversationId: id }
          : { name: 'chatMembers', conversationId: id }
      }
      if (parts[2] != null) return { name: 'home' }
      if (id === 'devices') return { name: 'chatDevices' }
      if (id === 'link') return { name: 'chatLink' }
      if (id === 'new') return { name: 'chatNew' }
      return { name: 'conversation', conversationId: id }
    case 'admin':
      return id === 'chat' && parts[2] === 'reports' && parts[3] == null
        ? { name: 'chatReports' }
        : { name: 'home' }
    case 'dev':
      return parseDevRoute(parts)
    default:
      return { name: 'home' }
  }
}

/**
 * `/dev/…`: the bench where the build has one, and home otherwise. The path
 * comes from the build's `chatBenchPath` twin, so the web bundle does not even
 * hold it, and the routes never import the bench.
 */
export function parseDevRoute(
  parts: string[],
  benchPath: string | undefined = chatBenchPath
): Route {
  return benchPath != null && `/${parts.join('/')}` === benchPath
    ? { name: 'chatBench' }
    : { name: 'home' }
}

/** The address of a route, ready for the history. */
function settingsChildPath(
  route: { kind: GroupKind; id: string } & SettingsContext,
  child: string
): string {
  const path = routePath({
    name: 'groupSettings',
    kind: route.kind,
    id: route.id,
    teamReturn: route.teamReturn
  })
  const [base, query] = path.split('?')
  return `${base}/${child}${query == null ? '' : '?' + query}`
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'leagueUmpires':
      return `/groups/league/${encodeURIComponent(route.id)}/umpires`
    case 'umpireNoteTypes':
      return `/groups/league/${encodeURIComponent(route.id)}/umpire-note-types`
    case 'umpireTypes':
      return `/groups/league/${encodeURIComponent(route.id)}/umpire-types`
    case 'umpireLevels':
      return `/groups/league/${encodeURIComponent(route.id)}/umpire-levels`
    case 'umpireRequirements':
      return `/groups/league/${encodeURIComponent(route.id)}/umpire-requirements`
    case 'umpireRequirementEdit':
      return `/groups/league/${encodeURIComponent(route.id)}/umpire-requirements/edit?seasons=${encodeURIComponent(route.seasonIds.join(','))}`
    case 'umpireSchedule': {
      const query = new URLSearchParams()
      for (const key of [
        'pill',
        'view',
        'priorSeasons',
        'levels',
        'days',
        'from',
        'to'
      ] as const)
        if (route[key] != null) query.set(key, route[key])
      return `/umpires/${encodeURIComponent(route.id)}${query.size === 0 ? '' : '?' + query.toString()}`
    }

    case 'oauthApprove':
      return `/oauth/approve/${route.uid}`
    case 'oauthNative':
      return `/oauth/native-approval/${route.handle}`
    case 'nodeAdministration':
      return '/node'
    case 'createGame':
      return `/groups/${route.kind}/${encodeURIComponent(route.id)}/create-game${route.gameId == null ? '' : '?game=' + encodeURIComponent(route.gameId)}`
    case 'gameSettings':
      return `/games/${encodeURIComponent(route.gameId)}/settings`
    case 'promoteExternal':
      return `/groups/team/${encodeURIComponent(route.id)}/invite-administrator`
    case 'discover': {
      const query = new URLSearchParams()
      if (route.kind != null) query.set('kind', route.kind)
      if (route.follow === true) query.set('follow', '1')
      const search = query.toString()
      return search === '' ? '/discover' : `/discover?${search}`
    }
    case 'notifications':
      return '/notifications'
    case 'notification':
      return `/notifications/${encodeURIComponent(route.id)}`
    case 'group': {
      const query = new URLSearchParams()
      if (route.tab != null) query.set('tab', route.tab)
      if (route.when != null) query.set('when', route.when)
      return `/groups/${route.kind}/${encodeURIComponent(route.id)}${query.size === 0 ? '' : '?' + query.toString()}`
    }
    case 'groupSettings': {
      const query = new URLSearchParams()
      if (route.kind === 'team' && route.teamReturn != null) {
        query.set('teamId', route.teamReturn.id)
        query.set('teamAddress', route.teamReturn.address)
        if (route.teamReturn.tab != null)
          query.set('teamTab', route.teamReturn.tab)
      }
      return `/groups/${route.kind}/${encodeURIComponent(route.id)}/settings${query.size === 0 ? '' : '?' + query.toString()}`
    }
    case 'groupAddPeople':
      return settingsChildPath(route, 'people')
    case 'groupInvites':
      return settingsChildPath(route, 'invites')
    case 'teamCreatePlayer':
      return settingsChildPath(route, 'create-player')
    case 'teamAddPlayer':
      return settingsChildPath(route, 'add-player')
    case 'groupLocation':
      return settingsChildPath(route, 'location')
    case 'seasonTimeFrame':
      return settingsChildPath(route, 'time-frame')
    case 'autoScheduler':
      return `/groups/league/${encodeURIComponent(route.leagueId)}/scheduler`
    case 'fieldManager':
      return `/groups/league/${encodeURIComponent(route.leagueId)}/scheduler/fields`
    case 'scheduleSeason':
      return `/groups/league/${encodeURIComponent(route.leagueId)}/scheduler/seasons/${encodeURIComponent(route.seasonId)}`
    case 'schedulePreview':
      return `/groups/league/${encodeURIComponent(route.leagueId)}/scheduler/previews/${encodeURIComponent(route.previewId)}`
    case 'venue':
      return `/venues/${encodeURIComponent(route.venueId)}`
    case 'venuePlace':
      return `/venues/place/${encodeURIComponent(route.placeId)}`
    case 'venueField':
      return `/venues/${encodeURIComponent(route.venueId)}/fields/${encodeURIComponent(route.fieldId)}`
    case 'groupLink':
      return `/groups/${route.kind}/${encodeURIComponent(route.id)}/link?target=${route.targetKind}&relationship=${route.relationship}&direction=${route.direction}`
    case 'createGroup': {
      const query = new URLSearchParams()
      if (route.parent != null) {
        query.set('parentKind', route.parent.kind)
        query.set('parentId', route.parent.id)
      }
      if (route.custodian != null) {
        query.set('custodianKind', route.custodian.kind)
        query.set('custodianId', route.custodian.id)
      }
      return `/create/${route.kind}${query.size === 0 ? '' : '?' + query.toString()}`
    }
    case 'home':
      return '/'
    case 'scoreGame':
      return `/games/${route.gameId}/score`
    case 'scoreOptions':
      return `/games/${route.gameId}/score-game`
    case 'gameReplay':
      return `/games/${route.gameId}/replay`
    case 'djGame':
      return `/games/${route.gameId}/dj`
    case 'coachGame':
      return `/games/${route.gameId}/coach/${route.teamId}`
    case 'scoreboardOverride':
      return `/games/${route.gameId}/scoreboard-override`
    case 'videos':
      return route.when === 'past' ? '/videos' : `/videos?when=${route.when}`
    case 'schedule':
      return route.when === 'upcoming'
        ? '/schedule'
        : `/schedule?when=${route.when}`
    case 'teamStationTv':
      return route.token == null
        ? '/account/tv'
        : `/tv-login?token=${encodeURIComponent(route.token)}`
    case 'account':
      return '/account'
    case 'apiKeyNew':
      return '/account/api-keys/new'
    case 'signInLink':
      return route.server == null
        ? `/signin/${route.token}`
        : `/signin/${route.token}?server=${encodeURIComponent(route.server)}`
    case 'team':
      return route.tab == null || route.tab === 'videos'
        ? `/teams/${route.teamId}`
        : `/teams/${route.teamId}?tab=${route.tab}`
    case 'season': {
      // Only what is not the default, the same rule `/videos` follows. The
      // season page used to write `?when=past` where the schedule wrote
      // nothing, which is two answers to one question.
      const bits: string[] = []
      if (route.tab != null) {
        bits.push(`tab=${route.tab}`)
      }
      if (route.when != null && route.when !== 'past') {
        bits.push(`when=${route.when}`)
      }
      return bits.length === 0
        ? `/seasons/${route.seasonId}`
        : `/seasons/${route.seasonId}?${bits.join('&')}`
    }
    case 'player': {
      // Videos is the tab a bare address opens on. Each tab's filter is
      // written only beside that tab, where it is read; the team the page was
      // opened for is written on every tab.
      const query = new URLSearchParams()
      if (route.tab == null || route.tab === 'videos') {
        if (route.videoSeasonId != null) {
          query.set('vseason', route.videoSeasonId)
        }
        if (route.videoTeamId != null) query.set('vteam', route.videoTeamId)
        if (route.videoYear != null) query.set('vyear', String(route.videoYear))
      } else if (route.tab === 'stats') {
        query.set('tab', 'stats')
        if (route.seasonId != null) query.set('season', route.seasonId)
        if (route.teamId != null) query.set('team', route.teamId)
        if (route.year != null) query.set('year', String(route.year))
      } else if (route.tab !== 'walkup' || route.onTeam != null) {
        query.set('tab', route.tab)
      }
      if (route.onTeam != null) query.set('onTeam', route.onTeam)
      const text = query.toString()
      return text === ''
        ? `/players/${route.userId}`
        : `/players/${route.userId}?${text}`
    }
    case 'league':
      return `/leagues/${route.leagueId}`
    case 'person':
      return `/${route.kind}s/${route.id}/people/${route.userId}`
    case 'game': {
      if (route.tab === 'score') return `/games/${route.gameId}/score-game`
      const query = new URLSearchParams()
      if (
        route.tab != null &&
        (route.tab !== 'watch' ||
          (route.videoId == null &&
            route.at == null &&
            (route.angles?.length ?? 0) === 0))
      )
        query.set('tab', route.tab)
      if (route.videoId != null) query.set('video', route.videoId)
      if (route.at != null) query.set('t', String(Math.round(route.at)))
      if (route.angles != null && route.angles.length > 0) {
        query.set('angles', route.angles.join(','))
        if (route.audio != null) query.set('audio', route.audio)
        if (route.zoom != null) query.set('zoom', route.zoom)
      }
      const text = query.toString()
      return text === ''
        ? `/games/${route.gameId}`
        : `/games/${route.gameId}?${text}`
    }
    case 'join':
      return `/i/${route.code}`
    case 'chatBench':
      return chatBenchPath ?? '/'
    case 'chatDevices':
      return '/chat/devices'
    case 'chatLink':
      return '/chat/link'
    case 'chat':
      return '/chat'
    case 'chatNew':
      return '/chat/new'
    case 'conversation':
      return `/chat/${encodeURIComponent(route.conversationId)}`
    case 'chatInfo':
      return `/chat/${encodeURIComponent(route.conversationId)}/info`
    case 'chatMembers':
      return `/chat/${encodeURIComponent(route.conversationId)}/members`
    case 'chatReports':
      return '/admin/chat/reports'
    case 'signIn':
      return route.next == null
        ? '/sign-in'
        : `/sign-in?next=${encodeURIComponent(route.next)}`
  }
}
