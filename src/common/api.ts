import {
  asArray,
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  asTuple,
  asUnknown,
  asValue,
  type Cleaner
} from 'cleaners'

import {
  type AccountPicture,
  type AccountSettings,
  asAccountEmailPending,
  asAccountSettings
} from './accountSettings'
import { type ApiKey, type ApiKeyCreate, asApiKey, asApiKeys } from './apiKeys'
import { asLiteral } from './asLiteral'
import { type Approval, asApproval, asBuildsLink } from './distribution'
import { type ApiError, asApiError, HttpError } from './errors'
import {
  asEventInfo,
  asEventLocation,
  asRsvp,
  type EventInfo,
  type Rsvp,
  type TeamEventInput,
  withEventMetadata
} from './eventInfo'
import {
  asEventPlaces,
  type EventPlace,
  type EventPlaceKind
} from './eventPlaces'
import { DEFAULT_FENCE_DISTANCE_FT } from './fenceDistance'
import {
  asGameScheduleProposal,
  asGameScheduling,
  type GameProposal,
  type GameScheduleProposal
} from './gameApprovals'
import {
  asGroupRef,
  type CreateGroup,
  type GroupKind,
  type GroupRef,
  isRecord
} from './groupCreation'
import {
  asParentPreview,
  type ParentAction,
  type ParentPreview
} from './groupLinks'
import { asGuests } from './guests'
import { asCount, asCurrentPlay, asGumboPlay } from './gumboPlay'
import { asLocality, type Locality } from './locality'
import {
  asNodeAccounts,
  type NodeAccount,
  type NodeAccountChange
} from './nodeAdministration'
import {
  asNodeSettings,
  asScoreboardOverlay,
  type NodeSettings,
  type ScoreboardOverlay
} from './nodeSettings'
import {
  asNotification,
  asNotificationPage,
  type Notification,
  type RelationshipRequestInput
} from './notifications'
import { type AnalyticsSink, observeApi } from './observability/apiEvents'
import { asOnboarding, type Onboarding } from './onboarding'
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
import type { AvailablePicture } from './pictureCatalog'
import {
  asPlayerNamePrivacy,
  type PlayerNamePrivacy
} from './playerNamePrivacy'
import type {
  ExistingRosterPlayer,
  NewRosterPlayer,
  PersonSettings,
  PlayerSettings
} from './playerSettings'
import {
  asGroupDetail,
  asPublicGroup,
  asSearchRow,
  type GroupDetail,
  type PublicGroup,
  type SearchRow
} from './publicGroups'
import { asRole, asRoleFlag, type Role, type RoleFlag } from './roles'
import {
  type AddedGame,
  asGameToReschedule,
  asPublication,
  asSchedulePreview,
  type GameToReschedule,
  type PreviewRequest,
  type Publication,
  type SchedulePreview
} from './schedulePreviews'
import { asScoreboardState, type ScoreboardState } from './scoreboard'
import {
  cleanAction,
  type Problem,
  type ScoringAction
} from './scoring/actions'
import type { BoardLine } from './scoring/boardLineTypes'
import {
  asDefaultLineup,
  asSideLineups,
  type DefaultLineup,
  type Lineup,
  type LineupChange,
  type LineupPerson,
  type SideLineups
} from './scoring/lineupHistory'
import { asSwapEffect } from './scoring/playsLost'
import {
  asSaidRosterCommand,
  type SaidRosterCommand
} from './scoring/rosterCommands'
import type { SaveChange, StoredGame } from './scoring/session'
import { type Position, POSITIONS, type Side } from './scoring/state'
import {
  asScheduleSetup,
  asSeasonScheduleSettings,
  type ScheduleSettings,
  type ScheduleSetup,
  type ScheduleSetupChoice,
  type SeasonScheduleSettings
} from './seasonScheduling'
import { type ServerSentEvent, serverSentEvents } from './serverSentEvents'
import {
  asTvLoginPreview,
  asTvLoginRequest,
  type TvLoginPreview,
  type TvLoginRequest,
  type TvPlatform
} from './tvLogin'
import {
  asUmpireLeaderboard,
  asUmpireLeagues,
  asUmpireLevel,
  asUmpireLevels,
  asUmpirePeople,
  asUmpireSchedule,
  asUmpireSeasons,
  asUmpireSettings,
  asUmpireTypes
} from './umpireCleaners'
import type { UmpireEdit } from './umpireEdits'
import type {
  UmpireCertification,
  UmpireLevel,
  UmpirePerson,
  UmpireSeason,
  UmpireSettings,
  UmpireType,
  UmpireTypeCount
} from './umpires'
import type {
  UmpireLeaderboard,
  UmpireLeague,
  UmpireSchedule
} from './umpireSchedule'
import { asUnrostered } from './unroster'
import { asGumboId, asUserId } from './userId'
import {
  asVenueDetail,
  asVenueSummary,
  type VenueDetail,
  type VenueSummary
} from './venues'
import { asWalkUpSong, type WalkUpSong } from './walkUpSong'
import type { WallTimeline } from './wallTimeline'

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

/**
 * A key that may be missing, and whose value may be null when it is there.
 * `asOptional` turns a null into the fallback, which loses the difference.
 */
const asAbsentOr =
  <T>(cleaner: Cleaner<T>): Cleaner<T | undefined> =>
  raw =>
    raw === undefined ? undefined : cleaner(raw)

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
   * `full` for a team and the compatible `external` token for a placeholder.
   * Placeholder identity is independent of season membership and exhibition
   * game classification. Older servers omit this field and default to full.
   */
  seasonCategory: asOptional(
    asLiteral('inSeason', 'exhibition', 'unscheduled'),
    'unscheduled'
  ),
  canViewPrivate: asOptional(asBoolean, false),
  /** Optional compatibility fields sent by older team-list servers. */
  access: asOptional(asLiteral('member', 'fan')),
  following: asOptional(asBoolean),
  onTeam: asOptional(asBoolean),
  kind: asOptional(asEither(asLiteral('full'), asLiteral('external')), 'full')
})
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
  left: asBoolean,
  avatarUrl: asOptional(asNullable(asString), null)
})
export type ChatDmPerson = ReturnType<typeof asChatDmPerson>

/**
 * One chat the caller is in, from `GET /chat/conversations`. `title` is null
 * for a DM, which the app names from its members. `locked`: the caller holds
 * no key for the latest epoch; `noHolder`: no current member does.
 */
export const asChatPreferences = asObject({
  pinned: asOptional(asBoolean, false),
  muted: asOptional(asBoolean, false),
  manualUnread: asOptional(asBoolean, false),
  manualUnreadRevision: asOptional(asNumber, 0)
})
export type ChatPreferences = ReturnType<typeof asChatPreferences>
export const asChatPin = asObject({ messageId: asString, pinnedAt: asString })
export type ChatPin = ReturnType<typeof asChatPin>

export const asChatConversation = asObject({
  id: asString,
  kind: asChatKind,
  title: asNullable(asString),
  scope: asNullable(
    asObject({ type: asLiteral('team', 'season', 'league'), id: asString })
  ),
  /**
   * The scope's own name, as its chats are titled (a team, a season title,
   * a league); null for a DM. The list groups chats by it.
   */
  scopeName: asNullable(asString),
  /** The scope's own identity; absent on older servers and for DMs. */
  avatarName: asOptional(asNullable(asString), null),
  avatarUrl: asOptional(asNullable(asString), null),
  lastSeq: asNumber,
  /** When the newest message was posted, ISO; null before the first. */
  lastMessageAt: asNullable(asString),
  lastPostAt: asOptional(asNullable(asString), null),
  lastPostId: asOptional(asNullable(asString), null),
  lastPostSeq: asOptional(asNumber, 0),
  preferences: asOptional(asChatPreferences, {
    pinned: false,
    muted: false,
    manualUnread: false,
    manualUnreadRevision: 0
  }),
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

/** One epoch of a chat, from `GET /chat/conversations/:id/epochs`. */
export const asChatEpoch = asObject({
  epoch: asNumber,
  createdByUserId: asUserId,
  identityId: asString,
  previousKeyBox: asNullable(asString),
  chainBreak: asBoolean,
  signature: asString,
  createdAt: asString
})
export type ChatEpoch = ReturnType<typeof asChatEpoch>

/** A chat's epochs after `after`, and the caller's boxes from `after` on. */
export const asChatEpochs = asObject({
  latest: asNumber,
  needsRotation: asBoolean,
  noHolder: asBoolean,
  epochs: asArray(asChatEpoch),
  boxes: asArray(
    asObject({
      epoch: asNumber,
      identityId: asString,
      pukGeneration: asNumber,
      box: asString,
      grantedByUserId: asNullable(asUserId)
    })
  )
})
export type ChatEpochs = ReturnType<typeof asChatEpochs>

/** Epoch n+1, signed, boxed to the eligible members. Bytes are base64url. */
export interface ChatEpochPublication {
  epoch: number
  previousKeyBox: string | null
  signature: string
  boxes: Array<{ userId: string; pukGeneration: number; box: string }>
}

export const asChatEpochMade = asObject({
  epoch: asNumber,
  chainBreak: asBoolean,
  boxed: asNumber,
  grantRequests: asNumber
})
export type ChatEpochMade = ReturnType<typeof asChatEpochMade>

/** An open grant request, from `GET /chat/grants`. */
export const asChatGrantRequest = asObject({
  id: asNumber,
  conversationId: asString,
  epoch: asNumber,
  userId: asUserId,
  identityId: asString,
  identityKey: asString,
  pukGeneration: asNumber,
  pukPublicKey: asString,
  pukSignature: asString,
  identityReset: asBoolean,
  canApprove: asBoolean,
  openedAt: asString
})
export type ChatGrantRequest = ReturnType<typeof asChatGrantRequest>

/** One box filling a grant request: the latest epoch's key (HPKE `grant`). */
export interface ChatGrantBox {
  conversationId: string
  epoch: number
  userId: string
  identityId: string
  pukGeneration: number
  box: string
}

export const asChatGrantsPosted = asObject({
  filled: asNumber,
  skipped: asArray(
    asObject({
      conversationId: asString,
      userId: asUserId,
      identityId: asString,
      pukGeneration: asNumber,
      reason: asLiteral('notOpen', 'staleEpoch')
    })
  )
})
export type ChatGrantsPosted = ReturnType<typeof asChatGrantsPosted>

/** What the server sees of a message: its envelope `kind`. */
export const asChatEnvelopeKind = asLiteral(
  'post',
  'reaction',
  'edit',
  'delete',
  'moderatorDelete'
)
export type ChatEnvelopeKind = ReturnType<typeof asChatEnvelopeKind>

/** One message, from `GET …/messages`; `ciphertext` is empty once cleared. */
export const asChatMessage = asObject({
  id: asString,
  conversationId: asString,
  seq: asNumber,
  epoch: asNumber,
  senderUserId: asUserId,
  senderIdentityId: asString,
  kind: asChatEnvelopeKind,
  targetIds: asNullable(asArray(asString)),
  nonce: asString,
  ciphertext: asString,
  signature: asString,
  attachmentIds: asArray(asString),
  clearedAt: asNullable(asString),
  createdAt: asString
})
export type ChatMessage = ReturnType<typeof asChatMessage>

/**
 * An encrypted attachment still arriving (`completed: false`, with the parts
 * `missing`, numbered from 0, each `partSize` bytes but the last), or a
 * finished one (`completed: true`; `url`, a presigned GET good for 10
 * minutes, and `expiresAt` only when read). `digest` is the blob's SHA-256,
 * base64url.
 */
export const asChatAttachment = asEither(
  asObject({
    id: asString,
    conversationId: asString,
    size: asNumber,
    completed: asValue(false),
    partSize: asNumber,
    parts: asNumber,
    missing: asArray(asNumber)
  }),
  asObject({
    id: asString,
    conversationId: asString,
    size: asNumber,
    digest: asString,
    completed: asValue(true),
    url: asOptional(asString),
    expiresAt: asOptional(asString)
  })
)
export type ChatAttachment = ReturnType<typeof asChatAttachment>

/** What a part's upload answers: how many have landed, and what is left. */
export const asChatAttachmentParts = asObject({
  received: asNumber,
  parts: asNumber,
  missing: asArray(asNumber)
})
export type ChatAttachmentParts = ReturnType<typeof asChatAttachmentParts>

/**
 * A message to post, sealed and signed by the device. `targetIds` only on
 * the two deletes, `attachmentIds` only on posts. Bytes are base64url.
 */
export interface ChatMessageEnvelope {
  id: string
  epoch: number
  kind: ChatEnvelopeKind
  senderIdentityId: string
  targetIds?: string[]
  attachmentIds?: string[]
  nonce: string
  ciphertext: string
  signature: string
}

/** A reported message, as site administrators see it. */
export const asChatReport = asObject({
  id: asString,
  conversation: asObject({
    id: asString,
    kind: asChatKind,
    title: asNullable(asString)
  }),
  messageId: asString,
  reporter: asObject({ userId: asUserId, shortName: asString }),
  sender: asObject({ userId: asUserId, shortName: asString }),
  kind: asChatEnvelopeKind,
  sentAt: asString,
  plaintext: asString,
  verified: asBoolean,
  createdAt: asString,
  resolvedAt: asNullable(asString)
})
export type ChatReport = ReturnType<typeof asChatReport>

/**
 * A team on a season's list: `exhibition` is set, and true, when the
 * season's admin flagged it as an exhibition team. Older servers omit it.
 */
export type SeasonTeamSummary = TeamSummary & { exhibition?: true }
function asSeasonTeamSummary(raw: unknown): SeasonTeamSummary {
  const team = asTeamSummary(raw)
  return isRecord(raw) && raw.exhibition === true
    ? { ...team, exhibition: true }
    : team
}

export const asGameSummary = withEventMetadata(
  asObject({
    id: asString,
    homeTeamId: asString,
    awayTeamId: asString,
    homeTeamName: asString,
    awayTeamName: asString,
    seasonId: asNullable(asString),
    startAt: asNullable(asString),
    venue: asNullable(asString),
    exhibition: asOptional(asBoolean, false),
    timezone: asOptional(asString, 'UTC'),
    pendingApproval: asOptional(asBoolean, false),
    pendingRequestId: asOptional(asNullable(asString), null),
    cancellationReason: asOptional(asNullable(asString), null),
    withdrawnByTeamId: asOptional(asNullable(asString), null),
    withdrawnByTeamName: asOptional(asNullable(asString), null),
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
)
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
  /**
   * Bytes are arriving on a stream of this video.
   *
   * A video stays `live` after its camera drops, so the recording can resume
   * on the same row. This says whether anything is sending right now. An
   * older server omits it, which means nothing is.
   */
  receiving: asOptional(asBoolean, false),
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

export const asGameDetail = withEventMetadata(
  asObject({
    umpires: asOptional(
      asEither(
        asObject({
          positions: asArray(
            asObject({
              slot: asString,
              typeId: asString,
              typeName: asString,
              ordinal: asNumber,
              required: asBoolean,
              person: asEither(
                asObject({
                  userId: asString,
                  name: asString,
                  avatarUrl: asOptional(asNullable(asString))
                }),
                asLiteral(null)
              )
            })
          )
        }),
        asLiteral(null)
      ),
      null
    ),
    guests: asGuests,
    unrostered: asUnrostered,
    guestPlayers: asOptional(
      asObject({
        away: asArray((raw: unknown): RosterEntry => asRosterEntry(raw)),
        home: asArray((raw: unknown): RosterEntry => asRosterEntry(raw))
      }),
      () => ({ away: [], home: [] })
    ),
    id: asString,
    homeTeamId: asString,
    awayTeamId: asString,
    /** The game's play generation; an older server sends none. */
    generation: asOptional(asNumber, 0),
    homeTeamName: asString,
    awayTeamName: asString,
    seasonId: asNullable(asString),
    startAt: asNullable(asString),
    venue: asNullable(asString),
    exhibition: asOptional(asBoolean, false),
    timezone: asOptional(asString, 'UTC'),
    pendingApproval: asOptional(asBoolean, false),
    pendingRequestId: asOptional(asNullable(asString), null),
    cancellationReason: asOptional(asNullable(asString), null),
    withdrawnByTeamId: asOptional(asNullable(asString), null),
    withdrawnByTeamName: asOptional(asNullable(asString), null),
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
     * Whether this viewer may DJ the game: a songkeeper or scorekeeper of
     * either team, which every administrator of it is. Absent from an older
     * server, and false.
     */
    canDj: asOptional(asBoolean, false),
    /** Assigned roles, including season/league inheritance, without implied privileges. UI only. */
    assignedRoles: asOptional(
      asObject({ away: asArray(asRole), home: asArray(asRole) }),
      () => ({ away: [], home: [] })
    ),
    /**
     * The sides whose team this viewer head-coaches, which every administrator
     * of it does, and so whose lineup they may save. An assistant has none.
     * Absent from an older server, and none.
     */
    coachSides: asOptional(asArray(asLiteral('away', 'home')), []),
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
    /**
     * Whether this caller is not a member of either team, including signed-out viewers: `linescore`
     * then carries each side's runs alone, `canScore` and `canDj` are false,
     * and the box score and playback answer `membersOnly`. False for members.
     */
    nonMemberView: asBoolean,
    /**
     * Whether anything TeamStation scored is stored for this game, so it can
     * be replayed. False from a server from before replays.
     */
    replayable: asOptional(asBoolean, false),
    videos: asArray(asVideoSummary)
  })
)
export type GameDetail = ReturnType<typeof asGameDetail>

export const asHighlight = asObject({
  eventId: asString,
  atBatIndex: asNumber,
  title: asString,
  startOffsetSec: asNumber,
  playOffsetSec: asNumber,
  /** Where it stops; absent from a server from before the setting. */
  endOffsetSec: asOptional(asNumber),
  eventType: asNullable(asString),
  isScoringPlay: asBoolean,
  /** One frame of the video at the moment of the play. */
  stillUrl: asString,
  /**
   * The play in a sentence, for the panel under the video: TeamStation's own
   * reading of it, written by the server when it answers. The list draws
   * `title`; only that panel draws this.
   */
  description: asOptional(asNullable(asString), null),
  tag: asOptional(asNullable(asString), null)
})
export type Highlight = Omit<
  ReturnType<typeof asHighlight>,
  'tag' | 'endOffsetSec'
> & {
  tag?: string | null
  endOffsetSec?: number
}

export const asHighlightsResponse = asObject({
  withheld: asNullable(asString),
  /** Plays left out because nobody could be named on them. */
  droppedCount: asOptional(asNumber, 0),
  highlights: asArray(asHighlight)
})
export type HighlightsResponse = Omit<
  ReturnType<typeof asHighlightsResponse>,
  'highlights'
> & { highlights: Highlight[] }

export type TvHighlight = Highlight & { preferred: boolean }
const asTvHighlights = asObject({
  highlights: asArray((raw: unknown): TvHighlight => ({
    ...asHighlight(raw),
    ...asObject({ preferred: asBoolean })(raw)
  }))
})

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
  /** Null on a withdrawn line: a placeholder in the game, nobody to open. */
  userId: asNullable(asUserId),
  /**
   * Whether the line opens its player's page for this viewer: false for a
   * withdrawn line, and for a pool player the viewer could not already see.
   * Absent from older servers and from team tables, which is true.
   */
  openable: asOptional(asBoolean, true),
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
  seasonAvg: asOptional(asNullable(asNumber), null),
  /** A withdrawn line's: the gumbo id of the batter it stands in for. */
  standsFor: asOptional(asNullable(asNumber), null)
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
  /** Null on a withdrawn line: a placeholder in the game, nobody to open. */
  userId: asNullable(asUserId),
  /**
   * Whether the line opens its player's page for this viewer: false for a
   * withdrawn line, and for a pool player the viewer could not already see.
   * Absent from older servers and from team tables, which is true.
   */
  openable: asOptional(asBoolean, true),
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

export const asSeasonStats = asObject({
  seasonId: asString,
  batting: asArray(asBattingRow),
  pitching: asArray(asPitchingRow)
})
export type SeasonStats = ReturnType<typeof asSeasonStats>

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

/**
 * A roster's sections, in the order they are listed: administrators, staff
 * (coach, assistant, scorekeeper, songkeeper, videographer), players, the
 * players' guardians, the other members (of the team, or of its season or
 * league), and the people who follow the team.
 */
export const asRosterSection = asLiteral(
  'admin',
  'staff',
  'player',
  'family',
  'spectator',
  'follower'
)
export type RosterSection = ReturnType<typeof asRosterSection>

const cleanRosterEntry = asObject({
  /** Only sent for an explicitly authorized roster-management read. */
  nameDetails: asOptional(
    asObject({
      firstName: asNullable(asString),
      lastName: asNullable(asString),
      displayName: asString
    })
  ),
  bats: asOptional(asBats, null),
  throws: asOptional(asThrows, null),
  userId: asUserId,
  gumboId: asOptional(asNullable(asGumboId), null),
  /**
   * The public name: first name, last initial, unless the team has chosen
   * another format. The field is named for what it is so a stored full name
   * cannot be shipped here by accident — the compiler visits every call site,
   * where a reviewer might not.
   */
  shortName: asString,
  /** The public format of `shortName`, unless it is the built-in one. */
  nameFormat: asOptional(asPlayerNamePrivacy),
  avatarUrl: asOptional(asNullable(asString), null),
  jersey: asNullable(asString),
  positions: asArray(asString),
  isPlayer: asBoolean,
  role: asString,
  /** The section they are listed under: the first of these that fits. */
  section: asRosterSection,
  /** The flags they were given on the team or above it, in flag order. */
  staffRoles: asArray(asRoleFlag),
  /**
   * For somebody listed for a role given above the team, the highest level
   * that gives it ("League admin", "Season coach"), and for a spectator
   * who is a member through the team's season or league, that level with
   * `member` ("Season spectator"); null for the team's own.
   */
  inheritedFrom: asNullable(
    asObject({
      level: asLiteral('season', 'league'),
      role: asEither(asRole, asLiteral('member'))
    })
  ),
  /** Their walk-up song on this team, or null for none. */
  walkUpSong: asOptional(asNullable(asWalkUpSong), null),
  /**
   * On a season's or league's people list, the teams a player plays on
   * there; absent from a team's roster, where the team is the page.
   */
  teamNames: asOptional(asArray(asString)),
  /**
   * Under a family member, the players on this list they are a guardian of,
   * by their short names; absent for everybody else.
   */
  guardianOf: asOptional(asArray(asString))
})
export type RosterEntry = Omit<
  ReturnType<typeof cleanRosterEntry>,
  'teamNames' | 'guardianOf' | 'nameFormat'
> & {
  teamNames?: string[]
  guardianOf?: string[]
  nameFormat?: PlayerNamePrivacy
}
export const asRosterEntry: (raw: unknown) => RosterEntry = cleanRosterEntry

const asStoredGame = asObject({
  plays: asArray(
    asObject({ id: asString, gameId: asString, gumbo: asGumboPlay })
  ),
  currentPlay: asOptional(asNullable(asCurrentPlay), null),
  playsDigest: asOptional(asNullable(asString), null),
  priorPlaysDigest: asOptional(asNullable(asString), null),
  lineupsDigest: asOptional(asNullable(asString), null),
  generation: asOptional(asNullable(asNumber), null),
  swap: asSwapEffect,
  modelNames: asOptional(asObject(asString))
})

/** A game's plays as a session reads them, with the digests that were sent. */
function storedGameOf(stored: ReturnType<typeof asStoredGame>): StoredGame {
  return {
    plays: stored.plays.map(row => row.gumbo),
    currentPlay: stored.currentPlay,
    ...(stored.playsDigest == null ? {} : { playsDigest: stored.playsDigest }),
    ...(stored.priorPlaysDigest == null
      ? {}
      : { priorPlaysDigest: stored.priorPlaysDigest }),
    ...(stored.lineupsDigest == null
      ? {}
      : { lineupsDigest: stored.lineupsDigest }),
    ...(stored.generation == null ? {} : { generation: stored.generation }),
    ...(stored.swap === undefined ? {} : { swap: stored.swap }),
    ...(stored.modelNames == null ? {} : { modelNames: stored.modelNames })
  }
}

/** The sides a swap is asked from, and the plays a reset confirmed. */
export interface SwapSidesRead {
  homeTeamId: string
  awayTeamId: string
  generation?: number
  playsDigest?: string
}

/** A swap's answer; an older server sends only the sides. */
const asSwapSidesAnswer = asObject({
  homeTeamId: asString,
  awayTeamId: asString,
  generation: asOptional(asNumber, 0),
  reset: asOptional(asObject({ atBats: asNumber, innings: asNumber }), () => ({
    atBats: 0,
    innings: 0
  }))
})
export type SwapSidesAnswer = ReturnType<typeof asSwapSidesAnswer>

/**
 * A replay step as the announcer reads it: its key, and how many of its
 * actions the sentence is for, since a step grows as the scorer goes on.
 */
export interface NarrationStepRef {
  key: string
  count: number
}

/**
 * A game's stored plays and the at-bat in progress, from what `GET /events`
 * answers or a game socket's `plays` change carries. Throws on anything else.
 */
export function parseStoredGame(raw: unknown): StoredGame {
  return storedGameOf(asStoredGame(raw))
}

/**
 * A team this player has played for, in which season, and their number and
 * positions there: null and empty on a team they only have stats for.
 * `current` is whether they play on it now; a team they left is false.
 */
export const asPlayerTeam = asObject({
  teamId: asString,
  teamName: asString,
  logoUrl: asNullable(asString),
  seasonId: asNullable(asString),
  seasonName: asNullable(asString),
  seasonYear: asNullable(asNumber),
  jersey: asNullable(asString),
  positions: asArray(asString),
  current: asBoolean
})
export type PlayerTeam = ReturnType<typeof asPlayerTeam>

/**
 * One person, for their own page.
 *
 * `name` is **always** the short form — `Jordan P` — for everybody, on every
 * screen. The whole name is never part of it: it is fetched separately, by
 * `playerName`, when somebody who may change it opens the name field.
 *
 * No jersey number on the person: a number belongs to a player *on a team*,
 * and travels only in a `teams` row of `PlayerDetail`, beside its team.
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
  gumboId: asOptional(asNullable(asGumboId), null),
  name: asString,
  /** Whether to offer this person the name field. A parent or an admin. */
  canEditName: asOptional(asBoolean, false),
  /**
   * How the viewer may invite a guardian of this person: `guardian`, as one
   * of their guardians, with no sending team; `team`, from a team the viewer
   * coaches that the person plays on, while they have no guardian; `null`,
   * not at all.
   */
  guardianInviteAs: asOptional(asNullable(asLiteral('guardian', 'team')), null),
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

/** How a player bats and throws, as `PUT /players/:userId/settings` stored it. */
export const asPersonSettingsAnswer = asObject({
  userId: asUserId,
  bats: asBats,
  throws: asThrows
})
export type PersonSettingsAnswer = ReturnType<typeof asPersonSettingsAnswer>

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
  tag: asOptional(asNullable(asString), null),
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
  /** Where it stops; absent from a server from before the setting. */
  endOffsetSec: asOptional(asNumber),
  stillUrl: asString
})
export type PlayerHighlight = Omit<
  ReturnType<typeof asPlayerHighlight>,
  'tag' | 'endOffsetSec'
> & { tag?: string | null; endOffsetSec?: number }

export const asPlayerHighlights = asObject({
  highlights: asArray(asPlayerHighlight),
  /** Ask for the next page from here. Null when this is the last one. */
  nextBefore: asNullable(asString),
  /** Plays of theirs on this page that no recording covers. */
  withoutVideo: asOptional(asNumber, 0)
})
export type PlayerHighlights = Omit<
  ReturnType<typeof asPlayerHighlights>,
  'highlights'
> & { highlights: PlayerHighlight[] }

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
  runDifferential: asNumber,
  logoUrl: asOptional(asNullable(asString), null),
  teamKind: asOptional(asLiteral('full', 'external'), 'full'),
  gamesBehind: asOptional(asNullable(asNumber), null),
  streak: asOptional(asNullable(asString), null),
  home: asOptional(asObject({ w: asNumber, l: asNumber, t: asNumber }), () => ({
    w: 0,
    l: 0,
    t: 0
  })),
  away: asOptional(asObject({ w: asNumber, l: asNumber, t: asNumber }), () => ({
    w: 0,
    l: 0,
    t: 0
  }))
})
export type StandingsRow = ReturnType<typeof asStandingsRow>

export const asPlayback = asObject({
  videoId: asString,
  storage: asString,
  /** `null` when the row exists but its files do not. */
  url: asNullable(asString),
  expiresAt: asNullable(asString),
  durationSec: asNullable(asNumber),
  unavailable: asBoolean,
  /** Publication is still pending, including after the stream has ended. */
  pending: asOptional(asBoolean)
})
export type Playback = Omit<ReturnType<typeof asPlayback>, 'pending'> & {
  pending?: boolean
}

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

export const asSeasonGame = withEventMetadata(
  asObject({
    id: asString,
    homeTeamId: asString,
    awayTeamId: asString,
    homeTeamName: asString,
    awayTeamName: asString,
    /** Placeholder identities have no roster of their own. */
    homeTeamExternal: asBoolean,
    awayTeamExternal: asBoolean,
    seasonId: asNullable(asString),
    startAt: asNullable(asString),
    venue: asNullable(asString),
    exhibition: asOptional(asBoolean, false),
    timezone: asOptional(asString, 'UTC'),
    pendingApproval: asOptional(asBoolean, false),
    pendingRequestId: asOptional(asNullable(asString), null),
    cancellationReason: asOptional(asNullable(asString), null),
    withdrawnByTeamId: asOptional(asNullable(asString), null),
    withdrawnByTeamName: asOptional(asNullable(asString), null),
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
)
export type SeasonGame = ReturnType<typeof asSeasonGame>

export type VideoGame = SeasonGame & {
  latestVideoId: string
  latestVideoAt: string
}
export const asVideoGame: Cleaner<VideoGame> = raw => ({
  ...asSeasonGame(raw),
  ...asObject({ latestVideoId: asString, latestVideoAt: asString })(raw)
})
export interface VideoCollectionOptions {
  team?: string
  participant?: string
  q?: string
  offset?: number
  limit?: number
  sort?: 'date' | 'upload'
}
function videoCollectionQuery(options: VideoCollectionOptions): string {
  return [
    'hasVideo=1',
    ...Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
  ].join('&')
}

/** A player a roster manager may add, as the search card draws them. */
export interface RosterCandidate {
  userId: string
  gumboId: number | null
  externalIds: string[]
  shortName: string
  shortParts: { first: string; last: string }
  avatarUrl: string | null
  bats: 'left' | 'right' | 'switch' | null
  throws: 'left' | 'right' | null
  teams: Array<{ teamId: string; name: string }>
  tier: 'mine' | 'season' | 'league' | 'other'
  cursor: string
}
export const asRosterCandidate: Cleaner<RosterCandidate> = asObject({
  userId: asString,
  gumboId: asNullable(asNumber),
  externalIds: asArray(asString),
  shortName: asString,
  shortParts: asObject({ first: asString, last: asString }),
  avatarUrl: asNullable(asString),
  bats: asBats,
  throws: asThrows,
  teams: asArray(asObject({ teamId: asString, name: asString })),
  tier: asEither(
    asLiteral('mine'),
    asLiteral('season'),
    asLiteral('league'),
    asLiteral('other')
  ),
  cursor: asString
})

/**
 * An existing player's add: their entry, with the notice their side was sent
 * when there was one, or the request their side must accept first.
 */
export type ExistingPlayerAnswer =
  { entry: RosterEntry; noticeId: string | null } | { pendingRequestId: string }
export function asExistingPlayerAnswer(raw: unknown): ExistingPlayerAnswer {
  const held = raw as {
    pending?: { requestId?: unknown }
    notice?: { requestId?: unknown }
  }
  if (held?.pending != null)
    return { pendingRequestId: asString(held.pending.requestId) }
  return {
    entry: asRosterEntry(raw),
    noticeId:
      held?.notice?.requestId == null ? null : asString(held.notice.requestId)
  }
}

/** A person another service knows, and which of the asked ids are theirs. */
export const asUserMatch = asObject({
  userId: asUserId,
  gumboId: asOptional(asNullable(asGumboId), null),
  externalIds: asArray(asString),
  /** `Jordan P`, told apart from anybody else in the same answer. */
  shortName: asOptional(asString),
  /** Their picture, signed and short-lived; null when they have none. */
  avatarUrl: asOptional(asNullable(asString), null)
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
const cleanLiveStream = asObject({
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
   * What the device holding it is, in words: `iPhone 13 Pro`, `iPad Pro`.
   * Null for a browser's or streaming software's stream. On every item of a
   * game's list, and on a single device stream.
   */
  deviceModel: asAbsentOr(asNullable(asString)),
  /**
   * The install holding it, on the owner's own streams only, so a device can
   * tell which of its angles are its own.
   */
  deviceId: asAbsentOr(asNullable(asString)),
  /** How far the phone's own recording has got. */
  localRecording: asOptional(asLiteral('none', 'recorded', 'uploaded')),
  /**
   * Only ever in the reply to a request that asked for it by name, and only
   * ever to the person the key belongs to.
   */
  url: asOptional(asString)
})
type CleanedLiveStream = ReturnType<typeof cleanLiveStream>
/** The device fields are absent from a browser stream's own answers. */
export type LiveStream = Omit<
  CleanedLiveStream,
  'deviceModel' | 'deviceId' | 'localRecording'
> & {
  deviceModel?: CleanedLiveStream['deviceModel']
  deviceId?: CleanedLiveStream['deviceId']
  localRecording?: CleanedLiveStream['localRecording']
}
export const asLiveStream: (raw: unknown) => LiveStream = cleanLiveStream

/** What a device sends with a camera name to get its own stream. */
export interface DeviceStreamOptions {
  /** The install id. With it, asking again returns the same stream. */
  deviceId: string
  deviceModel?: string
  /** A phone that keeps its own recording of this stream. */
  recordsLocally?: boolean
  /** The stream a redial already holds: 410 if somebody ended it. */
  heldStreamId?: string
}

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

const cleanSessionUser = asObject({
  id: asUserId,
  gumboId: asOptional(asNullable(asGumboId), null),
  displayName: asString,
  email: asOptional(asString),
  isAdmin: asBoolean,
  /** Signed and short-lived, for the picture in the header. */
  avatarUrl: asOptional(asNullable(asString), null),
  onboarding: asOptional(asOnboarding)
})
export type SessionUser = Omit<
  ReturnType<typeof cleanSessionUser>,
  'onboarding'
> & { onboarding?: Onboarding }
export const asSessionUser: Cleaner<SessionUser> = cleanSessionUser

const cleanSession = asObject({
  /** Original local destination, carried by email-link sign-in across app restarts. */
  next: asOptional(asString),
  token: asString,
  expiresAt: asString,
  user: asSessionUser
})
export type Session = Omit<ReturnType<typeof cleanSession>, 'next'> & {
  next?: string
}
export const asSession: Cleaner<Session> = cleanSession

/** The sign-in a client is waiting on, and the secret that makes it its own. */
export const asSignInWait = asObject({
  requestId: asString,
  clientSecret: asString
})
export type SignInWait = ReturnType<typeof asSignInWait>

/** Where a sign-in is asked for, and where its e-mailed link should open. */
export interface SignInRequestOptions {
  /** The platform asking. The web when absent. */
  origin?: 'web' | 'ios' | 'android'
  /** Where to go once signed in. */
  next?: string
  /**
   * The link host of the app asking, so the e-mailed link opens it. Only an
   * installed app sends it; the server refuses a host it does not sign in.
   */
  appOrigin?: string
}

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
const cleanInviteInfo = asObject({
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
  alreadyIn: asBoolean,
  requestedRoles: asOptional(asArray(asString), [])
})
export type InviteInfo = Omit<
  ReturnType<typeof cleanInviteInfo>,
  'requestedRoles'
> & { requestedRoles?: string[] }
export const asInviteInfo: (raw: unknown) => InviteInfo = cleanInviteInfo

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
  isPlayer: asOptional(asBoolean, false)
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

/** A level as a person's profile names it. */
export const asPeopleLevel = asLiteral('league', 'season', 'team')

/**
 * What a person holds at one level of their profile: the team, every season
 * the team belongs to taken together, or the league. `roles` and `member`
 * are what was given at that level itself, never inherited; `follower` is
 * whether they follow it. `editable` is whether this viewer's buttons change
 * it: only the level the profile was opened from, for its administrators,
 * coaches and assistants.
 */
export const asProfileSection = asObject({
  level: asPeopleLevel,
  groups: asArray(asNamed),
  roles: asArray(asRole),
  member: asBoolean,
  follower: asBoolean,
  editable: asBoolean
})
export type ProfileSection = ReturnType<typeof asProfileSection>

/**
 * One person as a team, season or league's people see them, opened from its
 * people list: who they are, the players they are a guardian of there, and
 * what they hold at that level and the ones above it.
 */
export const asPersonProfile = asObject({
  context: asObject({ kind: asPeopleLevel, id: asString, name: asString }),
  person: asObject({
    userId: asUserId,
    shortName: asString,
    /** Their whole name, for a viewer who may read it; otherwise null. */
    fullName: asNullable(asString),
    avatarUrl: asNullable(asString),
    /** Whether they can hold a role: an account that signs in. */
    canHoldRoles: asBoolean
  }),
  /** The players they guard who play at this level, each with a team. */
  guardianOf: asArray(
    asObject({
      userId: asUserId,
      shortName: asString,
      avatarUrl: asNullable(asString),
      teamId: asString
    })
  ),
  sections: asArray(asProfileSection),
  viewer: asObject({
    /** An administrator, coach or assistant of the level: the role switches. */
    manages: asBoolean,
    /** An administrator of it: the Admin row too. */
    admin: asBoolean
  })
})
export type PersonProfile = ReturnType<typeof asPersonProfile>

/** A season's or league's people, and what this viewer may do with them. */
export const asLevelPeople = asObject({
  people: asArray(asRosterEntry),
  manages: asBoolean,
  admin: asBoolean
})
export type LevelPeople = ReturnType<typeof asLevelPeople>

/** What somebody holds at one level after a change. */
export const asHeldAt = asObject({
  userId: asUserId,
  roles: asArray(asRole),
  member: asBoolean
})
export type HeldAt = ReturnType<typeof asHeldAt>

/** The roles the signed-in person holds on each team where they hold any. */
export const asMyRoles = asObject({
  teams: asObject(asArray(asRole)),
  /** The players they are a guardian of, by the row each signs in as. */
  guardianOf: asOptional(asArray(asUserId), () => [])
})
export type MyRoles = ReturnType<typeof asMyRoles>

/** Somebody invited by address who has not opened the link yet. */
const cleanPendingPerson = asObject({
  inviteId: asString,
  email: asString,
  code: asString,
  invitedAt: asString,
  requestId: asOptional(asString)
})
export type PendingPerson = Omit<
  ReturnType<typeof cleanPendingPerson>,
  'requestId'
> & { requestId?: string }
export const asPendingPerson: (raw: unknown) => PendingPerson =
  cleanPendingPerson

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
  'claude-haiku-5-5'
] as const
export type DictationModel = (typeof DICTATION_MODELS)[number]
/**
 * The model a scorer who never picked one gets, when the server has it:
 * the fastest of them, and as accurate as any on everyday sentences.
 */
export const DEFAULT_DICTATION_MODEL: DictationModel = 'claude-haiku-5-5'

/**
 * Models a scorer could once pick, and the one that answers for each now. An
 * app installed before Claude Haiku 5.5 still asks for Haiku 4.5, which costs
 * more and is no longer offered: it gets Haiku 5.5.
 */
export const RETIRED_DICTATION_MODELS: Readonly<
  Record<string, DictationModel>
> = { 'claude-haiku-4-5-20251001': 'claude-haiku-5-5' }

const asOfferedModel = asLiteral(...DICTATION_MODELS)
/** A model a scorer asked for, with a retired one read as its replacement. */
export const asDictationModel: Cleaner<DictationModel> = raw =>
  asOfferedModel(
    typeof raw === 'string' ? (RETIRED_DICTATION_MODELS[raw] ?? raw) : raw
  )

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
  'claude-haiku-5-5': 'Claude Haiku 5.5'
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
  dictationModels: asOptional(asArray(asString), []),
  /** Whether the replay's announcer can speak; absent from an older server. */
  narration: asOptional(asBoolean),
  /**
   * Whether Tess, the assistant, is available. Absent from an older server,
   * which has no Tess: only `true` shows her.
   */
  tess: asOptional(asBoolean),
  /**
   * How long a replay holds each pitch, in seconds. Absent from an older
   * server, which plays at the default five.
   */
  replayPitchSec: asOptional(asNumber, 5)
})
export type Health = Omit<
  ReturnType<typeof asHealth>,
  'narration' | 'tess' | 'replayPitchSec'
> & {
  narration?: boolean
  tess?: boolean
  replayPitchSec?: number
}

/** A string of at most `max` characters. */
function asTextUpTo(max: number): Cleaner<string> {
  return raw => {
    const text = asString(raw)
    if (text.length > max)
      throw new TypeError(`Expected at most ${max} characters`)
    return text
  }
}

/**
 * The page open beside Tess on a wide screen, and the pages that led there:
 * sent with a message so she knows what "this game" is. A narrow screen,
 * where the chat covers the app, sends none.
 */
export const asTessScreen = asObject({
  path: asTextUpTo(2000),
  title: asTextUpTo(200),
  stack: asOptional(
    asArray(asObject({ path: asTextUpTo(2000), title: asTextUpTo(200) })),
    () => []
  )
})
export type TessScreen = ReturnType<typeof asTessScreen>

/**
 * The id the app gives a message it sends, up to 64 letters, digits, `-`
 * and `_`. The conversation shows it on the message, so the app can tell
 * whether a send whose answer it lost was kept.
 */
export const asTessClientId: Cleaner<string> = raw => {
  const id = asString(raw)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
    throw new TypeError('Expected up to 64 letters, digits, - and _')
  return id
}

/** `POST /me/tess/messages`: what the person said, and what they attached. */
export const asTessMessageBody = asObject({
  text: asTextUpTo(20000),
  attachmentIds: asOptional(asArray(asString), () => []),
  screen: asOptional(asTessScreen),
  clientId: asOptional(asTessClientId)
})
export type TessMessageBody = ReturnType<typeof asTessMessageBody>

/** `POST /me/tess/attachments`: one file, its bytes in base64. */
export const asTessAttachmentBody = asObject({
  name: asTextUpTo(1000),
  /** May be empty: the type is then read from the name's extension. */
  mediaType: asOptional(asString, ''),
  data: asString
})
export type TessAttachmentBody = ReturnType<typeof asTessAttachmentBody>

export const asTessAttachmentKind = asLiteral(
  'image',
  'csv',
  'text',
  'markdown'
)
export type TessAttachmentKind = ReturnType<typeof asTessAttachmentKind>

/**
 * The most a picture for Tess may hold, in bytes: 5 MB of base64, the most
 * the model takes. The server refuses more, and the app does not send it.
 */
export const TESS_MAX_IMAGE_BYTES = (5 * 1024 * 1024 * 3) / 4
/** The most a CSV, plain text or Markdown file for Tess may hold, in bytes. */
export const TESS_MAX_TEXT_BYTES = 1024 * 1024
/** The most attachments one message may name. */
export const TESS_MAX_ATTACHMENTS = 5

/** The media types Tess reads, and what each is to her. */
const TESS_TYPES: Readonly<Record<string, TessAttachmentKind>> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'text/csv': 'csv',
  'text/plain': 'text',
  'text/markdown': 'markdown'
}

/** Other names the same types travel under. */
const TESS_TYPE_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'application/csv': 'text/csv',
  'text/comma-separated-values': 'text/csv',
  'text/x-markdown': 'text/markdown'
}

/** The type a file name's extension says. */
const TESS_EXTENSIONS: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown'
}

/** What a browser's file chooser offers for Tess, by type and by name. */
export const TESS_ACCEPT = [
  'image/*',
  ...new Set(
    Object.keys(TESS_EXTENSIONS)
      .filter(extension => TESS_TYPES[TESS_EXTENSIONS[extension]] !== 'image')
      .map(extension => `.${extension}`)
  ),
  ...Object.keys(TESS_TYPES).filter(type => !type.startsWith('image/'))
].join(',')

/**
 * The type a file for Tess is, from the media type it came with or, when
 * that is missing or names nothing she reads (a CSV that Windows calls a
 * spreadsheet), from its name's extension. Null for a file she cannot read.
 * The app and the server both read files by this.
 */
export function tessUploadType(
  name: string,
  mediaType: string | null | undefined
): { kind: TessAttachmentKind; mediaType: string } | null {
  const given = (mediaType ?? '').split(';')[0].trim().toLowerCase()
  const known = TESS_TYPE_ALIASES[given] ?? given
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase()
  const type =
    TESS_TYPES[known] != null
      ? known
      : extension == null
        ? undefined
        : TESS_EXTENSIONS[extension]
  return type == null ? null : { kind: TESS_TYPES[type], mediaType: type }
}

/** An uploaded file, as a message names it. */
export const asTessAttachment = asObject({
  id: asString,
  name: asString,
  kind: asTessAttachmentKind
})
export type TessAttachment = ReturnType<typeof asTessAttachment>

/**
 * A change Tess proposed: what the server will run, from the stored request
 * rather than her words, and where it stands. It runs only when the person
 * holds Confirm.
 */
export const asTessChange = asObject({
  id: asString,
  summary: asString,
  method: asLiteral('POST', 'PUT', 'PATCH', 'DELETE'),
  path: asString,
  body: asOptional(asUnknown, null),
  /**
   * `unknown`: it began to run and gave no answer in time, or the server
   * lost track of it, so whether it happened has to be checked.
   */
  status: asLiteral(
    'pending',
    'running',
    'done',
    'failed',
    'expired',
    'unknown'
  )
})
export type TessChange = ReturnType<typeof asTessChange>

/** How a step Tess took went: still going, worked, or failed. */
export const asTessStepStatus = asLiteral('running', 'done', 'failed')
export type TessStepStatus = ReturnType<typeof asTessStepStatus>

/**
 * One step Tess took for a reply: a tool call, labelled by the server in
 * words of its own ("Reading: Get a team's schedule"), never its path.
 */
export const asTessStep = asObject({
  label: asString,
  status: asTessStepStatus
})
export type TessStep = ReturnType<typeof asTessStep>

/**
 * One message of the conversation as the app shows it: the person's text
 * with their attachments, or Tess's reply with the changes she proposed in
 * it, the summaries of her thinking and the steps she took. Her tool calls
 * and their results are not shown.
 */
const asTessMessageShape = asObject({
  id: asString,
  role: asLiteral('user', 'assistant'),
  text: asString,
  attachments: asArray(
    asObject({
      id: asString,
      name: asString,
      kind: asTessAttachmentKind,
      /** Its bytes were replaced by a description to keep the conversation short. */
      described: asBoolean
    })
  ),
  changes: asArray(asTessChange),
  createdAt: asString,
  /** The id the app sent a message of the person's with, if it sent one. */
  clientId: asOptional(asString),
  /** On a reply: the summaries of Tess's thinking, joined. */
  thinking: asOptional(asString),
  /** On a reply: each step she took, in order. */
  steps: asOptional(asArray(asTessStep))
})
export type TessMessage = Omit<
  ReturnType<typeof asTessMessageShape>,
  'clientId' | 'thinking' | 'steps'
> & { clientId?: string; thinking?: string; steps?: TessStep[] }
/** A message, without `clientId`, `thinking` or `steps` when it has none. */
export const asTessMessage: Cleaner<TessMessage> = raw => {
  const { clientId, thinking, steps, ...message } = asTessMessageShape(raw)
  return {
    ...message,
    ...(clientId == null ? {} : { clientId }),
    ...(thinking == null ? {} : { thinking }),
    ...(steps == null ? {} : { steps })
  }
}

/** `GET /me/tess`: the conversation, and its size in tokens. */
const asTessConversationShape = asObject({
  available: asBoolean,
  messages: asArray(asTessMessage),
  contextTokens: asNumber,
  /**
   * Tess is answering a message or a confirmed change now; what she stores
   * shows on a later read.
   */
  answering: asOptional(asBoolean)
})
export type TessConversation = Omit<
  ReturnType<typeof asTessConversationShape>,
  'answering'
> & { answering?: boolean }
export const asTessConversation: Cleaner<TessConversation> =
  asTessConversationShape

/** `POST /me/tess/changes/:changeId/confirm`: the change, and Tess's report. */
export const asTessConfirmation = asObject({
  change: asTessChange,
  messages: asArray(asTessMessage)
})
export type TessConfirmation = ReturnType<typeof asTessConfirmation>

/**
 * What a streamed turn tells as it happens (`streamTessMessage`,
 * `streamTessConfirm`): pieces of Tess's thinking's summary and of her text;
 * each step as it starts and ends, by its tool call's id; and, once the turn
 * has begun, the person's message as stored (or, for a confirm, the change
 * as it ended).
 */
export type TessStreamEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'step'; id: string; label: string; status: TessStepStatus }
  | { type: 'stored'; messages: TessMessage[]; change?: TessChange }

const asTessDelta = asObject({ delta: asString })
const asTessStepEvent = asObject({
  id: asString,
  label: asString,
  status: asTessStepStatus
})
const asTessStored = asObject({
  messages: asArray(asTessMessage),
  change: asOptional(asTessChange)
})

/** One streamed event by its name, or null for one this app does not know. */
export function tessStreamEventOf(
  name: string,
  raw: unknown
): TessStreamEvent | null {
  switch (name) {
    case 'thinking':
    case 'text':
      return { type: name, delta: asTessDelta(raw).delta }
    case 'step':
      return { type: 'step', ...asTessStepEvent(raw) }
    case 'stored': {
      const { messages, change } = asTessStored(raw)
      return change == null
        ? { type: 'stored', messages }
        : { type: 'stored', messages, change }
    }
    default:
      return null
  }
}

/**
 * A streamed turn that failed once begun, as its `error` event told it: the
 * error the request would have failed with, and whether the server still
 * has the message, or the confirmation, it stored. One Tess failed to answer
 * before storing anything of her answer is taken back, and the changes it
 * expired are pending again.
 */
export class TessTurnError extends HttpError {
  readonly kept: boolean

  constructor(error: HttpError, kept: boolean) {
    super(error.code, error.message, error.details)
    this.name = 'TessTurnError'
    this.kept = kept
  }
}

/** One UTC week, from Monday, of the caller's use of Tess. */
export const asTessUsageWeek = asObject({
  weekStart: asString,
  inputTokens: asNumber,
  outputTokens: asNumber,
  requests: asNumber
})
export type TessUsageWeek = ReturnType<typeof asTessUsageWeek>

/** The response header a screen's read carries its revision in. */
export const REVISION_HEADER = 'x-teamstation-revision'

/**
 * The request header a queued write is sent with: the same request with
 * the same key is answered once and written once.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key'

/** One response's revision, as a screen's load collects them. */
export interface RevisionRead {
  path: string
  /** `x-teamstation-revision`, a decimal string: compare with `BigInt`. */
  revision: string
}

/** How one call to the API is made, beside its method, path and body. */
export interface RequestOptions {
  /** Whether a screen's load collects the answer's revision. */
  collect?: boolean
  headers?: Record<string, string>
  /**
   * The names of the players a live post's plays name, by gumbo id: never
   * sent, but kept on the device beside a queued post, so the phone's copy
   * of the game reads named before the server answers.
   */
  deviceNames?: Record<string, string>
  /** Cancels the call; a cancelled call is not the network going away. */
  signal?: AbortSignal
}

/**
 * The part of `XMLHttpRequest` a streamed call uses: on the web and in React
 * Native alike, `onprogress` sees the answer's text grow as it arrives,
 * where React Native's `fetch` has no streaming body.
 */
export interface StreamingRequest {
  open: (method: string, url: string) => void
  setRequestHeader: (name: string, value: string) => void
  getResponseHeader: (name: string) => string | null
  send: (body?: string) => void
  withCredentials: boolean
  readonly status: number
  readonly responseText: string
  onprogress: (() => void) | null
  onload: (() => void) | null
  onerror: (() => void) | null
  ontimeout: (() => void) | null
  onabort: (() => void) | null
}

export interface ClientOptions {
  baseUrl: string
  token?: string
  /** Swapped out in tests. Defaults to the platform's own. */
  fetch?: typeof fetch
  /** Makes the request a streamed call sends; the platform's `XMLHttpRequest` by default. */
  streamingRequest?: () => StreamingRequest
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
  /**
   * The digest the game keeps of both sides' lineups, which changes exactly
   * when what they show does. A screen keeps the one it last read or saved,
   * to tell its own save from somebody else's. Empty from an older server.
   */
  digest: string
  /** The game's play generation; absent from an older server. */
  generation?: number
}
const asTeamLineups: Cleaner<TeamLineups> = raw => {
  const team = asObject({ teamId: asString, teamName: asString })(raw)
  return { ...asSideLineups(raw), ...team }
}
export const asGameLineupsResponse: Cleaner<GameLineupsResponse> = asObject({
  away: asTeamLineups,
  home: asTeamLineups,
  digest: asOptional(asString, ''),
  generation: asOptional(asNumber)
})

/** A player in a saved lineup, named by who he is, never by a session id. */
export interface LineupPlayer {
  /** Null for a player made up at the field. */
  gumboId: number | null
  fullName: string
  jersey: string
}

/**
 * `POST /games/:gameId/lineups`: one side's players, batting order and
 * defence, as its head coach or a scorekeeper saves them. Every number but a
 * `gumboId` is an index into `players`, so the server never depends on the
 * client numbering players as it does. `base` is the lineups digest the
 * client last read; the last save wins, and the client uses it only to tell
 * its own save from somebody else's.
 */
export interface SaveLineupsBody {
  side: Side
  base: string
  players: LineupPlayer[]
  battingOrder: number[]
  defense: Partial<Record<Position, number>>
  /** Who bats next, when it is not the batter due. */
  nextBatter?: number
  /** Pinch runners who keep the batting order, each on the base he takes. */
  runners?: Array<{ base: '1B' | '2B' | '3B'; player: number }>
  /**
   * The play generation the saver opened the game on: a game reset since
   * refuses the save. An older app sends none.
   */
  generation?: number
}

const asIndex: Cleaner<number> = raw => {
  const index = asNumber(raw)
  if (!Number.isInteger(index) || index < 0)
    throw new TypeError(`Expected an index into players, got ${index}`)
  return index
}

const asSaveLineupsShape = asObject({
  side: asLiteral('away', 'home'),
  base: asString,
  players: asArray(
    asObject({
      gumboId: asNullable(asGumboId),
      fullName: asString,
      jersey: asString
    })
  ),
  battingOrder: asArray(asIndex),
  defense: asObject(
    Object.fromEntries(
      POSITIONS.map(position => [position, asOptional(asIndex)])
    ) as Record<Position, Cleaner<number | undefined>>
  ),
  nextBatter: asOptional(asIndex),
  runners: asOptional(
    asArray(asObject({ base: asLiteral('1B', '2B', '3B'), player: asIndex }))
  ),
  generation: asOptional(asCount)
})

/** Cleans a lineup save, and refuses an index past the players it names. */
export const asUnrosterBody = asObject({
  side: asLiteral('away', 'home'),
  userId: asUserId,
  rostered: asBoolean
})
export type UnrosterBody = ReturnType<typeof asUnrosterBody>

export const asSaveLineupsBody: Cleaner<SaveLineupsBody> = raw => {
  const body = asSaveLineupsShape(raw)
  const indexes = [
    ...body.battingOrder,
    ...Object.values(body.defense),
    body.nextBatter,
    ...(body.runners ?? []).map(runner => runner.player)
  ]
  for (const index of indexes)
    if (index != null && index >= body.players.length)
      throw new TypeError(
        `Player ${index} is not one of the ${body.players.length} players`
      )
  const defense: Partial<Record<Position, number>> = {}
  for (const position of POSITIONS) {
    const index = body.defense[position]
    if (index != null) defense[position] = index
  }
  return {
    side: body.side,
    base: body.base,
    players: body.players,
    battingOrder: body.battingOrder,
    defense,
    ...(body.nextBatter == null ? {} : { nextBatter: body.nextBatter }),
    ...(body.runners == null ? {} : { runners: body.runners }),
    ...(body.generation == null ? {} : { generation: body.generation })
  }
}

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

/** `GET /videos/:videoId/wall-timeline`: a video's points on the server clock. */
export const asWallTimeline: Cleaner<WallTimeline> = asObject({
  anchors: asArray(asTuple(asNumber, asNumber)),
  source: asLiteral('sei', 'arrival', 'start'),
  confidence: asLiteral('frame', 'clock', 'approximate'),
  live: asBoolean,
  startAt: asNullable(asString)
})

/** One step of a game's board: what it showed from `at` until the next. */
export interface BoardStep {
  /** Milliseconds, on the server's clock. */
  at: number
  state: ScoreboardState
}

/** One side's row of a line score at a moment: `BoardLineSide`. */
const asLineSide = asObject({
  innings: asArray(asNullable(asNumber)),
  r: asNumber,
  h: asNullable(asNumber),
  e: asNullable(asNumber)
})

/** One step of a game's line score: what it was from `at` until the next. */
export interface LineScoreStep {
  /** Milliseconds, on the server's clock. */
  at: number
  line: BoardLine
}

/** `GET /games/:gameId/line-score`. */
export interface LineScoreTimeline {
  /** Changes whenever the game's events or its team names do. */
  version: string
  teams: { away: string; home: string }
  steps: LineScoreStep[]
}

export const asLineScoreTimeline: Cleaner<LineScoreTimeline> = asObject({
  version: asString,
  teams: asObject({ away: asString, home: asString }),
  steps: asArray(
    asObject({
      at: asNumber,
      line: asObject({ away: asLineSide, home: asLineSide })
    })
  )
})

/** `GET /games/:gameId/scoreboard-timeline`. */
export interface BoardTimelineWindow {
  /** Changes whenever anything the timeline is built from does. */
  version: string
  steps: BoardStep[]
}

export const asBoardTimelineWindow: Cleaner<BoardTimelineWindow> = asObject({
  version: asString,
  steps: asArray(asObject({ at: asNumber, state: asScoreboardState }))
})

export class TeamStationClient {
  async startTvLogin(platform: TvPlatform): Promise<TvLoginRequest> {
    return await this.request('POST', '/auth/tv/start', asTvLoginRequest, {
      platform
    })
  }

  async claimTvLogin(
    requestId: string,
    clientSecret: string
  ): Promise<Session | { ready: false }> {
    return await this.request(
      'POST',
      '/auth/tv/claim',
      asEither(asSession, asObject({ ready: asLiteral(false) })),
      { requestId, clientSecret }
    )
  }

  async inspectTvLogin(token: string): Promise<TvLoginPreview> {
    return await this.request('POST', '/auth/tv/inspect', asTvLoginPreview, {
      token
    })
  }

  async approveTvLogin(input: {
    code?: string
    token?: string
  }): Promise<void> {
    await this.request('POST', '/auth/tv/approve', asUnknownOk, input)
  }

  async umpireSettings(league: string): Promise<UmpireSettings> {
    return await this.request(
      'GET',
      `/leagues/${encodeURIComponent(league)}/umpire-settings`,
      asUmpireSettings
    )
  }

  async setUmpireSettings(
    league: string,
    settings: { management?: boolean; credits?: boolean }
  ): Promise<UmpireSettings> {
    return await this.request(
      'PUT',
      `/leagues/${encodeURIComponent(league)}/umpire-settings`,
      asUmpireSettings,
      settings
    )
  }

  async umpireLevels(league: string): Promise<UmpireLevel[]> {
    return (
      await this.request(
        'GET',
        `/leagues/${encodeURIComponent(league)}/umpire-levels`,
        asUmpireLevels
      )
    ).levels
  }

  async addUmpireLevel(league: string, name: string): Promise<UmpireLevel> {
    return await this.request(
      'POST',
      `/leagues/${encodeURIComponent(league)}/umpire-levels`,
      asUmpireLevel,
      { name }
    )
  }

  async removeUmpireLevel(league: string, level: string): Promise<void> {
    await this.request(
      'DELETE',
      `/leagues/${encodeURIComponent(league)}/umpire-levels/${encodeURIComponent(level)}`,
      asUnknownOk
    )
  }

  async umpireTypes(league: string): Promise<UmpireType[]> {
    return (
      await this.request(
        'GET',
        `/leagues/${encodeURIComponent(league)}/umpire-types`,
        asUmpireTypes
      )
    ).types
  }

  async addUmpireType(league: string, name: string): Promise<UmpireType> {
    return await this.request(
      'POST',
      `/leagues/${encodeURIComponent(league)}/umpire-types`,
      asUmpireLevel,
      { name }
    )
  }

  async removeUmpireType(league: string, id: string): Promise<void> {
    await this.request(
      'DELETE',
      `/leagues/${encodeURIComponent(league)}/umpire-types/${encodeURIComponent(id)}`,
      asUnknownOk
    )
  }

  async umpireNoteTypes(league: string): Promise<UmpireType[]> {
    return (
      await this.request(
        'GET',
        `/leagues/${encodeURIComponent(league)}/umpire-note-types`,
        asUmpireTypes
      )
    ).types
  }

  async addUmpireNoteType(league: string, name: string): Promise<UmpireType> {
    return await this.request(
      'POST',
      `/leagues/${encodeURIComponent(league)}/umpire-note-types`,
      asUmpireLevel,
      { name }
    )
  }

  async removeUmpireNoteType(league: string, id: string): Promise<void> {
    await this.request(
      'DELETE',
      `/leagues/${encodeURIComponent(league)}/umpire-note-types/${encodeURIComponent(id)}`,
      asUnknownOk
    )
  }

  async saveUmpireNote(
    game: string,
    type: string,
    before: string,
    value: string
  ): Promise<{ value: string }> {
    return await this.request(
      'PUT',
      `/games/${encodeURIComponent(game)}/umpire-notes/${encodeURIComponent(type)}`,
      asObject({ value: asString }),
      { before, value }
    )
  }

  async umpireRequirements(league: string): Promise<UmpireSeason[]> {
    return (
      await this.request(
        'GET',
        `/leagues/${encodeURIComponent(league)}/umpire-requirements`,
        asUmpireSeasons
      )
    ).seasons
  }

  async setUmpireRequirements(
    league: string,
    requirement: {
      seasonIds: string[]
      levelId: string
      types: UmpireTypeCount[]
    }
  ): Promise<void> {
    await this.request(
      'PUT',
      `/leagues/${encodeURIComponent(league)}/umpire-requirements`,
      asUnknownOk,
      requirement
    )
  }

  async umpirePeople(league: string, query?: string): Promise<UmpirePerson[]> {
    return (
      await this.request(
        'GET',
        `/leagues/${encodeURIComponent(league)}/${query == null ? 'umpires' : `umpire-candidates?q=${encodeURIComponent(query)}`}`,
        asUmpirePeople
      )
    ).people
  }

  async saveUmpires(
    league: string,
    changes: UmpireEdit[]
  ): Promise<UmpirePerson[]> {
    return (
      await this.request(
        'PUT',
        `/leagues/${encodeURIComponent(league)}/umpires`,
        asUmpirePeople,
        { changes }
      )
    ).people
  }

  async grantUmpire(league: string, userId: string): Promise<void> {
    await this.request(
      'POST',
      `/leagues/${encodeURIComponent(league)}/umpires`,
      asUnknownOk,
      { userId }
    )
  }

  async revokeUmpire(league: string, userId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/leagues/${encodeURIComponent(league)}/umpires/${encodeURIComponent(userId)}`,
      asUnknownOk
    )
  }

  async certifyUmpire(
    league: string,
    userId: string,
    certification: UmpireCertification
  ): Promise<void> {
    await this.request(
      'PUT',
      `/leagues/${encodeURIComponent(league)}/umpires/${encodeURIComponent(userId)}/certifications`,
      asUnknownOk,
      certification
    )
  }

  async umpireLeagues(): Promise<UmpireLeague[]> {
    return (await this.request('GET', '/me/umpire-leagues', asUmpireLeagues))
      .leagues
  }

  async umpireSchedule(league: string, query = ''): Promise<UmpireSchedule> {
    const params = new URLSearchParams(query)
    for (const key of ['days', 'levels']) {
      const values = params.getAll(key).flatMap(value => value.split(','))
      params.delete(key)
      for (const value of values) if (value !== '') params.append(key, value)
    }
    return await this.request(
      'GET',
      `/leagues/${encodeURIComponent(league)}/umpire-schedule?${params.toString()}`,
      asUmpireSchedule
    )
  }

  async umpireLeaderboard(league: string): Promise<UmpireLeaderboard> {
    return await this.request(
      'GET',
      `/leagues/${encodeURIComponent(league)}/umpire-leaderboard`,
      asUmpireLeaderboard
    )
  }

  async assignUmpire(
    game: string,
    assignment: { slot: string; userId: string; creditTeamId?: string }
  ): Promise<void> {
    await this.request(
      'POST',
      `/games/${encodeURIComponent(game)}/umpire-slots`,
      asUnknownOk,
      assignment
    )
  }

  async removeUmpire(game: string, slot: string): Promise<void> {
    await this.request(
      'DELETE',
      `/games/${encodeURIComponent(game)}/umpire-slots`,
      asUnknownOk,
      { slot }
    )
  }

  async nodeAccounts(query = '', nodeAdmin = false): Promise<NodeAccount[]> {
    return await this.request(
      'GET',
      `/users?view=administration&query=${encodeURIComponent(query)}${nodeAdmin ? '&nodeAdmin=true' : ''}`,
      asNodeAccounts
    )
  }

  async changeNodeAccount(
    userId: string,
    change: NodeAccountChange
  ): Promise<void> {
    await this.request(
      'PATCH',
      `/users/${userId}/administration`,
      asUnknownOk,
      change
    )
  }

  async accountMail(): Promise<{ accountMessages: boolean }> {
    return await this.request(
      'GET',
      '/node/mail',
      asObject({ accountMessages: asBoolean })
    )
  }

  async setAccountMail(accountMessages: boolean): Promise<void> {
    await this.request('PUT', '/node/mail', asUnknownOk, { accountMessages })
  }

  /** Every node setting, for a node administrator. */
  async nodeSettings(): Promise<NodeSettings> {
    return await this.request('GET', '/node/settings', asNodeSettings)
  }

  /** A node administrator sets every node setting at once. */
  async setNodeSettings(settings: NodeSettings): Promise<NodeSettings> {
    return await this.request('PUT', '/node/settings', asNodeSettings, settings)
  }

  /** Whether a game's board shows over its videos, and where. */
  async scoreboardOverlay(gameId: string): Promise<ScoreboardOverlay> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/scoreboard-overlay`,
      asScoreboardOverlay
    )
  }

  /** Where the API is, which is also where its sockets are. */
  readonly baseUrl: string
  private readonly doFetch: typeof fetch
  private readonly newStreamingRequest?: () => StreamingRequest
  private readonly passwordKdf?: PasswordKdf
  private readonly passwordCosts?: ClientPasswordCosts
  private readonly passwordTargetMs?: number
  private passwordPreparation?: Promise<ClientPasswordCosts>
  /**
   * The sign-in request this client asked for last. An installed app that
   * spends its link (with a device name) is the one polling for it, and says
   * so, so the poll is not approved too. A browser spending a link names
   * nothing: the request it finishes may be waiting in another tab.
   */
  private askedSignIn?: string
  token: string | undefined
  /** Captures the current analytics identity before a request starts. */
  captureAnalytics?: () => AnalyticsSink
  analyticsApp?: 'TS' | 'TS web'
  /**
   * Set when the last request failed to leave the device, and cleared when
   * one reaches the server. Each change is told to `subscribeOffline`'s
   * listeners, so the phone's banner comes and goes without a reload.
   */
  get offline(): boolean {
    return this.unreachable
  }

  set offline(value: boolean) {
    if (value === this.unreachable) return
    this.unreachable = value
    for (const listener of [...this.offlineListeners]) listener(value)
  }

  /** Tells `listener` each time `offline` changes, until unsubscribed. */
  subscribeOffline(listener: (offline: boolean) => void): () => void {
    this.offlineListeners.add(listener)
    return () => {
      this.offlineListeners.delete(listener)
    }
  }

  private unreachable = false
  private readonly offlineListeners = new Set<(offline: boolean) => void>()
  /**
   * Told when a call answers 401: the session is no good. A sign-in attempt
   * refused (`POST /auth/...`) is not that.
   */
  onSessionRefused?: () => void
  /** The revision each path last answered with. */
  private readonly revisions = new Map<string, string>()
  /**
   * Where the screen loads now running collect the revisions they read. Home
   * runs three at once, and an answer cannot say which load asked for it, so
   * each running load collects every answer: the least of them is never
   * newer than the least of its own.
   */
  private readonly collectors = new Set<RevisionRead[]>()

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.passwordKdf = options.passwordKdf
    this.passwordCosts = options.passwordCosts
    this.passwordTargetMs = options.passwordTargetMs
    this.token = options.token
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.newStreamingRequest = options.streamingRequest
  }

  /** The revision the last answer from `path` carried, if any did. */
  revisionFor(path: string): string | undefined {
    return this.revisions.get(path)
  }

  /**
   * Collects `{ path, revision }` from every answer that carries one, until
   * `stopCollecting`. A screen's load sets this around the calls it makes,
   * and holds the least of them as the revision of what it shows.
   */
  collectRevisions(collector: RevisionRead[]): void {
    this.collectors.add(collector)
  }

  /** Stops collecting into `collector`. */
  stopCollecting(collector: RevisionRead[]): void {
    this.collectors.delete(collector)
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

  async clearAccountPhoto(): Promise<AccountSettings> {
    return await this.request('DELETE', '/me/account/photo', asAccountSettings)
  }

  /** The account's API keys, oldest first, each with its secret. */
  async apiKeys(): Promise<ApiKey[]> {
    return (await this.request('GET', '/me/api-keys', asApiKeys)).keys
  }

  async createApiKey(body: ApiKeyCreate): Promise<ApiKey> {
    return await this.request('POST', '/me/api-keys', asApiKey, body)
  }

  /** Revokes the key: anything using it stops working. */
  async deleteApiKey(id: string): Promise<void> {
    await this.request(
      'DELETE',
      `/me/api-keys/${encodeURIComponent(id)}`,
      asUnknownOk
    )
  }

  /** Irrecoverable: this account and every one merged into it can never sign in again. */
  async deleteAccount(): Promise<void> {
    try {
      await this.request('DELETE', '/me/account', asUnknownOk)
    } catch (error) {
      // Refused for want of a session: this token is no good either way.
      if (error instanceof HttpError && error.code === 'unauthorized')
        this.token = undefined
      throw error
    }
    this.token = undefined
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
    options: SignInRequestOptions = {}
  ): Promise<SignInWait> {
    const wait = await this.request('POST', '/auth/email-code', asSignInWait, {
      email,
      origin: options.origin ?? 'web',
      next: options.next,
      appOrigin: options.appOrigin
    })
    this.askedSignIn = wait.requestId
    return wait
  }

  /**
   * The origin of the server this client talks to: its base URL without the
   * API path, or the page's own origin when the base URL is a path, as it is
   * on the web.
   */
  serverOrigin(): string {
    const match = /^(https?:\/\/[^/]+)/i.exec(this.baseUrl)
    if (match != null) return match[1].toLowerCase()
    return (
      (globalThis as { location?: { origin?: string } }).location?.origin ?? ''
    )
  }

  /**
   * The server's OpenID issuer, `<its public origin>/oauth`: how an app finds
   * out what its server calls itself, which is not always the address the app
   * was built to talk to. Null when the server answered without one (a server
   * with OAuth off has no discovery, and so vouches for no other name);
   * undefined when it could not be asked: no answer, or a 5xx.
   */
  async issuer(): Promise<string | null | undefined> {
    let response: Response
    try {
      response = await this.doFetch(
        `${this.serverOrigin()}/oauth/.well-known/openid-configuration`,
        { method: 'GET', headers: { accept: 'application/json' } }
      )
    } catch {
      return undefined
    }
    if (response.status >= 500) return undefined
    if (!response.ok) return null
    try {
      const body: unknown = await response.json()
      const issuer =
        body != null && typeof body === 'object' && 'issuer' in body
          ? body.issuer
          : undefined
      return typeof issuer === 'string' ? issuer : null
    } catch {
      return null
    }
  }

  /**
   * Spend the link from the e-mail. Never happens on a bare page load.
   *
   * A device names itself, as it does when it types the code, and gets the
   * long-lived, named session a device does.
   */
  async signInWithLink(token: string, deviceName?: string): Promise<Session> {
    const session = await this.request('POST', '/auth/link/verify', asSession, {
      token,
      deviceName,
      requestId: deviceName == null ? undefined : this.askedSignIn
    })
    this.token = session.token
    this.askedSignIn = undefined
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

  /** The caller's conversation with Tess. */
  async tess(): Promise<TessConversation> {
    return await this.request('GET', '/me/tess', asTessConversation)
  }

  /**
   * Says something to Tess, with any attachments already uploaded and, on a
   * wide screen, the page beside the chat. Answers the new message and
   * everything Tess added after it. `clientId` comes back on the stored
   * message, so a send whose answer never arrived can be looked for.
   */
  async sendTessMessage(
    text: string,
    options: {
      attachmentIds?: string[]
      screen?: TessScreen
      clientId?: string
    } = {}
  ): Promise<TessMessage[]> {
    return (
      await this.request(
        'POST',
        '/me/tess/messages',
        asObject({ messages: asArray(asTessMessage) }),
        {
          text,
          ...(options.attachmentIds == null ||
          options.attachmentIds.length === 0
            ? {}
            : { attachmentIds: options.attachmentIds }),
          ...(options.screen == null ? {} : { screen: options.screen }),
          ...(options.clientId == null ? {} : { clientId: options.clientId })
        }
      )
    ).messages
  }

  /** Uploads one file for a later message to name. */
  async uploadTessAttachment(
    file: TessAttachmentBody
  ): Promise<TessAttachment> {
    return await this.request(
      'POST',
      '/me/tess/attachments',
      asTessAttachment,
      file
    )
  }

  /** Runs a change Tess proposed, once the person has held Confirm. */
  async confirmTessChange(changeId: string): Promise<TessConfirmation> {
    return await this.request(
      'POST',
      `/me/tess/changes/${encodeURIComponent(changeId)}/confirm`,
      asTessConfirmation
    )
  }

  /**
   * `sendTessMessage`, streamed: Tess's thinking, her steps and her text go
   * to `onEvent` as they happen, and it answers the same messages once she
   * is done. A refusal before her turn begins is the error `sendTessMessage`
   * throws; a failure in it is the one it would have thrown, as a
   * `TessTurnError` that says whether the message is kept; and a stream
   * that stops before she is done is `offline`, as a lost answer is.
   */
  async streamTessMessage(
    text: string,
    options: {
      attachmentIds?: string[]
      screen?: TessScreen
      clientId?: string
    },
    onEvent: (event: TessStreamEvent) => void
  ): Promise<TessMessage[]> {
    return (
      await this.streamTess(
        '/me/tess/messages',
        asObject({ messages: asArray(asTessMessage) }),
        {
          text,
          ...(options.attachmentIds == null ||
          options.attachmentIds.length === 0
            ? {}
            : { attachmentIds: options.attachmentIds }),
          ...(options.screen == null ? {} : { screen: options.screen }),
          ...(options.clientId == null ? {} : { clientId: options.clientId })
        },
        onEvent
      )
    ).messages
  }

  /** `confirmTessChange`, streamed as `streamTessMessage` is. */
  async streamTessConfirm(
    changeId: string,
    onEvent: (event: TessStreamEvent) => void
  ): Promise<TessConfirmation> {
    return await this.streamTess(
      `/me/tess/changes/${encodeURIComponent(changeId)}/confirm`,
      asTessConfirmation,
      undefined,
      onEvent
    )
  }

  /** The caller's tokens with Tess, week by week, newest first. */
  async tessUsage(): Promise<TessUsageWeek[]> {
    return (
      await this.request(
        'GET',
        '/me/tess/usage',
        asObject({ weeks: asArray(asTessUsageWeek) })
      )
    ).weeks
  }

  /** The server's clock, in milliseconds since the epoch. */
  async serverTime(): Promise<number> {
    const answer = await this.request(
      'GET',
      '/time',
      asObject({ now: asNumber })
    )
    return answer.now
  }

  async teams(): Promise<TeamSummary[]> {
    return await this.request('GET', '/teams', asArray(asTeamSummary))
  }

  async discoverGroups(kind: GroupKind, query = ''): Promise<SearchRow[]> {
    const collection =
      kind === 'league' ? 'leagues' : kind === 'season' ? 'seasons' : 'teams'
    return await this.request(
      'GET',
      `/${collection}?view=public&query=${encodeURIComponent(query)}`,
      asArray(asSearchRow)
    )
  }

  /**
   * Teams a game is likely to be against: the anchor team's season, league,
   * recent opponents and region, in that order, around `seasonId` too.
   */
  async relatedTeams(anchor: {
    teamId?: string
    seasonId?: string
  }): Promise<SearchRow[]> {
    const query = new URLSearchParams({ view: 'public' })
    if (anchor.teamId != null) query.set('relatedTeam', anchor.teamId)
    if (anchor.seasonId != null) query.set('relatedSeason', anchor.seasonId)
    return await this.request(
      'GET',
      `/teams?${query.toString()}`,
      asArray(asSearchRow)
    )
  }

  /** With `admin`, only the groups this person administers. */
  async ownGroups(role?: 'admin'): Promise<PublicGroup[]> {
    return await this.request(
      'GET',
      role == null ? '/me/groups' : `/me/groups?role=${role}`,
      asArray(asPublicGroup)
    )
  }

  /** The leagues, seasons and teams this person follows as a fan. */
  async follows(): Promise<PublicGroup[]> {
    return await this.request('GET', '/me/follows', asArray(asPublicGroup))
  }

  async follow(ref: GroupRef): Promise<PublicGroup> {
    return await this.request(
      'PUT',
      `/me/follows/${ref.kind}/${encodeURIComponent(ref.id)}`,
      asPublicGroup
    )
  }

  async unfollow(ref: GroupRef): Promise<void> {
    await this.request(
      'DELETE',
      `/me/follows/${ref.kind}/${encodeURIComponent(ref.id)}`,
      () => undefined
    )
  }

  async group(ref: GroupRef): Promise<GroupDetail> {
    const collection =
      ref.kind === 'league'
        ? 'leagues'
        : ref.kind === 'season'
          ? 'seasons'
          : 'teams'
    return await this.request(
      'GET',
      `/${collection}/${encodeURIComponent(ref.id)}`,
      asGroupDetail
    )
  }

  async createGroup(body: CreateGroup): Promise<{
    id: string
    kind: GroupKind
    name: string
    imageUrl: string | null
  }> {
    const collection =
      body.kind === 'league'
        ? 'leagues'
        : body.kind === 'season'
          ? 'seasons'
          : 'teams'
    return await this.request(
      'POST',
      `/${collection}`,
      asObject({
        id: asString,
        kind: asLiteral('league', 'season', 'team'),
        name: asString,
        imageUrl: asNullable(asString)
      }),
      body
    )
  }

  async updateGroup(
    ref: GroupRef,
    fields: Partial<Omit<CreateGroup, 'kind' | 'parent' | 'idempotencyKey'>> & {
      /** Null goes back to Default. */
      playerNamePrivacy?: PlayerNamePrivacy | null
    }
  ): Promise<PublicGroup> {
    return await this.request(
      'PUT',
      `/groups/${ref.kind}/${encodeURIComponent(ref.id)}`,
      asPublicGroup,
      fields
    )
  }

  async parentPreview(actions: ParentAction[]): Promise<ParentPreview> {
    return await this.request('POST', '/parent-previews', asParentPreview, {
      actions
    })
  }

  async changeParents(preview: ParentPreview): Promise<void> {
    await this.request('PUT', '/parent-links', asUnknownOk, {
      actions: preview.actions,
      expected: preview.expected
    })
  }

  async proposeGame(body: GameProposal): Promise<{
    id: string
    status: string
    gameId: string | null
    proposedGameId: string | null
    replacesGameId: string | null
  }> {
    return await this.request(
      'POST',
      '/game-requests',
      asObject({
        id: asString,
        status: asString,
        gameId: asNullable(asString),
        proposedGameId: asOptional(asNullable(asString), null),
        replacesGameId: asOptional(asNullable(asString), null)
      }),
      body
    )
  }

  async decideGameRequest(
    id: string,
    action: 'accept' | 'decline' | 'withdraw' | 'resend',
    idempotencyKey?: string
  ): Promise<{
    id: string
    status: string
    gameId: string | null
    proposedGameId: string | null
    replacesGameId: string | null
    notice?: string
  }> {
    return await this.request(
      'POST',
      `/game-requests/${encodeURIComponent(id)}/${action}`,
      asObject({
        id: asString,
        status: asString,
        gameId: asNullable(asString),
        proposedGameId: asOptional(asNullable(asString), null),
        replacesGameId: asOptional(asNullable(asString), null),
        notice: asOptional(asString)
      }),
      { idempotencyKey }
    )
  }

  async gameProposals(ref: GroupRef): Promise<GameScheduleProposal[]> {
    return await this.request(
      'GET',
      `/game-requests?scopeKind=${ref.kind}&scopeId=${encodeURIComponent(ref.id)}`,
      asArray(asGameScheduleProposal)
    )
  }

  async deleteDeclinedGame(id: string, scope?: GroupRef): Promise<void> {
    await this.request(
      'DELETE',
      `/game-requests/${encodeURIComponent(id)}/schedule-entry${scope == null ? '' : `?scopeKind=${scope.kind}&scopeId=${encodeURIComponent(scope.id)}`}`,
      asUnknownOk
    )
  }

  async gameScheduling(
    id: string
  ): Promise<ReturnType<typeof asGameScheduling>> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(id)}/scheduling`,
      asGameScheduling
    )
  }

  async withdrawFromGame(id: string, teamId: string): Promise<void> {
    await this.request(
      'POST',
      `/games/${encodeURIComponent(id)}/withdrawals`,
      asObject({
        id: asString,
        status: asLiteral('cancelled'),
        reason: asLiteral('withdrawal'),
        withdrawnByTeamId: asString
      }),
      { teamId }
    )
  }

  async inviteRelationship(
    body: RelationshipRequestInput
  ): Promise<{ id: string; status: string }> {
    return await this.request(
      'POST',
      '/relationship-requests',
      asObject({ id: asString, status: asString }),
      body
    )
  }

  async decideRelationship(
    id: string,
    decision: 'accept' | 'decline' | 'withdraw' | 'resend',
    idempotencyKey?: string
  ): Promise<{
    id: string
    status: string
    source?: GroupRef
    notice?: string
  }> {
    return await this.request(
      'POST',
      `/relationship-requests/${encodeURIComponent(id)}/${decision}`,
      asObject({
        id: asString,
        status: asString,
        source: asOptional(asGroupRef),
        notice: asOptional(asString)
      }),
      { idempotencyKey }
    )
  }

  async endParticipation(seasonId: string, teamId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/seasons/${encodeURIComponent(seasonId)}/memberships/${encodeURIComponent(teamId)}`,
      asUnknownOk
    )
  }

  async notifications(
    options: {
      history?: boolean
      sent?: boolean
      cursor?: string
      limit?: number
    } = {}
  ): Promise<{
    items: Notification[]
    hasPending: boolean
    nextCursor: string | null
  }> {
    const query = new URLSearchParams()
    if (options.history === true) query.set('history', '1')
    if (options.sent === true) query.set('sent', '1')
    if (options.cursor != null) query.set('cursor', options.cursor)
    if (options.limit != null) query.set('limit', String(options.limit))
    return await this.request(
      'GET',
      `/me/notifications?${query.toString()}`,
      asNotificationPage
    )
  }

  async notification(id: string): Promise<Notification> {
    return await this.request(
      'GET',
      `/me/notifications/${encodeURIComponent(id)}`,
      asNotification
    )
  }

  async viewNotification(id: string): Promise<void> {
    await this.request(
      'PUT',
      `/me/notifications/${encodeURIComponent(id)}/viewed`,
      asUnknownOk,
      {}
    )
  }

  /** Takes a reminder out of Pending and into History. */
  async dismissNotification(id: string): Promise<void> {
    await this.request(
      'PUT',
      `/me/notifications/${encodeURIComponent(id)}/dismissed`,
      asUnknownOk,
      {}
    )
  }

  async hasNotifications(): Promise<boolean> {
    return (
      await this.request(
        'GET',
        '/me/notifications/summary',
        asObject({ hasPending: asBoolean })
      )
    ).hasPending
  }

  async pictures(): Promise<AvailablePicture[]> {
    const answer = await this.request(
      'GET',
      '/pictures',
      asObject({
        version: asNumber,
        entries: asArray(
          asObject({
            id: asString,
            label: asString,
            kind: asLiteral('photo', 'creation'),
            prefix: asString,
            sha256: asString,
            width: asNumber,
            height: asNumber,
            url: asString
          })
        )
      })
    )
    return answer.entries
  }

  async chooseCatalogPicture(catalogId: string): Promise<void> {
    await this.request('PUT', '/me/account/catalog-picture', asUnknownOk, {
      catalogId
    })
  }

  async onboarding(): Promise<{ displayName: string; onboarding: Onboarding }> {
    return await this.request(
      'GET',
      '/me/onboarding',
      asObject({ displayName: asString, onboarding: asOnboarding })
    )
  }

  async saveOnboardingName(
    displayName: string
  ): Promise<{ displayName: string; onboarding: Onboarding }> {
    return await this.request(
      'PUT',
      '/me/onboarding/name',
      asObject({ displayName: asString, onboarding: asOnboarding }),
      { displayName }
    )
  }

  async finishOnboarding(picture: {
    catalogId?: string
    image?: AccountPicture
    initials?: boolean
  }): Promise<void> {
    await this.request('PUT', '/me/onboarding/photo', asUnknownOk, picture)
  }

  async citySuggestions(
    query: string,
    session: string
  ): Promise<{
    suggestions: Array<{ id: string; primary: string; secondary: string }>
    provider: 'google' | 'geonames'
    attribution: string
  }> {
    return await this.request(
      'GET',
      `/locations?query=${encodeURIComponent(query)}&session=${encodeURIComponent(session)}`,
      asObject({
        suggestions: asArray(
          asObject({ id: asString, primary: asString, secondary: asString })
        ),
        provider: asLiteral('google', 'geonames'),
        attribution: asString
      })
    )
  }

  async location(id: string, session: string): Promise<Locality> {
    const answer = await this.request(
      'GET',
      `/locations/${encodeURIComponent(id)}?session=${encodeURIComponent(session)}`,
      asObject({ place: asLocality })
    )
    return answer.place
  }

  async eventPlaces(
    query: string,
    kind: EventPlaceKind
  ): Promise<EventPlace[]> {
    return (await this.eventPlaceSuggestions(query, kind)).places
  }

  async eventPlaceSuggestions(
    query: string,
    kind: EventPlaceKind
  ): Promise<ReturnType<typeof asEventPlaces>> {
    return await this.request(
      'GET',
      `/locations?kind=${kind}&query=${encodeURIComponent(query)}`,
      asEventPlaces
    )
  }

  /**
   * Venues for the Field Manager: a search, a list near a point, or the
   * venues some leagues own. See `GET /venues`.
   */
  async venues(
    options: {
      query?: string
      near?: { latitude: number; longitude: number }
      leagueIds?: string[]
    } = {}
  ): Promise<VenueSummary[]> {
    const params = new URLSearchParams()
    if (options.query != null && options.query.trim() !== '')
      params.set('query', options.query.trim())
    if (options.near != null)
      params.set('near', `${options.near.latitude},${options.near.longitude}`)
    for (const id of options.leagueIds ?? []) params.append('league', id)
    const search = params.toString()
    return (
      await this.request(
        'GET',
        `/venues${search === '' ? '' : `?${search}`}`,
        asObject({ items: asArray(asVenueSummary) })
      )
    ).items
  }

  /** The league's Auto-Scheduler setup: its seasons, fields and choices. */
  async scheduleSetup(leagueId: string): Promise<ScheduleSetup> {
    return await this.request(
      'GET',
      `/leagues/${encodeURIComponent(leagueId)}/schedule-setup`,
      asScheduleSetup
    )
  }

  /** Builds a preview of the league's schedule. See `PreviewRequest`. */
  async buildSchedulePreview(
    leagueId: string,
    request: PreviewRequest
  ): Promise<SchedulePreview> {
    return await this.request(
      'POST',
      `/leagues/${encodeURIComponent(leagueId)}/schedule-previews`,
      asSchedulePreview,
      request
    )
  }

  async schedulePreview(previewId: string): Promise<SchedulePreview> {
    return await this.request(
      'GET',
      `/schedule-previews/${encodeURIComponent(previewId)}`,
      asSchedulePreview
    )
  }

  /** Rejects and adds games of one option of a preview. */
  async editSchedulePreview(
    previewId: string,
    edits: {
      option: number
      rejectedGameKeys?: string[]
      addedGames?: AddedGame[]
    }
  ): Promise<SchedulePreview> {
    return await this.request(
      'PUT',
      `/schedule-previews/${encodeURIComponent(previewId)}`,
      asSchedulePreview,
      edits
    )
  }

  async publishSchedulePreview(
    previewId: string,
    option: number
  ): Promise<Publication> {
    return await this.request(
      'POST',
      `/schedule-previews/${encodeURIComponent(previewId)}/publications`,
      asPublication,
      { option }
    )
  }

  /** The league's published games that need rescheduling. */
  async gamesToReschedule(leagueId: string): Promise<GameToReschedule[]> {
    return (
      await this.request(
        'GET',
        `/leagues/${encodeURIComponent(leagueId)}/games-to-reschedule`,
        asObject({ items: asArray(asGameToReschedule) })
      )
    ).items
  }

  /** Chooses the seasons and fields of the league's next schedule. */
  /**
   * Chooses a run's seasons and fields. With `addedFieldIds`, it replaces
   * the fields added from other venues, which stay listed, chosen or not.
   */
  async saveScheduleSetup(
    leagueId: string,
    choice: ScheduleSetupChoice
  ): Promise<ScheduleSetup> {
    return await this.request(
      'PUT',
      `/leagues/${encodeURIComponent(leagueId)}/schedule-setup`,
      asScheduleSetup,
      choice
    )
  }

  async saveScheduleSettings(
    seasonId: string,
    settings: ScheduleSettings
  ): Promise<SeasonScheduleSettings> {
    return await this.request(
      'PUT',
      `/seasons/${encodeURIComponent(seasonId)}/schedule-settings`,
      asSeasonScheduleSettings,
      settings
    )
  }

  /** Flags a team in a season as an exhibition team, or not. */
  async setExhibitionTeam(
    seasonId: string,
    teamId: string,
    exhibition: boolean
  ): Promise<void> {
    await this.request(
      'PUT',
      `/seasons/${encodeURIComponent(seasonId)}/memberships/${encodeURIComponent(teamId)}`,
      asObject({ exhibition: asBoolean }),
      { exhibition }
    )
  }

  /** The venue for a Google place: the registry's, or the place itself. */
  async venueForPlace(placeId: string): Promise<VenueDetail> {
    const [venue] = (
      await this.request(
        'GET',
        `/venues?place=${encodeURIComponent(placeId)}`,
        asObject({ items: asArray(asVenueDetail) })
      )
    ).items
    if (venue == null) throw new HttpError('notFound', 'Not found')
    return venue
  }

  async venue(venueId: string): Promise<VenueDetail> {
    return await this.request(
      'GET',
      `/venues/${encodeURIComponent(venueId)}`,
      asVenueDetail
    )
  }

  /** Adds a Google place to the registry and claims it for a league. */
  async claimPlace(placeId: string, leagueId: string): Promise<VenueDetail> {
    return await this.request('POST', '/venues', asVenueDetail, {
      placeId,
      leagueId
    })
  }

  /** Claims a venue, or asks to co-own it when it is claimed. */
  async claimVenue(venueId: string, leagueId: string): Promise<VenueDetail> {
    return await this.request(
      'POST',
      `/venues/${encodeURIComponent(venueId)}/claims`,
      asVenueDetail,
      { leagueId }
    )
  }

  async decideVenueClaim(
    venueId: string,
    claimId: string,
    decision: 'approve' | 'reject'
  ): Promise<VenueDetail> {
    return await this.request(
      'POST',
      `/venues/${encodeURIComponent(venueId)}/claims/${encodeURIComponent(claimId)}/decisions`,
      asVenueDetail,
      { decision }
    )
  }

  /** Leaves, withdraws or removes a claim. */
  async endVenueClaim(venueId: string, claimId: string): Promise<VenueDetail> {
    return await this.request(
      'DELETE',
      `/venues/${encodeURIComponent(venueId)}/claims/${encodeURIComponent(claimId)}`,
      asVenueDetail
    )
  }

  async updateVenue(
    venueId: string,
    changes: Record<string, unknown>
  ): Promise<VenueDetail> {
    return await this.request(
      'PUT',
      `/venues/${encodeURIComponent(venueId)}`,
      asVenueDetail,
      changes
    )
  }

  async createField(
    venueId: string,
    field: Record<string, unknown>
  ): Promise<VenueDetail> {
    return await this.request(
      'POST',
      `/venues/${encodeURIComponent(venueId)}/fields`,
      asVenueDetail,
      field
    )
  }

  async updateField(
    venueId: string,
    fieldId: string,
    changes: Record<string, unknown>
  ): Promise<VenueDetail> {
    return await this.request(
      'PUT',
      `/venues/${encodeURIComponent(venueId)}/fields/${encodeURIComponent(fieldId)}`,
      asVenueDetail,
      changes
    )
  }

  async deleteField(venueId: string, fieldId: string): Promise<VenueDetail> {
    return await this.request(
      'DELETE',
      `/venues/${encodeURIComponent(venueId)}/fields/${encodeURIComponent(fieldId)}`,
      asVenueDetail
    )
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

  async videoGames(options: VideoCollectionOptions = {}): Promise<VideoGame[]> {
    return await this.request(
      'GET',
      `/events?${videoCollectionQuery(options)}`,
      asArray(asVideoGame)
    )
  }

  async videoTeams(
    options: VideoCollectionOptions = {}
  ): Promise<TeamSummary[]> {
    return await this.request(
      'GET',
      `/teams?${videoCollectionQuery(options)}`,
      asArray(asTeamSummary)
    )
  }

  async videoPlayers(
    options: VideoCollectionOptions = {}
  ): Promise<UserMatch[]> {
    return await this.request(
      'GET',
      `/users?${videoCollectionQuery(options)}`,
      asArray(asUserMatch)
    )
  }

  /**
   * The people another service knows by these ids, as far as this person may
   * see them. A merged row answers as whoever it was merged into.
   */
  async users(options: {
    externalIds: string[]
    system?: string
  }): Promise<UserMatch[]> {
    const params = options.externalIds.map(
      id => `externalId=${encodeURIComponent(id)}`
    )
    if (options.system != null)
      params.push(`system=${encodeURIComponent(options.system)}`)
    const query = params.join('&')
    return await this.request('GET', `/users?${query}`, asArray(asUserMatch))
  }

  /** The players the signed-in person is a guardian of, by short name. */
  async guardedPlayers(): Promise<UserMatch[]> {
    return await this.request(
      'GET',
      '/users?guardedBy=me',
      asArray(asUserMatch)
    )
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
    } catch (error: unknown) {
      // Not knowing is not the same answer as nobody: no signal, a server
      // restarting (5xx), too many requests or an answer that cannot be read
      // all throw, and a phone keeps the session it has. Only the server's
      // 401 says the session is over.
      if (error instanceof HttpError && error.code === 'unauthorized')
        return null
      throw error
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

  async seasonTeams(seasonId: string): Promise<SeasonTeamSummary[]> {
    return await this.request(
      'GET',
      `/seasons/${encodeURIComponent(seasonId)}/teams`,
      asArray(asSeasonTeamSummary)
    )
  }

  async teamGames(teamId: string): Promise<GameSummary[]> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/games`,
      asArray(asGameSummary)
    )
  }

  async eventInfo(eventId: string, teamId?: string): Promise<EventInfo> {
    return await this.request(
      'GET',
      `/events/${encodeURIComponent(eventId)}/info${teamId == null ? '' : `?teamId=${encodeURIComponent(teamId)}`}`,
      asEventInfo
    )
  }

  async eventLocation(
    eventId: string
  ): Promise<ReturnType<typeof asEventLocation>> {
    return await this.request(
      'GET',
      `/events/${encodeURIComponent(eventId)}/location`,
      asEventLocation
    )
  }

  async createTeamEvent(body: TeamEventInput): Promise<{ id: string }> {
    return await this.request(
      'POST',
      '/events',
      asObject({ id: asString }),
      body
    )
  }

  async updateEventInfo(
    eventId: string,
    body: Record<string, unknown>
  ): Promise<EventInfo> {
    return await this.request(
      'PUT',
      `/events/${encodeURIComponent(eventId)}/info`,
      asEventInfo,
      body
    )
  }

  async saveRsvp(
    eventId: string,
    userId: string,
    response: Rsvp
  ): Promise<{ userId: string; response: Rsvp }> {
    return await this.request(
      'PUT',
      `/events/${encodeURIComponent(eventId)}/rsvps/${userId}`,
      asObject({ userId: asUserId, response: asRsvp }),
      { response }
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

  async tvHighlights(
    videoId: string,
    participant?: string
  ): Promise<TvHighlight[]> {
    return (
      await this.request(
        'GET',
        `/videos/${encodeURIComponent(videoId)}/highlights?personalized=1${participant === undefined ? '' : `&participant=${encodeURIComponent(participant)}`}`,
        asTvHighlights
      )
    ).highlights
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

  /**
   * Where each position of a video falls on the server's clock. With
   * `afterMs`, only the points after that position: what a live player polls
   * for as the stream grows.
   */
  async wallTimeline(videoId: string, afterMs?: number): Promise<WallTimeline> {
    const query = afterMs == null ? '' : `?afterMs=${Math.floor(afterMs)}`
    return await this.request(
      'GET',
      `/videos/${encodeURIComponent(videoId)}/wall-timeline${query}`,
      asWallTimeline
    )
  }

  /**
   * A game's board at every moment from `fromMs` on (to `toMs`, when given),
   * with the step already in effect at `fromMs`.
   */
  async scoreboardTimeline(
    gameId: string,
    window: { fromMs?: number; toMs?: number } = {}
  ): Promise<BoardTimelineWindow> {
    const query = new URLSearchParams()
    if (window.fromMs != null)
      query.set('from', String(Math.max(0, Math.floor(window.fromMs))))
    if (window.toMs != null)
      query.set('to', String(Math.max(0, Math.ceil(window.toMs))))
    const text = query.toString()
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/scoreboard-timeline${
        text === '' ? '' : `?${text}`
      }`,
      asBoardTimelineWindow
    )
  }

  /**
   * A game's line score from its events alone: every step, the one in effect
   * at an instant (`at`), or those in a window, with the one in effect at
   * `fromMs`.
   */
  async lineScore(
    gameId: string,
    query: { at?: number; fromMs?: number; toMs?: number } = {}
  ): Promise<LineScoreTimeline> {
    const params = new URLSearchParams()
    if (query.at != null)
      params.set('at', String(Math.max(0, Math.floor(query.at))))
    if (query.fromMs != null)
      params.set('from', String(Math.max(0, Math.floor(query.fromMs))))
    if (query.toMs != null)
      params.set('to', String(Math.max(0, Math.ceil(query.toMs))))
    const text = params.toString()
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/line-score${
        text === '' ? '' : `?${text}`
      }`,
      asLineScoreTimeline
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

  /**
   * Another camera of my own on this game, up to the fourth. With a device,
   * the stream this device holds under this name, or a new one.
   */
  async addLiveStream(
    gameId: string,
    label?: string,
    device?: DeviceStreamOptions
  ): Promise<LiveStream> {
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/live-streams`,
      asLiveStream,
      { ...(label == null ? {} : { label }), ...(device ?? {}) }
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

  /**
   * Renames one of my cameras, or says this phone holds its recording
   * (`localRecording: 'recorded'`), which starts the upload reminder.
   */
  async updateLiveStream(
    gameId: string,
    streamId: string,
    change: { label?: string; localRecording?: 'recorded' }
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

  /**
   * Saves one side's lineup in a game, as its head coach or a scorekeeper
   * sets it, and answers both sides' lineups as they now stand.
   */
  async saveLineups(
    gameId: string,
    body: SaveLineupsBody
  ): Promise<GameLineupsResponse> {
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/lineups`,
      asGameLineupsResponse,
      body
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

  /** The caller's recent tags and globally popular active assignments. */
  async tagChoices(options: { includeUnused?: boolean } = {}): Promise<{
    recent: string[]
    popular: Array<{ tag: string; count: number }>
  }> {
    return await this.request(
      'GET',
      options.includeUnused === true ? '/tags?includeUnused=true' : '/tags',
      asObject({
        recent: asArray(asString),
        popular: asArray(asObject({ tag: asString, count: asNumber }))
      })
    )
  }

  /**
   * Swaps the game's home and away teams, for whoever may score it. A begun
   * game is reset first, once `read` names the plays digest and generation
   * its scorer confirmed losing; the answer names the at-bats and innings
   * the reset deleted. `read` is the sides the caller read: sent again, the
   * call changes nothing.
   */
  async swapGameSides(
    gameId: string,
    read: SwapSidesRead
  ): Promise<SwapSidesAnswer> {
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/swap-sides`,
      asSwapSidesAnswer,
      read
    )
  }

  async saveEventTag(
    gameId: string,
    targetId: string,
    tag: string | null
  ): Promise<{ targetId: string; tag: string | null; revision: string }> {
    return await this.request(
      tag == null ? 'DELETE' : 'PUT',
      `/games/${encodeURIComponent(gameId)}/tags/${encodeURIComponent(targetId)}`,
      asObject({
        targetId: asString,
        tag: asNullable(asString),
        revision: asString
      }),
      tag == null ? undefined : { tag }
    )
  }

  /**
   * Where a replay step's spoken sentence is, as the step stood with `count`
   * actions, with the header that says who is asking, for a player that
   * fetches it itself. A browser's session is its cookie, which needs no
   * header.
   */
  narrationSource(
    gameId: string,
    step: NarrationStepRef
  ): { uri: string; headers: Record<string, string> } {
    return {
      uri: `${this.baseUrl}/games/${encodeURIComponent(gameId)}/narrations/${encodeURIComponent(step.key)}?count=${step.count}`,
      headers:
        this.token == null ? {} : { authorization: `Bearer ${this.token}` }
    }
  }

  /** A replay step's spoken sentence, as MP3 audio. */
  async narrationAudio(
    gameId: string,
    step: NarrationStepRef,
    signal?: AbortSignal
  ): Promise<Blob> {
    const response = await this.narrationResponse('GET', gameId, step, signal)
    return await response.blob()
  }

  /**
   * Resolves once a replay step's sentence is ready to be heard, without
   * downloading it, for a player that fetches the audio itself.
   */
  async narrationReady(
    gameId: string,
    step: NarrationStepRef,
    signal?: AbortSignal
  ): Promise<void> {
    await this.narrationResponse('HEAD', gameId, step, signal)
  }

  private async narrationResponse(
    method: 'GET' | 'HEAD',
    gameId: string,
    step: NarrationStepRef,
    signal?: AbortSignal
  ): Promise<Response> {
    const { uri, headers } = this.narrationSource(gameId, step)
    let response: Response
    try {
      response = await this.doFetch(uri, {
        method,
        headers: { ...headers, accept: 'audio/mpeg' },
        credentials: 'include',
        signal
      })
    } catch {
      throw new HttpError(
        'offline',
        'Cannot reach TeamStation. Check your connection and try again.'
      )
    }
    if (!response.ok) throw errorFrom(response.status, await response.text())
    return response
  }

  /**
   * A game's stored plays and the at-bat in progress, with the digest of its
   * lineups.
   */
  async gameEvents(gameId: string): Promise<StoredGame> {
    return storedGameOf(
      await this.request(
        'GET',
        `/games/${encodeURIComponent(gameId)}/events`,
        asStoredGame
      )
    )
  }

  /**
   * Scores into a game as it is played: the plays that changed, the indexes
   * an undo took away, and the at-bat in progress when it changed. Naming
   * the lineups digest it was built on, it is refused as stale (409,
   * `details.stale`) once somebody else has saved the lineups since.
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
          : { fenceDistanceFt: change.fenceDistanceFt }),
        ...(change.lineupsBase === undefined
          ? {}
          : { lineupsBase: change.lineupsBase }),
        ...(change.generation === undefined
          ? {}
          : { generation: change.generation })
      },
      change.names == null ? undefined : { deviceNames: change.names }
    )
    return storedGameOf(stored)
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
  async followTeam(teamId: string): Promise<boolean> {
    const answer = await this.request(
      'PUT',
      `/teams/${encodeURIComponent(teamId)}/follow`,
      asObject({ following: asBoolean })
    )
    return answer.following
  }

  /** Stops following a team. Unfollowing one not followed changes nothing. */
  async unfollowTeam(teamId: string): Promise<boolean> {
    const answer = await this.request(
      'DELETE',
      `/teams/${encodeURIComponent(teamId)}/follow`,
      asObject({ following: asBoolean })
    )
    return answer.following
  }

  /** The teams this person follows. */
  async myFollows(): Promise<FollowableTeam[]> {
    return await this.request(
      'GET',
      '/me/team-follows',
      asArray(asFollowableTeam)
    )
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

  async roster(
    teamId: string,
    options: { includeFullNames?: boolean } = {}
  ): Promise<RosterEntry[]> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/roster${options.includeFullNames === true ? '?includeFullNames=true' : ''}`,
      asArray(asRosterEntry)
    )
  }

  /**
   * Creates a player on the team. The answer is their roster entry, whole
   * name included, as a roster manager reads it.
   */
  async createRosterPlayer(
    teamId: string,
    player: NewRosterPlayer
  ): Promise<RosterEntry> {
    return await this.request(
      'POST',
      `/teams/${encodeURIComponent(teamId)}/roster-players`,
      asRosterEntry,
      player
    )
  }

  async setRostered(
    gameId: string,
    body: UnrosterBody
  ): Promise<ReturnType<typeof asUnrostered>> {
    return await this.request(
      'PUT',
      `/games/${encodeURIComponent(gameId)}/unroster`,
      asUnrostered,
      body
    )
  }

  /**
   * Puts a player who already exists on the team's roster, by user id, with
   * only a jersey and positions of the team's own. The entry, with the notice
   * their side was sent, or the request waiting for their side's approval.
   */
  async addExistingRosterPlayer(
    teamId: string,
    body: ExistingRosterPlayer
  ): Promise<ExistingPlayerAnswer> {
    return await this.request(
      'POST',
      `/teams/${encodeURIComponent(teamId)}/roster-players`,
      asExistingPlayerAnswer,
      body
    )
  }

  /** Adds a player who already exists to one side of one game only. */
  async addExistingGuest(
    gameId: string,
    side: 'away' | 'home',
    body: ExistingRosterPlayer,
    teamId?: string
  ): Promise<ExistingPlayerAnswer> {
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/guest-players`,
      asExistingPlayerAnswer,
      { side, ...(teamId == null ? {} : { teamId }), ...body }
    )
  }

  /**
   * The players a roster manager may add to a team, or to its side of a
   * game, nearest first, a page at a time (`GET /users?forTeam=`).
   */
  async rosterCandidates(ask: {
    teamId: string
    gameId?: string
    q?: string
    after?: string
    limit?: number
    signal?: AbortSignal
  }): Promise<RosterCandidate[]> {
    const params = new URLSearchParams({ forTeam: ask.teamId })
    if (ask.gameId != null) params.set('forGame', ask.gameId)
    if (ask.q != null && ask.q !== '') params.set('q', ask.q)
    if (ask.after != null) params.set('after', ask.after)
    if (ask.limit != null) params.set('limit', String(ask.limit))
    return await this.request(
      'GET',
      `/users?${params.toString()}`,
      asArray(asRosterCandidate),
      undefined,
      ask.signal == null ? {} : { signal: ask.signal }
    )
  }

  /**
   * A guest on one side of the game. `teamId` is the team the caller means:
   * when home and away were swapped since it read the game, the server
   * refuses rather than add the guest to the other team.
   */
  async createGuestPlayer(
    gameId: string,
    side: 'away' | 'home',
    player: NewRosterPlayer,
    teamId?: string
  ): Promise<RosterEntry> {
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/guest-players`,
      asRosterEntry,
      { side, ...(teamId == null ? {} : { teamId }), ...player }
    )
  }

  /**
   * Corrects the name of a game-only player, a guest of this game who cannot
   * sign in: his account is renamed, so every read of the game names him
   * anew. The answer is his roster entry as `createGuestPlayer` answers it.
   * `gumboId`, when given, is kept on the device with the name, so a rename
   * queued offline names him so in the phone's copy of the game.
   */
  async renameGuestPlayer(
    gameId: string,
    userId: string,
    name: { firstName: string; lastName: string },
    gumboId?: number | null
  ): Promise<RosterEntry> {
    return await this.request(
      'PUT',
      `/games/${encodeURIComponent(gameId)}/guest-players/${encodeURIComponent(userId)}`,
      asRosterEntry,
      { firstName: name.firstName, lastName: name.lastName },
      gumboId == null
        ? undefined
        : {
            deviceNames: {
              [String(gumboId)]: [name.firstName, name.lastName]
                .filter(part => part !== '')
                .join(' ')
            }
          }
    )
  }

  /**
   * What a roster manager sets for one player on one team. Only the fields sent
   * change; the answer is the player's roster entry as it now reads.
   */
  async setPlayerSettings(
    teamId: string,
    userId: string,
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
   * How a player bats and throws, away from any team: for a guardian of the
   * player, or a coach of a team they play on. Only the fields sent change.
   */
  async setPlayerBatsThrows(
    userId: string,
    settings: PersonSettings
  ): Promise<PersonSettingsAnswer> {
    return await this.request(
      'PUT',
      `/players/${encodeURIComponent(userId)}/settings`,
      asPersonSettingsAnswer,
      settings
    )
  }

  /**
   * Sets a player's walk-up song on one team, for a songkeeper. The answer
   * is the song as it was stored.
   */
  async setWalkUpSong(
    teamId: string,
    userId: string,
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
  async clearWalkUpSong(teamId: string, userId: string): Promise<void> {
    await this.request('DELETE', walkUpSongPath(teamId, userId), asUnknownOk)
  }

  /** A player's guardians and adult family members, guardians first. */
  async guardians(teamId: string, userId: string): Promise<Guardian[]> {
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
    userId: string,
    who: { userId: string } | { email: string },
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
    userId: string,
    guardianId: string
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
    userId: string,
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

  async updateChatPreferences(
    conversationId: string,
    patch: Partial<Pick<ChatPreferences, 'pinned' | 'muted' | 'manualUnread'>>
  ): Promise<ChatPreferences> {
    return await this.request(
      'PATCH',
      `${chatPath(conversationId)}/preferences`,
      asChatPreferences,
      patch
    )
  }

  async chatPins(conversationId: string): Promise<ChatPin[]> {
    return await this.request(
      'GET',
      `${chatPath(conversationId)}/pins`,
      asArray(asChatPin)
    )
  }

  async pinChatMessage(
    conversationId: string,
    messageId: string,
    pinned: boolean
  ): Promise<ChatPin[]> {
    return await this.request(
      pinned ? 'PUT' : 'DELETE',
      `${chatPath(conversationId)}/pins/${encodeURIComponent(messageId)}`,
      asArray(asChatPin)
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
  async dmCandidates(query = '', userId?: string): Promise<ChatPerson[]> {
    return await this.request(
      'GET',
      `/chat/dm-candidates?q=${encodeURIComponent(query)}${userId == null ? '' : `&userId=${encodeURIComponent(userId)}`}`,
      asArray(asChatPerson)
    )
  }

  /**
   * Adults who may be included beside these players, as SafeSport's MAAPP
   * asks: suggestions without a query, every match with one.
   */
  async includedAdults(
    playerIds: string[],
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
  async createDm(userIds: string[]): Promise<ChatConversation> {
    return await this.request('POST', '/chat/dms', asChatConversation, {
      userIds
    })
  }

  /** Adds people to a DM the caller is in; answers who was added. */
  async addDmMembers(
    conversationId: string,
    userIds: string[]
  ): Promise<string[]> {
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

  /**
   * Revokes one of the caller's devices (this one, to sign out). With
   * `keepSession`, only the device bound to this session, and the session
   * stays signed in (a device whose saved keys cannot be read, reset).
   */
  async revokeChatDevice(
    deviceId: string,
    options: { keepSession?: boolean } = {}
  ): Promise<ChatDevice> {
    const query = options.keepSession === true ? '?keepSession=true' : ''
    return await this.request(
      'DELETE',
      `/chat/devices/${encodeURIComponent(deviceId)}${query}`,
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
  async chatUserKeys(userId: string): Promise<ChatUserKeys> {
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

  /** A chat's epochs after `after` (0 for all), and the caller's boxes. */
  async chatEpochs(conversationId: string, after = 0): Promise<ChatEpochs> {
    return await this.request(
      'GET',
      `${chatPath(conversationId)}/epochs?after=${encodeURIComponent(after)}`,
      asChatEpochs
    )
  }

  /** Makes a chat's next epoch from this (linked) device. */
  async postChatEpoch(
    conversationId: string,
    epoch: ChatEpochPublication
  ): Promise<ChatEpochMade> {
    return await this.request(
      'POST',
      `${chatPath(conversationId)}/epochs`,
      asChatEpochMade,
      epoch
    )
  }

  /** The open grant requests in the caller's chats. */
  async chatGrants(): Promise<ChatGrantRequest[]> {
    return await this.request(
      'GET',
      '/chat/grants',
      asArray(asChatGrantRequest)
    )
  }

  /** Fills grant requests, at most 500 boxes at once. */
  async postChatGrants(boxes: ChatGrantBox[]): Promise<ChatGrantsPosted> {
    return await this.request('POST', '/chat/grants', asChatGrantsPosted, {
      boxes
    })
  }

  /** Posts a sealed message; a repeat of its id answers the stored one. */
  async postChatMessage(
    conversationId: string,
    envelope: ChatMessageEnvelope
  ): Promise<ChatMessage> {
    return await this.request(
      'POST',
      `${chatPath(conversationId)}/messages`,
      asChatMessage,
      envelope
    )
  }

  /**
   * A page of a chat's messages, oldest first: after `after`, or the last
   * ones before `before`.
   */
  async chatMessages(
    conversationId: string,
    page: { after?: number; before?: number; limit?: number } = {}
  ): Promise<ChatMessage[]> {
    const query = (['after', 'before', 'limit'] as const)
      .flatMap(name =>
        page[name] == null
          ? []
          : [`${name}=${encodeURIComponent(page[name] ?? 0)}`]
      )
      .join('&')
    return await this.request(
      'GET',
      `${chatPath(conversationId)}/messages${query === '' ? '' : `?${query}`}`,
      asArray(asChatMessage)
    )
  }

  /** Moves the caller's read cursor on to `seq`; it never moves back. */
  async markChatRead(
    conversationId: string,
    seq: number,
    clearManualUnreadRevision?: number
  ): Promise<{ seq: number }> {
    return await this.request(
      'PUT',
      `${chatPath(conversationId)}/read`,
      asObject({ seq: asNumber }),
      {
        seq,
        ...(clearManualUnreadRevision == null
          ? {}
          : { clearManualUnreadRevision })
      }
    )
  }

  /** Reports one message, disclosing its text and its own key. */
  async reportChatMessage(report: {
    messageId: string
    plaintext: string
    messageKey: string
  }): Promise<{ id: string; verified: boolean }> {
    return await this.request(
      'POST',
      '/chat/reports',
      asObject({ id: asString, verified: asBoolean }),
      report
    )
  }

  /**
   * Opens an attachment upload: the sealed blob's size in bytes and its
   * SHA-256 (base64url), in a chat the caller may post in.
   */
  async createChatAttachment(upload: {
    conversationId: string
    size: number
    digest: string
  }): Promise<ChatAttachment> {
    return await this.request(
      'POST',
      '/chat/attachments',
      asChatAttachment,
      upload
    )
  }

  /** Sends part `index` (from 0) of an attachment; again is harmless. */
  async putChatAttachmentPart(
    attachmentId: string,
    index: number,
    bytes: Uint8Array
  ): Promise<ChatAttachmentParts> {
    return await this.request(
      'PUT',
      `${attachmentPath(attachmentId)}/parts/${index}`,
      asChatAttachmentParts,
      bytes
    )
  }

  /** Every part sent: the server checks the digest and keeps the blob. */
  async completeChatAttachment(attachmentId: string): Promise<ChatAttachment> {
    return await this.request(
      'POST',
      `${attachmentPath(attachmentId)}/complete`,
      asChatAttachment
    )
  }

  /**
   * A finished attachment with a presigned URL to fetch its blob, or, to its
   * uploader, an unfinished one with the parts still missing.
   */
  async chatAttachment(attachmentId: string): Promise<ChatAttachment> {
    return await this.request(
      'GET',
      attachmentPath(attachmentId),
      asChatAttachment
    )
  }

  /** Reported messages (site administrators); only unresolved with `open`. */
  async chatReports(open = false): Promise<ChatReport[]> {
    return await this.request(
      'GET',
      `/admin/chat/reports${open ? '?open=true' : ''}`,
      asArray(asChatReport)
    )
  }

  /** Marks a report resolved (site administrators). */
  async resolveChatReport(reportId: string): Promise<ChatReport> {
    return await this.request(
      'PUT',
      `/admin/chat/reports/${encodeURIComponent(reportId)}/resolve`,
      asChatReport
    )
  }

  /** One person: their picture, their name, their handedness, their teams. */
  async player(userId: string, forTeam?: string): Promise<PlayerDetail> {
    return await this.request(
      'GET',
      `/players/${encodeURIComponent(userId)}${forTeam == null ? '' : `?forTeam=${encodeURIComponent(forTeam)}`}`,
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

  /**
   * Every highlight one player is credited on, newest first, a page at a
   * time, narrowed to a season, a team or a year as `playerStats` is.
   */
  async playerHighlights(
    userId: string,
    options: {
      before?: string
      limit?: number
      seasonId?: string
      teamId?: string
      year?: number
    } = {}
  ): Promise<PlayerHighlights> {
    const query = new URLSearchParams()
    if (options.before != null) query.set('before', options.before)
    if (options.limit != null) query.set('limit', String(options.limit))
    if (options.seasonId != null) query.set('seasonId', options.seasonId)
    if (options.teamId != null) query.set('teamId', options.teamId)
    if (options.year != null) query.set('year', String(options.year))
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

  async seasonStats(seasonId: string): Promise<SeasonStats> {
    return await this.request(
      'GET',
      `/seasons/${encodeURIComponent(seasonId)}/stats`,
      asSeasonStats
    )
  }

  async standings(
    seasonId: string,
    filter: { includeExhibitions?: boolean } = {}
  ): Promise<StandingsRow[]> {
    return await this.request(
      'GET',
      `/seasons/${encodeURIComponent(seasonId)}/standings${filter.includeExhibitions == null ? '' : `?includeExhibitions=${String(filter.includeExhibitions)}`}`,
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
    options: { email: string; displayName?: string } & SignInRequestOptions
  ): Promise<SignInWait> {
    const wait = await this.request(
      'POST',
      `/join/${encodeURIComponent(code)}/email-code`,
      asSignInWait,
      { ...options, origin: options.origin ?? 'web' }
    )
    this.askedSignIn = wait.requestId
    return wait
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
    email: string,
    options: {
      admin?: boolean
      flags?: RoleFlag[]
      idempotencyKey?: string
    } = {}
  ): Promise<AddedPerson> {
    return await this.request(
      'POST',
      `/manage/${kind}/${encodeURIComponent(id)}/people`,
      asAddedPerson,
      { email, ...options }
    )
  }

  /** Take away what this level grants, and only that. */
  async removePerson(
    kind: 'league' | 'season' | 'team',
    id: string,
    userId: string
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
    userId: string,
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
    userId: string,
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

  /** A season's or league's people, in the roster's sections. */
  async levelPeople(
    kind: 'league' | 'season',
    id: string
  ): Promise<LevelPeople> {
    return await this.request(
      'GET',
      `/${kind}s/${encodeURIComponent(id)}/people`,
      asLevelPeople
    )
  }

  /** One person, as the level they were opened from sees them. */
  async personProfile(
    kind: 'league' | 'season' | 'team',
    id: string,
    userId: string
  ): Promise<PersonProfile> {
    return await this.request(
      'GET',
      `/${kind}s/${encodeURIComponent(id)}/people/${encodeURIComponent(userId)}`,
      asPersonProfile
    )
  }

  /**
   * Gives somebody one role at this level, or its membership (`member`), at
   * once: a role brings the membership with it.
   */
  async addRole(
    kind: 'league' | 'season' | 'team',
    id: string,
    userId: string,
    role: Role | 'member'
  ): Promise<HeldAt> {
    return await this.request(
      'PUT',
      `/manage/${kind}/${encodeURIComponent(id)}/people/${encodeURIComponent(userId)}/roles/${role}`,
      asHeldAt,
      {}
    )
  }

  /**
   * Takes one role at this level away from somebody, or with `member` takes
   * them out of the level, every role there with it.
   */
  async removeRole(
    kind: 'league' | 'season' | 'team',
    id: string,
    userId: string,
    role: Role | 'member'
  ): Promise<HeldAt> {
    return await this.request(
      'DELETE',
      `/manage/${kind}/${encodeURIComponent(id)}/people/${encodeURIComponent(userId)}/roles/${role}`,
      asHeldAt
    )
  }

  /**
   * Leaves a team, season or league: its membership and every role there.
   * What a level above gives is left where it was given.
   */
  async leaveGroup(
    kind: 'league' | 'season' | 'team',
    id: string
  ): Promise<{ removed: boolean }> {
    return await this.request(
      'DELETE',
      `/me/groups/${kind}/${encodeURIComponent(id)}`,
      asObject({ removed: asBoolean })
    )
  }

  /** Steps down from one role of your own at this level. */
  async stepDown(
    kind: 'league' | 'season' | 'team',
    id: string,
    role: Role
  ): Promise<HeldAt> {
    return await this.request(
      'DELETE',
      `/me/groups/${kind}/${encodeURIComponent(id)}/roles/${role}`,
      asHeldAt
    )
  }

  /** The roles the signed-in person holds, team by team. */
  async myRoles(): Promise<MyRoles> {
    return await this.request('GET', '/me/roles', asMyRoles)
  }

  /**
   * A document this client keeps on the device, read without the network:
   * what the last answer for `key` stored, or nothing. The web keeps none.
   */
  async cached<T>(_key: string, _cleaner: Cleaner<T>): Promise<T | undefined> {
    return undefined
  }

  /**
   * Every call to the API. `collect: false` keeps the answer's revision out
   * of the screen loads now collecting, as a prefetch's is. `headers` are
   * sent beside the usual ones: a queued write's `Idempotency-Key`.
   */
  protected async request<T>(
    method: string,
    path: string,
    cleaner: Cleaner<T>,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    return await observeApi(
      method,
      path,
      async () =>
        await this.requestUnobserved(method, path, cleaner, body, options),
      this.captureAnalytics
    )
  }

  /**
   * A `POST` whose answer is a stream of events (`text/event-stream`): each
   * one Tess tells as it happens goes to `onEvent`, and `done` is the answer,
   * cleaned by `cleaner`, or `error` the failure. A JSON answer is taken as
   * it is: a refusal, or a server that does not stream.
   */
  private async streamTess<T>(
    path: string,
    cleaner: Cleaner<T>,
    body: unknown,
    onEvent: (event: TessStreamEvent) => void
  ): Promise<T> {
    return await observeApi(
      'POST',
      path,
      async () =>
        await new Promise<T>((resolve, reject) => {
          this.streamUnobserved(path, cleaner, body, onEvent, resolve, reject)
        }),
      this.captureAnalytics
    )
  }

  private streamUnobserved<T>(
    path: string,
    cleaner: Cleaner<T>,
    body: unknown,
    onEvent: (event: TessStreamEvent) => void,
    resolve: (value: T) => void,
    reject: (error: unknown) => void
  ): void {
    const make =
      this.newStreamingRequest ??
      (() => {
        const Platform = (
          globalThis as { XMLHttpRequest?: new () => StreamingRequest }
        ).XMLHttpRequest
        if (Platform == null) throw new Error('No XMLHttpRequest here')
        return new Platform()
      })
    const xhr = make()
    let settled = false
    let read = 0
    const events = serverSentEvents()
    const settle = (outcome: () => T): void => {
      if (settled) return
      settled = true
      try {
        resolve(outcome())
      } catch (error) {
        reject(error)
      }
    }
    const lost = (): void => {
      if (settled) return
      this.offline = true
      settle(() => {
        throw new HttpError(
          'offline',
          'Cannot reach TeamStation. Check your connection and try again.'
        )
      })
    }
    const ok = (): boolean => xhr.status >= 200 && xhr.status < 300
    const streaming = (): boolean =>
      ok() &&
      (xhr.getResponseHeader('content-type') ?? '').includes(
        'text/event-stream'
      )
    const take = ({ event: name, data }: ServerSentEvent): void => {
      // A comment, `: keep-alive`, has no data.
      if (data == null) return
      let value: unknown
      try {
        value = JSON.parse(data)
      } catch {
        return
      }
      if (name === 'done') {
        settle(() => cleaner(value))
        return
      }
      if (name === 'error') {
        settle(() => {
          throw streamError(value)
        })
        return
      }
      let event: TessStreamEvent | null
      try {
        event = tessStreamEventOf(name, value)
      } catch {
        return
      }
      if (event != null && !settled) onEvent(event)
    }
    const pump = (): void => {
      if (!streaming()) return
      const text = xhr.responseText
      const more = text.slice(read)
      read = text.length
      for (const event of events.push(more)) take(event)
    }
    xhr.onprogress = pump
    xhr.onload = () => {
      this.offline = false
      if (xhr.status === 401) this.onSessionRefused?.()
      if (!ok()) {
        settle(() => {
          throw errorFrom(xhr.status, xhr.responseText)
        })
        return
      }
      if (!streaming()) {
        settle(() => {
          let parsed: unknown
          try {
            parsed = JSON.parse(xhr.responseText)
          } catch {
            throw new HttpError(
              'internal',
              'The server sent something unreadable'
            )
          }
          return cleaner(parsed)
        })
        return
      }
      pump()
      for (const event of events.end()) take(event)
      // The stream ended before Tess was done: the answer was lost.
      lost()
    }
    xhr.onerror = lost
    xhr.ontimeout = lost
    xhr.onabort = lost
    xhr.open('POST', `${this.baseUrl}${path}`)
    // The cookie on the web, as `request` sends it.
    xhr.withCredentials = true
    xhr.setRequestHeader('accept', 'text/event-stream')
    if (body !== undefined)
      xhr.setRequestHeader('content-type', 'application/json')
    if (this.analyticsApp != null)
      xhr.setRequestHeader('x-teamstation-app', this.analyticsApp)
    if (this.token != null)
      xhr.setRequestHeader('authorization', `Bearer ${this.token}`)
    xhr.send(body === undefined ? undefined : JSON.stringify(body))
  }

  private async requestUnobserved<T>(
    method: string,
    path: string,
    cleaner: Cleaner<T>,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...options.headers,
      accept: 'application/json'
    }
    // Bytes (an attachment's part) go as they are; anything else as JSON.
    const bytes = body instanceof Uint8Array ? body : undefined
    if (body !== undefined) {
      headers['content-type'] =
        bytes != null ? 'application/octet-stream' : 'application/json'
    }
    if (this.analyticsApp != null)
      headers['x-teamstation-app'] = this.analyticsApp
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
        body:
          bytes != null
            ? new Uint8Array(bytes)
            : body === undefined
              ? undefined
              : JSON.stringify(body),
        ...(options.signal == null ? {} : { signal: options.signal })
      })
    } catch (caught: unknown) {
      if (options.signal?.aborted === true) throw caught
      this.offline = true
      throw new HttpError(
        'offline',
        'Cannot reach TeamStation. Check your connection and try again.'
      )
    }
    this.offline = false
    if (
      response.status === 401 &&
      !(method === 'POST' && path.startsWith('/auth/'))
    )
      this.onSessionRefused?.()

    // The connection can drop after the answer starts, while its body is
    // read. The status has arrived by then: a refusal is still the server's
    // answer, and only a success cut short is as offline as a fetch that
    // never reached the server.
    let text: string
    try {
      text = await response.text()
    } catch {
      if (!response.ok) throw errorFrom(response.status, '')
      throw new HttpError(
        'offline',
        'Cannot reach TeamStation. Check your connection and try again.'
      )
    }
    if (!response.ok) throw errorFrom(response.status, text)
    const revision = revisionOf(response)
    if (revision != null) {
      this.revisions.set(path, revision)
      if (options.collect !== false)
        for (const collector of this.collectors)
          collector.push({ path, revision })
    }
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

function guardiansPath(teamId: string, userId: string): string {
  return `/teams/${encodeURIComponent(teamId)}/players/${encodeURIComponent(userId)}/guardians`
}

function walkUpSongPath(teamId: string, userId: string): string {
  return `/teams/${encodeURIComponent(teamId)}/players/${encodeURIComponent(userId)}/walk-up-song`
}

/** The answer's revision. A stand-in response may carry no headers. */
function revisionOf(response: Response): string | null {
  const headers = (response as Partial<Response>).headers
  return headers == null ? null : headers.get(REVISION_HEADER)
}

function attachmentPath(attachmentId: string): string {
  return `/chat/attachments/${encodeURIComponent(attachmentId)}`
}

/** For the endpoints whose body carries nothing a caller needs. */
function chatPath(conversationId: string): string {
  return `/chat/conversations/${encodeURIComponent(conversationId)}`
}

const asUnknownOk: Cleaner<null> = () => null

/**
 * The failure a stream's `error` event carries: the error the server would
 * have answered with, or its status, as a `TessTurnError` when it says
 * whether the turn's message is kept.
 */
function streamError(value: unknown): HttpError {
  let error: HttpError
  try {
    const api = asApiError(value)
    error = new HttpError(api.code, api.message, api.details)
  } catch {
    const status = (value as { status?: unknown } | null)?.status
    error = errorFrom(typeof status === 'number' ? status : 500, '')
  }
  const kept = (value as { kept?: unknown } | null)?.kept
  return typeof kept === 'boolean' ? new TessTurnError(error, kept) : error
}

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
  const code =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'notFound'
          : 'internal'
  return new HttpError(code, `The server answered ${status}`)
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
/**
 * Roster commands as said, each checked by the scoring library's own
 * cleaner. One that does not clean is dropped, and the rest are kept.
 */
const asWireRoster: Cleaner<SaidRosterCommand[]> = raw => {
  if (!Array.isArray(raw)) throw new TypeError('Expected a list of commands')
  return raw.flatMap(item => {
    try {
      return [asSaidRosterCommand(item)]
    } catch {
      return []
    }
  })
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
  tagOrder: asOptional(asArray(asGumboId)),
  /** Absent means the model the server is configured with. */
  model: asOptional(asDictationModel)
})
export type DictationStart = { kind: 'start'; tagOrder?: number[] } & Omit<
  ReturnType<typeof asStartBody>,
  'tagOrder'
>
export const asDictationStart: Cleaner<DictationStart> = raw => {
  if ((raw as { kind?: unknown } | null)?.kind !== 'start')
    throw new TypeError('Expected a start frame')
  const { tagOrder, ...body } = asStartBody(raw)
  if (tagOrder != null && new Set(tagOrder).size !== tagOrder.length)
    throw new TypeError('Duplicate player tag identity')
  return { kind: 'start', ...body, ...(tagOrder == null ? {} : { tagOrder }) }
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
      /**
       * Roster commands as said, for the client to find the players of and
       * stage on its roster screen.
       */
      roster?: SaidRosterCommand[]
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
      const { roster, undo, ...rest } = asObject({
        id: asNonEmpty,
        transcript: asString,
        actions: asArray(asWireAction),
        roster: asOptional(asWireRoster),
        dropped: asOptional(asArray(asProblem), () => []),
        undo: asOptional(asBoolean)
      })(raw)
      return {
        kind,
        ...rest,
        ...(roster == null ? {} : { roster }),
        ...(undo === true ? { undo } : {})
      }
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
