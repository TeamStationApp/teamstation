import { useEffect, useRef } from 'react'

import type { GameLiveStreams, VideoSummary } from '../../common/api'

/** How often a game's videos are asked for again while a camera is live. */
export const VIDEO_LIST_REFRESH_MS = 10_000

/**
 * Keeps a game's list of videos current while a camera on it is live.
 *
 * The list is read once, when the page opens. A camera that goes live after
 * that is a video the page has never heard of: it said "No videos." beside a
 * cameras panel reading "Live now", and an angle that joined later never
 * reached the angle pills or the multi-camera view, until a reload.
 *
 * So while any of the game's videos is live, or the cameras panel has seen a
 * camera publishing (`publishing`, the video ids it is publishing to), the list
 * is asked for again every `VIDEO_LIST_REFRESH_MS`; and a publishing video the
 * list does not hold yet is asked for at once. A game nothing is live on asks
 * nothing.
 */
export function useVideoListRefresh(options: {
  /** The list the page holds, or undefined while it is still loading. */
  videos: VideoSummary[] | undefined
  publishing: string[]
  refresh: () => void
  everyMs?: number
}): void {
  const { videos, publishing, everyMs = VIDEO_LIST_REFRESH_MS } = options
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
  useEffect(() => {
    if (!anyLive) return
    const timer = setInterval(() => {
      refresh.current()
    }, everyMs)
    return () => {
      clearInterval(timer)
    }
  }, [anyLive, everyMs])
}

/**
 * Which video a game page opens on: a live one ahead of anything already
 * recorded, then one that is ready, then any.
 */
export function openingVideo(videos: VideoSummary[]): VideoSummary | undefined {
  return (
    videos.find(item => item.status === 'live') ??
    videos.find(item => item.status === 'ready') ??
    videos[0]
  )
}

/**
 * Whether two lists hold the same videos in the same states, so a refresh
 * that changed nothing leaves the page's own copy, and everything drawn from
 * it, alone.
 */
export function sameVideos(
  before: VideoSummary[],
  after: VideoSummary[]
): boolean {
  if (before.length !== after.length) return false
  return before.every(
    (video, index) =>
      video.id === after[index]?.id && video.status === after[index]?.status
  )
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
