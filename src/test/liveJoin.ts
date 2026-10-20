import { act } from 'react'

/**
 * The positions a player is sent to once it plays, opened as Safari opens a
 * live playlist: at its start, ten minutes before its newest footage. A live
 * viewer joins `LIVE_DELAY_SEC` behind that end (`joinLiveOnFirstPlay`); a
 * recording is left where it opened.
 */
export async function playedFromStart(
  video: HTMLVideoElement
): Promise<number[]> {
  const sent: number[] = []
  Object.defineProperty(video, 'paused', { configurable: true, value: false })
  Object.defineProperty(video, 'seekable', {
    configurable: true,
    value: { length: 1, start: () => 0, end: () => 600 }
  })
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => sent.at(-1) ?? 0,
    set: (value: number) => {
      sent.push(value)
    }
  })
  await act(async () => {
    video.dispatchEvent(new window.Event('play'))
    video.dispatchEvent(new window.Event('progress'))
  })
  return sent
}
