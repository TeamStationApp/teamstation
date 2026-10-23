import type { Pushed } from '../App'
import { identityOf } from './stackScene'

type Ids<Name extends Pushed['name']> = (
  frame: Pushed & { name: Name }
) => ReadonlyArray<string | undefined>

/**
 * The fields that pick out what each screen shows. Every screen is listed, so
 * a new one cannot be added without saying which of its fields those are;
 * the rest change in place and keep the screen's scene.
 */
const SCREEN_IDS: { [Name in Pushed['name']]: Ids<Name> } = {
  leagueUmpires: frame => [frame.id],
  umpireNoteTypes: frame => [frame.id],
  umpireTypes: frame => [frame.id],
  umpireLevels: frame => [frame.id],
  umpireRequirements: frame => [frame.id],
  umpireRequirementEdit: frame => [frame.id],
  umpireSchedule: frame => [frame.id],
  groupAddPeople: frame => [frame.kind, frame.id],
  groupInvites: frame => [frame.kind, frame.id],
  groupLocation: frame => [frame.kind, frame.id],
  nodeAdministration: () => [],
  createGame: frame => [frame.kind, frame.id, frame.gameId],
  gameSettings: frame => [frame.gameId],
  promoteExternal: frame => [frame.id],
  discover: frame => [frame.kind],
  group: frame => [frame.kind, frame.id],
  groupSettings: frame => [frame.kind, frame.id],
  createGroup: frame => [frame.kind],
  groupLink: frame => [
    frame.kind,
    frame.id,
    frame.targetKind,
    frame.relationship,
    frame.direction
  ],
  notifications: () => [],
  notification: frame => [frame.id],
  scoreGame: frame => [frame.gameId],
  scoreOptions: frame => [frame.gameId],
  coachGame: frame => [frame.gameId, frame.teamId],
  gameReplay: frame => [frame.gameId],
  djGame: frame => [frame.gameId],
  scoreboardOverride: frame => [frame.gameId],
  season: frame => [frame.season.id],
  team: frame => [frame.team.id],
  game: frame => [frame.gameId],
  account: () => [],
  player: frame => [frame.userId],
  walkUpSong: frame => [frame.teamId, frame.userId],
  person: frame => [frame.kind, frame.id, frame.userId]
}

/** Which screen a pushed frame is, for its scene key (`frameKey`). */
export function screenIdentity(frame: Pushed): string {
  const ids = SCREEN_IDS[frame.name] as (
    frame: Pushed
  ) => ReturnType<Ids<Pushed['name']>>
  return identityOf(frame.name, ids(frame))
}
