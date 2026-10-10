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
export type CreationRoute =
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

export function isCreationRoute(route: {
  name: string
}): route is CreationRoute {
  return [
    'nodeAdministration',
    'discover',
    'group',
    'groupSettings',
    'createGroup',
    'groupLink',
    'notifications',
    'notification',
    'promoteExternal',
    'createGame',
    'gameSettings'
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
  | { name: 'team'; teamId: string; tab?: string }
  /**
   * One player, and what the Stats tab is narrowed to.
   *
   * The filter is on the address like everything else, so a parent can send
   * somebody a link to one child's spring rather than to a career total. Only
   * the Stats tab has a filter, so the three narrowing parameters are written
   * only beside `tab=stats`.
   *
   * `onTeam` is something else: the team the page was opened for — the roster
   * row or the box-score side that was tapped. It is on every tab, the filter
   * never changes it, and it is what the Settings and Walk-up tabs edit the
   * player on, so `settings` and `walkup` are only tabs at all beside it.
   */
  | {
      name: 'player'
      userId: string
      tab?: 'videos' | 'stats' | 'settings' | 'walkup'
      seasonId?: string
      teamId?: string
      year?: number
      onTeam?: string
    }
  | { name: 'season'; seasonId: string; tab?: string; when?: When }
  | { name: 'league'; leagueId: string }
  /**
   * The page behind the gear on a team, season or league card: who can see
   * this, who may change it, and the invite links that let more people in.
   */
  | { name: 'manage'; scopeKind: 'league' | 'season' | 'team'; scopeId: string }
  | {
      name: 'game'
      gameId: string
      tab?: 'boxScore' | 'watch' | 'score'
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
   */
  | { name: 'signInLink'; token: string }

const WHENS = new Set<string>(['upcoming', 'past', 'all'])

function whenOf(raw: string | null, fallback: When): When {
  return raw != null && WHENS.has(raw) ? (raw as When) : fallback
}

/** `/games/g1?video=v1&t=734` → the game, the video, and where in it. */
export function parseRoute(path: string, search = ''): Route {
  if (path === '/node') return { name: 'nodeAdministration' }
  const query = new URLSearchParams(search)
  const parts = path.split('/').filter(part => part !== '')
  if (parts.length === 0) return { name: 'home' }

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
        return {
          name: 'groupSettings',
          kind: id,
          id: groupId,
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
      }
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
    case 'account':
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
      return { name: 'signInLink', token: id }
    case 'players': {
      if (id == null) return { name: 'home' }
      const onTeam = query.get('onTeam') ?? undefined
      const asked = query.get('tab')
      // Settings and Walk-up edit the player on the team the page was opened
      // for, so without one there is nothing for them to edit, and the page
      // opens on its first tab instead.
      const tab =
        asked === 'stats'
          ? 'stats'
          : (asked === 'settings' || asked === 'walkup') && onTeam != null
            ? asked
            : 'videos'
      const on = onTeam == null ? {} : { onTeam }
      if (tab === 'videos') return { name: 'player', userId: id, ...on }
      if (tab === 'settings' || tab === 'walkup') {
        return { name: 'player', userId: id, tab, ...on }
      }
      const year = Number(query.get('year'))
      return {
        name: 'player',
        userId: id,
        tab,
        seasonId: query.get('season') ?? undefined,
        teamId: query.get('team') ?? undefined,
        year: Number.isInteger(year) && year > 1900 ? year : undefined,
        ...on
      }
    }
    case 'teams':
      if (id == null) return { name: 'home' }
      if (parts[2] === 'manage') {
        return { name: 'manage', scopeKind: 'team', scopeId: id }
      }
      return { name: 'team', teamId: id, tab: query.get('tab') ?? undefined }
    case 'seasons':
      if (id == null) return { name: 'home' }
      if (parts[2] === 'manage') {
        return { name: 'manage', scopeKind: 'season', scopeId: id }
      }
      return {
        name: 'season',
        seasonId: id,
        tab: query.get('tab') ?? undefined,
        when:
          query.get('when') == null
            ? undefined
            : whenOf(query.get('when'), 'past')
      }
    case 'leagues':
      if (id == null) return { name: 'home' }
      if (parts[2] === 'manage') {
        return { name: 'manage', scopeKind: 'league', scopeId: id }
      }
      return { name: 'league', leagueId: id }
    case 'games': {
      if (id == null) return { name: 'home' }
      if (parts[2] === 'settings')
        return { name: 'gameSettings', gameId: decodeURIComponent(id) }
      if (parts[2] === 'score') return { name: 'scoreGame', gameId: id }
      if (parts[2] === 'dj') return { name: 'djGame', gameId: id }
      // The Score Game section of the game page. The same address it had as
      // its own screen, so a link to it still opens, with the hero above it.
      if (parts[2] === 'score-game') {
        return { name: 'game', gameId: id, tab: 'score' }
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
              : 'watch',
        videoId: query.get('video') ?? undefined,
        at: Number.isFinite(at) && at > 0 ? at : undefined,
        ...(angles.length > 0 ? { angles } : {}),
        ...(angles.length > 0 && audio != null ? { audio } : {}),
        ...(angles.length > 0 && zoom != null ? { zoom } : {})
      }
    }
    default:
      return { name: 'home' }
  }
}

/** The address of a route, ready for the history. */
export function routePath(route: Route): string {
  switch (route.name) {
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
    case 'djGame':
      return `/games/${route.gameId}/dj`
    case 'scoreboardOverride':
      return `/games/${route.gameId}/scoreboard-override`
    case 'videos':
      return route.when === 'past' ? '/videos' : `/videos?when=${route.when}`
    case 'schedule':
      return route.when === 'upcoming'
        ? '/schedule'
        : `/schedule?when=${route.when}`
    case 'account':
      return '/account'
    case 'signInLink':
      return `/signin/${route.token}`
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
      // Videos is the tab a bare address opens on, and it has no filter: the
      // narrowing belongs to Stats, so it is written only where it is read.
      // The team the page was opened for is written on every tab.
      const query = new URLSearchParams()
      if (route.tab === 'stats') {
        query.set('tab', 'stats')
        if (route.seasonId != null) query.set('season', route.seasonId)
        if (route.teamId != null) query.set('team', route.teamId)
        if (route.year != null) query.set('year', String(route.year))
      } else if (
        (route.tab === 'settings' || route.tab === 'walkup') &&
        route.onTeam != null
      ) {
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
    case 'manage':
      return `/${route.scopeKind}s/${route.scopeId}/manage`
    case 'game': {
      if (route.tab === 'score') return `/games/${route.gameId}/score-game`
      const query = new URLSearchParams()
      if (route.tab === 'boxScore') query.set('tab', 'boxScore')
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
    case 'signIn':
      return route.next == null
        ? '/sign-in'
        : `/sign-in?next=${encodeURIComponent(route.next)}`
  }
}

/**
 * A `next` is a path on this site and nothing else.
 *
 * Without this it is an open redirect: `/sign-in?next=//evil.example` reads as
 * a protocol-relative URL and sends somebody who has just typed their password
 * to another site. One leading slash, and never two.
 */
export function safeNext(raw: string | null | undefined): string | undefined {
  if (raw == null || raw === '') return undefined
  if (!raw.startsWith('/')) return undefined
  if (raw.startsWith('//')) return undefined
  if (raw.includes('\\')) return undefined
  return raw
}
