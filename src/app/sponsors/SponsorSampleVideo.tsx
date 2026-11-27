import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { usePaneWidth } from '../components'
import { attachHls } from '../player/attachHls'
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

/** Below this pane width the sample takes the whole column. */
const FULL_WIDTH_BELOW = 600

export type { SponsorSampleVideoProps }

/**
 * Two minutes of real video, muted and looping, for a sponsor's picture to
 * be previewed over: the window of the league's own recording the server
 * chose, or the node's sample clip. The one `<video>` stays mounted while
 * the screen is open, and previews come and go above it, so playback never
 * restarts. The phones play it with react-native-video
 * (SponsorSampleVideo.native.tsx).
 */
export function SponsorSampleVideo({
  client,
  leagueId,
  children,
  attach = attachHls,
  fill = false
}: SponsorSampleVideoProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const paneWidth = usePaneWidth()
  const read = useSponsorSample(client, leagueId)
  const [failed, setFailed] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  // Read when the sample changes, not on every render: a caller's new
  // function must not restart the playback.
  const latest = useRef(attach)
  latest.current = attach

  const sample = read.kind === 'ready' ? read.sample : null
  const url = sample?.url
  const kind = sample?.kind
  const start = sample?.window[0]
  const end = sample?.window[1]
  useEffect(() => {
    setFailed(false)
    const element = video.current
    if (element == null || url == null || start == null || end == null) return
    const window: [number, number] = [start, end]
    const begin = (): void => {
      element.currentTime = window[0]
    }
    const tick = (): void => {
      const seek = loopSeek(element.currentTime, window)
      if (seek != null) element.currentTime = seek
    }
    const fail = (): void => {
      setFailed(true)
    }
    element.addEventListener('loadedmetadata', begin)
    element.addEventListener('timeupdate', tick)
    element.addEventListener('error', fail)
    // A recording plays through the player's HLS; the node's clip is a file.
    let detach = (): void => undefined
    if (kind === 'recording') detach = latest.current(element, url)
    else element.src = url
    return () => {
      element.removeEventListener('loadedmetadata', begin)
      element.removeEventListener('timeupdate', tick)
      element.removeEventListener('error', fail)
      detach()
      element.removeAttribute('src')
    }
  }, [url, kind, start, end])

  const overlay = overlayOf(read)
  return (
    <View
      testID="sponsor-sample-video"
      style={[
        styles.frame,
        {
          width:
            fill || (paneWidth > 0 && paneWidth < FULL_WIDTH_BELOW)
              ? '100%'
              : '50%'
        }
      ]}
    >
      {sample != null && (
        <video
          ref={video}
          muted
          autoPlay
          playsInline
          disablePictureInPicture
          aria-label="Sample game video"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            background: '#000'
          }}
        />
      )}
      {/* While the sample is read the frame stays dark: no placeholder. */}
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
    aspectRatio: 16 / 9,
    maxWidth: '100%',
    position: 'relative',
    overflow: 'hidden',
    borderRadius: theme.rem(0.75),
    backgroundColor: '#111'
  },
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
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
