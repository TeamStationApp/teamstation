import {
  asArray,
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  asTuple,
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
  type GroupRef
} from './groupCreation'
import {
  asParentPreview,
  type ParentAction,
  type ParentPreview
} from './groupLinks'
import { asCurrentPlay, asGumboPlay } from './gumboPlay'
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
import type {
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
import { asScoreboardState, type ScoreboardState } from './scoreboard'
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
import {
  asSaidRosterCommand,
  type SaidRosterCommand
} from './scoring/rosterCommands'
import type { SaveChange, StoredGame } from './scoring/session'
import { type Position, POSITIONS, type Side } from './scoring/state'
import { asUserId } from './userIdNumber'
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
  kind: asOptional(asEither(asLiteral('full'), asLiteral('external')), 'full')
})
export type TeamSummary = ReturnType<typeof asTeamSummary>

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
     * Whether this caller is signed in and a member of neither team: `linescore`
     * then carries each side's runs alone, `canScore` and `canDj` are false,
     * and the box score and playback answer `membersOnly`. False for members.
     */
    nonMemberView: asBoolean,
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
export type Highlight = Omit<ReturnType<typeof asHighlight>, 'tag'> & {
  tag?: string | null
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
  'teamNames' | 'guardianOf'
> & { teamNames?: string[]; guardianOf?: string[] }
export const asRosterEntry: (raw: unknown) => RosterEntry = cleanRosterEntry

const asStoredGame = asObject({
  plays: asArray(
    asObject({ id: asString, gameId: asString, gumbo: asGumboPlay })
  ),
  currentPlay: asOptional(asNullable(asCurrentPlay), null),
  playsDigest: asOptional(asNullable(asString), null),
  priorPlaysDigest: asOptional(asNullable(asString), null),
  lineupsDigest: asOptional(asNullable(asString), null)
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
      : { lineupsDigest: stored.lineupsDigest })
  }
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
  stillUrl: asString
})
export type PlayerHighlight = Omit<
  ReturnType<typeof asPlayerHighlight>,
  'tag'
> & { tag?: string | null }

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

/** A person another service knows, and which of the asked ids are theirs. */
export const asUserMatch = asObject({
  userId: asUserId,
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
export type ScopeGrant = ReturnType<typeof asScopeGrant>

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
export type ScopePerson = ReturnType<typeof asScopePerson>

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
    name: asString
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
export type ManagePage = ReturnType<typeof asManagePage>

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
  /**
   * The digest the game keeps of both sides' lineups, which changes exactly
   * when what they show does. A screen keeps the one it last read or saved,
   * to tell its own save from somebody else's. Empty from an older server.
   */
  digest: string
}
const asTeamLineups: Cleaner<TeamLineups> = raw => {
  const team = asObject({ teamId: asString, teamName: asString })(raw)
  return { ...asSideLineups(raw), ...team }
}
export const asGameLineupsResponse: Cleaner<GameLineupsResponse> = asObject({
  away: asTeamLineups,
  home: asTeamLineups,
  digest: asOptional(asString, '')
})

/** A player in a saved lineup, named by who he is, never by a session id. */
export interface LineupPlayer {
  /** Null for a player made up at the field. */
  userId: number | null
  fullName: string
  jersey: string
}

/**
 * `POST /games/:gameId/lineups`: one side's players, batting order and
 * defence, as its head coach or a scorekeeper saves them. Every number but a
 * `userId` is an index into `players`, so the server never depends on the
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
      userId: asNullable(asUserId),
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
  )
})

/** Cleans a lineup save, and refuses an index past the players it names. */
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
    ...(body.runners == null ? {} : { runners: body.runners })
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
  async nodeAccounts(query = '', nodeAdmin = false): Promise<NodeAccount[]> {
    return await this.request(
      'GET',
      `/users?view=administration&query=${encodeURIComponent(query)}${nodeAdmin ? '&nodeAdmin=true' : ''}`,
      asNodeAccounts
    )
  }

  async changeNodeAccount(
    userId: number,
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

  async clearAccountPhoto(): Promise<AccountSettings> {
    return await this.request('DELETE', '/me/account/photo', asAccountSettings)
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
    fields: Partial<Omit<CreateGroup, 'kind' | 'parent' | 'idempotencyKey'>>
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
    userId: number,
    response: Rsvp
  ): Promise<{ userId: number; response: Rsvp }> {
    return await this.request(
      'PUT',
      `/events/${encodeURIComponent(eventId)}/rsvps/${userId}`,
      asObject({ userId: asNumber, response: asRsvp }),
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
          : { lineupsBase: change.lineupsBase })
      }
    )
    return storedGameOf(stored)
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

  /**
   * What a roster manager sets for one player on one team. Only the fields sent
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
   * How a player bats and throws, away from any team: for a guardian of the
   * player, or a coach of a team they play on. Only the fields sent change.
   */
  async setPlayerBatsThrows(
    userId: number | string,
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
    userId: number
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
    userId: number,
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
    userId: number,
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

function walkUpSongPath(teamId: string, userId: number | string): string {
  return `/teams/${encodeURIComponent(teamId)}/players/${encodeURIComponent(userId)}/walk-up-song`
}

/** For the endpoints whose body carries nothing a caller needs. */
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
  /** Absent means the model the server is configured with. */
  model: asOptional(asDictationModel)
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
