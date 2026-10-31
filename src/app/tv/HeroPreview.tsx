import React, { useEffect, useState } from 'react'
import { AppState, Platform, StyleSheet } from 'react-native'
import Video from 'react-native-video'

import type { TeamStationClient, VideoSummary } from '../../common/api'

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
  active
}: {
  client: TeamStationClient
  gameId: string
  active: boolean
}): React.ReactElement | null {
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active'
  )
  const [source, setSource] = useState<{ uri: string; id: string } | null>(null)
  const [failed, setFailed] = useState<string[]>([])
  useEffect(() => {
    const listener = AppState.addEventListener('change', state =>
      setForeground(state === 'active')
    )
    return () => listener.remove()
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
      for (const video of previewCandidates(game.videos)) {
        if (!current) return
        if (failed.includes(video.id)) continue
        try {
          const playback = await client.playback(video.id)
          if (!current) return
          if (playback.url !== null) {
            setSource({ uri: playback.url, id: video.id })
            return
          }
        } catch {
          /* Try the next authorized playable angle. */
        }
      }
    }
    void load().catch(() => {
      /* The poster stays visible. */
    })
    return () => {
      current = false
    }
  }, [client, gameId, active, foreground, failed])
  if (!active || !foreground || source === null) return null
  return (
    <Video
      key={source.id}
      testID="tv-hero-video"
      source={{ uri: source.uri }}
      style={StyleSheet.absoluteFill}
      resizeMode="cover"
      volume={Platform.OS === 'web' ? 60 : 0.6}
      muted={false}
      repeat
      controls={false}
      playInBackground={false}
      playWhenInactive={false}
      onError={() => setFailed(ids => [...ids, source.id])}
    />
  )
}
