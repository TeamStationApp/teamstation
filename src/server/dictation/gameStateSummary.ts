import { POSITIONS } from '../../common/scoring/state'

/**
 * A readable account of the game a dictation prompt was about, written into
 * the journal beside that prompt. The screen is the one that sent it:
 * scoring carries both rosters and the live situation, set roster carries
 * both rosters, and Coach Game carries one team's roster.
 */

const FIELDER_SPLIT = new RegExp(`, (?=(?:${POSITIONS.join('|')}) )`)

export interface RosterSideSummary {
  side: string
  name: string
  /** Batting order, `1. Alex Lee #4 (SS)`. */
  lineup: string[]
  /** Name and number, not in the batting order and not on the field. */
  bench: string[]
  /** On the field but not in the batting order, `Alex Lee #4 (P)`. */
  fieldNotBatting: string[]
}

export interface GameStateSummary {
  /** `scoring`, `set roster`, or `coach`. Any other scope is kept as sent. */
  screen: string
  /** The prompt includes the live situation: inning, batter, bases, defense. */
  live: boolean
  inning: string | null
  battingTeam: string | null
  fieldingTeam: string | null
  batter: string | null
  pitcher: string | null
  nextBatter: string | null
  bases: { first: string; second: string; third: string } | null
  defense: string[]
  teams: RosterSideSummary[]
  /**
   * Set when this prompt is not the context that screen is supposed to send:
   * a coach prompt that names the other team, a set-roster prompt that
   * includes the live situation, or a scoring prompt missing either.
   */
  note: string | null
}

/** Which screen sent this prompt, from its scope and how many rosters it holds. */
export function dictationScreen(scope: string, context: string): string {
  const teams = teamCount(context)
  if (scope === 'scoring') return 'scoring'
  if (scope === 'roster') return teams === 1 ? 'coach' : 'set roster'
  return scope
}

/** The game state inside a dictation prompt. Tags are left out of every name. */
export function summarizeGameState(
  scope: string,
  context: string
): GameStateSummary {
  const text = context.replace(/ \(tag [A-Z]{2}[0-9]\)/g, '')
  const screen = dictationScreen(scope, text)
  const live = /^(?:Top|Bottom) of the /m.test(text)
  const teams = rostersOf(text)
  const situation = live ? situationOf(text) : null
  return {
    screen,
    live,
    inning: situation?.inning ?? null,
    battingTeam: situation?.battingTeam ?? null,
    fieldingTeam: situation?.fieldingTeam ?? null,
    batter: situation?.batter ?? null,
    pitcher: situation?.pitcher ?? null,
    nextBatter: situation?.nextBatter ?? null,
    bases: situation?.bases ?? null,
    defense: situation?.defense ?? defenseFromRosters(teams),
    teams,
    note: noteFor(screen, live, teams.length)
  }
}

/**
 * Journal lines for one sentence. Each line stands alone: systemd records a
 * newline as a new entry, and the id keeps the block together.
 */
export function gameStateLogLines(input: {
  id: string
  model: string
  scope: string
  context: string
  said: string
}): string[] {
  const summary = summarizeGameState(input.scope, input.context)
  const prefix = `dictation-state ${input.id}`
  const lines = [`${prefix} model=${input.model} screen=${summary.screen}`]
  if (summary.note != null) lines.push(`${prefix} ${summary.note}`)
  if (!summary.live) lines.push(`${prefix} The game has not begun.`)
  else {
    const where = [
      summary.inning,
      summary.battingTeam == null ? null : `${summary.battingTeam} batting`,
      summary.fieldingTeam == null
        ? null
        : `${summary.fieldingTeam} in the field`
    ]
      .filter(part => part != null)
      .join('. ')
    if (where !== '') lines.push(`${prefix} ${where}.`)
    lines.push(
      `${prefix} Batter: ${summary.batter ?? 'nobody'}. Pitcher: ${summary.pitcher ?? 'nobody'}. Next batter: ${summary.nextBatter ?? 'nobody'}.`
    )
    const bases = summary.bases
    lines.push(
      `${prefix} On first: ${bases?.first ?? 'nobody'}. On second: ${bases?.second ?? 'nobody'}. On third: ${bases?.third ?? 'nobody'}.`
    )
    lines.push(
      `${prefix} Defense: ${summary.defense.length === 0 ? 'none' : summary.defense.join(', ')}.`
    )
  }
  if (summary.teams.length === 0)
    lines.push(`${prefix} Rosters: none in this prompt.`)
  for (const team of summary.teams) {
    const who = `${team.side} ${team.name}`
    lines.push(
      `${prefix} ${who} lineup: ${team.lineup.length === 0 ? 'none' : team.lineup.join(', ')}.`
    )
    lines.push(
      `${prefix} ${who} bench: ${team.bench.length === 0 ? 'none' : team.bench.join(', ')}.`
    )
    if (team.fieldNotBatting.length > 0)
      lines.push(
        `${prefix} ${who} on the field, not batting: ${team.fieldNotBatting.join(', ')}.`
      )
  }
  lines.push(`${prefix} Said: ${input.said}`)
  return lines
}

function teamCount(context: string): number {
  return [...context.matchAll(/^(?:AWAY|HOME) — /gm)].length
}

function noteFor(screen: string, live: boolean, teams: number): string | null {
  const notes: string[] = []
  if (screen === 'coach' && teams !== 1)
    notes.push(
      `Coach Game should send one team. This prompt has ${teams === 0 ? 'no roster' : `${teams} rosters`}.`
    )
  if (screen === 'coach' && live)
    notes.push(
      'Coach Game should send one team. This prompt also includes the live situation, which names the other team.'
    )
  if (screen === 'set roster' && teams !== 2)
    notes.push(
      `Set roster should send both teams. This prompt has ${teams === 0 ? 'no roster' : `${teams} roster`}.`
    )
  if (screen === 'set roster' && live)
    notes.push(
      'Set roster should send the two rosters. This prompt also includes the live game situation.'
    )
  if (screen === 'scoring' && (!live || teams !== 2))
    notes.push('Scoring should send both rosters and the live game situation.')
  return notes.length === 0 ? null : notes.join(' ')
}

interface Situation {
  inning: string
  battingTeam: string | null
  fieldingTeam: string | null
  batter: string | null
  pitcher: string | null
  nextBatter: string | null
  bases: { first: string; second: string; third: string }
  defense: string[]
}

function situationOf(text: string): Situation {
  const inning =
    /^(Top|Bottom) of the .+$/m.exec(text)?.[0]?.replace(/\.$/, '') ?? ''
  const teams = /^(.+) batting, (.+) in the field\.$/m.exec(text)
  const atBat = /^Batter: (.+)\. Pitcher: (.+)\.$/m.exec(text)
  const bases = /^On first: (.+)\. On second: (.+)\. On third: (.+)\.$/m.exec(
    text
  )
  const next = /^Next batter: (.+)\.$/m.exec(text)
  const fielders = /^Fielders: (.+)\.$/m.exec(text)
  return {
    inning,
    battingTeam: teams?.[1] ?? null,
    fieldingTeam: teams?.[2] ?? null,
    batter: playerOf(atBat?.[1]),
    pitcher: playerOf(atBat?.[2]),
    nextBatter: playerOf(next?.[1]),
    bases: {
      first: playerOf(bases?.[1]) ?? 'nobody',
      second: playerOf(bases?.[2]) ?? 'nobody',
      third: playerOf(bases?.[3]) ?? 'nobody'
    },
    defense:
      fielders == null
        ? []
        : fielders[1].split(FIELDER_SPLIT).flatMap(part => {
            const match = /^([A-Z0-9]+) (.+)$/.exec(part.trim())
            if (match == null) return []
            return [`${match[1]} ${playerOf(match[2]) ?? match[2]}`]
          })
  }
}

function playerOf(raw: string | undefined): string | null {
  if (raw == null) return null
  const name = raw.trim()
  if (name === '' || name === 'nobody') return name === '' ? null : 'nobody'
  return name
}

function rostersOf(text: string): RosterSideSummary[] {
  const start = text.indexOf('ROSTERS\n')
  const body = start < 0 ? '' : text.slice(start + 'ROSTERS\n'.length)
  const teams: RosterSideSummary[] = []
  let current: RosterSideSummary | null = null
  for (const line of body.split('\n')) {
    const header = /^(AWAY|HOME) — (.+)$/.exec(line)
    if (header != null) {
      if (current != null) teams.push(finish(current))
      current = {
        side: header[1],
        name: header[2],
        lineup: [],
        bench: [],
        fieldNotBatting: []
      }
      continue
    }
    const player = /^ {2}(.+) — (.+)$/.exec(line)
    if (current == null || player == null) continue
    const name = player[1].trim()
    const roles = player[2]
    const slot = /bats (\d+)/.exec(roles)
    const position = /plays ([A-Z0-9]+)/.exec(roles)
    if (slot != null) {
      current.lineup.push(
        `${Number(slot[1])}. ${name}${position == null ? '' : ` (${position[1]})`}`
      )
      continue
    }
    if (roles.trim() === 'bench') {
      current.bench.push(name)
      continue
    }
    if (position != null)
      current.fieldNotBatting.push(`${name} (${position[1]})`)
  }
  if (current != null) teams.push(finish(current))
  return teams
}

function finish(team: RosterSideSummary): RosterSideSummary {
  team.lineup.sort(
    (a, b) => Number(/^(\d+)\./.exec(a)?.[1]) - Number(/^(\d+)\./.exec(b)?.[1])
  )
  return team
}

/** Positions named on the roster, when the prompt has no Fielders line. */
function defenseFromRosters(teams: RosterSideSummary[]): string[] {
  const byPosition = new Map<string, string>()
  for (const team of teams)
    for (const entry of [...team.lineup, ...team.fieldNotBatting]) {
      const match =
        /^(\d+)\. (.+) \(([A-Z0-9]+)\)$/.exec(entry) ??
        /^(.+) \(([A-Z0-9]+)\)$/.exec(entry)
      if (match == null) continue
      const position = match[match.length - 1]
      const name = match[match.length - 2]
      if (!byPosition.has(position))
        byPosition.set(position, `${position} ${name}`)
    }
  return POSITIONS.flatMap(position => {
    const named = byPosition.get(position)
    return named == null ? [] : [named]
  })
}
