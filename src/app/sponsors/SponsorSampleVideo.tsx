import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { usePaneWidth } from '../components'
import { attachHls } from '../player/attachHls'
import type { VideoHandle } from '../player/videoHandle'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  findSampleRecording,
  loopSeek,
  type SampleClient,
  type SampleRecording,
  sampleWindow
} from './sampleRecording'

/** Below this pane width the sample takes the whole column. */
const FULL_WIDTH_BELOW = 600

export interface SponsorSampleVideoProps {
  client: SampleClient
  leagueId: string
  /** Previews drawn over the video, each placed in its own box. */
  children?: React.ReactNode
  /** Points the element at the playback URL; the player's own by default. */
  attach?: (handle: VideoHandle, url: string) => () => void
  /** Finds the recording; the league's newest home angle by default. */
  find?: (client: SampleClient, leagueId: string) => Promise<SampleRecording>
  /** Fills the box it is in, as beside a side panel. */
  fill?: boolean
}

/**
 * Two minutes of a real recording, muted and looping, for a sponsor's
 * picture to be previewed over: 30:00 to 32:00 of the league's newest
 * home-angle game. The one `<video>` stays mounted while the screen is
 * open, and previews come and go above it, so playback never restarts.
 */
export function SponsorSampleVideo({
  client,
  leagueId,
  children,
  attach = attachHls,
  find = findSampleRecording,
  fill = false
}: SponsorSampleVideoProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const paneWidth = usePaneWidth()
  const [recording, setRecording] = useState<SampleRecording | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  // Read when the league changes or a recording is found, not on every
  // render: a caller's new function must not restart the playback.
  const latest = useRef({ find, attach })
  latest.current = { find, attach }

  useEffect(() => {
    let live = true
    setRecording(null)
    latest.current
      .find(client, leagueId)
      .then(found => {
        if (live) setRecording(found)
      })
      .catch(() => {
        if (live) setRecording({ kind: 'none' })
      })
    return () => {
      live = false
    }
  }, [client, leagueId])

  const found = recording?.kind === 'found' ? recording : null
  const url = found?.url
  const durationSec = found?.durationSec
  useEffect(() => {
    const element = video.current
    if (element == null || url == null || durationSec == null) return
    const window = sampleWindow(durationSec)
    const start = (): void => {
      element.currentTime = window[0]
    }
    const tick = (): void => {
      const seek = loopSeek(element.currentTime, window)
      if (seek != null) element.currentTime = seek
    }
    element.addEventListener('loadedmetadata', start)
    element.addEventListener('timeupdate', tick)
    const detach = latest.current.attach(element, url)
    return () => {
      element.removeEventListener('loadedmetadata', start)
      element.removeEventListener('timeupdate', tick)
      detach()
    }
  }, [url, durationSec])

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
      {found != null ? (
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
      ) : (
        <View style={styles.panel}>
          <Text style={styles.panelText}>
            {recording == null
              ? 'Finding a recording…'
              : 'No recording to preview'}
          </Text>
        </View>
      )}
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {children}
      </View>
    </View>
  )
}

/** Draws `children` in `box`, given as fractions of the sample's frame. */
export function OverlayAt({
  box,
  children,
  testID
}: {
  box: { x: number; y: number; width: number; height: number }
  children: React.ReactNode
  testID?: string
}): React.ReactElement {
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`
      }}
    >
      {children}
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
