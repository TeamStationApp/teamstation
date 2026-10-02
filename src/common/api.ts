import {
  asArray,
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import {
  type AccountPicture,
  type AccountSettings,
  asAccountEmailPending,
  asAccountSettings
} from './accountSettings'
import { asLiteral } from './asLiteral'
import { type Approval, asApproval, asBuildsLink } from './distribution'
import { type ApiError, asApiError, HttpError } from './errors'
import { DEFAULT_FENCE_DISTANCE_FT } from './fenceDistance'
import { asCurrentPlay, asGumboPlay } from './gumboPlay'
import { calibratePasswordCosts } from './passwordCalibration'
import {
  asArgonParameters,
  asClientHash,
  asNewPasswordParameters,
  checkNewPassword,
  clientParameters,
  type ClientPasswordCosts,
  type PasswordKdf,
  type ResetAuthorization
} from './passwordProtocol'
import type { PlayerSettings } from './playerSettings'
import { asRole, type Role, type RoleFlag } from './roles'
import {
  cleanAction,
  type Problem,
  type ScoringAction
} from './scoring/actions'
import {
  asDefaultLineup,
  asSideLineups,
  type DefaultLineup,
  type Lineup,
  type LineupChange,
  type LineupPerson,
  type SideLineups
} from './scoring/lineupHistory'
import type { SaveChange, StoredGame } from './scoring/session'
import { asUserId } from './userIdNumber'
import { asWalkUpSong, type WalkUpSong } from './walkUpSong'

/**
 * The client the app talks to the server through.
 *
 * Every response is cleaned here, not just on the server: the two ends check
 * the same shapes, so a server that starts sending something else fails loudly
 * in one place instead of making a screen render nonsense.
 */

/** The API sends `null` for an absent value, which `asOptional` will not take. */
const asNullable = <T>(cleaner: Cleaner<T>): Cleaner<T | null> =>
  asEither(asLiteral(null), cleaner)

export const asTeamSummary = asObject({
  id: asString,
  name: asString,
  shortName: asNullable(asString),
  logoPath: asNullable(asString),
  /**
   * Signed and short-lived. The app never builds one: only the server knows
   * where a picture lives and who may see it.
   */
  logoUrl: asOptional(asNullable(asString), null),
  /**
   * The team's record in its most recent season, counted from its finished
   * games' scores.
   *
   * Per season, never across all time: seasons overlap, so a child on a spring
   * team and an all-stars team at once would have one combined record that
   * means nothing. Null for a team that has not played — `0–0` is a claim
   * about games that were played, and there were none.
   */
  record: asOptional(
    asNullable(
      asObject({
        w: asNumber,
        l: asNumber,
        t: asNumber,
        seasonName: asNullable(asString)
      })
    ),
    null
  ),
  /**
   * `full` for a team in a season, `external` for an opponent from outside
   * every season. Only a list asked for external teams holds one; a server
   * from before the field sends none, and every team it lists is full.
   */
  kind: asOptional(asEither(asLiteral('full'), asLiteral('external')), 'full'),
  /**
   * How this person sees the team: `member` as one of its own people (or
   * anybody else who can see the whole team), `fan` when they only follow
   * it, which shows its schedule, roster and staff and nothing else. Only
   * `GET /teams` says; a summary from elsewhere is a team seen whole.
   */
  access: asOptional(asLiteral('member', 'fan')),
  /** Whether this person follows the team. Only `GET /teams` says. */
  following: asOptional(asBoolean),
  /**
   * Whether this person has a place on the team's roster. Only `GET /teams`
   * says; the team page offers Follow to somebody who has none.
   */
  onTeam: asOptional(asBoolean)
})
/** The three a summary from elsewhere than `GET /teams` leaves out, as optional. */
type TeamSummaryFromList = ReturnType<typeof asTeamSummary>
export type TeamSummary = Omit<
  TeamSummaryFromList,
  'access' | 'following' | 'onTeam'
> &
  Partial<Pick<TeamSummaryFromList, 'access' | 'following' | 'onTeam'>>

/** A team somebody may follow, from `GET /teams/search` or `/me/follows`. */
export const asFollowableTeam = asObject({
  id: asString,
  name: asString,
  logoUrl: asNullable(asString),
  /** The seasons it plays in, each titled `<league> <season>`. */
  seasons: asArray(asObject({ id: asString, title: asString })),
  following: asBoolean
})
export type FollowableTeam = ReturnType<typeof asFollowableTeam>

/**
 * One game on a team's schedule, as a fan may read it: when, who, where.
 * Never a status, a score, a poster or a video.
 */
export const asScheduleEntry = asObject({
  gameId: asString,
  startsAt: asString,
  homeTeam: asObject({ id: asString, name: asString }),
  awayTeam: asObject({ id: asString, name: asString }),
  venue: asNullable(asString)
})
export type ScheduleEntry = ReturnType<typeof asScheduleEntry>

/** One of a team's staff, with the roles they hold directly on the team. */
export const asStaffEntry = asObject({
  userId: asUserId,
  shortName: asString,
  avatarUrl: asNullable(asString),
  roles: asArray(asRole)
})
export type StaffEntry = ReturnType<typeof asStaffEntry>

/** The audience a chat is kept to, or `dm`. */
export const asChatKind = asLiteral(
  'teamStaff',
  'teamMembers',
  'teamFans',
  'seasonStaff',
  'seasonAllStaff',
  'seasonAnnouncements',
  'leagueOrg',
  'dm'
)
export type ChatKindName = ReturnType<typeof asChatKind>

/**
 * Somebody else who was in a DM with the caller, for its name: a current
 * member, or one who left (`left`) while the caller was in it.
 */
export const asChatDmPerson = asObject({
  userId: asUserId,
  shortName: asString,
  left: asBoolean
})
export type ChatDmPerson = ReturnType<typeof asChatDmPerson>

/**
 * One chat the caller is in, from `GET /chat/conversations`. `title` is null
 * for a DM, which the app names from its members. `locked`: the caller holds
 * no key for the latest epoch; `noHolder`: no current member does.
 */
export const asChatConversation = asObject({
  id: asString,
  kind: asChatKind,
  title: asNullable(asString),
  scope: asNullable(
    asObject({ type: asLiteral('team', 'season', 'league'), id: asString })
  ),
  lastSeq: asNumber,
  unread: asNumber,
  canPost: asBoolean,
  canModerate: asBoolean,
  locked: asBoolean,
  noHolder: asBoolean,
  closed: asBoolean,
  memberCount: asNumber,
  /**
   * For a DM, everyone else who was ever in it with the caller, current and
   * former, so the app can still name it once the others have all left;
   * empty for a scope chat.
   */
  people: asOptional(asArray(asChatDmPerson), [])
})
export type ChatConversation = ReturnType<typeof asChatConversation>

/** One member of a chat, from `GET /chat/conversations/:id/members`. */
export const asChatMember = asObject({
  userId: asUserId,
  shortName: asString,
  avatarUrl: asNullable(asString),
  /** How they stand in the chat, such as "Coach · Guardian". */
  label: asString,
  isModerator: asBoolean,
  isApprover: asBoolean,
  /** Has an identity and is not waiting for reset approval here. */
  eligible: asBoolean,
  hasIdentity: asBoolean,
  /** Their current identity public key, base64url. */
  identityKey: asNullable(asString),
  /** Their current per-user key generation. */
  generation: asNullable(asNumber)
})
export type ChatMember = ReturnType<typeof asChatMember>

/**
 * One row of a chat's hash-chained membership log. `prevHash` and `hash` are
 * base64url; `at` is the milliseconds the hash covers.
 */
export const asChatLogRow = asObject({
  seq: asNumber,
  event: asLiteral('join', 'leave', 'identityReset', 'closed'),
  userId: asUserId,
  actorUserId: asNullable(asUserId),
  reason: asNullable(asString),
  prevHash: asString,
  hash: asString,
  at: asNumber
})
export type ChatLogRow = ReturnType<typeof asChatLogRow>

/** Somebody the caller may name in a DM, from `GET /chat/dm-candidates`. */
export const asChatPerson = asObject({
  userId: asUserId,
  shortName: asString,
  avatarUrl: asNullable(asString)
})
export type ChatPerson = ReturnType<typeof asChatPerson>

/**
 * An adult who may be included beside a player, from `GET
 * /chat/included-adults`, with a label such as "Guardian" or "Coach · Hawks".
 */
export const asIncludedAdult = asObject({
  userId: asUserId,
  shortName: asString,
  label: asString
})
export type IncludedAdult = ReturnType<typeof asIncludedAdult>

/** How far one member has read, from `GET /chat/conversations/:id/reads`. */
export const asChatRead = asObject({ userId: asUserId, seq: asNumber })
export type ChatRead = ReturnType<typeof asChatRead>

/** A chat device platform. */
export const asChatPlatform = asLiteral('web', 'ios', 'android')
export type ChatPlatform = ReturnType<typeof asChatPlatform>

/**
 * One of the caller's chat devices, from `GET /chat/devices`. Keys are
 * base64url. `linked`: holds the current per-user key generation and is not
 * revoked; `current`: bound to this session.
 */
export const asChatDevice = asObject({
  id: asString,
  name: asString,
  platform: asChatPlatform,
  boxPublicKey: asString,
  signPublicKey: asString,
  createdAt: asString,
  lastSeenAt: asString,
  revokedAt: asNullable(asString),
  linked: asBoolean,
  current: asBoolean
})
export type ChatDevice = ReturnType<typeof asChatDevice>

/** What a new device registers: its name, platform and public keys (base64url). */
export interface ChatDeviceRegistration {
  name: string
  platform: ChatPlatform
  boxPublicKey: string
  signPublicKey: string
}

/** A nonce to sign, with the session it binds to. */
export const asChatResumeChallenge = asObject({
  nonce: asString,
  sessionId: asString,
  expiresAt: asString
})
export type ChatResumeChallenge = ReturnType<typeof asChatResumeChallenge>

/**
 * A new identity (enrolment or reset): its device-made `cid_` id, public key,
 * and PUK generation 1 with the identity's signature and this device's box.
 * Bytes are base64url.
 */
export interface ChatIdentityPublication {
  identityId: string
  identityPublicKey: string
  pukPublicKey: string
  pukSignature: string
  box: string
}

export const asChatEnrolment = asObject({
  identityId: asString,
  generation: asNumber,
  grantRequests: asNumber
})
export type ChatEnrolment = ReturnType<typeof asChatEnrolment>

export const asChatReset = asObject({
  identityId: asString,
  generation: asNumber,
  revokedDeviceIds: asArray(asString)
})
export type ChatReset = ReturnType<typeof asChatReset>

/** PUK generation n+1, boxed to exactly the linked devices. Bytes are base64url. */
export interface ChatPukPublication {
  generation: number
  publicKey: string
  signature: string
  previousKeysBox: string
  boxes: Array<{ deviceId: string; box: string }>
}

const asChatIdentityKey = asObject({
  id: asString,
  publicKey: asString,
  createdAt: asString
})

/** `GET /chat/me/keys`: the caller's identity, generations and this device's boxes. */
export const asChatMyKeys = asObject({
  deviceId: asNullable(asString),
  linked: asBoolean,
  identity: asNullable(asChatIdentityKey),
  generations: asArray(
    asObject({
      generation: asNumber,
      publicKey: asString,
      signature: asString,
      previousKeysBox: asNullable(asString),
      box: asNullable(asString)
    })
  ),
  pukNeedsRotation: asBoolean
})
export type ChatMyKeys = ReturnType<typeof asChatMyKeys>

/** `GET /chat/users/:userId/keys`: another user's current identity and PUK. */
export const asChatUserKeys = asObject({
  userId: asUserId,
  identity: asNullable(asChatIdentityKey),
  puk: asNullable(
    asObject({ generation: asNumber, publicKey: asString, signature: asString })
  )
})
export type ChatUserKeys = ReturnType<typeof asChatUserKeys>

/** `GET /chat/identities/:identityId`: any identity, current or replaced. */
export const asChatIdentity = asObject({
  id: asString,
  userId: asUserId,
  publicKey: asString,
  createdAt: asString,
  replacedAt: asNullable(asString)
})
export type ChatIdentity = ReturnType<typeof asChatIdentity>

/** A link request as the new device sees it; `box` once approved. */
export const asChatLink = asObject({
  id: asString,
  newDeviceId: asString,
  createdAt: asString,
  expiresAt: asString,
  approved: asBoolean,
  expired: asBoolean,
  approvedByDeviceId: asNullable(asString),
  box: asNullable(asString)
})
export type ChatLink = ReturnType<typeof asChatLink>

/** An open link request as the user's linked devices see it. */
export const asChatPendingLink = asObject({
  id: asString,
  newDevice: asObject({
    id: asString,
    name: asString,
    platform: asChatPlatform,
    boxPublicKey: asString
  }),
  createdAt: asString,
  expiresAt: asString
})
export type ChatPendingLink = ReturnType<typeof asChatPendingLink>

/** The approval: the identity key boxed to the new device, and every PUK generation. */
export interface ChatLinkApproval {
  box: string
  pukBoxes: Array<{ generation: number; box: string }>
}

export const asGameSummary = asObject({
  id: asString,
  homeTeamId: asString,
  awayTeamId: asString,
  homeTeamName: asString,
  awayTeamName: asString,
  seasonId: asNullable(asString),
  startAt: asNullable(asString),
  venue: asNullable(asString),
  status: asString,
  homeScore: asNullable(asNumber),
  awayScore: asNullable(asNumber),
  ingestStatus: asString,
  videoCount: asNumber,
  /** The longest video of the game, for the length on a thumbnail. */
  durationSec: asOptional(asNullable(asNumber), null),
  /** A frame of the game's video, signed and short-lived. */
  posterUrl: asOptional(asNullable(asString), null)
})
export type GameSummary = ReturnType<typeof asGameSummary>

export const asVideoSummary = asObject({
  id: asString,
  /**
   * How many cameras the recording holds. One unless something said otherwise.
   * A count, not a type: a game's videos are otherwise independent.
   */
  numCameras: asOptional(asNumber, 1),
  kind: asString,
  title: asString,
  status: asString,
  storage: asString,
  startAt: asNullable(asString),
  /** This recording's own clock correction, for switching angle in step. */
  syncOffsetSec: asOptional(asNumber, 0),
  durationSec: asNullable(asNumber),
  width: asNullable(asNumber),
  height: asNullable(asNumber),
  codecs: asNullable(asString),
  /** A frame of this video, signed and short-lived. */
  posterUrl: asOptional(asNullable(asString), null)
})
export type VideoSummary = ReturnType<typeof asVideoSummary>

export const asLineScoreSide = asObject({
  /** Runs in each inning, first inning first. */
  runs: asArray(asNumber),
  r: asNumber,
  /** Null when the plays cannot say — which is not the same as none. */
  h: asNullable(asNumber),
  e: asNullable(asNumber),
  /**
   * Walks, and the batters of this side who struck out, and its home runs.
   *
   * Optional because a game ingested before they were counted has a line score
   * without them, and `null` there means "not counted" rather than "none" —
   * the card draws nothing rather than claiming a no-hitter.
   *
   * A side's **defensive** strikeouts are not stored: they are the other
   * side's `k`, and counting the same thing twice is how two numbers that must
   * agree end up disagreeing.
   */
  bb: asOptional(asNullable(asNumber), null),
  k: asOptional(asNullable(asNumber), null),
  hr: asOptional(asNullable(asNumber), null),
  hbp: asOptional(asNullable(asNumber), null)
})

export type LineScoreSide = ReturnType<typeof asLineScoreSide>

export const asGameDetail = asObject({
  id: asString,
  homeTeamId: asString,
  awayTeamId: asString,
  homeTeamName: asString,
  awayTeamName: asString,
  seasonId: asNullable(asString),
  startAt: asNullable(asString),
  venue: asNullable(asString),
  status: asString,
  homeScore: asNullable(asNumber),
  awayScore: asNullable(asNumber),
  ingestStatus: asString,
  ingestMessage: asNullable(asString),
  /** `teamstation` once TeamStation scores the game, and nothing else may. */
  scoringOwner: asOptional(
    asNullable(asLiteral('external', 'teamstation')),
    null
  ),
  /** Each side's record in this game's season, `12–3`. */
  awayRecord: asOptional(asNullable(asString), null),
  homeRecord: asOptional(asNullable(asString), null),
  /** Each side's mark, signed and short-lived. */
  awayLogoUrl: asOptional(asNullable(asString), null),
  homeLogoUrl: asOptional(asNullable(asString), null),
  /**
   * Runs, hits and errors per side, counted from the plays.
   *
   * The runs come from the same shared counter the final score does, so the
   * two cannot disagree. An error is charged to the side that made it, which
   * is the fielding side.
   */
  linescore: asOptional(
    asNullable(
      asObject({
        away: asLineScoreSide,
        home: asLineScoreSide
      })
    ),
    null
  ),
  /**
   * Feet from home plate to the fence the game is played to: its own, its
   * season's or its league's, fixed once the game has plays. A server from
   * before fences had sizes sends none, and every game there is played to
   * the default.
   */
  fenceDistanceFt: asOptional(asNumber, DEFAULT_FENCE_DISTANCE_FT),
  /**
   * Whether this viewer may score the game: a scorekeeper of either team,
   * which every administrator of it is. A server from before the role flags
   * sends none, and the app offers no Score Game it would refuse.
   */
  canScore: asOptional(asBoolean, false),
  /**
   * Whether this viewer may DJ the game: a songkeeper of either team, which
   * every administrator of it is. Absent from an older server, and false.
   */
  canDj: asOptional(asBoolean, false),
  /**
   * The game's scoreboard: whether it is open, and whether this caller runs
   * the game and so may override it. Null when the server cannot tell, which
   * leaves the Score Game screen's Scoreboard option unavailable, and from a
   * server from before scoreboards.
   */
  scoreboard: asOptional(
    asNullable(asObject({ open: asBoolean, mayOverride: asBoolean })),
    null
  ),
  videos: asArray(asVideoSummary)
})
export type GameDetail = ReturnType<typeof asGameDetail>

export const asHighlight = asObject({
  eventId: asString,
  atBatIndex: asNumber,
  title: asString,
  startOffsetSec: asNumber,
  playOffsetSec: asNumber,
  eventType: asNullable(asString),
  isScoringPlay: asBoolean,
  /** One frame of the video at the moment of the play. */
  stillUrl: asString,
  /**
   * The play in a sentence, for the panel under the video: TeamStation's own
   * reading of it, written by the server when it answers. The list draws
   * `title`; only that panel draws this.
   */
  description: asOptional(asNullable(asString), null)
})
export type Highlight = ReturnType<typeof asHighlight>

export const asHighlightsResponse = asObject({
  withheld: asNullable(asString),
  /** Plays left out because nobody could be named on them. */
  droppedCount: asOptional(asNumber, 0),
  highlights: asArray(asHighlight)
})
export type HighlightsResponse = ReturnType<typeof asHighlightsResponse>

const asRates = asObject({
  avg: asOptional(asNumber),
  obp: asOptional(asNumber),
  slg: asOptional(asNumber),
  ops: asOptional(asNumber),
  sbPct: asOptional(asNumber)
})

const asPitchingRates = asObject({
  /** Earned runs per game; absent for a pitcher with no outs. */
  era: asOptional(asNumber),
  whip: asOptional(asNumber),
  baa: asOptional(asNumber),
  sbPct: asOptional(asNumber)
})

export const asBattingRow = asObject({
  userId: asUserId,
  /** First name, last initial. Never the whole name. */
  shortName: asOptional(asString),
  teamId: asNullable(asString),
  /** Games this line is the sum of. */
  g: asOptional(asNumber, 0),
  pa: asNumber,
  ab: asNumber,
  h: asNumber,
  singles: asNumber,
  doubles: asNumber,
  triples: asNumber,
  hr: asNumber,
  bb: asNumber,
  k: asNumber,
  /** Runs scored, which belongs to whoever crossed the plate. */
  r: asOptional(asNumber, 0),
  hbp: asNumber,
  rbi: asNumber,
  sb: asOptional(asNumber, 0),
  cs: asOptional(asNumber, 0),
  sf: asOptional(asNumber, 0),
  /** Sacrifice bunts. */
  sh: asOptional(asNumber, 0),
  roe: asOptional(asNullable(asNumber), null),
  fc: asOptional(asNullable(asNumber), null),
  pik: asOptional(asNullable(asNumber), null),
  rates: asRates,
  /**
   * This player's average for the season so far, up to and including this
   * game — not the afternoon's. Null where they have no at-bats to average.
   */
  seasonAvg: asOptional(asNullable(asNumber), null)
})
export type BattingRow = ReturnType<typeof asBattingRow>

/**
 * One pitcher's line, earned runs and all.
 *
 * An earned run is not a figure a play-by-play can produce — telling one from
 * an unearned one means replaying the inning without the mistakes — so these
 * come from the stat lines the stats engine writes. `rates.era` is earned runs
 * per game, a game being the season's or its league's ERA innings, six where
 * neither sets one.
 */
export const asPitchingRow = asObject({
  userId: asUserId,
  shortName: asOptional(asString),
  teamId: asNullable(asString),
  /** `5.2`, the way it is always written. */
  ip: asString,
  g: asOptional(asNumber, 0),
  outs: asNumber,
  bf: asNumber,
  h: asNumber,
  hr: asNumber,
  hbp: asNumber,
  r: asNumber,
  er: asOptional(asNumber, 0),
  bb: asNumber,
  k: asNumber,
  gs: asOptional(asNullable(asNumber), null),
  pitches: asOptional(asNullable(asNumber), null),
  kl: asOptional(asNullable(asNumber), null),
  lob: asOptional(asNullable(asNumber), null),
  bk: asOptional(asNullable(asNumber), null),
  pik: asOptional(asNullable(asNumber), null),
  cs: asOptional(asNullable(asNumber), null),
  sb: asOptional(asNullable(asNumber), null),
  wp: asOptional(asNullable(asNumber), null),
  rates: asPitchingRates
})
export type PitchingRow = ReturnType<typeof asPitchingRow>

/**
 * One player's figures, and what there is to narrow them to.
 *
 * The filter comes back with the answer because the two are the same question:
 * these are the seasons, teams and years this player has figures for, and the
 * totals are whichever of those rows were asked for. A career is the unfiltered
 * answer, which is what the page opens on unless the reader arrived from a game.
 */
export const asPlayerStats = asObject({
  userId: asUserId,
  filter: asObject({
    seasonId: asNullable(asString),
    teamId: asNullable(asString),
    year: asNullable(asNumber)
  }),
  games: asNumber,
  /** Null where this player has never batted under the chosen filter. */
  batting: asNullable(asBattingRow),
  pitching: asNullable(asPitchingRow),
  options: asObject({
    seasons: asArray(
      asObject({
        seasonId: asString,
        name: asString,
        year: asNullable(asNumber)
      })
    ),
    teams: asArray(asObject({ teamId: asString, name: asString })),
    years: asArray(asNumber)
  })
})
export type PlayerStats = ReturnType<typeof asPlayerStats>

export const asGameStatsStatus = asEither(
  asObject({ status: asLiteral('none') }),
  asObject({
    status: asEither(
      asLiteral('pending'),
      asLiteral('built'),
      asLiteral('incomplete'),
      asLiteral('failed')
    ),
    detail: asNullable(asString),
    builtAt: asNullable(asString)
  })
)
export type GameStatsStatusResponse = ReturnType<typeof asGameStatsStatus>

export const asBoxScore = asObject({
  batting: asArray(asBattingRow),
  pitching: asArray(asPitchingRow),
  // Optional so older servers without the stats builder still clean.
  stats: asOptional(asGameStatsStatus)
})
export type BoxScore = ReturnType<typeof asBoxScore>

/** How a player bats and throws. Null is `nobody has said`, not `neither`. */
export const asBats = asEither(
  asLiteral(null),
  asLiteral('left'),
  asLiteral('right'),
  asLiteral('switch')
)
export const asThrows = asEither(
  asLiteral(null),
  asLiteral('left'),
  asLiteral('right')
)

export const asRosterEntry = asObject({
  bats: asOptional(asBats, null),
  throws: asOptional(asThrows, null),
  userId: asUserId,
  /**
   * First name, last initial. The field is named for what it is so a full
   * name cannot be shipped here by accident — the compiler visits every call
   * site, where a reviewer might not.
   */
  shortName: asString,
  avatarUrl: asOptional(asNullable(asString), null),
  jersey: asNullable(asString),
  positions: asArray(asString),
  isPlayer: asBoolean,
  role: asString,
  /** `coach`, `player` or `follower` — the section they are listed under. */
  group: asOptional(asString, 'player'),
  /** Their walk-up song on this team, or null for none. */
  walkUpSong: asOptional(asNullable(asWalkUpSong), null)
})
export type RosterEntry = ReturnType<typeof asRosterEntry>

const asStoredGame = asObject({
  plays: asArray(
    asObject({ id: asString, gameId: asString, gumbo: asGumboPlay })
  ),
  currentPlay: asOptional(asNullable(asCurrentPlay), null)
})

/** A team this player has played for, and in which season. */
export const asPlayerTeam = asObject({
  teamId: asString,
  teamName: asString,
  seasonId: asNullable(asString),
  seasonName: asNullable(asString),
  seasonYear: asNullable(asNumber)
})
export type PlayerTeam = ReturnType<typeof asPlayerTeam>

/**
 * One person, for their own page.
 *
 * `name` is **always** the short form — `Jordan P` — for everybody, on every
 * screen. The whole name is never part of it: it is fetched separately, by
 * `playerName`, when somebody who may change it opens the name field.
 *
 * No jersey number: a number belongs to a player *on a team*, and is drawn on
 * the team's roster and in the box score, where that context exists.
 */
export const asPlayerName = asObject({
  userId: asUserId,
  displayName: asString,
  firstName: asNullable(asString),
  lastName: asNullable(asString)
})
export type PlayerName = ReturnType<typeof asPlayerName>

export const asPlayerDetail = asObject({
  userId: asUserId,
  name: asString,
  /** Whether to offer this person the name field. A parent or an admin. */
  canEditName: asOptional(asBoolean, false),
  avatarUrl: asOptional(asNullable(asString), null),
  bats: asOptional(asBats, null),
  throws: asOptional(asThrows, null),
  /**
   * `YYYY-MM`, or null when nobody has set it. Absent for anybody who may
   * not set it: only the team's administrators and coaches and the
   * player's guardians see it.
   */
  birthMonth: asOptional(asNullable(asString)),
  teams: asArray(asPlayerTeam)
})
export type PlayerDetail = ReturnType<typeof asPlayerDetail>

/** A player's guardian or adult family member. */
export const asGuardian = asObject({
  userId: asUserId,
  name: asString,
  email: asNullable(asString),
  kind: asLiteral('guardian', 'family')
})
export type Guardian = ReturnType<typeof asGuardian>
export type RelativeKind = Guardian['kind']

/** What linking a relative answers: the list now, and any invitation sent. */
export const asAddedGuardian = asObject({
  guardians: asArray(asGuardian),
  invited: asOptional(
    asObject({
      inviteId: asString,
      email: asString,
      code: asString,
      invitedAt: asString
    })
  )
})
export type AddedGuardian = ReturnType<typeof asAddedGuardian>

/**
 * One highlight of one player, for their own page.
 *
 * The team is the one they were on **at that moment**, which is the credit's
 * own team rather than wherever they play now: a child who moved clubs sees
 * both down one list, each play against the shirt they were wearing.
 */
export const asPlayerHighlight = asObject({
  eventId: asString,
  gameId: asString,
  videoId: asString,
  teamId: asNullable(asString),
  teamName: asNullable(asString),
  /** `Run scored`, `Strikeout pitching`, `Single`. Never their own name. */
  outcome: asString,
  /** The line under the video, which names who did it. */
  title: asString,
  /** When the play happened, corrected — not when the scorekeeper tapped. */
  playAt: asString,
  startOffsetSec: asNumber,
  playOffsetSec: asNumber,
  stillUrl: asString
})
export type PlayerHighlight = ReturnType<typeof asPlayerHighlight>

export const asPlayerHighlights = asObject({
  highlights: asArray(asPlayerHighlight),
  /** Ask for the next page from here. Null when this is the last one. */
  nextBefore: asNullable(asString),
  /** Plays of theirs on this page that no recording covers. */
  withoutVideo: asOptional(asNumber, 0)
})
export type PlayerHighlights = ReturnType<typeof asPlayerHighlights>

export const asStandingsRow = asObject({
  teamId: asString,
  teamName: asString,
  w: asNumber,
  l: asNumber,
  t: asNumber,
  runsFor: asNumber,
  runsAgainst: asNumber,
  played: asNumber,
  winningPct: asNullable(asNumber),
  runDifferential: asNumber
})
export type StandingsRow = ReturnType<typeof asStandingsRow>

export const asPlayback = asObject({
  videoId: asString,
  storage: asString,
  /** `null` when the row exists but its files do not. */
  url: asNullable(asString),
  expiresAt: asNullable(asString),
  durationSec: asNullable(asNumber),
  unavailable: asBoolean
})
export type Playback = ReturnType<typeof asPlayback>

export const asSeasonSummary = asObject({
  id: asString,
  /** Null until somebody creates a league and moves this season into it. */
  leagueId: asNullable(asString),
  name: asString,
  year: asNumber,
  term: asNullable(asString),
  ageGroup: asNullable(asString),
  teams: asNumber,
  games: asNumber,
  videos: asNumber,
  /**
   * The season's mark, from the organisation it was imported from. Signed and
   * short-lived, like every other picture the app is given.
   */
  logoUrl: asOptional(asNullable(asString), null)
})
export type SeasonSummary = ReturnType<typeof asSeasonSummary>

export const asSeasonGame = asObject({
  id: asString,
  homeTeamId: asString,
  awayTeamId: asString,
  homeTeamName: asString,
  awayTeamName: asString,
  /** An opponent from outside the season: no roster, no team page. */
  homeTeamExternal: asBoolean,
  awayTeamExternal: asBoolean,
  seasonId: asNullable(asString),
  startAt: asNullable(asString),
  venue: asNullable(asString),
  status: asString,
  homeScore: asNullable(asNumber),
  awayScore: asNullable(asNumber),
  ingestStatus: asString,
  videoCount: asNumber,
  /** The longest video of the game, for the length on a thumbnail. */
  durationSec: asOptional(asNullable(asNumber), null),
  /** A frame of the game's video, signed and short-lived. */
  posterUrl: asOptional(asNullable(asString), null),
  /** Each side's mark, signed and short-lived; null for a side without one. */
  homeLogoUrl: asOptional(asNullable(asString), null),
  awayLogoUrl: asOptional(asNullable(asString), null),
  /** Being played, and being streamed, right now. */
  isLive: asOptional(asBoolean, false),
  /** Other services' ids for the game, as its importers recorded them. */
  externalIds: asOptional(asArray(asString), () => [])
})
export type SeasonGame = ReturnType<typeof asSeasonGame>

/** A person another service knows, and which of the asked ids are theirs. */
export const asUserMatch = asObject({
  userId: asUserId,
  externalIds: asArray(asString)
})
export type UserMatch = ReturnType<typeof asUserMatch>

/**
 * A live stream's own state, as the ingest last reported it.
 *
 * `label` never carries a stream key — the ingest strips it before the status
 * is written down — so this whole object is safe on a screen and in a log.
 */
export const asLiveOutputStatus = asObject({
  kind: asString,
  label: asString,
  state: asString,
  lastError: asOptional(asString),
  bytesWritten: asNumber,
  bytesPerSecond: asNumber,
  /** How much video this output has written. The HLS leg's real measure. */
  recordedSec: asOptional(asNumber),
  restartCount: asNumber
})
export type LiveOutputStatus = ReturnType<typeof asLiveOutputStatus>

export const asLiveStatus = asObject({
  liveStreamId: asString,
  ingress: asObject({
    publishing: asBoolean,
    receivingPackets: asBoolean,
    bytesReceived: asNumber,
    bytesPerSecond: asNumber
  }),
  outputs: asArray(asLiveOutputStatus)
})
export type LiveStatus = ReturnType<typeof asLiveStatus>

/**
 * A game's live stream.
 *
 * `url` is present only in the reply to a request that asked for it by name —
 * creating the stream, revealing it, rotating it. Every other reply carries
 * `keyPrefix` and nothing that can publish.
 */
export const asLiveStream = asObject({
  id: asString,
  gameId: asString,
  /** Whose camera it is, and what they are called. */
  userId: asUserId,
  ownerName: asString,
  /** Which of that person's four, and what they call it. */
  slot: asNumber,
  label: asString,
  keyPrefix: asString,
  state: asString,
  opensAt: asString,
  /** When somebody ended it. Null while it is still good: it has no clock. */
  closesAt: asNullable(asString),
  videoId: asOptional(asNullable(asString), null),
  lastError: asOptional(asNullable(asString), null),
  status: asOptional(asNullable(asLiveStatus), null),
  /**
   * Only ever in the reply to a request that asked for it by name, and only
   * ever to the person the key belongs to.
   */
  url: asOptional(asString)
})
export type LiveStream = ReturnType<typeof asLiveStream>

/**
 * Everything pointed at one game, split by whether it is yours.
 *
 * `mine` carries what a person may act on; `others` says who else is streaming
 * this game and what their camera is doing, and never carries a key. That
 * division is the point of the whole shape: a key publishes video as somebody,
 * so it is theirs and not the team's.
 */
export const asGameLiveStreams = asObject({
  gameId: asString,
  mine: asArray(asLiveStream),
  others: asArray(asLiveStream),
  /** How many more cameras this person may add to this game. */
  canAdd: asNumber,
  maxCameras: asNumber
})
export type GameLiveStreams = ReturnType<typeof asGameLiveStreams>

/** What a delete answers with: which video went, and what left the Space. */
export const asDeletedVideo = asObject({
  id: asString,
  removedFromSpace: asOptional(asNumber, 0)
})
export type DeletedVideo = ReturnType<typeof asDeletedVideo>

/**
 * A game TS Director can be pointed at.
 *
 * The icons are the two teams' marks, which the picker draws on either side of
 * the row; the names read `<away> at <home>`, the way the game is spoken of.
 */
export const asDirectorEvent = asObject({
  gameId: asString,
  startAt: asString,
  venue: asNullable(asString),
  homeTeamName: asString,
  awayTeamName: asString,
  homeLogoUrl: asNullable(asString),
  awayLogoUrl: asNullable(asString),
  /** `none` until the game has been given a stream. */
  liveState: asString
})
export type DirectorEvent = ReturnType<typeof asDirectorEvent>

/** What a Director gets when it takes a game: the URL, key and all. */
export const asDirectorClaim = asObject({
  gameId: asString,
  url: asString,
  opensAt: asNullable(asString),
  closesAt: asNullable(asString)
})
export type DirectorClaim = ReturnType<typeof asDirectorClaim>

/** A game being played right now that this person may watch. */
export const asLiveNow = asObject({
  /** The angle to lead with: the one that started most recently. */
  videoId: asString,
  gameId: asString,
  title: asString,
  homeTeamName: asString,
  awayTeamName: asString,
  startedAt: asNullable(asString),
  gameStartAt: asString,
  /** How many cameras are on this game right now. Usually one. */
  angles: asOptional(asNumber, 1)
})
export type LiveNow = ReturnType<typeof asLiveNow>

export const asSessionUser = asObject({
  id: asUserId,
  displayName: asString,
  email: asOptional(asString),
  isAdmin: asBoolean,
  /** Signed and short-lived, for the picture in the header. */
  avatarUrl: asOptional(asNullable(asString), null)
})
export type SessionUser = ReturnType<typeof asSessionUser>

export const asSession = asObject({
  token: asString,
  expiresAt: asString,
  user: asSessionUser
})
export type Session = ReturnType<typeof asSession>

/** The sign-in a client is waiting on, and the secret that makes it its own. */
export const asSignInWait = asObject({
  requestId: asString,
  clientSecret: asString
})
export type SignInWait = ReturnType<typeof asSignInWait>

/**
 * Either a session, or `ready: false` — waiting is the ordinary answer here
 * and not a failure, so it is a shape rather than a status code.
 */
export const asMaybeSession = asEither(
  asObject({ ready: asLiteral(false) }),
  asSession
)

/** One invite code, as the panel that made it shows it. */
export const asInvite = asObject({
  id: asString,
  code: asString,
  /** The address to send somebody, built by the server. */
  url: asString,
  scopeType: asLiteral('league', 'season', 'team'),
  scopeId: asString,
  label: asNullable(asString),
  maxUses: asNullable(asNumber),
  uses: asNumber,
  expiresAt: asNullable(asString),
  revokedAt: asNullable(asString),
  createdAt: asString,
  /** Why it no longer works, or null while it does. */
  problem: asNullable(asLiteral('revoked', 'expired', 'exhausted'))
})
export type Invite = ReturnType<typeof asInvite>

export const asInviteList = asObject({
  /** False for somebody who can see the page but does not administer it. */
  canInvite: asBoolean,
  invites: asArray(asInvite)
})
export type InviteList = ReturnType<typeof asInviteList>

/** What is behind a code, for the screen its link opens. */
export const asInviteInfo = asObject({
  code: asString,
  valid: asBoolean,
  problem: asNullable(asLiteral('revoked', 'expired', 'exhausted')),
  scope: asObject({
    kind: asLiteral('league', 'season', 'team'),
    id: asString,
    name: asString
  }),
  signedIn: asBoolean,
  /** True when they already have what it offers, which is not a failure. */
  alreadyIn: asBoolean
})
export type InviteInfo = ReturnType<typeof asInviteInfo>

export const asRedeemed = asObject({
  granted: asBoolean,
  scope: asObject({
    kind: asLiteral('league', 'season', 'team'),
    id: asString,
    name: asString
  })
})
export type Redeemed = ReturnType<typeof asRedeemed>

/** One thing somebody belongs to, and what they are in it. */
export const asScopeGrant = asObject({
  id: asString,
  name: asString,
  role: asString,
  /** On a team grant only: whether they play on the team. */
  isPlayer: asOptional(asBoolean)
})
/** `isPlayer` optional, so a season's or league's grant is one too. */
export type ScopeGrant = Omit<ReturnType<typeof asScopeGrant>, 'isPlayer'> & {
  isPlayer?: boolean
}

export const asNamed = asObject({ id: asString, name: asString })

/** The roles one person holds on one level of the tree being managed. */
export const asRoleGrant = asObject({
  kind: asLiteral('league', 'season', 'team'),
  id: asString,
  name: asString,
  roles: asArray(asRole)
})
export type RoleGrant = ReturnType<typeof asRoleGrant>

/**
 * One person with access, and every level it comes through.
 *
 * Never the strongest grant alone: a coach whose own child is on the roster
 * and who also joined the league holds two, and an administrator who removes
 * one and sees nothing change has been told a half-truth.
 */
export const asScopePerson = asObject({
  userId: asUserId,
  displayName: asString,
  emails: asArray(asString),
  teams: asArray(asScopeGrant),
  seasons: asArray(asScopeGrant),
  leagues: asArray(asScopeGrant),
  /**
   * Every role they hold in this tree, one entry per level. A server from
   * before the role flags sends only `adminOf`, which reads as admin rows.
   */
  grants: asOptional(asArray(asRoleGrant)),
  adminOf: asArray(
    asObject({
      kind: asLiteral('league', 'season', 'team'),
      id: asString,
      name: asString
    })
  ),
  /** When the account was made. */
  createdAt: asString,
  /**
   * When they last signed in, and when they were last here.
   *
   * Both, because a session lasts a month and a device's half a year: one
   * sign-in in March and every game watched since would otherwise read as
   * six months away. Null for an account nobody has ever used.
   */
  lastSignInAt: asNullable(asString),
  lastSeenAt: asNullable(asString)
})
type ScopePersonFromPage = ReturnType<typeof asScopePerson>
export type ScopePerson = Omit<
  ScopePersonFromPage,
  'teams' | 'seasons' | 'leagues'
> & {
  teams: ScopeGrant[]
  seasons: ScopeGrant[]
  leagues: ScopeGrant[]
}

/** Every role one person holds on one level, from `ScopePerson.grants`. */
export function grantsOf(person: ScopePerson): RoleGrant[] {
  return (
    person.grants ??
    person.adminOf.map(level => ({ ...level, roles: ['admin' as const] }))
  )
}

/** The roles the signed-in person holds on each team where they hold any. */
export const asMyRoles = asObject({
  teams: asObject(asArray(asRole))
})
export type MyRoles = ReturnType<typeof asMyRoles>

/** Somebody invited by address who has not opened the link yet. */
export const asPendingPerson = asObject({
  inviteId: asString,
  email: asString,
  code: asString,
  invitedAt: asString
})
export type PendingPerson = ReturnType<typeof asPendingPerson>

/** Everything the page behind the gear draws, in one answer. */
export const asManagePage = asObject({
  scope: asObject({
    kind: asLiteral('league', 'season', 'team'),
    id: asString,
    name: asString,
    /**
     * A league only: whether it is a SafeSport Local Affiliated
     * Organization, which binds it to the MAAPP.
     */
    safesportLao: asOptional(asBoolean)
  }),
  /** The levels around this one, named, so a tick can say which it is. */
  tree: asObject({
    leagues: asArray(asNamed),
    seasons: asArray(asNamed),
    teams: asArray(asNamed)
  }),
  people: asArray(asScopePerson),
  pending: asArray(asPendingPerson),
  invites: asArray(asInvite)
})
type ManagePageFromServer = ReturnType<typeof asManagePage>
export type ManagePage = Omit<ManagePageFromServer, 'scope' | 'people'> & {
  scope: Omit<ManagePageFromServer['scope'], 'safesportLao'> & {
    safesportLao?: boolean
  }
  people: ScopePerson[]
}

export const asAddedPerson = asObject({
  added: asBoolean,
  person: asOptional(
    asObject({ userId: asUserId, displayName: asString, email: asString })
  ),
  invited: asOptional(asPendingPerson)
})
export type AddedPerson = ReturnType<typeof asAddedPerson>

/** The LLMs dictation can put an utterance to, in the order a scorer picks. */
/**
 * The models a scorer can pick. Grok 4.7 is not offered, though the server
 * still routes any grok- model to xAI and its prompt is the same.
 */
export const DICTATION_MODELS = [
  'grok-4.3',
  'gpt-6-luna',
  'gpt-6-sol',
  'claude-haiku-4-5-20251001'
] as const
export type DictationModel = (typeof DICTATION_MODELS)[number]
/**
 * The model a scorer who never picked one gets, when the server has it:
 * the fastest of them, and as accurate as any on everyday sentences.
 */
export const DEFAULT_DICTATION_MODEL: DictationModel =
  'claude-haiku-4-5-20251001'

/**
 * The model dictation uses: the scorer's pick when the server offers it, or
 * else the default, or else the first the server offers.
 */
export function dictationModelOf(
  picked: DictationModel | undefined,
  offered: readonly string[]
): DictationModel | undefined {
  for (const choice of [picked, DEFAULT_DICTATION_MODEL])
    if (choice != null && offered.includes(choice)) return choice
  return DICTATION_MODELS.find(model => offered.includes(model))
}

/** What a scorer calls each of them. */
export const DICTATION_MODEL_NAMES: Record<DictationModel, string> = {
  'grok-4.3': 'Grok 4.3',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6-sol': 'GPT-6 Sol',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5'
}

/**
 * What `/health` reports. `dictation` is absent from a server that predates
 * it; `dictationModels` lists the models this server has a key for, and may
 * name one this client does not know.
 */
export const asHealth = asObject({
  status: asLiteral('ok', 'degraded'),
  version: asString,
  database: asLiteral('ok', 'unreachable'),
  migrations: asNumber,
  dictation: asOptional(asBoolean, false),
  dictationModels: asOptional(asArray(asString), [])
})
export type Health = ReturnType<typeof asHealth>

export interface ClientOptions {
  baseUrl: string
  token?: string
  /** Swapped out in tests. Defaults to the platform's own. */
  fetch?: typeof fetch
  passwordKdf?: PasswordKdf
  passwordCosts?: ClientPasswordCosts
  passwordTargetMs?: number
}

export type { DefaultLineup, Lineup, LineupChange, LineupPerson, SideLineups }

/** One side of `GET /games/:gameId/lineups`: its team, and its lineups. */
export type TeamLineups = SideLineups & { teamId: string; teamName: string }
export interface GameLineupsResponse {
  away: TeamLineups
  home: TeamLineups
}
const asTeamLineups: Cleaner<TeamLineups> = raw => {
  const team = asObject({ teamId: asString, teamName: asString })(raw)
  return { ...asSideLineups(raw), ...team }
}
export const asGameLineupsResponse: Cleaner<GameLineupsResponse> = asObject({
  away: asTeamLineups,
  home: asTeamLineups
})

/** One batter in DJ Game's list: a placeholder has no user id and no song. */
export const asDjBatter = asObject({
  userId: asNullable(asUserId),
  name: asString,
  walkUpSong: asNullable(asWalkUpSong)
})
export type DjBatter = ReturnType<typeof asDjBatter>

/**
 * One side of `GET /games/:gameId/dj`: its batters in order, and where the
 * order came from — the game's own lineup as it stands, the team's default
 * before the game has one, or else its players by jersey.
 */
export const asDjSide = asObject({
  teamId: asString,
  teamName: asString,
  source: asLiteral('lineup', 'default', 'roster'),
  /** Whether this viewer may set this team's walk-up songs. */
  canEditWalkUp: asBoolean,
  batters: asArray(asDjBatter)
})
export type DjSide = ReturnType<typeof asDjSide>

/** The plate appearance in progress: which side, and who is batting. */
export const asDjAtBat = asObject({
  side: asLiteral('away', 'home'),
  userId: asNullable(asUserId)
})
export type DjAtBat = ReturnType<typeof asDjAtBat>

/** Missing, on an older server, reads the same as no plate appearance. */
function asDjAtBatField(raw: unknown): DjAtBat | null {
  return raw == null ? null : asDjAtBat(raw)
}

export const asDjGame = asObject({
  away: asDjSide,
  home: asDjSide,
  /** Who is at the plate, or null when no plate appearance is in progress. */
  atBat: asDjAtBatField
})
export type DjGame = ReturnType<typeof asDjGame>

export class TeamStationClient {
  /** Where the API is, which is also where its sockets are. */
  readonly baseUrl: string
  private readonly doFetch: typeof fetch
  private readonly passwordKdf?: PasswordKdf
  private readonly passwordCosts?: ClientPasswordCosts
  private readonly passwordTargetMs?: number
  private passwordPreparation?: Promise<ClientPasswordCosts>
  token: string | undefined

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.passwordKdf = options.passwordKdf
    this.passwordCosts = options.passwordCosts
    this.passwordTargetMs = options.passwordTargetMs
    this.token = options.token
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async accountSettings(): Promise<AccountSettings> {
    return await this.request('GET', '/me/account', asAccountSettings)
  }

  async buildsLink(): Promise<string | undefined> {
    return (await this.request('GET', '/me/builds', asBuildsLink)).url
  }

  async oauthApproval(handle: string): Promise<Approval> {
    return await this.request(
      'GET',
      `/oauth/approvals/${encodeURIComponent(handle)}`,
      asApproval
    )
  }

  async decideOAuth(handle: string, approve: boolean): Promise<void> {
    await this.request(
      'POST',
      `/oauth/approvals/${encodeURIComponent(handle)}`,
      asObject({ approved: asBoolean }),
      { approve }
    )
  }

  async setAccountName(displayName: string): Promise<AccountSettings> {
    return await this.request('PUT', '/me/account/name', asAccountSettings, {
      displayName
    })
  }

  async setAccountPhoto(image: AccountPicture): Promise<AccountSettings> {
    return await this.request('PUT', '/me/account/photo', asAccountSettings, {
      image
    })
  }

  private requirePasswordKdf(): PasswordKdf {
    if (this.passwordKdf == null)
      throw new Error(
        'Password hashing is unavailable. Use an email code to sign in'
      )
    return this.passwordKdf
  }

  /** Start on editor entry; overlapping requests share work, later visits measure again. */
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- Keep one shared pending promise.
  preparePasswordCosts(): Promise<ClientPasswordCosts> {
    if (this.passwordPreparation != null) return this.passwordPreparation
    const pending = Promise.resolve().then(
      async () =>
        (
          await calibratePasswordCosts(
            this.requirePasswordKdf(),
            this.passwordCosts,
            this.passwordTargetMs
          )
        ).costs
    )
    this.passwordPreparation = pending
    const clear = (): void => {
      if (this.passwordPreparation === pending)
        this.passwordPreparation = undefined
    }
    // Attach failure handling immediately, even when the person never presses Save.
    pending.then(clear, clear)
    return pending
  }

  async setAccountPassword(
    password: string,
    currentPassword?: string,
    reset?: ResetAuthorization,
    preparation?: Promise<ClientPasswordCosts>,
    signal?: AbortSignal
  ): Promise<AccountSettings> {
    // Native/Worker hashes cannot be interrupted, but leaving the editor must
    // prevent their eventual result from being submitted.
    const checkActive = (): void => {
      if (signal?.aborted === true) throw new Error('Password change cancelled')
    }
    checkActive()
    const derive = this.requirePasswordKdf()
    checkNewPassword(password)
    const costs = await (preparation ?? this.preparePasswordCosts())
    checkActive()
    asNewPasswordParameters(clientParameters('00'.repeat(16), costs))
    const account = await this.accountSettings()
    checkActive()
    if (account.newPasswordSalt == null)
      throw new Error('Update the server before setting a password')
    if (account.passwordNeedsUpgrade && reset == null)
      throw new Error('Verify an email code to set a new password')
    let currentClientHash: string | undefined
    if (account.hasPassword && reset == null) {
      if (account.passwordParameters == null || currentPassword == null)
        throw new Error(
          'Enter your current password or reset it with an email code'
        )
      currentClientHash = asClientHash(
        await derive(currentPassword, account.passwordParameters.client)
      )
      checkActive()
    }
    const parameters = clientParameters(account.newPasswordSalt, costs)
    const clientHash = asClientHash(await derive(password, parameters))
    checkActive()
    return await this.request(
      'PUT',
      '/me/account/password',
      asAccountSettings,
      {
        clientHash,
        clientParameters: parameters,
        currentClientHash,
        reset
      }
    )
  }

  async requestPasswordReset(): Promise<{ requestId: string; email: string }> {
    return await this.request(
      'POST',
      '/me/account/password/reset',
      asObject({ requestId: asString, email: asString }),
      {}
    )
  }

  async requestAccountEmail(
    email: string,
    replaceEmailId?: string
  ): Promise<{ requestId: string }> {
    return await this.request(
      'POST',
      '/me/account/emails/request',
      asAccountEmailPending,
      { email, replaceEmailId }
    )
  }

  async confirmAccountEmail(
    requestId: string,
    code: string
  ): Promise<AccountSettings> {
    return await this.request(
      'POST',
      '/me/account/emails/confirm',
      asAccountSettings,
      { requestId, code }
    )
  }

  async setAccountPrimaryEmail(emailId: string): Promise<AccountSettings> {
    return await this.request(
      'PUT',
      '/me/account/emails/primary',
      asAccountSettings,
      { emailId }
    )
  }

  async signInWithPassword(email: string, password: string): Promise<Session> {
    const derive = this.requirePasswordKdf()
    const parameters = await this.request(
      'POST',
      '/auth/password/parameters',
      raw => asArgonParameters(raw),
      { email }
    )
    const clientHash = asClientHash(await derive(password, parameters))
    const session = await this.request('POST', '/auth/password', asSession, {
      email,
      clientHash
    })
    this.token = session.token
    return session
  }

  /**
   * Always succeeds, whether or not the address has an account.
   *
   * What comes back is the sign-in this client is now waiting on: an id, and a
   * secret that proves the wait is its own. Both are useless until somebody
   * opens the link in the mail or types the code, which is what lets a link
   * tapped on a laptop finish a sign-in a phone started.
   */
  async requestEmailCode(
    email: string,
    options: { origin?: 'web' | 'ios' | 'android'; next?: string } = {}
  ): Promise<SignInWait> {
    return await this.request('POST', '/auth/email-code', asSignInWait, {
      email,
      origin: options.origin ?? 'web',
      next: options.next
    })
  }

  /** Spend the link from the e-mail. Never happens on a bare page load. */
  async signInWithLink(token: string): Promise<Session> {
    const session = await this.request('POST', '/auth/link/verify', asSession, {
      token
    })
    this.token = session.token
    return session
  }

  /**
   * Has the sign-in this client asked for been approved somewhere else?
   *
   * `undefined` means not yet, which is the ordinary answer and not an error.
   */
  async claimSignIn(wait: SignInWait): Promise<Session | undefined> {
    const answer = await this.request(
      'POST',
      '/auth/request/claim',
      asMaybeSession,
      { requestId: wait.requestId, clientSecret: wait.clientSecret }
    )
    if (!('token' in answer)) return undefined
    this.token = answer.token
    return answer
  }

  async signInWithCode(email: string, code: string): Promise<Session> {
    const session = await this.request(
      'POST',
      '/auth/email-code/verify',
      asSession,
      { email, code }
    )
    this.token = session.token
    return session
  }

  async signOut(): Promise<void> {
    await this.request('POST', '/auth/logout', asUnknownOk)
    this.token = undefined
  }

  /** What the server can do, including whether it takes dictation. */
  async health(): Promise<Health> {
    return await this.request('GET', '/health', asHealth)
  }

  async teams(): Promise<TeamSummary[]> {
    return await this.request('GET', '/teams', asArray(asTeamSummary))
  }

  /** The seasons this person can see, which is what home leads with. */
  async seasons(): Promise<SeasonSummary[]> {
    return await this.request('GET', '/seasons', asArray(asSeasonSummary))
  }

  /**
   * Every game this person can see, across all their seasons, in one request.
   * `externalIds` narrows it to the games another service knows by those ids.
   * `when` asks the server for past or upcoming rather than the whole list.
   */
  async games(
    options: {
      externalIds?: string[]
      when?: 'past' | 'upcoming' | 'all'
    } = {}
  ): Promise<SeasonGame[]> {
    const params: string[] = []
    if (options.when != null && options.when !== 'all') {
      params.push(`when=${options.when}`)
    }
    for (const id of options.externalIds ?? []) {
      params.push(`externalId=${encodeURIComponent(id)}`)
    }
    const query = params.length === 0 ? '' : `?${params.join('&')}`
    return await this.request('GET', `/events${query}`, asArray(asSeasonGame))
  }

  /**
   * The people another service knows by these ids, as far as this person may
   * see them. A merged row answers as whoever it was merged into.
   */
  async users(options: { externalIds: string[] }): Promise<UserMatch[]> {
    const query = options.externalIds
      .map(id => `externalId=${encodeURIComponent(id)}`)
      .join('&')
    return await this.request('GET', `/users?${query}`, asArray(asUserMatch))
  }

  async seasonGames(seasonId: string): Promise<SeasonGame[]> {
    return await this.request(
      'GET',
      `/events?season=${encodeURIComponent(seasonId)}`,
      asArray(asSeasonGame)
    )
  }

  /**
   * Who the cookie says you are, or null.
   *
   * The session is in an `HttpOnly` cookie the app cannot read, so asking the
   * server is the only way to know whether somebody is signed in. Without
   * this a reload showed the sign-in screen with a live session sitting in
   * the jar, and every link landed there instead of where it pointed.
   */
  async whoAmI(): Promise<SessionUser | null> {
    try {
      return await this.request('GET', '/auth/me', asSessionUser)
    } catch {
      return null
    }
  }

  /** The newest played game anywhere this person can see, or null. */
  async recentGame(): Promise<SeasonGame | null> {
    const games = await this.request(
      'GET',
      '/events?played=1&limit=1',
      asArray(asSeasonGame)
    )
    return games[0] ?? null
  }

  async seasonTeams(seasonId: string): Promise<TeamSummary[]> {
    return await this.request(
      'GET',
      `/seasons/${encodeURIComponent(seasonId)}/teams`,
      asArray(asTeamSummary)
    )
  }

  async teamGames(teamId: string): Promise<GameSummary[]> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/games`,
      asArray(asGameSummary)
    )
  }

  async game(gameId: string): Promise<GameDetail> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}`,
      asGameDetail
    )
  }

  async highlights(videoId: string): Promise<HighlightsResponse> {
    return await this.request(
      'GET',
      `/videos/${encodeURIComponent(videoId)}/highlights`,
      asHighlightsResponse
    )
  }

  /**
   * Where to play a video from, and for how long that answer is good.
   *
   * The app never builds a media URL itself: the server decides, because only
   * it knows whether the video is on its own disk, still in PeerTube's tree or
   * finished in the Space, and it checks membership while it is looking.
   */
  async playback(videoId: string): Promise<Playback> {
    return await this.request(
      'GET',
      `/videos/${encodeURIComponent(videoId)}/playback`,
      asPlayback
    )
  }

  /** What is live right now. Empty on the ordinary day, which is most of them. */
  async liveNow(): Promise<LiveNow[]> {
    return await this.request('GET', '/live', asArray(asLiveNow))
  }

  /** Every camera pointed at this game: mine whole, everybody else's named. */
  async liveStreams(gameId: string): Promise<GameLiveStreams> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/live-streams`,
      asGameLiveStreams
    )
  }

  /** Another camera of my own on this game, up to the fourth. */
  async addLiveStream(gameId: string, label?: string): Promise<LiveStream> {
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/live-streams`,
      asLiveStream,
      label == null ? {} : { label }
    )
  }

  /** Asks for one of my URLs again, key and all. Recorded in the audit log. */
  async revealLiveStream(
    gameId: string,
    streamId: string
  ): Promise<LiveStream> {
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/live-streams/${encodeURIComponent(streamId)}/reveal`,
      asLiveStream,
      {}
    )
  }

  /** A new key for one of my cameras. The old one stops working at once. */
  async rotateLiveStream(
    gameId: string,
    streamId: string
  ): Promise<LiveStream> {
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/live-streams/${encodeURIComponent(streamId)}/rotate`,
      asLiveStream,
      {}
    )
  }

  /** Renames one of my cameras. */
  async updateLiveStream(
    gameId: string,
    streamId: string,
    change: { label?: string }
  ): Promise<LiveStream> {
    return await this.request(
      'PATCH',
      `/games/${encodeURIComponent(gameId)}/live-streams/${encodeURIComponent(streamId)}`,
      asLiveStream,
      change
    )
  }

  /**
   * Takes one of my cameras off this game altogether.
   *
   * Ending a camera stops it; this removes it. Somebody who added a fourth by
   * mistake wants the row gone and the slot back, not a row that says "ended"
   * for ever.
   */
  async removeLiveStream(
    gameId: string,
    streamId: string
  ): Promise<GameLiveStreams> {
    return await this.request(
      'DELETE',
      `/games/${encodeURIComponent(gameId)}/live-streams/${encodeURIComponent(streamId)}`,
      asGameLiveStreams
    )
  }

  /**
   * Deletes a recording, its files, and what the Space holds of it.
   *
   * For whoever runs the game, and for the person whose camera made it — a
   * stream started to check a URL leaves a recording of a car park, and the
   * person who made it should not need an administrator to remove it.
   */
  async deleteVideo(videoId: string): Promise<{ id: string }> {
    return await this.request(
      'DELETE',
      `/videos/${encodeURIComponent(videoId)}`,
      asDeletedVideo
    )
  }

  /** Ends a camera now: its key stops working and its video is closed. */
  async endLiveStream(gameId: string, streamId: string): Promise<LiveStream> {
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/live-streams/${encodeURIComponent(streamId)}/end`,
      asLiveStream,
      {}
    )
  }

  async boxScore(gameId: string): Promise<BoxScore> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/box-score`,
      asBoxScore
    )
  }

  /**
   * A team's default lineup: the starting lineup of the last game scored
   * here that began with a different one. All three fields are null for a
   * team with none.
   */
  async defaultLineup(teamId: string): Promise<DefaultLineup> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/default-lineup`,
      asDefaultLineup
    )
  }

  /** Each side's lineups in a game: start, changes and current. */
  async gameLineups(gameId: string): Promise<GameLineupsResponse> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/lineups`,
      asGameLineupsResponse
    )
  }

  /** Both sides' batters and their walk-up songs, for DJ Game. */
  async djGame(gameId: string): Promise<DjGame> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/dj`,
      asDjGame
    )
  }

  /** A game's stored plays and the at-bat in progress. */
  async gameEvents(gameId: string): Promise<StoredGame> {
    const stored = await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/events`,
      asStoredGame
    )
    return {
      plays: stored.plays.map(row => row.gumbo),
      currentPlay: stored.currentPlay
    }
  }

  /**
   * Scores into a game as it is played: the plays that changed, the indexes
   * an undo took away, and the at-bat in progress when it changed.
   */
  async saveGameEvents(
    gameId: string,
    change: SaveChange
  ): Promise<StoredGame> {
    const stored = await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/events`,
      asStoredGame,
      {
        mode: 'live',
        source: { system: 'teamstation' },
        plays: change.plays,
        remove: change.remove,
        ...(change.currentPlay === undefined
          ? {}
          : { currentPlay: change.currentPlay }),
        ...(change.fenceDistanceFt === undefined
          ? {}
          : { fenceDistanceFt: change.fenceDistanceFt })
      }
    )
    return {
      plays: stored.plays.map(row => row.gumbo),
      currentPlay: stored.currentPlay
    }
  }

  /**
   * Full teams whose name holds `query`, at most 20, for somebody looking for
   * one to follow. The server needs two characters at least.
   */
  async searchTeams(query: string): Promise<FollowableTeam[]> {
    return await this.request(
      'GET',
      `/teams/search?q=${encodeURIComponent(query)}`,
      asArray(asFollowableTeam)
    )
  }

  /** Follows a team. Following one already followed changes nothing. */
  async follow(teamId: string): Promise<boolean> {
    const answer = await this.request(
      'PUT',
      `/teams/${encodeURIComponent(teamId)}/follow`,
      asObject({ following: asBoolean })
    )
    return answer.following
  }

  /** Stops following a team. Unfollowing one not followed changes nothing. */
  async unfollow(teamId: string): Promise<boolean> {
    const answer = await this.request(
      'DELETE',
      `/teams/${encodeURIComponent(teamId)}/follow`,
      asObject({ following: asBoolean })
    )
    return answer.following
  }

  /** The teams this person follows. */
  async myFollows(): Promise<FollowableTeam[]> {
    return await this.request('GET', '/me/follows', asArray(asFollowableTeam))
  }

  /** A team's games, as anybody who can read its listing may see them. */
  async teamSchedule(teamId: string): Promise<ScheduleEntry[]> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/schedule`,
      asArray(asScheduleEntry)
    )
  }

  /** A team's staff, with their roles on it. */
  async teamStaff(teamId: string): Promise<StaffEntry[]> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/staff`,
      asArray(asStaffEntry)
    )
  }

  async roster(teamId: string): Promise<RosterEntry[]> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/roster`,
      asArray(asRosterEntry)
    )
  }

  /**
   * What a coach sets for one player on one team. Only the fields sent
   * change; the answer is the player's roster entry as it now reads.
   */
  async setPlayerSettings(
    teamId: string,
    userId: number | string,
    settings: PlayerSettings
  ): Promise<RosterEntry> {
    return await this.request(
      'PUT',
      `/teams/${encodeURIComponent(teamId)}/players/${encodeURIComponent(userId)}/settings`,
      asRosterEntry,
      settings
    )
  }

  /**
   * Sets a player's walk-up song on one team, for a songkeeper. The answer
   * is the song as it was stored.
   */
  async setWalkUpSong(
    teamId: string,
    userId: number | string,
    song: WalkUpSong
  ): Promise<WalkUpSong> {
    return await this.request(
      'PUT',
      walkUpSongPath(teamId, userId),
      asWalkUpSong,
      song
    )
  }

  /** Removes a player's walk-up song on one team. Removing none is fine. */
  async clearWalkUpSong(
    teamId: string,
    userId: number | string
  ): Promise<void> {
    await this.request('DELETE', walkUpSongPath(teamId, userId), asUnknownOk)
  }

  /** A player's guardians and adult family members, guardians first. */
  async guardians(
    teamId: string,
    userId: number | string
  ): Promise<Guardian[]> {
    return await this.request(
      'GET',
      guardiansPath(teamId, userId),
      asArray(asGuardian)
    )
  }

  /**
   * Links a guardian or adult family member, by account or by address. An
   * address with no account is sent an invitation only it can redeem.
   */
  async addGuardian(
    teamId: string,
    userId: number | string,
    who: { userId: number } | { email: string },
    kind: RelativeKind = 'guardian'
  ): Promise<AddedGuardian> {
    return await this.request(
      'POST',
      guardiansPath(teamId, userId),
      asAddedGuardian,
      'userId' in who
        ? { userId: String(who.userId), kind }
        : { email: who.email, kind }
    )
  }

  /** Unlinks a guardian or family member, with what the link granted. */
  async removeGuardian(
    teamId: string,
    userId: number | string,
    guardianId: number
  ): Promise<boolean> {
    const answer = await this.request(
      'DELETE',
      `${guardiansPath(teamId, userId)}/${encodeURIComponent(guardianId)}`,
      asObject({ removed: asBoolean })
    )
    return answer.removed
  }

  /**
   * Sets a player's year and month of birth, never a day, or clears it with
   * null. Answers the month as `YYYY-MM`, or null.
   */
  async setBirthMonth(
    userId: number | string,
    birth: { year: number; month: number } | null
  ): Promise<string | null> {
    const answer = await this.request(
      'PUT',
      `/players/${encodeURIComponent(userId)}/birth-month`,
      asObject({ birthMonth: asNullable(asString) }),
      birth ?? { year: null, month: null }
    )
    return answer.birthMonth
  }

  /** Says whether a league is a SafeSport Local Affiliated Organization. */
  async setSafesport(leagueId: string, lao: boolean): Promise<boolean> {
    const answer = await this.request(
      'PUT',
      `/manage/league/${encodeURIComponent(leagueId)}/safesport`,
      asObject({ safesportLao: asBoolean }),
      { lao }
    )
    return answer.safesportLao
  }

  /** Every chat the caller is in. */
  async chatConversations(): Promise<ChatConversation[]> {
    return await this.request(
      'GET',
      '/chat/conversations',
      asArray(asChatConversation)
    )
  }

  /** A chat's current members. */
  async chatMembers(conversationId: string): Promise<ChatMember[]> {
    return await this.request(
      'GET',
      `${chatPath(conversationId)}/members`,
      asArray(asChatMember)
    )
  }

  /** Every member's read cursor in a chat. */
  async chatReads(conversationId: string): Promise<ChatRead[]> {
    return await this.request(
      'GET',
      `${chatPath(conversationId)}/reads`,
      asArray(asChatRead)
    )
  }

  /** A chat's membership log after `after` (0 for all of it). */
  async chatLog(conversationId: string, after = 0): Promise<ChatLogRow[]> {
    return await this.request(
      'GET',
      `${chatPath(conversationId)}/log?after=${encodeURIComponent(after)}`,
      asArray(asChatLogRow)
    )
  }

  /** The people the caller may start a DM with, matching `query`. */
  async dmCandidates(query = ''): Promise<ChatPerson[]> {
    return await this.request(
      'GET',
      `/chat/dm-candidates?q=${encodeURIComponent(query)}`,
      asArray(asChatPerson)
    )
  }

  /**
   * Adults who may be included beside these players, as SafeSport's MAAPP
   * asks: suggestions without a query, every match with one.
   */
  async includedAdults(
    playerIds: number[],
    query = ''
  ): Promise<IncludedAdult[]> {
    const ids = playerIds.map(id => encodeURIComponent(id)).join(',')
    return await this.request(
      'GET',
      `/chat/included-adults?playerIds=${ids}&q=${encodeURIComponent(query)}`,
      asArray(asIncludedAdult)
    )
  }

  /**
   * Starts a DM with these people, or answers the open one-to-one already
   * there. A refusal carries `details.reason`: `notCandidate`, or
   * `adultRequired` with `playerIds`.
   */
  async createDm(userIds: number[]): Promise<ChatConversation> {
    return await this.request('POST', '/chat/dms', asChatConversation, {
      userIds
    })
  }

  /** Adds people to a DM the caller is in; answers who was added. */
  async addDmMembers(
    conversationId: string,
    userIds: number[]
  ): Promise<number[]> {
    const answer = await this.request(
      'POST',
      `/chat/dms/${encodeURIComponent(conversationId)}/members`,
      asObject({ added: asArray(asUserId) }),
      { userIds }
    )
    return answer.added
  }

  /** Leaves a DM; answers whether leaving closed it. */
  async leaveDm(conversationId: string): Promise<{ closed: boolean }> {
    const answer = await this.request(
      'DELETE',
      `/chat/dms/${encodeURIComponent(conversationId)}/members/me`,
      asObject({ closed: asBoolean })
    )
    return { closed: answer.closed }
  }

  /** Registers this device for chat and binds it to the session. */
  async registerChatDevice(
    device: ChatDeviceRegistration
  ): Promise<ChatDevice> {
    return await this.request('POST', '/chat/devices', asChatDevice, device)
  }

  /** Every chat device of the caller's, revoked ones included. */
  async chatDevices(): Promise<ChatDevice[]> {
    return await this.request('GET', '/chat/devices', asArray(asChatDevice))
  }

  /** Revokes one of the caller's devices (this one, to sign out). */
  async revokeChatDevice(deviceId: string): Promise<ChatDevice> {
    return await this.request(
      'DELETE',
      `/chat/devices/${encodeURIComponent(deviceId)}`,
      asChatDevice
    )
  }

  /** A nonce for this device to sign, to bind it to the current session. */
  async chatResumeChallenge(deviceId: string): Promise<ChatResumeChallenge> {
    return await this.request(
      'POST',
      `/chat/devices/${encodeURIComponent(deviceId)}/resume-challenge`,
      asChatResumeChallenge
    )
  }

  /**
   * Binds a device to the current session with its signature over the
   * challenge. A refusal carries `deviceRevoked` or `unknownDevice`.
   */
  async resumeChatDevice(
    deviceId: string,
    proof: { nonce: string; signature: string }
  ): Promise<ChatDevice> {
    return await this.request(
      'POST',
      `/chat/devices/${encodeURIComponent(deviceId)}/resume`,
      asChatDevice,
      proof
    )
  }

  /** Publishes the user's first identity and PUK from this device. */
  async enrolChat(identity: ChatIdentityPublication): Promise<ChatEnrolment> {
    return await this.request(
      'PUT',
      '/chat/identity',
      asChatEnrolment,
      identity
    )
  }

  /** Replaces the user's identity from this device; the others are revoked. */
  async resetChatIdentity(
    identity: ChatIdentityPublication
  ): Promise<ChatReset> {
    return await this.request(
      'POST',
      '/chat/identity/reset',
      asChatReset,
      identity
    )
  }

  /** Posts the next PUK generation. */
  async postChatPuk(
    puk: ChatPukPublication
  ): Promise<{ generation: number; grantRequests: number }> {
    return await this.request(
      'POST',
      '/chat/puk',
      asObject({ generation: asNumber, grantRequests: asNumber }),
      puk
    )
  }

  /** The caller's identity, PUK generations and this device's boxes. */
  async myChatKeys(): Promise<ChatMyKeys> {
    return await this.request('GET', '/chat/me/keys', asChatMyKeys)
  }

  /** Another user's current identity and PUK. */
  async chatUserKeys(userId: number): Promise<ChatUserKeys> {
    return await this.request(
      'GET',
      `/chat/users/${encodeURIComponent(userId)}/keys`,
      asChatUserKeys
    )
  }

  /** An identity by id, current or replaced. */
  async chatIdentity(identityId: string): Promise<ChatIdentity> {
    return await this.request(
      'GET',
      `/chat/identities/${encodeURIComponent(identityId)}`,
      asChatIdentity
    )
  }

  /** Asks the user's linked devices to link this one. */
  async requestChatLink(): Promise<ChatLink> {
    return await this.request('POST', '/chat/links', asChatLink)
  }

  /** The open link requests a linked device may approve. */
  async chatLinks(): Promise<ChatPendingLink[]> {
    return await this.request('GET', '/chat/links', asArray(asChatPendingLink))
  }

  /** One link request, with its box once approved. */
  async chatLink(linkId: string): Promise<ChatLink> {
    return await this.request(
      'GET',
      `/chat/links/${encodeURIComponent(linkId)}`,
      asChatLink
    )
  }

  /** Approves a link from this (linked) device. */
  async approveChatLink(
    linkId: string,
    approval: ChatLinkApproval
  ): Promise<ChatLink> {
    return await this.request(
      'POST',
      `/chat/links/${encodeURIComponent(linkId)}/approve`,
      asChatLink,
      approval
    )
  }

  /** One person: their picture, their name, their handedness, their teams. */
  async player(userId: string): Promise<PlayerDetail> {
    return await this.request(
      'GET',
      `/players/${encodeURIComponent(userId)}`,
      asPlayerDetail
    )
  }

  /**
   * A player's name in full, for the field it is typed into.
   *
   * Answered only for a parent or an administrator, and asked for only when
   * that field is opened — never to draw a page.
   */
  async playerName(userId: string): Promise<PlayerName> {
    return await this.request(
      'GET',
      `/players/${encodeURIComponent(userId)}/name`,
      asPlayerName
    )
  }

  /** Every highlight one player is credited on, newest first, a page at a time. */
  async playerHighlights(
    userId: string,
    options: { before?: string; limit?: number } = {}
  ): Promise<PlayerHighlights> {
    const query = new URLSearchParams()
    if (options.before != null) query.set('before', options.before)
    if (options.limit != null) query.set('limit', String(options.limit))
    const text = query.toString()
    return await this.request(
      'GET',
      `/players/${encodeURIComponent(userId)}/highlights${
        text === '' ? '' : `?${text}`
      }`,
      asPlayerHighlights
    )
  }

  /**
   * One player's figures, narrowed to a season, a team or a year.
   *
   * The narrowing is done by the server rather than here: the page would
   * otherwise have to add rows up and work out rates a second time, and two
   * pieces of arithmetic for one figure is one too many.
   */
  async playerStats(
    userId: string,
    filter: { seasonId?: string; teamId?: string; year?: number } = {}
  ): Promise<PlayerStats> {
    const query = new URLSearchParams()
    if (filter.seasonId != null) query.set('seasonId', filter.seasonId)
    if (filter.teamId != null) query.set('teamId', filter.teamId)
    if (filter.year != null) query.set('year', String(filter.year))
    const text = query.toString()
    return await this.request(
      'GET',
      `/players/${encodeURIComponent(userId)}/stats${
        text === '' ? '' : `?${text}`
      }`,
      asPlayerStats
    )
  }

  /** A team's batting for a season, or across every season when unset. */
  async teamStats(teamId: string, seasonId?: string): Promise<BattingRow[]> {
    const query =
      seasonId == null ? '' : `?seasonId=${encodeURIComponent(seasonId)}`
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/stats${query}`,
      asArray(asBattingRow)
    )
  }

  async teamPitchingStats(
    teamId: string,
    seasonId?: string
  ): Promise<PitchingRow[]> {
    const query = new URLSearchParams({ kind: 'pitching' })
    if (seasonId != null) query.set('seasonId', seasonId)
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/stats?${query.toString()}`,
      asArray(asPitchingRow)
    )
  }

  async standings(seasonId: string): Promise<StandingsRow[]> {
    return await this.request(
      'GET',
      `/seasons/${encodeURIComponent(seasonId)}/standings`,
      asArray(asStandingsRow)
    )
  }

  /** The invite codes for one league, season or team. */
  async invites(
    scopeType: 'league' | 'season' | 'team',
    scopeId: string
  ): Promise<InviteList> {
    return await this.request(
      'GET',
      `/invites?scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId)}`,
      asInviteList
    )
  }

  async createInvite(options: {
    scopeType: 'league' | 'season' | 'team'
    scopeId: string
    code?: string
    label?: string
    maxUses?: number
    expiresAt?: string
  }): Promise<Invite> {
    return await this.request('POST', '/invites', asInvite, options)
  }

  /** Stops an invite. The row stays, so who came in through it still reads. */
  async revokeInvite(inviteId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/invites/${encodeURIComponent(inviteId)}`,
      asUnknownOk
    )
  }

  /** What a code is worth, asked before anybody signs in. */
  async inviteInfo(code: string): Promise<InviteInfo> {
    return await this.request(
      'GET',
      `/join/${encodeURIComponent(code)}`,
      asInviteInfo
    )
  }

  /** Take up the invite as whoever is signed in now. */
  async redeemInvite(code: string): Promise<Redeemed> {
    return await this.request(
      'POST',
      `/join/${encodeURIComponent(code)}/redeem`,
      asRedeemed,
      {}
    )
  }

  /**
   * Asks for a sign-in code that carries the invite, which is what lets
   * somebody with no account come in through one: the account is made when
   * that code is typed or its link opened, not now.
   */
  async requestInviteCode(
    code: string,
    options: { email: string; displayName?: string; next?: string }
  ): Promise<SignInWait> {
    return await this.request(
      'POST',
      `/join/${encodeURIComponent(code)}/email-code`,
      asSignInWait,
      { ...options, origin: 'web' }
    )
  }

  /** Everything the page behind the gear needs, in one call. */
  async managePage(
    kind: 'league' | 'season' | 'team',
    id: string
  ): Promise<ManagePage> {
    return await this.request(
      'GET',
      `/manage/${kind}/${encodeURIComponent(id)}`,
      asManagePage
    )
  }

  /**
   * Add one person by address: straight in if they have an account, and an
   * invitation in the post if they do not.
   */
  async addPerson(
    kind: 'league' | 'season' | 'team',
    id: string,
    email: string
  ): Promise<AddedPerson> {
    return await this.request(
      'POST',
      `/manage/${kind}/${encodeURIComponent(id)}/people`,
      asAddedPerson,
      { email }
    )
  }

  /** Take away what this level grants, and only that. */
  async removePerson(
    kind: 'league' | 'season' | 'team',
    id: string,
    userId: number
  ): Promise<{ removed: boolean }> {
    return await this.request(
      'DELETE',
      `/manage/${kind}/${encodeURIComponent(id)}/people/${encodeURIComponent(userId)}`,
      asObject({ removed: asBoolean })
    )
  }

  /**
   * What somebody is at this level: its administrator, or one of its people.
   *
   * Scoped to the level being managed and no other, which is why the screen
   * can say "team admin" rather than "admin" and mean it. Either answer
   * leaves them able to watch.
   */
  async setRole(
    kind: 'league' | 'season' | 'team',
    id: string,
    userId: number,
    role: 'admin' | 'member'
  ): Promise<void> {
    await this.request(
      'PUT',
      `/manage/${kind}/${encodeURIComponent(id)}/people/${encodeURIComponent(userId)}/role`,
      asObject({ userId: asUserId, role: asString }),
      { role }
    )
  }

  /**
   * Everything somebody holds at this level: administrator or not, and which
   * of the four flags. The whole set, so a flag left out is taken away.
   */
  async setRoles(
    kind: 'league' | 'season' | 'team',
    id: string,
    userId: number,
    roles: { admin: boolean; flags: RoleFlag[] }
  ): Promise<Role[]> {
    const answer = await this.request(
      'PUT',
      `/manage/${kind}/${encodeURIComponent(id)}/people/${encodeURIComponent(userId)}/roles`,
      asObject({ userId: asUserId, roles: asArray(asRole) }),
      roles
    )
    return answer.roles
  }

  /** The roles the signed-in person holds, team by team. */
  async myRoles(): Promise<MyRoles> {
    return await this.request('GET', '/me/roles', asMyRoles)
  }

  private async request<T>(
    method: string,
    path: string,
    cleaner: Cleaner<T>,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.token != null) headers.authorization = `Bearer ${this.token}`

    // `fetch` rejects with a bare TypeError when the request never leaves the
    // device — no data, aeroplane mode, a captive portal at the field. Safari
    // words that "Load failed", Chrome "Failed to fetch", and either one
    // reaching a parent reads as "the site is broken" when the site is fine.
    // The distinction is worth keeping: this app is used on a phone at the edge
    // of a ball field, where no signal is the ordinary case, not the exception.
    let response: Response
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        // The session lives in an `HttpOnly` cookie, which this code cannot
        // read and therefore cannot put in a header. `include` is what sends
        // it when the app and the API are different origins, as they are in
        // development.
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch (caught: unknown) {
      throw new HttpError(
        'offline',
        'Cannot reach TeamStation. Check your connection and try again.'
      )
    }

    const text = await response.text()
    if (!response.ok) throw errorFrom(response.status, text)
    if (text === '') return cleaner(undefined)

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new HttpError('internal', 'The server sent something unreadable')
    }
    return cleaner(parsed)
  }
}

function guardiansPath(teamId: string, userId: number | string): string {
  return `/teams/${encodeURIComponent(teamId)}/players/${encodeURIComponent(userId)}/guardians`
}

function walkUpSongPath(teamId: string, userId: number | string): string {
  return `/teams/${encodeURIComponent(teamId)}/players/${encodeURIComponent(userId)}/walk-up-song`
}

/** For the endpoints whose body carries nothing a caller needs. */
function chatPath(conversationId: string): string {
  return `/chat/conversations/${encodeURIComponent(conversationId)}`
}

const asUnknownOk: Cleaner<null> = () => null

/**
 * Turns a failed response back into the same `HttpError` the server threw, so
 * a caller can branch on `code` rather than on a status number.
 */
function errorFrom(status: number, text: string): HttpError {
  let api: ApiError | undefined
  try {
    api = asApiError(JSON.parse(text))
  } catch {
    api = undefined
  }
  if (api != null) return new HttpError(api.code, api.message, api.details)
  return new HttpError('internal', `The server answered ${status}`)
}

/*
 * Dictation's wire. One socket at `/api/v1/dictation` carries PCM and these
 * control frames up, and the reply frames down. Every frame names its `kind`,
 * and every frame about an utterance carries that utterance's `id`, so a reply
 * is never matched to the wrong sentence. Both ends clean with these.
 */

/** An LLM may offer at most this many answers to a question. */
export const MAX_ASK_OPTIONS = 5

const asNonEmpty: Cleaner<string> = raw => {
  const text = asString(raw)
  if (text.trim() === '') throw new TypeError('Expected a non-empty string')
  return text
}
/** Whatever a scope acts on. Each scope cleans its own target. */
const asTarget: Cleaner<Record<string, unknown>> = raw => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
    throw new TypeError('Expected a target object')
  return raw as Record<string, unknown>
}
/** An action, checked by the scoring library's own cleaner. */
export const asWireAction: Cleaner<ScoringAction> = raw => {
  const cleaned = cleanAction(raw)
  if ('problem' in cleaned) throw new TypeError(cleaned.problem.message)
  return cleaned.action
}
const asProblem: Cleaner<Problem> = asObject({
  code: asLiteral(
    'unknownAction',
    'malformed',
    'notNow',
    'illegal',
    'unknownPlayer',
    'gameOver'
  ),
  message: asString
})

/** Opens an utterance. The context is the game as it stands right now. */
const asStartBody = asObject({
  id: asNonEmpty,
  scope: asNonEmpty,
  target: asTarget,
  context: asNonEmpty,
  /** Absent means the model the server is configured with. */
  model: asOptional(asLiteral(...DICTATION_MODELS))
})
export type DictationStart = { kind: 'start' } & ReturnType<typeof asStartBody>
export const asDictationStart: Cleaner<DictationStart> = raw => {
  if ((raw as { kind?: unknown } | null)?.kind !== 'start')
    throw new TypeError('Expected a start frame')
  return { kind: 'start', ...asStartBody(raw) }
}

/** Retargets the recogniser. Sent ahead of the utterances that will use it. */
export interface DictationKeyterms {
  kind: 'keyterms'
  keyterms: string[]
}
export const asDictationKeyterms: Cleaner<DictationKeyterms> = raw => {
  if ((raw as { kind?: unknown } | null)?.kind !== 'keyterms')
    throw new TypeError('Expected a keyterms frame')
  return { kind: 'keyterms', ...asObject({ keyterms: asArray(asString) })(raw) }
}

/** Ends the audio of an utterance. */
export interface DictationRelease {
  kind: 'release'
  id: string
}
export const asDictationRelease: Cleaner<DictationRelease> = raw => {
  if ((raw as { kind?: unknown } | null)?.kind !== 'release')
    throw new TypeError('Expected a release frame')
  return { kind: 'release', ...asObject({ id: asNonEmpty })(raw) }
}

/** The scorer's reply to an `ask`: an option chosen, or the question dismissed. */
export const asDictationAnswer: Cleaner<
  | { kind: 'answer'; id: string; option: number }
  | { kind: 'dismiss'; id: string }
> = raw => {
  const kind = (raw as { kind?: unknown } | null)?.kind
  if (kind === 'dismiss')
    return { kind: 'dismiss', ...asObject({ id: asNonEmpty })(raw) }
  if (kind !== 'answer') throw new TypeError('Expected an answer or dismiss')
  const answer = asObject({ id: asNonEmpty, option: asNumber })(raw)
  if (!Number.isInteger(answer.option) || answer.option < 0)
    throw new TypeError('Expected an option index')
  return { kind: 'answer', ...answer }
}
export type DictationAnswer = ReturnType<typeof asDictationAnswer>

/** Any control frame the browser sends up. */
export type DictationUp =
  DictationStart | DictationKeyterms | DictationRelease | DictationAnswer
export const asDictationUp: Cleaner<DictationUp> = raw => {
  switch ((raw as { kind?: unknown } | null)?.kind) {
    case 'start':
      return asDictationStart(raw)
    case 'keyterms':
      return asDictationKeyterms(raw)
    case 'release':
      return asDictationRelease(raw)
    case 'answer':
    case 'dismiss':
      return asDictationAnswer(raw)
    default:
      throw new TypeError('Unknown dictation frame')
  }
}

const asAskOption: Cleaner<{
  label: string
  actions?: ScoringAction[]
}> = raw => {
  const { label, actions } = asObject({
    label: asNonEmpty,
    actions: asOptional(asArray(asWireAction))
  })(raw)
  return actions == null ? { label } : { label, actions }
}
/** Truncated rather than refused: a model has returned 14 for a limit of 5. */
const asAskOptions: Cleaner<Array<ReturnType<typeof asAskOption>>> = raw => {
  const options = asArray(asAskOption)(raw).slice(0, MAX_ASK_OPTIONS)
  if (options.length === 0) throw new TypeError('A question needs an option')
  return options
}

/** Every frame the route sends down. */
export type DictationReply =
  | { kind: 'partial'; id: string; text: string }
  | { kind: 'transcript'; id: string; text: string }
  | {
      kind: 'actions'
      id: string
      transcript: string
      actions: ScoringAction[]
      dropped: Problem[]
      /** Take back the last thing scored, as Undo does, before the actions. */
      undo?: boolean
    }
  | {
      kind: 'ask'
      id: string
      question: string
      options: Array<{ label: string; actions?: ScoringAction[] }>
    }
  | { kind: 'error'; id: string | null; message: string }
export const asDictationReply: Cleaner<DictationReply> = raw => {
  const kind = (raw as { kind?: unknown } | null)?.kind
  switch (kind) {
    case 'partial':
    case 'transcript':
      return { kind, ...asObject({ id: asNonEmpty, text: asString })(raw) }
    case 'actions': {
      const { undo, ...rest } = asObject({
        id: asNonEmpty,
        transcript: asString,
        actions: asArray(asWireAction),
        dropped: asOptional(asArray(asProblem), () => []),
        undo: asOptional(asBoolean)
      })(raw)
      return { kind, ...rest, ...(undo === true ? { undo } : {}) }
    }
    case 'ask':
      return {
        kind,
        ...asObject({
          id: asNonEmpty,
          question: asNonEmpty,
          options: asAskOptions
        })(raw)
      }
    case 'error':
      return {
        kind,
        ...asObject({ id: asNullable(asString), message: asString })(raw)
      }
    default:
      throw new TypeError('Unknown dictation reply')
  }
}
