import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native'
import Video from 'react-native-video'

import type { TeamStationClient, VideoSummary } from '../../common/api'
import { tvControl } from './remote'
import type { TvPlayRequest } from './TvBrowser'
import { TvButton } from './TvButton'

interface Angle {
  video: VideoSummary
  uri: string
}
export function TvPlayer({
  client,
  request,
  onClose
}: {
  client: TeamStationClient
  request: TvPlayRequest
  onClose: () => void
}): React.ReactElement {
  useEffect(() => {
    tvControl?.enableTVMenuKey()
    return () => tvControl?.disableTVMenuKey()
  }, [])
  const [angles, setAngles] = useState<Angle[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [full, setFull] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setError(null)
    const load = async (): Promise<void> => {
      const game = await client.game(request.game.id)
      const videos = game.videos
        .filter(
          video =>
            video.numCameras <= 1 &&
            (video.status === 'ready' || video.status === 'live')
        )
        .slice(0, 4)
      const loaded = await Promise.all(
        videos.map(async video => ({
          video,
          playback: await client.playback(video.id)
        }))
      )
      if (loaded.some(angle => angle.playback.url === null))
        throw new Error(
          'This game is still preparing its video. Please try again.'
        )
      if (loaded.length === 0)
        throw new Error('No camera angles are available for this game.')
      if (current)
        setAngles(
          loaded.map(({ video, playback }) => ({ video, uri: playback.url! }))
        )
    }
    load().catch((reason: unknown) => {
      if (current)
        setError(
          reason instanceof Error ? reason.message : 'This game could not open.'
        )
    })
    return () => {
      current = false
    }
  }, [client, request, retry])
  const back = useCallback((): void => {
    if (full !== null) setFull(null)
    else onClose()
  }, [full, onClose])
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        back()
        return true
      }
    )
    return () => {
      subscription.remove()
    }
  }, [back])
  const sources = useMemo(
    () => angles?.map(angle => ({ uri: angle.uri })) ?? [],
    [angles]
  )
  return (
    <View testID="tv-player" style={styles.scene}>
      {angles?.map((angle, index) => {
        const expanded = full === angle.video.id || angles.length === 1
        return (
          <Pressable
            key={angle.video.id}
            accessibilityRole="button"
            accessibilityLabel={`Camera ${angle.video.title}`}
            onFocus={() => {
              setFocus(angle.video.id)
            }}
            onBlur={() => {
              setFocus(null)
            }}
            onPress={() => {
              if (angles.length > 1) setFull(angle.video.id)
            }}
            style={{
              position: 'absolute',
              left: expanded ? '0%' : `${(index % 2) * 50}%`,
              top: expanded
                ? '0%'
                : angles.length === 2
                  ? '25%'
                  : `${Math.floor(index / 2) * 50}%`,
              width: expanded ? '100%' : '50%',
              height: expanded ? '100%' : '50%',
              zIndex: expanded ? 2 : 1,
              borderWidth: focus === angle.video.id ? 4 : 0,
              borderColor: '#fff'
            }}
          >
            <Video
              source={sources[index]}
              style={StyleSheet.absoluteFill}
              muted={index !== 0}
              resizeMode="contain"
              onError={() => {
                setError(
                  `The ${angle.video.title} camera could not play. Try again.`
                )
              }}
            />
          </Pressable>
        )
      })}
      {angles === null && error === null && (
        <Text style={styles.copy}>Opening game…</Text>
      )}
      {error !== null && (
        <View style={styles.error}>
          <Text style={styles.copy}>{error}</Text>
          <TvButton
            label="Retry video"
            onPress={() => {
              setAngles(null)
              setRetry(n => n + 1)
            }}
          />
        </View>
      )}
      <View style={styles.back}>
        <TvButton
          label={full !== null ? 'Back to cameras' : 'Back to games'}
          onPress={back}
        />
      </View>
    </View>
  )
}
const styles = StyleSheet.create({
  scene: {
    flex: 1,
    width: '100%',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center'
  },
  copy: { color: '#fff', fontSize: 28 },
  error: {
    zIndex: 4,
    backgroundColor: '#252525',
    padding: 40,
    gap: 24,
    borderRadius: 24
  },
  back: { position: 'absolute', top: 30, left: 40, zIndex: 3 }
})
