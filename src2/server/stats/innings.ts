/**
 * A half inning, replayed twice: as it happened, and as it would have gone if
 * nobody had made an error.
 *
 * This is what an earned run is. The rule (MLB 9.16) does not say "a run that
 * did not involve an error" — it says to reconstruct the inning without the
 * errors and the passed balls, give the pitcher the benefit of every doubt,
 * and count what would still have scored. Two things fall out of that and out
 * of nothing else:
 *
 * - **An out that was not made still counts.** A batter who reached only
 *   because somebody dropped the ball is out in the reconstruction, and once
 *   the reconstruction has three outs the half is over for earned-run
 *   purposes — every run after it is unearned, however it scored.
 * - **A run belongs to the pitcher who put the runner on**, not to whoever was
 *   on the mound when it crossed the plate. Without that, a child who comes in
 *   with the bases loaded is charged for somebody else's inning.
 *
 * The same walk answers three questions at once — outs recorded, runs charged
 * and earned runs — because they are the same walk. Splitting them would mean
 * three copies of the base-running wording, which is the one thing here that
 * is genuinely hard to read.
 */
export interface InningPlay {
  order: number
  inning: number | null
  half: string | null
  /** The play's name: `Single`, `Error`, `Strikeout`. */
  name: string
  /** `final_details` templates, in order. */
  finalText: string[]
  /** `at_plate_details` templates, in order. */
  duringText: string[]
  /** Who crossed the plate, in the order the wording says. */
  scoredBy: string[]
  /**
   * The runner moves the game stream recorded for this play, if any.
   *
   * Not a complete ledger of runs — 667 scoring moves against 1,805 scoring
   * lines in the wording — because the stream records one when it needs to
   * *explain* a move rather than for every move. Which is exactly the useful
   * half: `advanced_on_error`, `on_same_error`, `passed_ball`, `wild_pitch`,
   * `stole_base`. The wording says who scored; this says why, and the
   * difference between a wild pitch and a passed ball is the difference
   * between an earned run and an unearned one.
   */
  moves: RunnerMove[]
  /**
   * Every move the stream recorded in this whole half inning.
   *
   * Pairing a move to the exact play it belongs to is only about 78% right —
   * the stream and the play list are two sequences that have to be lined up,
   * and a mistake puts a reason on the wrong run. A **half inning** is a far
   * coarser target and a runner can only score once in one, so runner plus
   * half is a key that cannot land on the wrong run.
   */
  halfMoves: RunnerMove[]
  /** The batter, where the wording names one. */
  batterId: string | null
  /**
   * Who was standing on third as this play began.
   *
   * The same state the RBI rule needs, and for the same reason: before two are
   * out, a runner on third scores on an ordinary out. So if an error takes
   * that out away, their run would have scored regardless — which makes it
   * earned, however the replayed inning ended.
   */
  atThird: Set<string>
  /**
   * The out count **after** this play, as the scorekeeper's counter keeps it.
   *
   * The authority on outs, and the reason the wording is only a fallback: a
   * fielder's choice may or may not retire somebody, and the sentence does not
   * always say which — but the counter does, and `didOutsChange` confirms it.
   * Getting this wrong closed innings early in the earned-run replay and made
   * real runs unearned.
   */
  outsAfter: number | null
  didOutsChange: boolean
}

export interface RunnerMove {
  runnerId: string
  /** 2, 3, or 4 for the plate. */
  base: number
  playType: string
}

/** Moves that mean somebody else's mistake put the runner where they are. */
const BY_ERROR = new Set(['advanced_on_error', 'on_same_error'])
const BY_PASSED_BALL = new Set(['passed_ball'])

export interface PitcherTotals {
  /** Outs recorded while this pitcher was on the mound. */
  outs: number
  /** Runs charged, by who put the runner on. */
  runs: number
  /** Of those, the ones that would have scored without the errors. */
  earned: number
  /** Plays whose wording this could not read. A figure with any is suspect. */
  unread: number
}

const ID = '\\$\\{([0-9a-fA-F-]{8,})\\}'
const SCORES = new RegExp(`^${ID} scores`)
const OUT_ON_BASES = new RegExp(
  `${ID} (?:out advancing to|is out at|out at|thrown out at|caught stealing|is caught stealing|picked off|is picked off)`
)
const DOUBLE_PLAY = /double play/i
const TRIPLE_PLAY = /triple play/i

/**
 * How many outs a play made, read from its wording.
 *
 * Only for a game whose plays carry no out count — every game we hold does
 * carry one, and the counter is the better answer wherever it is there.
 */
function outsFromWording(play: InningPlay): number {
  if (TRIPLE_PLAY.test(play.name)) return 3
  if (DOUBLE_PLAY.test(play.name)) return 2
  let outs = BATTER_IS_OUT.has(play.name) ? 1 : 0
  for (const line of [...play.duringText, ...play.finalText]) {
    if (OUT_ON_BASES.test(line)) outs += 1
  }
  return outs
}

/**
 * Entries that close a half inning without anybody being retired.
 *
 * `Inning Ended` steps the out counter straight to three — a time limit, a run
 * rule, or a scorekeeper tidying up — and charging that step to the pitcher
 * gave them two outs nobody recorded. This credits them with none.
 */
const MARKERS = new Set(['Inning Ended', 'Inning Changed by Scorekeeper'])

/** Plays where the batter is out at the plate, before any base running. */
const BATTER_IS_OUT = new Set([
  'Ground Out',
  'Fly Out',
  'Line Out',
  'Pop Out',
  'Foul Out',
  'Infield Fly',
  'Strikeout',
  'Batter Out',
  'Sacrifice Fly',
  'Sacrifice Bunt',
  'Double Play',
  'Triple Play',
  'FC Double Play'
])

/** Plays where the batter reaches, and whether an error is why. */
const BATTER_REACHES = new Set([
  'Single',
  'Double',
  'Triple',
  'Home Run',
  'Walk',
  'Intentional Walk',
  'Hit By Pitch',
  "Fielder's Choice",
  'Fielders Choice',
  'Error',
  'Dropped 3rd Strike',
  "Catcher's Interference"
])

/**
 * A run that needed an error to come home.
 *
 * `on the throw` is deliberately **not** here: a runner who scores on the
 * throw scored because somebody threw somewhere else, which is a choice rather
 * than a mistake, and those count as earned.
 */
const UNEARNED_RUN =
  /on (?:the same |an? )?error|on a muffed|on catcher's interference/i

interface Runner {
  id: string
  /** The pitcher who put them on, and who wears the run if they score. */
  responsible: string | null
  /** False when they only reached because of an error. */
  earnedEligible: boolean
}

/**
 * Walks a game and charges every out and every run to a pitcher.
 *
 * `pitcherByOrder` is who was on the mound for each play, taken from the
 * defence the scorekeeper filled in — the wording names a pitcher only on a
 * strikeout, a walk or a hit batter, so without it most plays have nobody.
 */
export interface RunDecision {
  order: number
  inning: number | null
  half: string | null
  runnerId: string
  pitcherId: string | null
  earned: boolean
  /** Why not, in a word: `reachedOnError`, `scoredOnError`, `inningWouldHaveEnded`. */
  reason: string
}

/**
 * The judgement calls the rule book leaves room for.
 *
 * Every one of these is a real scoring question that two books answer two
 * ways. They are options so that the answer can be *measured* against
 * published box scores rather than argued about, and the defaults are whatever
 * reproduced them over the games we hold.
 */
export interface ChargeOptions {
  /**
   * A run that came home on a passed ball: unearned by the book.
   *
   * **Off, because the box scores we hold do not do it.** The rule book treats
   * a passed ball as an error for reconstruction, so the run is unearned; their
   * scorer evidently charges it to the pitcher anyway. Switching this off —
   * counting those runs as earned — took earned runs from 105 figures adrift to
   * 94 over 95 games, and it is the single largest thing left that we know
   * about their scoring rather than the rule book's.
   */
  passedBallUnearned?: boolean
  /** A runner who only reached because of an error can never score earned. */
  reachedOnErrorUnearned?: boolean
  /** The out the error took away closes the replayed inning. */
  errorTakesAnOut?: boolean
  /** Take the reason a run scored from the stream, where it gives one. */
  useStreamReason?: boolean
  /**
   * A run by a runner on third, before two are out, is earned even when the
   * replayed inning has ended — an ordinary out would have scored them.
   */
  thirdScoresAnyway?: boolean
  /**
   * A runner the stream says a mistake moved along cannot score earned.
   *
   * **Off, and measured.** It sounds right and it is wrong: switching it on
   * took earned runs from 105 figures adrift of the box scores to 136, over the
   * same 95 games. Advancing on an error does not make a run
   * unearned — only *reaching base* on one does — because the rule gives the
   * pitcher the benefit of the doubt about whether the runner would have come
   * round anyway. Kept as a switch so the next person does not have to find
   * that out by argument.
   */
  taintFromMoves?: boolean
  /** A runner a passed ball moved along cannot score earned. */
  taintFromPassedBall?: boolean
}

export function chargeInnings(
  plays: InningPlay[],
  pitcherByOrder: Map<number, string>,
  trace?: RunDecision[],
  options: ChargeOptions = {}
): Map<string, PitcherTotals> {
  const {
    passedBallUnearned = false,
    reachedOnErrorUnearned = true,
    errorTakesAnOut = true,
    useStreamReason = true,
    thirdScoresAnyway = false,
    taintFromMoves = false,
    taintFromPassedBall = false
  } = options
  const totals = new Map<string, PitcherTotals>()
  const add = (
    pitcherId: string | null,
    field: keyof PitcherTotals,
    count = 1
  ): void => {
    if (pitcherId == null || pitcherId === '') return
    const held = totals.get(pitcherId) ?? {
      outs: 0,
      runs: 0,
      earned: 0,
      unread: 0
    }
    held[field] += count
    totals.set(pitcherId, held)
  }

  const ordered = [...plays].sort((a, b) => a.order - b.order)

  let half = ''
  let onBase = new Map<string, Runner>()
  let outsMade = 0
  /** Outs the inning would have had without the errors. */
  let outsReconstructed = 0

  for (const play of ordered) {
    // A pending plate appearance — `${id} at bat` — is not a play. Its out
    // count reads zero, which would restart the inning's book-keeping.
    if (play.finalText.length === 0) continue

    const key = `${play.inning ?? 0} ${play.half ?? ''}`
    if (key !== half) {
      half = key
      onBase = new Map()
      outsMade = 0
      outsReconstructed = 0
    }

    const pitcher = pitcherByOrder.get(play.order) ?? null
    const outsBeforePlay = outsMade
    const lines = [...play.duringText, ...play.finalText]
    // An error somewhere on the play is not the same as the batter reaching
    // because of one. A single where a runner takes third on a bad throw is
    // still a single, and the batter is still a runner the pitcher put on.
    const batterReachedOnError =
      play.name === 'Error' ||
      /reaches on (?:a |an )?\w*\s?error|safe on error/i.test(
        play.finalText[0] ?? ''
      )

    // --- Outs -------------------------------------------------------------
    // The play's own out counter first. It is the state after the play, so what
    // the play added is the step from where the inning stood.
    let outs =
      play.outsAfter == null ? -1 : Math.max(0, play.outsAfter - outsMade)

    if (MARKERS.has(play.name)) {
      // The inning is over; nobody was put out to end it.
      outsMade = play.outsAfter ?? outsMade
      outsReconstructed = Math.max(outsReconstructed, outsMade)
      continue
    }

    if (outs >= 0) {
      // `didOutsChange` is the same claim said twice; where they disagree the
      // counter wins, because it is what the scoreboard showed.
      if (!play.didOutsChange && outs > 0) outs = 0
    } else {
      outs = outsFromWording(play)
    }
    // Whoever was retired on the bases leaves them, however the out was
    // counted: a runner thrown out advancing, caught stealing during the next
    // batter's at-bat, picked off between pitches.
    for (const line of lines) {
      const match = OUT_ON_BASES.exec(line)
      if (match != null) onBase.delete(match[1])
    }

    add(pitcher, 'outs', outs)
    // Follow the counter where there is one, so a play we read wrongly does
    // not put every later play in the inning out by the same amount.
    outsMade = play.outsAfter ?? outsMade + outs
    outsReconstructed += outs

    // An out that was not made, because somebody dropped the ball. The
    // reconstruction has it, which is what closes the inning for earned-run
    // purposes while the real one carries on. Only where the error is why the
    // batter is standing on a base: an error that merely moved a runner along
    // took nobody's out away.
    if (batterReachedOnError && errorTakesAnOut) outsReconstructed += 1

    // --- Who is on base ---------------------------------------------------
    if (play.batterId != null && BATTER_REACHES.has(play.name)) {
      onBase.set(play.batterId, {
        id: play.batterId,
        responsible: pitcher,
        // Reaching on an error is the whole point of the reconstruction: this
        // runner is not there in it, so nothing they do afterwards is earned.
        earnedEligible: !(batterReachedOnError && reachedOnErrorUnearned)
      })
    }

    // A runner the stream says was moved along by somebody's mistake is not
    // standing there in the replayed inning, so nothing they do afterwards is
    // earned. This is the half the wording never states: a bare `${id}
    // advances to 3rd` line reads the same whether the throw was wild or not.
    for (const move of play.moves) {
      const tainted =
        (taintFromMoves && BY_ERROR.has(move.playType)) ||
        (taintFromPassedBall && BY_PASSED_BALL.has(move.playType))
      if (!tainted) continue
      const held = onBase.get(move.runnerId)
      if (held != null) held.earnedEligible = false
    }

    // --- Runs -------------------------------------------------------------
    for (const runnerId of play.scoredBy) {
      const runner = onBase.get(runnerId)
      const responsible = runner?.responsible ?? pitcher
      add(responsible, 'runs')

      // What the stream says brought them home, where it says anything. A
      // wild pitch is the pitcher's own doing and a steal of home is the
      // runner's, so both are earned; an error or a passed ball is somebody
      // else's mistake, and is not.
      const move = useStreamReason
        ? play.halfMoves.find(
            item => item.runnerId === runnerId && item.base === 4
          )
        : undefined
      const line = lines.find(
        text => SCORES.test(text) && text.includes(runnerId)
      )
      const cameHomeOnError =
        move != null
          ? move.playType === 'advanced_on_error' ||
            move.playType === 'on_same_error' ||
            (passedBallUnearned && move.playType === 'passed_ball')
          : line != null &&
            (UNEARNED_RUN.test(line) ||
              (passedBallUnearned && /on passed ball/i.test(line)))
      const reachedOnError = !(runner?.earnedEligible ?? true)
      const inningWouldHaveEnded = outsReconstructed >= 3
      // On third with fewer than two out: an ordinary out brings them home, so
      // the error that took the out away did not create this run.
      const wouldHaveScoredAnyway =
        thirdScoresAnyway &&
        batterReachedOnError &&
        outsBeforePlay < 2 &&
        play.atThird.has(runnerId)
      const earned =
        !reachedOnError &&
        !cameHomeOnError &&
        (!inningWouldHaveEnded || wouldHaveScoredAnyway)
      if (earned) add(responsible, 'earned')
      trace?.push({
        order: play.order,
        inning: play.inning,
        half: play.half,
        runnerId,
        pitcherId: responsible,
        earned,
        reason: earned
          ? 'earned'
          : reachedOnError
            ? 'reachedOnError'
            : cameHomeOnError
              ? 'scoredOnError'
              : 'inningWouldHaveEnded'
      })

      onBase.delete(runnerId)
    }
  }

  return totals
}
