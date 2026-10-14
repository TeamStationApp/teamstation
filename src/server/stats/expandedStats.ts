import { normalizeEventType } from '../../common/gumboEventTypes'
import type { GumboPlay } from '../../common/gumboPlay'
import { emptyStatExtras, type StatExtras } from '../../common/statExtras'
import { battingTeamForHalf, type GameTeams } from '../events/eventWrite'
import {
  emptyLine,
  eventTypeCounts,
  gameStatLines,
  type PlayerGameLine
} from './gumboStats'

type Doc = Record<string, unknown>
const doc = (value: unknown): Doc =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Doc)
    : {}
const list = (value: unknown): Doc[] =>
  Array.isArray(value) ? value.map(doc) : []
const typeOf = (value: unknown): string =>
  typeof value === 'string' ? normalizeEventType(value) : ''
const personKey = (value: unknown): string => {
  const person = doc(value)
  return typeof person.id === 'number'
    ? `id:${person.id}`
    : `name:${typeof person.fullName === 'string' ? person.fullName : ''}`
}

export interface ExpandedGameLine extends PlayerGameLine {
  extra: StatExtras
}

/** Add source detail while retaining the base scorer's validation and scoring. */
export function expandedGameStatLines(
  plays: GumboPlay[],
  teams: GameTeams,
  knownUsers: ReadonlySet<number>
):
  | { kind: 'lines'; lines: ExpandedGameLine[] }
  | { kind: 'incomplete'; detail: string } {
  const base = gameStatLines(plays, teams, knownUsers)
  if (base.kind === 'incomplete') return base
  const lines = new Map<number, ExpandedGameLine>(
    base.lines.map(line => [
      line.userId,
      { ...line, sb: 0, cs: 0, extra: emptyStatExtras() }
    ])
  )
  const idOf = (value: unknown): number | null => {
    const id = doc(value).id
    return typeof id === 'number' && knownUsers.has(id) ? id : null
  }
  const lineOf = (
    id: number | null,
    team: string | null
  ): ExpandedGameLine | undefined => {
    if (id == null) return undefined
    let line = lines.get(id)
    if (line == null) {
      line = { ...emptyLine(id, team), extra: emptyStatExtras() }
      lines.set(id, line)
    }
    return line
  }
  const previous = new Map<string, number | null>()
  const starters = new Map<string, number | null>()
  const seenHalf = new Set<string>()
  let halfKey = ''
  let complete = false
  let historyKnown = false
  let occupants = new Map<string, number | null>()
  let halfPitchers = new Set<number>()
  const finishHalf = (): void => {
    if (!historyKnown || !complete) {
      for (const id of halfPitchers) lines.get(id)!.extra.lob = null
    } else {
      for (const owner of occupants.values()) {
        if (owner == null) {
          for (const id of halfPitchers) lines.get(id)!.extra.lob = null
        } else {
          const extra = lines.get(owner)?.extra
          if (extra?.lob != null) extra.lob++
        }
      }
    }
  }

  for (const play of plays) {
    const { inning, halfInning: half, atBatIndex } = play.about
    if (half == null || inning == null) continue
    const key = `${inning}:${half}`
    if (key !== halfKey) {
      if (halfKey !== '') finishHalf()
      halfKey = key
      occupants = new Map()
      halfPitchers = new Set()
      complete = false
      historyKnown = plays[0]?.about.atBatIndex === 0
    }
    const battingTeam = battingTeamForHalf(half, teams)
    const pitchingTeam = half === 'top' ? teams.homeTeamId : teams.awayTeamId
    const outcome = typeOf(play.result.eventType)
    const counts = eventTypeCounts(outcome)
    const events = list(play.playEvents).sort(
      (a, b) => Number(a.index) - Number(b.index)
    )
    const changes = events.filter(
      e => doc(e.details).eventType === 'pitching_substitution'
    )
    const pitches = events.filter(e => e.isPitch === true)
    const finalPitcher = idOf(play.matchup?.pitcher)
    const openingPitch = pitches.find(
      event =>
        changes.length === 0 ||
        (typeof event.index === 'number' &&
          event.index < Number(changes[0].index))
    )
    const began =
      changes.length === 0
        ? (idOf(openingPitch?.player) ?? finalPitcher)
        : (idOf(changes[0].replacedPlayer) ??
          idOf(openingPitch?.player) ??
          previous.get(half) ??
          null)
    const moundAt = (index: unknown): number | null => {
      if (typeof index !== 'number') return finalPitcher
      let id = began
      for (const change of changes) {
        if (typeof change.index === 'number' && change.index < index)
          id = idOf(change.player)
      }
      return id
    }
    const hasAppearance =
      counts != null || events.some(event => event.isPitch === true)
    if (hasAppearance || changes.length > 0) previous.set(half, finalPitcher)
    if (!seenHalf.has(half) && hasAppearance) {
      seenHalf.add(half)
      starters.set(
        half,
        inning === 1 && plays[0]?.about.atBatIndex === 0
          ? pitches.length === 0
            ? began
            : (idOf(pitches[0].player) ?? moundAt(pitches[0].index))
          : null
      )
    }
    const appear = (id: number | null): StatExtras | undefined => {
      const extra = lineOf(id, pitchingTeam)?.extra
      if (extra != null && id != null) {
        extra.appeared = true
        extra.gs =
          starters.get(half) == null ? null : starters.get(half) === id ? 1 : 0
        halfPitchers.add(id)
      }
      return extra
    }
    const pitcher = counts == null ? undefined : appear(finalPitcher)
    const batter =
      counts?.pa === true
        ? lines.get(idOf(play.matchup?.batter) ?? -1)
        : undefined
    // Statistical credits without a movement are ignored by the base scorer.
    const runnerEntries = list(play.runners).filter(
      entry =>
        entry.movement != null &&
        typeof entry.movement === 'object' &&
        !Array.isArray(entry.movement)
    )
    const choice =
      ['force_out', 'fielders_choice', 'fielders_choice_out'].includes(
        outcome
      ) ||
      (['double_play', 'grounded_into_double_play', 'triple_play'].includes(
        outcome
      ) &&
        runnerEntries.some(
          entry =>
            idOf(doc(entry.details).runner) === idOf(play.matchup?.batter) &&
            doc(entry.movement).isOut !== true &&
            ['1B', '2B', '3B'].includes(String(doc(entry.movement).end))
        ))
    if (batter != null) {
      batter.extra.firstPa ??= atBatIndex
      if (outcome === 'field_error') batter.extra.roe!++
      if (choice) batter.extra.fc!++
    }
    // A replaced batter can own the completed strikeout. Record their earlier
    // turn too, so that charged line does not fall to the end of the box score.
    for (const event of events) {
      if (doc(event.details).eventType !== 'offensive_substitution') continue
      const replaced = lines.get(idOf(event.replacedPlayer) ?? -1)
      if (replaced != null && replaced.pa > 0)
        replaced.extra.firstPa ??= atBatIndex
    }
    if (counts?.ab === true && pitcher?.pitchAb != null) pitcher.pitchAb++
    for (const event of pitches) {
      const extra = appear(idOf(event.player) ?? moundAt(event.index))
      if (extra?.pitches != null) extra.pitches++
    }
    if (!Array.isArray(play.playEvents) && pitcher != null)
      pitcher.pitches = null
    if (counts?.k === true && pitcher != null) {
      const last = pitches[pitches.length - 1]
      const details = doc(last?.details)
      const call = doc(details.call).code ?? details.code
      if (typeof call !== 'string') pitcher.kl = null
      else if (call === 'C' && pitcher.kl != null) pitcher.kl++
    }

    const battery = new Set<string>()
    const batteryEvent = (
      type: string,
      index: unknown,
      id: number | null
    ): void => {
      const field =
        type === 'wild_pitch'
          ? 'wp'
          : type === 'balk' || type === 'forced_balk'
            ? 'bk'
            : null
      if (field == null) return
      // Runner detail can omit its event index. The indexed battery events
      // already establish the count; that detail is not another occurrence.
      if (
        typeof index !== 'number' &&
        Array.from(battery).some(key => key.startsWith(`${field}:`))
      )
        return
      const eventKey = `${field}:${typeof index === 'number' ? index : 'result'}`
      if (battery.has(eventKey)) return
      battery.add(eventKey)
      const extra = appear(id)
      if (extra?.[field] != null) extra[field]++
    }
    for (const event of events)
      batteryEvent(
        typeOf(doc(event.details).eventType),
        event.index,
        moundAt(event.index)
      )
    const runnerChanges = events.filter(
      event =>
        (doc(event.details).eventType === 'offensive_substitution' &&
          doc(event.position).abbreviation === 'PR') ||
        typeOf(doc(event.details).eventType) === 'ts_courtesy_runner'
    )
    let nextRunnerChange = 0
    // A pinch runner inherits the occupied base and its responsible pitcher,
    // whether he takes the man's place in the order or leaves it as it is.
    // Apply substitutions between movements, before the new runner can leave.
    const replaceRunnersBefore = (index: number): void => {
      while (nextRunnerChange < runnerChanges.length) {
        const change = runnerChanges[nextRunnerChange]
        if (typeof change.index === 'number' && change.index >= index) break
        nextRunnerChange++
        const oldKey = personKey(change.replacedPlayer)
        const newKey = personKey(change.player)
        if (!occupants.has(oldKey) || newKey === 'name:') {
          historyKnown = false
          continue
        }
        const owner = occupants.get(oldKey) ?? null
        occupants.delete(oldKey)
        occupants.set(newKey, owner)
      }
    }
    const movements = new Set<string>()
    const runnerIndex = (entry: Doc): number =>
      typeof doc(entry.details).playIndex === 'number'
        ? Number(doc(entry.details).playIndex)
        : Infinity
    const runners = runnerEntries.sort(
      (a, b) => runnerIndex(a) - runnerIndex(b)
    )
    const choiceOwners = new Map<number, number | null>()
    for (const entry of runners) {
      const movement = doc(entry.movement)
      const details = doc(entry.details)
      const person = doc(details.runner)
      const runnerId = idOf(person)
      replaceRunnersBefore(runnerIndex(entry))
      // Capture the replaced runner before either movement removes him;
      // stored runner arrays need not put the out before the batter reaching.
      const index = runnerIndex(entry)
      if (choice && !choiceOwners.has(index)) {
        const replaced = runners
          .filter(
            runner =>
              runnerIndex(runner) === index &&
              doc(runner.movement).isOut === true &&
              idOf(doc(runner.details).runner) !== idOf(play.matchup?.batter)
          )
          .sort(
            (a, b) =>
              Number(doc(a.movement).outNumber ?? Infinity) -
              Number(doc(b.movement).outNumber ?? Infinity)
          )[0]
        if (replaced != null)
          choiceOwners.set(
            index,
            occupants.get(personKey(doc(replaced.details).runner)) ??
              idOf(doc(replaced.details).responsiblePitcher)
          )
      }
      const runnerKey = personKey(person)
      const type = typeOf(details.eventType)
      const movementKey = JSON.stringify([
        runnerKey,
        details.playIndex,
        type,
        movement.start,
        movement.end,
        movement.isOut
      ])
      if (movements.has(movementKey)) continue
      movements.add(movementKey)
      const id = idOf(details.pitcher) ?? moundAt(details.playIndex)
      const sb = type.startsWith('stolen_base')
      const cs =
        type.startsWith('caught_stealing') ||
        type.startsWith('pickoff_caught_stealing')
      const pik =
        type.startsWith('pickoff_') &&
        !type.startsWith('pickoff_error') &&
        movement.isOut === true
      if (sb || cs || pik) {
        const runner = lineOf(runnerId, battingTeam)
        const extra = appear(id)
        if (runner != null) {
          if (sb) runner.sb++
          if (cs) runner.cs++
          if (pik) runner.extra.pik!++
        }
        if (extra != null) {
          if (sb && extra.pitchSb != null) extra.pitchSb++
          if (cs && extra.pitchCs != null) extra.pitchCs++
          const thrower = list(entry.credits)[0]
          const pitcherPickoff =
            thrower == null ||
            doc(thrower.position).abbreviation === 'P' ||
            idOf(thrower.player) === id
          if (pik && pitcherPickoff && extra.pitchPik != null) extra.pitchPik++
        }
      }
      batteryEvent(type, details.playIndex, id)
      if (movement.start != null && !occupants.has(runnerKey))
        historyKnown = false
      const owner =
        occupants.get(runnerKey) ??
        idOf(details.responsiblePitcher) ??
        (movement.start == null &&
        counts?.pa === true &&
        runnerId === idOf(play.matchup?.batter)
          ? choiceOwners.has(index)
            ? choiceOwners.get(index)!
            : finalPitcher
          : null)
      if (movement.isOut === true || movement.end === 'score')
        occupants.delete(runnerKey)
      else if (['1B', '2B', '3B'].includes(String(movement.end)))
        occupants.set(runnerKey, owner)
    }
    replaceRunnersBefore(Infinity)
    // Standalone battery events may have no runners, and a multi-runner play
    // may describe the same event in both its result and runner entries.
    if (
      !Array.from(battery).some(key =>
        key.startsWith(outcome === 'wild_pitch' ? 'wp:' : 'bk:')
      )
    )
      batteryEvent(outcome, null, finalPitcher)
    if (play.count?.outs != null) complete = play.count.outs === 3
  }
  if (halfKey !== '') finishHalf()
  return {
    kind: 'lines',
    lines: [...lines.values()].sort((a, b) => a.userId - b.userId)
  }
}
