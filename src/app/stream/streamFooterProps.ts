import type { TeamStationClient } from '../../common/api'

export interface StreamFooterProps {
  client: TeamStationClient
  gameId: string
  /** The videos this game's cameras are publishing to, each time that changes. */
  onPublishing?: (videoIds: string[]) => void
  /** Whether the game has a video to play. Without one a phone says so here. */
  hasVideo: boolean
  /** Plays one of the game's videos in the player above. */
  onPlay?: (videoId: string) => void
}
