import { addStatCount, type StatExtras } from '../common/statExtras'

// The figures on a screen, added up out of the stored stat lines.
//
// One row per player per game is written by a stats engine outside these
// routes, which recomputes a game's rows whenever its plays change. A game it
// has written no rows for has no box score and adds nothing to a total.
// Everything here is arithmetic on those rows: a box score is one game's, a
// season is a season's, a career is all of them. There is no second way of
// working a figure out, so a box score and a career total cannot disagree.

/**
 * The innings an ERA divides by where neither the season nor its league says:
 * six, the length of a game in the leagues TeamStation serves.
 */
export const DEFAULT_ERA_INNINGS = 6

export interface StatRow {
  extra?: StatExtras | null
  userId: number
  teamId: string | null
  /**
   * The innings a game in this game's season runs, which is what an ERA
   * divides by: the season's `era_innings`, else its league's, else
   * `DEFAULT_ERA_INNINGS`. `statRows` fills it in its query.
   */
  eraInnings: number
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
  sh: number
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
  roe: number | null
  fc: number | null
  pik: number | null
  firstPa: number | null
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
  /** Sacrifice flies, which an on-base percentage counts against. */
  sf: number
  /** Sacrifice bunts, which it does not. */
  sh: number
}

export interface PitchingLine {
  gs: number | null
  pitches: number | null
  kl: number | null
  pitchAb: number | null
  wp: number | null
  lob: number | null
  bk: number | null
  pik: number | null
  cs: number | null
  sb: number | null
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
   * The ERA divisor of the games in this line, weighted by the innings thrown
   * under each.
   */
  eraInnings: number
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
    sf: 0,
    sh: 0,
    roe: 0,
    fc: 0,
    pik: 0,
    firstPa: null
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
    wp: 0,
    gs: 0,
    pitches: 0,
    kl: 0,
    pitchAb: 0,
    lob: 0,
    bk: 0,
    pik: 0,
    cs: 0,
    sb: 0,
    eraInnings: DEFAULT_ERA_INNINGS
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
    held.sh += row.sh
    held.roe = addStatCount(held.roe, row.extra?.roe)
    held.fc = addStatCount(held.fc, row.extra?.fc)
    held.pik = addStatCount(held.pik, row.extra?.pik)
    if (row.extra?.firstPa != null)
      held.firstPa = Math.min(held.firstPa ?? Infinity, row.extra.firstPa)
    byPlayer.set(row.userId, held)
  }
  return [...byPlayer.values()]
    .filter(
      line =>
        line.pa > 0 ||
        line.r > 0 ||
        line.sb > 0 ||
        line.cs > 0 ||
        (line.pik ?? 0) > 0
    )
    .sort((a, b) => b.pa - a.pa)
}

/** One per pitcher, most outs first; the starter is recorded separately. */
export function pitchingLines(rows: StatRow[]): PitchingLine[] {
  const byPlayer = new Map<number, PitchingLine>()
  // The ERA divisor is weighted by the innings thrown under it, so a career
  // across a six-inning league and a nine-inning one lands between the two
  // rather than on whichever season came last.
  const weighted = new Map<number, { outs: number; product: number }>()
  for (const row of rows) {
    if (
      row.pitchBf === 0 &&
      row.pitchOuts === 0 &&
      row.extra?.appeared !== true
    )
      continue
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
    for (const field of [
      'gs',
      'pitches',
      'kl',
      'pitchAb',
      'lob',
      'bk',
      'wp'
    ] as const) {
      held[field] = addStatCount(held[field], row.extra?.[field])
    }
    held.pik = addStatCount(held.pik, row.extra?.pitchPik)
    held.cs = addStatCount(held.cs, row.extra?.pitchCs)
    held.sb = addStatCount(held.sb, row.extra?.pitchSb)
    byPlayer.set(row.userId, held)

    const sum = weighted.get(row.userId) ?? { outs: 0, product: 0 }
    sum.outs += row.pitchOuts
    sum.product += row.pitchOuts * row.eraInnings
    weighted.set(row.userId, sum)
  }
  for (const [userId, sum] of weighted) {
    const line = byPlayer.get(userId)
    if (line == null || sum.outs === 0) continue
    line.eraInnings = sum.product / sum.outs
  }
  return [...byPlayer.values()].sort((a, b) => b.outs - a.outs)
}

export interface BattingRates {
  sbPct?: number
  avg?: number
  obp?: number
  slg?: number
  ops?: number
}

export function battingRates(line: BattingLine): BattingRates {
  const rates: BattingRates = {}
  if (line.sb + line.cs > 0) rates.sbPct = round3(line.sb / (line.sb + line.cs))
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
  baa?: number
  sbPct?: number
  /**
   * Earned runs per game — and a game is the season's `eraInnings`, six unless
   * the season or league says otherwise, not nine. Undefined with no outs.
   */
  era?: number
  /** Walks and hits per inning. */
  whip?: number
}

export function pitchingRates(line: PitchingLine): PitchingRates {
  const rates: PitchingRates = {}
  if (line.pitchAb != null && line.pitchAb > 0)
    rates.baa = round3(line.h / line.pitchAb)
  if (line.sb != null && line.cs != null && line.sb + line.cs > 0)
    rates.sbPct = round3(line.sb / (line.sb + line.cs))
  if (line.outs === 0) return rates
  const innings = line.outs / 3
  rates.era = round2((line.eraInnings * line.er) / innings)
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
