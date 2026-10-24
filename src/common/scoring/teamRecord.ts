import type { TeamStationRecord } from './gumbo'
import type { GameSetup, GameSide, Side } from './state'

/**
 * A record as TeamStation stores it from version 3: every lineup it holds,
 * every lineup change and every side a roster save confirmed or left unseen
 * named by its team's id, never by home or away. Which team is home is the
 * game's to say, so the same record reads the same after home and away are
 * exchanged. The engine works on sides: a record is turned to sides as it is
 * read, with the game's teams, and back to teams as it is written, with the
 * teams the engine played it under.
 */

/** The teams of a game, by side: what turns a team's id into its side. */
export type SideTeams = Record<Side, { id: string }>

/** A setup with each team's lineup under its id. */
export interface TeamSetup {
  players: GameSetup['players']
  teams: Record<string, GameSide>
  tagOrder: number[]
}

const SIDES: readonly Side[] = ['away', 'home']

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** The side holding this team, or undefined when neither does. */
function sideOf(teams: SideTeams, teamId: unknown): Side | undefined {
  return SIDES.find(side => teams[side].id === teamId)
}

/** Each side's lineup under its team's id. */
export function setupByTeam(setup: GameSetup, teams: SideTeams): TeamSetup {
  return {
    players: setup.players,
    teams: {
      [teams.away.id]: setup.sides.away,
      [teams.home.id]: setup.sides.home
    },
    tagOrder: setup.tagOrder
  }
}

/** A stored setup's lineups by side, as untyped as it was stored. */
function setupBySide(raw: unknown, teams: SideTeams): unknown {
  if (!object(raw) || !object(raw.teams)) return raw
  const { teams: byTeam, ...rest } = raw
  return {
    ...rest,
    sides: { away: byTeam[teams.away.id], home: byTeam[teams.home.id] }
  }
}

/** Sides named by their teams' ids, in the same order. */
function teamIdsOf(sides: readonly Side[], teams: SideTeams): string[] {
  return sides.map(side => teams[side].id)
}

/** Team ids turned back to sides; one naming neither team is dropped. */
function sidesOf(raw: unknown, teams: SideTeams): unknown {
  if (!Array.isArray(raw)) return raw
  return raw.flatMap(id => {
    const side = sideOf(teams, id)
    return side == null ? [] : [side]
  })
}

/** One action as a version 3 record stores it. Only lineup actions change. */
export function actionByTeam<A extends { type: string }>(
  action: A,
  teams: SideTeams
): Record<string, unknown> {
  if (action.type !== 'lineup') return action
  const { side, setup, confirmed, unseen, ...rest } = action as A & {
    side?: Side
    setup?: GameSetup
    confirmed?: Side[]
    unseen?: Side[]
  }
  return {
    ...rest,
    ...(side == null ? {} : { teamId: teams[side].id }),
    ...(setup == null ? {} : { setup: setupByTeam(setup, teams) }),
    ...(confirmed == null ? {} : { confirmed: teamIdsOf(confirmed, teams) }),
    ...(unseen == null ? {} : { unseen: teamIdsOf(unseen, teams) })
  }
}

/**
 * Teams a stored record can be read with when the game's are not at hand:
 * a version 3 record's own two teams, in no particular order, or none for
 * an older record, which names sides. What it reads by side is only good for
 * writing back with the same teams (`recordByTeam`), or for what names no
 * side at all.
 */
export function ownTeams(raw: unknown): SideTeams {
  const setup = object(raw) ? raw.setupBefore : undefined
  const ids =
    object(raw) && raw.version === 3 && object(setup) && object(setup.teams)
      ? Object.keys(setup.teams)
      : []
  return { away: { id: ids[0] ?? '' }, home: { id: ids[1] ?? '' } }
}

/** A record read by sides, as version 3 stores it under these teams. */
export function recordByTeam(
  record: TeamStationRecord,
  teams: SideTeams
): Record<string, unknown> {
  return {
    ...record,
    version: 3,
    setupBefore: setupByTeam(record.setupBefore, teams),
    actions: record.actions.map(action => actionByTeam(action, teams))
  }
}

/** One stored action with its teams turned to sides, still uncleaned. */
function actionBySide(raw: unknown, teams: SideTeams): unknown {
  if (!object(raw) || raw.type !== 'lineup') return raw
  const { teamId, setup, confirmed, unseen, ...rest } = raw
  const side = teamId == null ? undefined : sideOf(teams, teamId)
  if (teamId != null && side == null)
    throw new Error('A lineup change names a team not in this game')
  return {
    ...rest,
    ...(side == null ? {} : { side }),
    ...(setup == null ? {} : { setup: setupBySide(setup, teams) }),
    ...(confirmed == null ? {} : { confirmed: sidesOf(confirmed, teams) }),
    ...(unseen == null ? {} : { unseen: sidesOf(unseen, teams) })
  }
}

/**
 * A version 3 record as the version 2 shape the cleaner reads: its setups
 * and lineup changes turned to sides with the game's teams. A record whose
 * setup names a team on neither side is not this game's to read.
 */
export function recordBySide(raw: unknown, teams: SideTeams): unknown {
  if (!object(raw) || raw.version !== 3) return raw
  const setup = raw.setupBefore
  const byTeam = object(setup) ? setup.teams : undefined
  if (
    !object(byTeam) ||
    Object.keys(byTeam).some(id => sideOf(teams, id) == null) ||
    SIDES.some(side => byTeam[teams[side].id] == null)
  )
    throw new Error('The record names a team not in this game')
  return {
    ...raw,
    version: 2,
    setupBefore: setupBySide(setup, teams),
    actions: Array.isArray(raw.actions)
      ? raw.actions.map(action => actionBySide(action, teams))
      : raw.actions
  }
}

/**
 * The same team ids, wherever a stored record names one, changed from one
 * team to another: what a game whose team was replaced must do to keep its
 * records readable.
 */
export function retargetRecord(
  raw: unknown,
  fromId: string,
  toId: string
): unknown {
  if (!object(raw) || raw.version !== 3) return raw
  const team = (id: unknown): unknown => (id === fromId ? toId : id)
  // Each player names his team too.
  const players = (value: unknown): unknown =>
    object(value)
      ? Object.fromEntries(
          Object.entries(value).map(([id, player]) => [
            id,
            object(player) && player.teamId === fromId
              ? { ...player, teamId: toId }
              : player
          ])
        )
      : value
  const setup = (value: unknown): unknown =>
    object(value) && object(value.teams)
      ? {
          ...value,
          players: players(value.players),
          teams: Object.fromEntries(
            Object.entries(value.teams).map(([id, lineup]) => [
              team(id),
              lineup
            ])
          )
        }
      : value
  const ids = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(team) : value
  return {
    ...raw,
    setupBefore: setup(raw.setupBefore),
    actions: Array.isArray(raw.actions)
      ? raw.actions.map(action =>
          object(action) && action.type === 'lineup'
            ? {
                ...action,
                ...(action.teamId == null
                  ? {}
                  : { teamId: team(action.teamId) }),
                ...(action.setup == null ? {} : { setup: setup(action.setup) }),
                ...(action.confirmed == null
                  ? {}
                  : { confirmed: ids(action.confirmed) }),
                ...(action.unseen == null ? {} : { unseen: ids(action.unseen) })
              }
            : action
        )
      : raw.actions
  }
}
