import type { TeamStationClient } from '../../common/api'
import type { GameRecording } from './gameRecording'

/** Browser recording is not supported by the phone camera engine. */
export function useGameRecording(
  _client: TeamStationClient,
  _gameId: string
): GameRecording {
  return {}
}
