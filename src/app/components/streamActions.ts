import type { LiveStream, TeamStationClient } from '../../common/api'
import { copyToClipboard } from '../platform/clipboard'

/**
 * What can be done to a camera on a game, by whoever may manage it.
 *
 * The browser's stream panel and the phone's camera list both offer these,
 * through the same rules and the same calls, so a person sees the same choices
 * on a camera wherever they look at it.
 */
export type StreamAction =
  'reveal' | 'rotate' | 'end' | 'deleteVideo' | 'remove'

/**
 * The actions a camera offers, in the order they are shown.
 *
 * On one of your own: its URL, a new key, End while it has not ended, Delete
 * the recording once it made one and is off the air, and Remove while it is
 * off the air. On somebody else's, which the server lists only to the people
 * who run the team: End while it has not ended, and nothing that touches its
 * key, which publishes video as them.
 */
export function streamActionsFor(
  stream: LiveStream,
  mine: boolean
): StreamAction[] {
  const actions: StreamAction[] = []
  if (mine) actions.push('reveal', 'rotate')
  if (stream.state !== 'ended') actions.push('end')
  if (!mine) return actions
  if (stream.videoId != null && stream.state !== 'publishing')
    actions.push('deleteVideo')
  if (stream.state !== 'publishing') actions.push('remove')
  return actions
}

/** What the "…" on a phone's camera row offers. */
export type PhoneStreamAction = Extract<StreamAction, 'rotate' | 'end'>

/**
 * The phone's "…": a new key and End on one's own camera, End on somebody
 * else's, while it has not ended. The phone's RTMP sheet, Revoke and the row's
 * delete button stand in for the rest of `streamActionsFor`.
 */
export function phoneStreamActions(
  stream: LiveStream,
  mine: boolean
): PhoneStreamAction[] {
  if (stream.state === 'ended' || stream.closesAt != null) return []
  return mine ? ['rotate', 'end'] : ['end']
}

/**
 * Whether a press has to be made twice.
 *
 * A new key, End and Remove take a game off the air while it is being played,
 * and a mis-tap on a phone in a dugout costs the rest of the game, so they ask
 * twice while video is arriving and act at once otherwise. Deleting a
 * recording cannot be undone, so it always asks twice. Revealing a URL takes
 * nothing away.
 */
export function asksTwice(action: StreamAction, stream: LiveStream): boolean {
  if (action === 'reveal') return false
  if (action === 'deleteVideo') return true
  return stream.state === 'publishing'
}

/**
 * Does one action on the server. Answers the camera as it now is, with its
 * URL where the answer carries one, or nothing for the actions that take the
 * camera or its recording away.
 */
export async function runStreamAction(
  client: TeamStationClient,
  gameId: string,
  stream: LiveStream,
  action: StreamAction
): Promise<LiveStream | undefined> {
  switch (action) {
    case 'reveal':
      return await client.revealLiveStream(gameId, stream.id)
    case 'rotate':
      return await client.rotateLiveStream(gameId, stream.id)
    case 'end':
      return await client.endLiveStream(gameId, stream.id)
    case 'deleteVideo':
      if (stream.videoId != null) await client.deleteVideo(stream.videoId)
      return undefined
    case 'remove':
      await client.removeLiveStream(gameId, stream.id)
      return undefined
  }
}

/**
 * Copy stream URL: the camera's whole address, asked for when the list left
 * it out, put on the clipboard. Answers the address.
 */
export async function copyStreamUrl(
  client: TeamStationClient,
  gameId: string,
  stream: LiveStream,
  copy: (text: string) => void = copyToClipboard
): Promise<string> {
  const url =
    stream.url ?? (await runStreamAction(client, gameId, stream, 'reveal'))?.url
  if (url == null) throw new Error('This camera has no URL to copy')
  copy(url)
  return url
}
