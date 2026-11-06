import React, { useEffect, useState } from 'react'
import { AppState, Image, StyleSheet } from 'react-native'

import type { TeamStationClient, VideoSummary } from '../../common/api'
import { MidpointPreview } from './MidpointPreview'

export function previewCandidates(videos: VideoSummary[]): VideoSummary[] {
  const rank = (video: VideoSummary): number =>
    /\bprimary\b/i.test(video.title) ? 0 : /\bhome\b/i.test(video.title) ? 1 : 2
  return videos
    .filter(
      v =>
        v.numCameras <= 1 &&
        v.durationSec !== 0 &&
        ['ready', 'live'].includes(v.status)
    )
    .sort((a, b) => rank(a) - rank(b))
}

/** A page-owned preview never participates in the game's playback clock. */
export function HeroPreview({
  client,
  gameId,
  active,
  muted = false,
  paused = false,
  videoId,
  fallbackPoster,
  onPosition
}: {
  client: TeamStationClient
  gameId: string
  active: boolean
  muted?: boolean
  paused?: boolean
  fallbackPoster?: string | null
  videoId?: string
  onPosition?: (seconds: number) => void
}): React.ReactElement | null {
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active'
  )
  const [source, setSource] = useState<{
    uri: string
    id: string
    live: boolean
    duration: number | null
    owner: string
  } | null>(null)
  const owner = `${gameId}:${videoId ?? ''}`
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [failedStill, setFailedStill] = useState<string | null>(null)
  const [failed, setFailed] = useState<string[]>([])
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      setForeground(state === 'active')
    })
    return () => {
      listener.remove()
    }
  }, [])
  useEffect(() => {
    setFailed([])
    setFailedStill(null)
  }, [gameId, client])
  useEffect(() => {
    let current = true
    setSource(null)
    setUnavailable(null)
    if (!active || !foreground) return
    const load = async (): Promise<void> => {
      const game = await client.game(gameId)
      for (const video of previewCandidates(game.videos).filter(
        v => videoId === undefined || v.id === videoId
      )) {
        if (!current) return
        if (failed.includes(video.id)) continue
        try {
          const playback = await client.playback(video.id)
          if (!current) return
          if (playback.url !== null) {
            setSource({
              uri: playback.url,
              id: video.id,
              live: video.status === 'live',
              duration: playback.durationSec ?? video.durationSec,
              owner
            })
            return
          }
        } catch {
          /* Try the next authorized playable angle. */
        }
      }
      if (current) setUnavailable(owner)
    }
    load().catch(() => {
      if (current) setUnavailable(owner)
    })
    return () => {
      current = false
    }
  }, [client, gameId, videoId, active, foreground, failed, owner])
  if (!active || !foreground) return null
  const playable = source?.owner === owner ? source : null
  if (playable === null && unavailable !== owner) return null
  const midpoint =
    !muted &&
    playable !== null &&
    !playable.live &&
    playable.duration != null &&
    playable.duration > 0
      ? `${client.baseUrl}/videos/${encodeURIComponent(playable.id)}/still?t=${Math.round(playable.duration / 2)}`
      : null
  const useMidpoint = midpoint !== null && midpoint !== failedStill
  const poster = useMidpoint ? midpoint : fallbackPoster
  return (
    <>
      {poster != null && (
        <Image
          testID={
            useMidpoint ? 'tv-hero-midpoint-still' : 'tv-hero-fallback-poster'
          }
          source={{
            uri: poster,
            headers:
              useMidpoint && client.token !== undefined
                ? { Authorization: `Bearer ${client.token}` }
                : undefined
          }}
          onError={
            useMidpoint
              ? () => {
                  setFailedStill(midpoint)
                }
              : undefined
          }
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, { width: '100%', height: '100%' }]}
        />
      )}
      {playable !== null && (
        <MidpointPreview
          key={`${playable.id}:${playable.uri}`}
          testID={muted ? 'tv-tile-video' : 'tv-hero-video'}
          uri={playable.uri}
          live={playable.live}
          muted={muted}
          paused={paused}
          onPosition={onPosition}
          onError={() => {
            setFailed(ids => [...ids, playable.id])
          }}
        />
      )}
    </>
  )
}
