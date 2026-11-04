import type { LiveStream, TeamStationClient } from '../../common/api'
import { isEnded } from '../stream/cameraRowRules'

export type PhoneStreamAction = 'rotate' | 'end'

/** The server lists other people's cameras only to operators who may end them. */
export function phoneStreamActions(
  stream: LiveStream,
  mine: boolean
): PhoneStreamAction[] {
  if (isEnded(stream)) return []
  return mine ? ['rotate', 'end'] : ['end']
}

export function asksTwice(
  _action: PhoneStreamAction,
  stream: LiveStream
): boolean {
  return stream.state === 'publishing'
}

export async function runStreamAction(
  client: TeamStationClient,
  gameId: string,
  stream: LiveStream,
  action: PhoneStreamAction
): Promise<LiveStream> {
  return action === 'rotate'
    ? await client.rotateLiveStream(gameId, stream.id)
    : await client.endLiveStream(gameId, stream.id)
}
