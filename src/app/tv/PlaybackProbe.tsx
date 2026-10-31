import React, { useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Video from 'react-native-video'

import { TvButton } from './TvButton'

/** Development-only fixture: native players remain mounted while layout changes. */
export function PlaybackProbe({
  urls
}: {
  urls: string[]
}): React.ReactElement {
  const sources = useMemo(() => urls.slice(0, 4).map(uri => ({ uri })), [urls])
  const [hidden, setHidden] = useState(false)
  const [large, setLarge] = useState(false)
  const [clocks, setClocks] = useState<number[]>([])
  const [errors, setErrors] = useState<string[]>([])
  return (
    <View style={{ flex: 1, width: '100%', gap: 20 }}>
      <Text style={{ color: '#fff', fontSize: 30 }}>Playback verification</Text>
      <View style={{ flex: 1 }}>
        {sources.map((source, index) => (
          <View
            key={source.uri}
            style={{
              position: 'absolute',
              left: large && index === 0 ? '0%' : `${(index % 2) * 50}%`,
              top:
                large && index === 0 ? '0%' : `${Math.floor(index / 2) * 50}%`,
              width: large && index === 0 ? '100%' : '50%',
              height: large && index === 0 ? '100%' : '50%',
              zIndex: large && index === 0 ? 2 : 1,
              opacity: hidden && index === 1 ? 0 : 1
            }}
          >
            <Video
              source={source}
              style={StyleSheet.absoluteFill}
              muted={index !== 0}
              repeat
              resizeMode="contain"
              progressUpdateInterval={500}
              onProgress={({ currentTime }) => {
                setClocks(old => {
                  const next = [...old]
                  next[index] = currentTime
                  return next
                })
              }}
              onError={() => {
                setErrors(old => [...old, `Angle ${index + 1} failed`])
              }}
            />
          </View>
        ))}
      </View>
      <Text testID="probe-clocks" style={{ color: '#fff', fontSize: 22 }}>
        {sources
          .map(
            (_, index) =>
              `Angle ${index + 1}: ${(clocks[index] ?? 0).toFixed(1)}`
          )
          .join(' • ')}
      </Text>
      {errors.map((error, index) => (
        <Text key={index} style={{ color: '#fff' }}>
          {error}
        </Text>
      ))}
      <View style={{ flexDirection: 'row', gap: 25 }}>
        <TvButton
          label={hidden ? 'Restore angle 2' : 'Hide angle 2'}
          onPress={() => {
            setHidden(!hidden)
          }}
        />
        <TvButton
          label={large ? 'Collapse angle 1' : 'Enlarge angle 1'}
          onPress={() => {
            setLarge(!large)
          }}
        />
      </View>
    </View>
  )
}
