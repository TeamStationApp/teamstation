// The figures on a screen, added up out of the stored stat lines.
//
// One row per player per game is written by a stats engine outside these
// routes, which recomputes a game's rows whenever its plays change. A game it
// has written no rows for has no box score and adds nothing to a total.
// Everything here is arithmetic on those rows: a box score is one game's, a
// season is a season's, a career is all of them. There is no second way of
// working a figure out, so a box score and a career total cannot disagree.

export interface StatRow {
  userId: number
  teamId: string | null
  /**
   * The regulation length of the game's season, which is what an ERA divides
   * by. Null where nobody has worked it out — see `stats/regulation.ts`.
   */
  inningsPerGame?: number | null
  pa: number
  ab: number
  h: number
  singles: number
  doubles: number
  triples: number
  hr: number
  bb: number
  k: number
  r: number
  rbi: number
  hbp: number
  ci: number
  sf: number
  sb: number
  cs: number
  pitchBf: number
  pitchOuts: number
  pitchH: number
  pitchHr: number
  pitchBb: number
  pitchHbp: number
  pitchK: number
  pitchR: number
  pitchEr: number
}

export interface BattingLine {
  userId: number
  /** Null where the total spans more than one team, as a career does. */
  teamId: string | null
  /** Games this player has a line for. */
  g: number
  /** Plate appearances: every time this player came to bat. */
  pa: number
  /** At-bats: plate appearances less walks, hit batters and sacrifices. */
  ab: number
  h: number
  singles: number
  doubles: number
  triples: number
  hr: number
  bb: number
  k: number
  /** Runs scored, which is the runner's own figure and not the batter's. */
  r: number
  rbi: number
  hbp: number
  sb: number
  cs: number
  /** Sacrifices, which an on-base percentage counts against. */
  sf: number
}

export interface PitchingLine {
  userId: number
  teamId: string | null
  g: number
  /** Outs recorded, which is what innings pitched actually means. */
  outs: number
  /** Batters faced. */
  bf: number
  h: number
  hr: number
  hbp: number
  /** Runs allowed, charged to whoever put the runner on. */
  r: number
  /** Of those, the ones that were earned. */
  er: number
  bb: number
  k: number
  /**
   * The innings-weighted regulation length of the games in this line, which an
   * ERA divides by. Null where none of them say.
   */
  inningsPerGame: number | null
}

function emptyBatting(userId: number, teamId: string | null): BattingLine {
  return {
    userId,
    teamId,
    g: 0,
    pa: 0,
    ab: 0,
    h: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    bb: 0,
    k: 0,
    r: 0,
    rbi: 0,
    hbp: 0,
    sb: 0,
    cs: 0,
    sf: 0
  }
}

function emptyPitching(userId: number, teamId: string | null): PitchingLine {
  return {
    userId,
    teamId,
    g: 0,
    outs: 0,
    bf: 0,
    h: 0,
    hr: 0,
    hbp: 0,
    r: 0,
    er: 0,
    bb: 0,
    k: 0,
    inningsPerGame: null
  }
}

/** One line per player, most plate appearances first. */
export function battingLines(rows: StatRow[]): BattingLine[] {
  const byPlayer = new Map<number, BattingLine>()
  for (const row of rows) {
    const held =
      byPlayer.get(row.userId) ?? emptyBatting(row.userId, row.teamId)
    // A career spans teams, and a total that claims one of them is wrong.
    if (held.teamId !== row.teamId) held.teamId = null
    held.g += 1
    held.pa += row.pa
    held.ab += row.ab
    held.h += row.h
    held.singles += row.singles
    held.doubles += row.doubles
    held.triples += row.triples
    held.hr += row.hr
    held.bb += row.bb
    held.k += row.k
    held.r += row.r
    held.rbi += row.rbi
    held.hbp += row.hbp
    held.sb += row.sb
    held.cs += row.cs
    held.sf += row.sf
    byPlayer.set(row.userId, held)
  }
  return [...byPlayer.values()]
    .filter(line => line.pa > 0 || line.r > 0 || line.sb > 0 || line.cs > 0)
    .sort((a, b) => b.pa - a.pa)
}

/** And one per pitcher, most work first, which is the starter. */
export function pitchingLines(rows: StatRow[]): PitchingLine[] {
  const byPlayer = new Map<number, PitchingLine>()
  // The ERA divisor is weighted by the innings thrown under it, so a career
  // across a six-inning league and a nine-inning one lands between the two
  // rather than on whichever season came last.
  const weighted = new Map<number, { outs: number; product: number }>()
  for (const row of rows) {
    if (row.pitchBf === 0 && row.pitchOuts === 0) continue
    const held =
      byPlayer.get(row.userId) ?? emptyPitching(row.userId, row.teamId)
    if (held.teamId !== row.teamId) held.teamId = null
    held.g += 1
    held.outs += row.pitchOuts
    held.bf += row.pitchBf
    held.h += row.pitchH
    held.hr += row.pitchHr
    held.hbp += row.pitchHbp
    held.r += row.pitchR
    held.er += row.pitchEr
    held.bb += row.pitchBb
    held.k += row.pitchK
    byPlayer.set(row.userId, held)

    if (row.inningsPerGame == null) continue
    const sum = weighted.get(row.userId) ?? { outs: 0, product: 0 }
    sum.outs += row.pitchOuts
    sum.product += row.pitchOuts * row.inningsPerGame
    weighted.set(row.userId, sum)
  }
  for (const [userId, sum] of weighted) {
    const line = byPlayer.get(userId)
    if (line == null || sum.outs === 0) continue
    line.inningsPerGame = sum.product / sum.outs
  }
  return [...byPlayer.values()].sort((a, b) => b.outs - a.outs)
}

export interface BattingRates {
  avg?: number
  obp?: number
  slg?: number
  ops?: number
}

export function battingRates(line: BattingLine): BattingRates {
  const rates: BattingRates = {}
  if (line.ab > 0) {
    rates.avg = round3(line.h / line.ab)
    const bases =
      line.singles + line.doubles * 2 + line.triples * 3 + line.hr * 4
    rates.slg = round3(bases / line.ab)
  }
  // Their denominator, which counts a sacrifice against a hitter and a walk
  // for them.
  const onBaseChances = line.ab + line.bb + line.hbp + line.sf
  if (onBaseChances > 0) {
    rates.obp = round3((line.h + line.bb + line.hbp) / onBaseChances)
  }
  if (rates.obp != null && rates.slg != null) {
    rates.ops = round3(rates.obp + rates.slg)
  }
  return rates
}

export interface PitchingRates {
  /**
   * Earned runs per game — and a game is six innings here, not nine. Undefined
   * until something has worked out how long a game in this league is, because a
   * divisor we guessed would be wrong by a third.
   */
  era?: number
  /** Walks and hits per inning. */
  whip?: number
}

export function pitchingRates(line: PitchingLine): PitchingRates {
  const rates: PitchingRates = {}
  if (line.outs === 0) return rates
  const innings = line.outs / 3
  if (line.inningsPerGame != null) {
    rates.era = round2((line.inningsPerGame * line.er) / innings)
  }
  rates.whip = round2((line.h + line.bb) / innings)
  return rates
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** `5.2`, the way an innings-pitched column is always written. */
export function inningsPitched(outs: number): string {
  return `${Math.floor(outs / 3)}.${outs % 3}`
}
