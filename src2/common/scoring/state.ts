import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner
} from 'cleaners'

/**
 * A game as the scoring library holds it: GUMBO's own `gameData` and
 * `liveData`, with every player named by a **session id** — a small integer
 * the game hands out — and each player's server identity kept beside it as
 * `userId`. Nothing here is geometry, timing or presentation.
 */

export const POSITIONS = [
  'P',
  'C',
  '1B',
  '2B',
  'SS',
  '3B',
  'LF',
  'CF',
  'RF'
] as const
export type Position = (typeof POSITIONS)[number]
export type Side = 'away' | 'home'
export type BatSide = 'R' | 'L'

export function asSessionId(raw: unknown): number {
  const id = asNumber(raw)
  if (!Number.isSafeInteger(id) || id < 0)
    throw new Error('Invalid local player id')
  return id
}

const asPoint = asObject({ x: asNumber, z: asNumber })
export type Point = ReturnType<typeof asPoint>

export const asPlayerRef = asObject({ id: asSessionId, fullName: asString })
export type PlayerRef = ReturnType<typeof asPlayerRef>
const asCount = asObject({ balls: asNumber, strikes: asNumber, outs: asNumber })
const asCredit = asObject({
  player: asPlayerRef,
  credit: asValue(
    'f_assist' as const,
    'f_putout' as const,
    'f_fielded_ball' as const,
    'f_fielding_error' as const,
    'f_throwing_error' as const
  ),
  position: asString
})
export type RunnerCredit = ReturnType<typeof asCredit>
const asRoute = asArray(asObject({ player: asPlayerRef, location: asPoint }))

/**
 * A pitch's `pitchData` as the scorer gives it: its speed, and its zone. Gumbo
 * writes much more there, all of it measured, so GameStation writes no more.
 */
export interface PitchData {
  startSpeed?: number
  zone?: number
}

/** One pitch or action of a play, in Gumbo's shape. */
export interface PlayEvent {
  index: number
  isPitch: boolean
  type: string
  details: {
    description: string
    /** A pitch's call code, or the engine's own name for an action. */
    code: string
    /** The umpire's call on a pitch, as Gumbo writes it. */
    call?: { code: string; description: string }
    /** The pitch was put in play. */
    isInPlay?: boolean
    /** The runner entry a runner's action wrote, just before it. */
    runnerEntry?: number
    /** Where a player who changed position played before. */
    fromPosition?: string
  }
  /** A lineup change, which does not begin a play. */
  isSubstitution?: boolean
  /** A lineup change's position: `P` to `RF`, or `PH` and `PR`. */
  position?: string
  /** A lineup change's place in the order as MLB writes it, `601`. */
  battingOrder?: string
  /** The player a lineup change took out of the order or off the field. */
  replacedPlayer?: PlayerRef
  /** A change of batting order: each man it moves and where he now bats. */
  moved?: Array<{ player: PlayerRef; bats: number }>
  /** After a pitch, the count it left; the in-play pitch keeps its own. */
  count: { balls: number; strikes: number; outs: number }
  /**
   * What the scorer said of a pitch itself: its speed in mph, to a tenth, and
   * its MLB zone. Each is present only when he gave it, in range.
   */
  pitchData?: PitchData
  player: PlayerRef
  /**
   * On a runner's action, the pitcher on the mound when it happened: a
   * pitching change later in the plate appearance changes the matchup, not
   * who threw the wild pitch.
   */
  pitcher?: PlayerRef
}
const asPlayEvent = exactly(
  asObject({
    index: asSessionId,
    isPitch: asBoolean,
    type: asString,
    details: asObject({
      description: asString,
      code: asString,
      call: asOptional(asObject({ code: asString, description: asString })),
      isInPlay: asOptional(asBoolean),
      runnerEntry: asOptional(asNumber),
      fromPosition: asOptional(asString)
    }),
    isSubstitution: asOptional(asBoolean),
    position: asOptional(asString),
    battingOrder: asOptional(asString),
    replacedPlayer: asOptional(asPlayerRef),
    moved: asOptional(
      asArray(asObject({ player: asPlayerRef, bats: asNumber }))
    ),
    count: asCount,
    pitchData: asOptional(
      asObject({ startSpeed: asOptional(asNumber), zone: asOptional(asNumber) })
    ),
    player: asPlayerRef,
    pitcher: asOptional(asPlayerRef)
  })
) as Cleaner<PlayEvent>

const asDefense = asObject(
  Object.fromEntries(
    POSITIONS.map(position => [position, asEither(asNull, asSessionId)])
  ) as Record<Position, Cleaner<number | null>>
)
/** Each side's batting order and fielders at one moment of the game. */
const asSideLineup = asObject({
  battingOrder: asArray(asSessionId),
  defense: asDefense
})
const asLineups = asObject({ away: asSideLineup, home: asSideLineup })
export type Lineups = ReturnType<typeof asLineups>
export type SideLineup = Lineups[Side]

/** Each side's batting order and fielders as the game stands. */
export function lineupsOf(state: GameState): Lineups {
  const { away, home } = state.liveData.boxscore.teams
  return copyState({
    away: { battingOrder: away.battingOrder, defense: away.defense },
    home: { battingOrder: home.battingOrder, defense: home.defense }
  })
}

/** One play as the game holds it, in GUMBO's shape, with session ids. */
export const asGamePlay = asObject({
  about: asObject({
    atBatIndex: asSessionId,
    inning: asNumber,
    halfInning: asValue('top' as const, 'bottom' as const),
    isComplete: asBoolean
  }),
  result: asObject({
    event: asString,
    eventType: asString,
    description: asString,
    awayScore: asNumber,
    homeScore: asNumber,
    rbi: asNumber
  }),
  count: asCount,
  matchup: asObject({
    batter: asPlayerRef,
    pitcher: asPlayerRef,
    batSide: asObject({ code: asValue('R' as const, 'L' as const) })
  }),
  runners: asArray(
    asObject({
      movement: asObject({
        originBase: asNumber,
        start: asNumber,
        end: asNumber,
        isOut: asBoolean,
        outNumber: asOptional(asNumber),
        forceOut: asBoolean,
        /** A runner safe on a base he was forced to. */
        forced: asOptional(asBoolean),
        runScored: asOptional(asBoolean)
      }),
      details: asObject({
        runner: asPlayerRef,
        movementReason: asString,
        /** The pitcher this runner is charged to (`earnedRuns.ts`). */
        responsiblePitcher: asOptional(asEither(asNull, asPlayerRef)),
        /** A run that is earned to the responsible pitcher. */
        earned: asOptional(asBoolean),
        /** A run that is unearned to the team, reconstructed over the whole half. */
        teamUnearned: asOptional(asBoolean),
        /** A run the batter drove in. */
        rbi: asOptional(asBoolean),
        /** The play event that made this movement. */
        playIndex: asOptional(asNumber),
        /**
         * Made by an action between pitches — a steal, a wild pitch, a runner
         * sent on — rather than on a play the plate appearance's result made.
         */
        byAction: asOptional(asBoolean)
      }),
      credits: asArray(asCredit)
    })
  ),
  playEvents: asArray(asPlayEvent),
  /**
   * The lineups as the play opened, and as its first pitch or action came:
   * a side announces its fielding changes as the net of the two
   * (`document.ts`), so a change undone before then is never written.
   */
  lineups: asOptional(asObject({ opened: asLineups, began: asLineups })),
  /**
   * The ball in play as the scoring screen draws it: the launch angle and its
   * label, where the scorer put the ball on the field, and the fielder who
   * played it with his position then. Each is present only when the scorer
   * gave it. The stored play writes MLB's `hitData` from it (`document.ts`).
   */
  hitData: asOptional(
    asObject({
      launchAngle: asOptional(asNumber),
      trajectory: asOptional(asString),
      coordinates: asOptional(asPoint),
      fielder: asOptional(asPlayerRef),
      position: asOptional(asString)
    })
  ),
  source: asObject({
    system: asValue('gamestation' as const),
    gamestation: asObject({
      version: asValue('estimated-v1' as const),
      outcome: asString,
      outSubtype: asOptional(asString),
      contactKind: asOptional(asValue('swing' as const, 'bunt' as const)),
      foulCaught: asOptional(asBoolean),
      homeRunKind: asOptional(
        asValue('out-of-park' as const, 'in-park' as const)
      ),
      landingHeight: asOptional(asNumber),
      /**
       * The trajectory the scorer chose, in the action's own terms
       * (`chopper` included), or the one his launch angle falls in.
       */
      trajectory: asOptional(asString),
      /** The launch angle: the scorer's, or estimated from his trajectory. */
      launchAngle: asOptional(asNumber),
      /**
       * The scorer set the launch angle himself, by dragging it on the field,
       * so the stored play gives it as the ball's `launchAngle`. An angle
       * estimated from a trajectory alone stays here and nowhere else.
       */
      launchAngleSet: asOptional(asBoolean),
      /** The lineup changed during this at-bat, so the at-bat is open. */
      lineupChanged: asOptional(asBoolean),
      errorCredit: asOptional(
        asObject({ player: asPlayerRef, defensiveRoute: asRoute })
      ),
      runnerActions: asOptional(
        asArray(
          asObject({
            runner: asPlayerRef,
            origin: asNumber,
            destination: asNumber,
            reason: asString,
            pitchReference: asOptional(
              asObject({ atBatIndex: asSessionId, index: asSessionId })
            ),
            isOut: asBoolean,
            forceOut: asBoolean,
            runScored: asBoolean,
            credits: asArray(asCredit),
            defensiveRoute: asOptional(asRoute),
            throwerLocation: asOptional(asPoint),
            defenderLocation: asOptional(asPoint)
          })
        )
      )
    })
  })
})
export type GamePlay = ReturnType<typeof asGamePlay>

export interface GamePlayer {
  id: number
  /** The server's identity for this person, or null for one made up here. */
  userId: number | null
  teamId: string
  fullName: string
  firstName?: string
  lastName?: string
  jersey: string
  bats: 'left' | 'right' | 'switch'
  throws: 'left' | 'right' | null
  positions: string[]
  local: boolean
}
export interface GameTeam {
  logoUrl?: string | null
  id: string
  name: string
}
export interface GameSide {
  players: number[]
  battingOrder: number[]
  battingIndex: number
  defense: Record<Position, number | null>
  pitchCounts: Record<number, number>
}
export interface PlayerIdentityMap {
  /** Type-prefixed source identities, `number:123`, to their session ids. */
  sourceToSession: Record<string, number>
  sessionToSource: Record<number, string | number | null>
  nextId: number
}

export const BASE_KEYS = ['first', 'second', 'third'] as const
export type BaseKey = (typeof BASE_KEYS)[number]

/**
 * What a runner carries for earned runs: the pitcher his run is charged to,
 * and whether he reached on an error — catcher's interference, a dropped third
 * strike that needed an error and the placed runner count as one — so that his
 * run is unearned whatever follows.
 */
export interface RunnerCharge {
  pitcher: PlayerRef | null
  reachedOnError: boolean
}

/**
 * The outs the defence would have made in this half without its errors: the
 * team's over the whole half, and each pitcher's from when he took the mound
 * (the half's first pitcher first). A reliever's entry names the pitcher he
 * relieved and the count on the batter when he came in.
 */
export interface ErrorlessOuts {
  team: number
  pitchers: Array<{
    pitcher: PlayerRef
    outs: number
    relieved?: {
      pitcher: PlayerRef
      atBatIndex: number
      balls: number
      strikes: number
    }
  }>
}

/** A runner's part in the play being resolved. Base 0 is the plate, 4 home. */
export interface Movement {
  automaticHome?: boolean
  homeReleased?: boolean
  playerId: number
  /** Original base when the play began; kept across correction steps. */
  start?: number
  from: number
  to: number
  /**
   * HIT_BASES destination when this was an unforced one-base advance short of
   * home. The runner is placed there, and correction may drag him back to
   * `start` with no Safe/Out strip.
   */
  offeredTo?: number
  force: boolean
  decision: 'pending' | 'safe' | 'out'
  resolved?: boolean
}

/** What happened at the plate, in the words the play records it with. */
export type ResolutionOutcome =
  | 'Single'
  | 'Double'
  | 'Triple'
  | 'Home Run'
  | "Fielder's Choice"
  | 'Error'
  | 'Throw Out'
  | 'Ball Caught'
  | 'Batter Interference'
  | 'Walk'
  | 'Strikeout'
  | 'Balk'
  | 'Batter Out — Other'
  | 'Dropped Third Strike'
  | 'Manual placement'

/**
 * The play being resolved: a result is known and some runners' fates are not.
 * It is baseball, not drawing: who moves where, who is still to be decided,
 * and what the half looked like before the play, so a third out can take back
 * the runs a force made.
 */
export interface Resolution {
  outcome: ResolutionOutcome
  contactKind?: 'swing' | 'bunt'
  automaticAward?: boolean
  errorPending?: boolean
  homeRunKind?: 'out-of-park' | 'in-park'
  /** A balk moves runners without ending the appearance. */
  sameAppearance?: boolean
  choiceApplied?: boolean
  /** The fielder who first handled the ball, and who holds it now. */
  fielder?: number
  ballHolder?: number
  originalRunnerRecordCount: number
  originalBases: Array<number | null>
  originalRuns: number
  originalOuts: number
  movements: Movement[]
  /** The play event the result came with: the in-play pitch, ball four, … */
  eventIndex?: number
  /** What each runner on base when the play began is charged with. */
  charges?: Record<number, RunnerCharge>
  /** The batter reached on an error, catcher's interference, or a dropped third strike that needed one. */
  batterReachedOnError?: boolean
}

/** Feet from home plate to the fence down each line and to centre. */
export interface FieldInfo {
  leftLine: number
  center: number
  rightLine: number
}

/** A fence the same distance all the way round, as the model draws it. */
export function fieldInfoOf(fenceDistanceFt: number): FieldInfo {
  return {
    leftLine: fenceDistanceFt,
    center: fenceDistanceFt,
    rightLine: fenceDistanceFt
  }
}

export interface GameState {
  gamePk: string
  gameData: {
    teams: Record<Side, GameTeam>
    players: Record<number, GamePlayer>
    /**
     * Gumbo's field sizes, in feet. The model's fence is a circle, so all
     * three are the one fence distance. A game saved before fences had sizes
     * has none, and is played to the default.
     */
    venue?: { fieldInfo: FieldInfo }
  }
  liveData: {
    linescore: {
      currentInning: number
      currentInningOrdinal: string
      inningState: 'Top' | 'Bottom'
      isTopInning: boolean
      balls: number
      strikes: number
      outs: number
      teams: Record<Side, { runs: number; hits: number; errors: number }>
      offense: {
        batter: PlayerRef | null
        first: PlayerRef | null
        second: PlayerRef | null
        third: PlayerRef | null
        /** The pitcher each runner on base is charged to. */
        responsiblePitcher?: Record<BaseKey, PlayerRef | null>
        /** Each runner on base who reached on an error, as `RunnerCharge` says. */
        reachedOnError?: Record<BaseKey, boolean>
      }
      defense: Record<Position, PlayerRef | null>
      /** Absent until the engine first sees the half. */
      errorlessOuts?: ErrorlessOuts
    }
    boxscore: { teams: Record<Side, GameSide> }
    plays: { allPlays: GamePlay[]; currentPlay: GamePlay | null }
  }
  /** The play being resolved, or null between plays. */
  pending: Resolution | null
  /** Runners headed home whose fate is not yet decided, lead runner first. */
  homeQueue: number[]
  /** The last pitch a wild pitch or passed ball may be charged to. */
  recentPitch: { atBatIndex: number; index: number } | null
  /** The batter due is already on base, so the lineup must change first. */
  awaitingBatter: {
    teamId: string
    dueIndex: number
    duePlayerId: number
  } | null
  /** The game has ended; only an undo reopens it. */
  final: boolean
  meta: {
    source?: 'local-development' | 'api'
    sequence: number
    identities: PlayerIdentityMap
    /** Some plays were rebuilt from their documents rather than their actions. */
    derived?: boolean
  }
}

export function copyState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * The finished plays that `copyGame` made. Nothing changes a play once it is
 * finished, so every later copy of a game holds the same one.
 */
const finishedPlays = new WeakSet<object>()

/**
 * A copy of a game, as `copyState` makes one, that shares the finished plays
 * an earlier copy made rather than copying them again. They are nearly the
 * whole of a game (97% of one 70 plate appearances long), so copying them for
 * every action made a phone stall longer the longer the game went on.
 */
export function copyGame(game: GameState): GameState {
  const { plays } = game.liveData
  const copy = copyState<GameState>({
    ...game,
    liveData: { ...game.liveData, plays: { ...plays, allPlays: [] } }
  })
  copy.liveData.plays.allPlays = plays.allPlays.map(play => {
    if (finishedPlays.has(play)) return play
    const own = copyState(play)
    finishedPlays.add(own)
    return own
  })
  return copy
}

/**
 * A cleaner's result keeps every optional key, set to `undefined` when it was
 * absent. This types those keys as optional and drops them, so a cleaned
 * value equals the one that was sent.
 */
export type Optional<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K]
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >
}
export function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T
  if (value == null || typeof value !== 'object') return value
  // Keys, not entries: an entry pair per key made this the most of what
  // folding a game cost on a phone.
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const item = source[key]
    if (item !== undefined) out[key] = withoutUndefined(item)
  }
  return out as T
}
export function exactly<T>(cleaner: Cleaner<T>): Cleaner<T> {
  return raw => withoutUndefined(cleaner(raw))
}

const asSide = asObject({
  players: asArray(asSessionId),
  battingOrder: asArray(asSessionId),
  battingIndex: asNumber,
  defense: asDefense,
  pitchCounts: asObject(asNumber)
})
const asPlayer = asObject({
  id: asSessionId,
  userId: asEither(asNull, asNumber),
  teamId: asString,
  fullName: asString,
  firstName: asOptional(asString),
  lastName: asOptional(asString),
  jersey: asString,
  bats: asValue('left' as const, 'right' as const, 'switch' as const),
  throws: asEither(asNull, asValue('left' as const, 'right' as const)),
  positions: asArray(asString),
  local: asBoolean
})
const asIdentities = asObject({
  sourceToSession: asObject(asNumber),
  sessionToSource: asObject(asEither(asNull, asString, asNumber)),
  nextId: asNumber
})

/**
 * What no GUMBO play carries and a scorer must not lose: both rosters, each
 * side's batting order and place in it, the defence, and the players made up
 * at the field. A play stores the setup as it stood before its first action.
 */
export interface GameSetup {
  players: Record<number, GamePlayer>
  sides: Record<Side, GameSide>
  identities: PlayerIdentityMap
}
export const asGameSetup: Cleaner<GameSetup> = exactly(
  asObject({
    players: asObject(asPlayer),
    sides: asObject({ away: asSide, home: asSide }),
    identities: asIdentities
  })
)

export function setupOf(state: GameState): GameSetup {
  return {
    players: copyState(state.gameData.players),
    sides: copyState(state.liveData.boxscore.teams),
    identities: copyState(state.meta.identities)
  }
}

const asTeam = asObject({
  logoUrl: asOptional(asEither(asNull, asString)),
  id: asString,
  name: asString
})
const asMovement = asObject({
  automaticHome: asOptional(asBoolean),
  homeReleased: asOptional(asBoolean),
  playerId: asSessionId,
  start: asOptional(asNumber),
  from: asNumber,
  to: asNumber,
  offeredTo: asOptional(asNumber),
  force: asBoolean,
  decision: asValue('pending' as const, 'safe' as const, 'out' as const),
  resolved: asOptional(asBoolean)
})
const asRef = asEither(asNull, asPlayerRef)
const asCharge = asObject({ pitcher: asRef, reachedOnError: asBoolean })
const asErrorlessOuts = asObject({
  team: asNumber,
  pitchers: asArray(
    asObject({
      pitcher: asPlayerRef,
      outs: asNumber,
      relieved: asOptional(
        asObject({
          pitcher: asPlayerRef,
          atBatIndex: asNumber,
          balls: asNumber,
          strikes: asNumber
        })
      )
    })
  )
})

/** Checks a whole game, such as one a session kept or a test built. */
export const asGameState: Cleaner<GameState> = exactly(
  asObject({
    gamePk: asString,
    gameData: asObject({
      teams: asObject({ away: asTeam, home: asTeam }),
      players: asObject(asPlayer),
      venue: asOptional(
        asObject({
          fieldInfo: asObject({
            leftLine: asNumber,
            center: asNumber,
            rightLine: asNumber
          })
        })
      )
    }),
    liveData: asObject({
      linescore: asObject({
        currentInning: asNumber,
        currentInningOrdinal: asString,
        inningState: asValue('Top' as const, 'Bottom' as const),
        isTopInning: asBoolean,
        balls: asNumber,
        strikes: asNumber,
        outs: asNumber,
        teams: asObject({
          away: asObject({ runs: asNumber, hits: asNumber, errors: asNumber }),
          home: asObject({ runs: asNumber, hits: asNumber, errors: asNumber })
        }),
        offense: asObject({
          batter: asRef,
          first: asRef,
          second: asRef,
          third: asRef,
          responsiblePitcher: asOptional(
            asObject({ first: asRef, second: asRef, third: asRef })
          ),
          reachedOnError: asOptional(
            asObject({ first: asBoolean, second: asBoolean, third: asBoolean })
          )
        }),
        defense: asObject(
          Object.fromEntries(
            POSITIONS.map(position => [position, asRef])
          ) as Record<Position, Cleaner<PlayerRef | null>>
        ),
        errorlessOuts: asOptional(asErrorlessOuts)
      }),
      boxscore: asObject({ teams: asObject({ away: asSide, home: asSide }) }),
      plays: asObject({
        allPlays: asArray(asGamePlay),
        currentPlay: asEither(asNull, asGamePlay)
      })
    }),
    pending: asEither(
      asNull,
      asObject({
        outcome: asString as Cleaner<ResolutionOutcome>,
        contactKind: asOptional(asValue('swing' as const, 'bunt' as const)),
        automaticAward: asOptional(asBoolean),
        errorPending: asOptional(asBoolean),
        homeRunKind: asOptional(
          asValue('out-of-park' as const, 'in-park' as const)
        ),
        sameAppearance: asOptional(asBoolean),
        choiceApplied: asOptional(asBoolean),
        fielder: asOptional(asSessionId),
        ballHolder: asOptional(asSessionId),
        originalRunnerRecordCount: asNumber,
        originalBases: asArray(asEither(asNull, asSessionId)),
        originalRuns: asNumber,
        originalOuts: asNumber,
        movements: asArray(asMovement),
        eventIndex: asOptional(asNumber),
        charges: asOptional(asObject(asCharge)),
        batterReachedOnError: asOptional(asBoolean)
      })
    ),
    homeQueue: asArray(asSessionId),
    recentPitch: asEither(
      asNull,
      asObject({ atBatIndex: asNumber, index: asNumber })
    ),
    awaitingBatter: asEither(
      asNull,
      asObject({ teamId: asString, dueIndex: asNumber, duePlayerId: asNumber })
    ),
    final: asBoolean,
    meta: asObject({
      source: asOptional(asValue('local-development' as const, 'api' as const)),
      sequence: asNumber,
      identities: asIdentities,
      derived: asOptional(asBoolean)
    })
  })
)
