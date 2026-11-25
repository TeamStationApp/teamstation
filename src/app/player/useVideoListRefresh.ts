import { useEffect, useRef } from 'react'

import type { GameLiveStreams, VideoSummary } from '../../common/api'

/**
 * Keeps a game's list of videos current while a camera on it is live.
 *
 * The list is read once, when the page opens, and again on the game's own
 * notices (the event scope), which a camera going live, a recording landing
 * or an angle joining all send. A camera the cameras panel sees publishing
 * (`publishing`, the video ids it is publishing to) to a video the list does
 * not hold yet is asked for at once, once; and a page covered while a camera
 * was live asks once again when it is shown. Nothing is asked on a timer.
 */
export function useVideoListRefresh(options: {
  /** The list the page holds, or undefined while it is still loading. */
  videos: VideoSummary[] | undefined
  publishing: string[]
  refresh: () => void
  /**
   * Whether the page is on show: covered by a screen opened from it, it asks
   * nothing, and asks once again when it is shown.
   */
  active?: boolean
}): void {
  const { videos, publishing, active = true } = options
  const refresh = useRef(options.refresh)
  refresh.current = options.refresh

  const listed = new Set((videos ?? []).map(video => video.id))
  const unknown = publishing.filter(id => !listed.has(id)).sort()
  const unknownKey = unknown.join(' ')
  /** The unknown ids already asked about, so one answer is not asked twice. */
  const askedFor = useRef('')
  useEffect(() => {
    if (videos == null || unknownKey === '' || askedFor.current === unknownKey)
      return
    askedFor.current = unknownKey
    refresh.current()
  }, [unknownKey, videos])

  const anyLive =
    publishing.length > 0 ||
    (videos ?? []).some(video => video.status === 'live')
  const hidden = useRef(false)
  useEffect(() => {
    if (!active) {
      hidden.current = true
      return
    }
    if (anyLive && hidden.current) refresh.current()
    hidden.current = false
  }, [anyLive, active])
}

/**
 * Which video a game page opens on: a live one whose camera is sending now,
 * then any live one, then one that is ready, then any.
 *
 * A video stays live after its camera drops, so the recording can resume on
 * the same row, and the first live one in the list was often a camera that
 * had stopped while another went on sending: "Watch live" opened on a picture
 * that never moved.
 */
export function openingVideo(videos: VideoSummary[]): VideoSummary | undefined {
  return (
    videos.find(item => item.status === 'live' && item.receiving) ??
    videos.find(item => item.status === 'live') ??
    videos.find(item => item.status === 'ready') ??
    videos[0]
  )
}

/**
 * Whether two lists hold the same videos, unchanged, so a refresh that changed
 * nothing leaves the page's own copy, and everything drawn from it, alone.
 *
 * Every field counts but the frame's address, which is signed afresh on each
 * read. A live video's start in particular moves after the page first sees
 * it: the server places it by when it heard the stream, and the phone then
 * says when its first picture was taken. A refresh that brings that is the
 * one the multi-camera view lines its angles up by, and a rename is a rename.
 */
export function sameVideos(
  before: VideoSummary[],
  after: VideoSummary[]
): boolean {
  if (before.length !== after.length) return false
  return before.every((video, index) => {
    const other = after[index]
    if (other == null) return false
    const keys = new Set([...Object.keys(video), ...Object.keys(other)])
    keys.delete('posterUrl')
    return [...keys].every(
      key =>
        video[key as keyof VideoSummary] === other[key as keyof VideoSummary]
    )
  })
}

/**
 * Tells the page which videos a cameras panel has seen publishing, each time
 * that changes: what `useVideoListRefresh` keeps the page's list by.
 */
export function usePublishingReport(
  streams: GameLiveStreams | undefined,
  onPublishing: ((videoIds: string[]) => void) | undefined
): void {
  const report = useRef(onPublishing)
  report.current = onPublishing
  const key = [...(streams?.mine ?? []), ...(streams?.others ?? [])]
    .flatMap(row =>
      row.state === 'publishing' && row.videoId != null ? [row.videoId] : []
    )
    .sort()
    .join(' ')
  useEffect(() => {
    report.current?.(key === '' ? [] : key.split(' '))
  }, [key])
}
