import {
  asArray,
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner
} from 'cleaners'

import { type ApiError, asApiError, HttpError } from './errors'
import { DEFAULT_FENCE_DISTANCE_FT } from './fenceDistance'
import { asCurrentPlay, asGumboPlay } from './gumboPlay'
import type { SaveChange, StoredGame } from './scoring/session'
import { asUserId } from './userIdNumber'

/**
 * The client the app talks to the server through.
 *
 * Every response is cleaned here, not just on the server: the two ends check
 * the same shapes, so a server that starts sending something else fails loudly
 * in one place instead of making a screen render nonsense.
 */

/** The API sends `null` for an absent value, which `asOptional` will not take. */
const asNullable = <T>(cleaner: Cleaner<T>): Cleaner<T | null> =>
  asEither(asValue(null), cleaner)

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
   * The team's record in its most recent season, counted from the plays.
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
  )
})
export type TeamSummary = ReturnType<typeof asTeamSummary>

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
  /** `gamestation` once GameStation scores the game, and nothing else may. */
  scoringOwner: asOptional(
    asNullable(asValue('external' as const, 'gamestation' as const)),
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
   * The play in a sentence, for the panel under the video: GameStation's own
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
  ops: asOptional(asNumber)
})

const asPitchingRates = asObject({
  /** Earned runs per game; absent for a pitcher with no outs. */
  era: asOptional(asNumber),
  whip: asOptional(asNumber)
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
  asObject({ status: asValue('none' as const) }),
  asObject({
    status: asEither(
      asValue('pending' as const),
      asValue('built' as const),
      asValue('incomplete' as const),
      asValue('failed' as const)
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
  asValue(null),
  asValue('left' as const),
  asValue('right' as const),
  asValue('switch' as const)
)
export const asThrows = asEither(
  asValue(null),
  asValue('left' as const),
  asValue('right' as const)
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
  group: asOptional(asString, 'player')
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
 * `name` is **always** the short form — `Jensen P` — for everybody, on every
 * screen. There is no viewer who gets the whole name here, and no second field
 * holding one: a field that exists is a field that eventually gets drawn. The
 * surname is fetched separately, by somebody who is about to type in it.
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
  teams: asArray(asPlayerTeam)
})
export type PlayerDetail = ReturnType<typeof asPlayerDetail>

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
 * A game GS Director can be pointed at.
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
  asObject({ ready: asValue(false) }),
  asSession
)

/** One invite code, as the panel that made it shows it. */
export const asInvite = asObject({
  id: asString,
  code: asString,
  /** The address to send somebody, built by the server. */
  url: asString,
  scopeType: asValue('league', 'season', 'team'),
  scopeId: asString,
  label: asNullable(asString),
  maxUses: asNullable(asNumber),
  uses: asNumber,
  expiresAt: asNullable(asString),
  revokedAt: asNullable(asString),
  createdAt: asString,
  /** Why it no longer works, or null while it does. */
  problem: asNullable(asValue('revoked', 'expired', 'exhausted'))
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
  problem: asNullable(asValue('revoked', 'expired', 'exhausted')),
  scope: asObject({
    kind: asValue('league', 'season', 'team'),
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
    kind: asValue('league', 'season', 'team'),
    id: asString,
    name: asString
  })
})
export type Redeemed = ReturnType<typeof asRedeemed>

/** One thing somebody belongs to, and what they are in it. */
export const asScopeGrant = asObject({
  id: asString,
  name: asString,
  role: asString
})
export type ScopeGrant = ReturnType<typeof asScopeGrant>

export const asNamed = asObject({ id: asString, name: asString })

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
  adminOf: asArray(
    asObject({
      kind: asValue('league', 'season', 'team'),
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
    kind: asValue('league', 'season', 'team'),
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

export interface ClientOptions {
  baseUrl: string
  token?: string
  /** Swapped out in tests. Defaults to the platform's own. */
  fetch?: typeof fetch
}

export class GameStationClient {
  private readonly baseUrl: string
  private readonly doFetch: typeof fetch
  token: string | undefined

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async signInWithPassword(email: string, password: string): Promise<Session> {
    const session = await this.request('POST', '/auth/password', asSession, {
      email,
      password
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
   */
  async games(options: { externalIds?: string[] } = {}): Promise<SeasonGame[]> {
    const ids = options.externalIds ?? []
    const query =
      ids.length === 0
        ? ''
        : `?${ids.map(id => `externalId=${encodeURIComponent(id)}`).join('&')}`
    return await this.request('GET', `/games${query}`, asArray(asSeasonGame))
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
      `/seasons/${encodeURIComponent(seasonId)}/games`,
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
    return await this.request('GET', '/games/recent', asNullable(asSeasonGame))
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
        source: { system: 'gamestation' },
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

  async roster(teamId: string): Promise<RosterEntry[]> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/roster`,
      asArray(asRosterEntry)
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
        'Cannot reach GameStation. Check your connection and try again.'
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
  return new HttpError('internal', `The server answered ${status}`)
}
