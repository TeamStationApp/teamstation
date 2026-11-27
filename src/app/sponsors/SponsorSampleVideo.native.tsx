import React, { useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Video, { type VideoRef } from 'react-native-video'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { OverlayAt } from './OverlayAt'
import type { SponsorSampleVideoProps } from './sponsorViewProps'
import {
  loopSeek,
  overlayOf,
  SAMPLE_FAILED,
  useSponsorSample
} from './useSponsorSample'

export { OverlayAt }

/**
 * The phones' sample video: react-native-video, muted, seeking to the
 * window's start once loaded and back to it at the window's end, with the
 * previews drawn above it. It fills its column, as the phones stack the
 * preview over the controls.
 */
export function SponsorSampleVideo({
  client,
  leagueId,
  children
}: SponsorSampleVideoProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const read = useSponsorSample(client, leagueId)
  const [failed, setFailed] = useState(false)
  const player = useRef<VideoRef>(null)
  const sample = read.kind === 'ready' ? read.sample : null
  const overlay = overlayOf(read)
  return (
    <View testID="sponsor-sample-video" style={styles.frame}>
      {sample != null && !failed && (
        <Video
          key={sample.url}
          ref={player}
          source={{ uri: sample.url }}
          accessibilityLabel="Sample game video"
          muted
          repeat={false}
          resizeMode="cover"
          style={StyleSheet.absoluteFill}
          onLoad={() => {
            player.current?.seek(sample.window[0])
          }}
          onProgress={({ currentTime }) => {
            const seek = loopSeek(currentTime, sample.window)
            if (seek != null) player.current?.seek(seek)
          }}
          onEnd={() => {
            player.current?.seek(sample.window[0])
            player.current?.resume()
          }}
          onError={() => {
            setFailed(true)
          }}
        />
      )}
      {(read.kind === 'failed' || failed) && (
        <View style={styles.panel}>
          <Text style={styles.panelText}>{SAMPLE_FAILED}</Text>
        </View>
      )}
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {typeof children === 'function' ? children(overlay) : children}
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  frame: {
    width: '100%',
    aspectRatio: 16 / 9,
    position: 'relative',
    overflow: 'hidden',
    borderRadius: theme.rem(0.75),
    backgroundColor: '#111'
  },
  panel: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1b1f1a'
  },
  panelText: {
    color: '#f2f2ee',
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  }
}))
