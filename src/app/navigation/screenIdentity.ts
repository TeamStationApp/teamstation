import type { Pushed } from '../App'
import { identityOf, type Presentation } from './stackScene'

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
  teamCreatePlayer: frame => [frame.id],
  teamAddPlayer: frame => [frame.id],
  groupLocation: frame => [frame.kind, frame.id],
  seasonTimeFrame: frame => [frame.kind, frame.id],
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
  autoScheduler: frame => [frame.leagueId],
  fieldManager: frame => [frame.leagueId],
  scheduleSeason: frame => [frame.leagueId, frame.seasonId],
  schedulePreview: frame => [frame.leagueId, frame.previewId],
  venue: frame => [frame.venueId],
  venuePlace: frame => [frame.placeId],
  venueField: frame => [frame.venueId, frame.fieldId],
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
  apiKeyNew: () => [],
  chatDevices: () => [],
  chatLink: () => [],
  chatNew: () => [],
  // Its title is written in place once known.
  conversation: frame => [frame.conversationId],
  chatMembers: frame => [frame.conversationId],
  chatInfo: frame => [frame.conversationId],
  chatReports: () => [],
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

/**
 * How a frame comes on. The scorer rises over everything; Add Player's own
 * sheet rises from the bottom, so the screen beneath it stays where it is.
 */
export function presentationOf(frame: Pushed | undefined): Presentation {
  return frame?.name === 'scoreGame' || frame?.name === 'teamAddPlayer'
    ? 'cover'
    : 'push'
}

/** The chat list and a conversation drawn beside it: one scene. */
export const CHAT_WORKSPACE_KEY = 'chat:workspace'

/**
 * Whether a frame of `tab`'s stack (`undefined` for its root) is the chat
 * workspace's single scene. Wide, `ChatWorkspace` shows the chat list and a
 * chat side by side, and picking another chat changes the one beside the
 * list: as one scene it keeps its list and its place in it, with nothing
 * sliding. Narrower it shows one at a time, and a chat is pushed over the
 * list like any other screen.
 */
export function inChatWorkspace(
  tab: string,
  frame: Pushed | undefined,
  wide: boolean
): boolean {
  if (!wide) return false
  return frame == null ? tab === 'chat' : frame.name === 'conversation'
}
