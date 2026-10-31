import React, { useEffect, useState } from 'react'
import { AppState } from 'react-native'

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
  videoId,
  onPosition
}: {
  client: TeamStationClient
  gameId: string
  active: boolean
  muted?: boolean
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
    owner: string
  } | null>(null)
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
  }, [gameId, client])
  useEffect(() => {
    let current = true
    setSource(null)
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
              owner: `${gameId}:${videoId ?? ''}`
            })
            return
          }
        } catch {
          /* Try the next authorized playable angle. */
        }
      }
    }
    load().catch(() => {
      /* The poster stays visible. */
    })
    return () => {
      current = false
    }
  }, [client, gameId, videoId, active, foreground, failed])
  if (!active || !foreground || source?.owner !== `${gameId}:${videoId ?? ''}`)
    return null
  return (
    <MidpointPreview
      key={`${source.id}:${source.uri}`}
      testID={muted ? 'tv-tile-video' : 'tv-hero-video'}
      uri={source.uri}
      live={source.live}
      muted={muted}
      onPosition={onPosition}
      onError={() => {
        setFailed(ids => [...ids, source.id])
      }}
    />
  )
}
