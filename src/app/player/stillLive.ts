import type { TeamStationClient } from '../../common/api'

/**
 * Whether the game still lists a video as live: asked by the web player when
 * the video's playlist has been closed, to tell a camera that has been away a
 * while from a game that has finished (`liveRejoin.ts`).
 */
export async function isStillLive(
  client: Pick<TeamStationClient, 'game'>,
  gameId: string,
  videoId: string
): Promise<boolean> {
  const game = await client.game(gameId)
  return game.videos.some(item => item.id === videoId && item.status === 'live')
}
