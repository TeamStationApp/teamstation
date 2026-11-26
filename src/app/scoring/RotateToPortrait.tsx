import React, { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Text, View, type ViewStyle } from 'react-native'

import { glassStyle } from '../field/useFieldSurface'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'

/** The plan's side-column height: a window shorter than this has no column. */
const SIDE_MIN_HEIGHT = 640
/** A device whose shortest screen side is under this is a phone. */
const PHONE_MAX_SHORT_SIDE = 600

/**
 * A phone held sideways: the window is wider than tall and too short for
 * the side column, on a screen whose shortest side is a phone's. A desktop
 * window that short is on a large screen, and a tablet's screen is not a
 * phone's, so neither is one.
 */
export function phoneLandscape(
  window: { width: number; height: number },
  screen: { width: number; height: number }
): boolean {
  return (
    window.width > window.height &&
    window.height < SIDE_MIN_HEIGHT &&
    Math.min(screen.width, screen.height) < PHONE_MAX_SHORT_SIDE
  )
}

function readPhoneLandscape(): boolean {
  return phoneLandscape(
    { width: window.innerWidth, height: window.innerHeight },
    { width: window.screen.width, height: window.screen.height }
  )
}

/** Whether this browser window is a phone held sideways, kept current. */
export function usePhoneLandscape(): boolean {
  const [sideways, setSideways] = useState(readPhoneLandscape)
  useLayoutEffect(() => {
    const read = (): void => {
      setSideways(readPhoneLandscape())
    }
    read()
    window.addEventListener('resize', read)
    window.addEventListener('orientationchange', read)
    return () => {
      window.removeEventListener('resize', read)
      window.removeEventListener('orientationchange', read)
    }
  }, [])
  return sideways
}

/** Fixed over the whole page, above every sheet, blurring what is under it. */
function cover(backgroundColor: string): ViewStyle {
  return {
    position: 'fixed',
    inset: 0,
    zIndex: 2147483000,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor,
    touchAction: 'none',
    ...glassStyle
  } as unknown as ViewStyle
}

/**
 * On the web a page cannot lock its rotation (Safari has no
 * `screen.orientation.lock`, and Chrome allows it only in fullscreen). A
 * phone held sideways gets a blurred cover over everything, sheets included,
 * that takes every touch and click until it is turned upright again. The
 * scoring screen under it is left as it is.
 */
export function RotateToPortrait(): React.ReactElement | null {
  const theme = useTheme()
  const sideways = usePhoneLandscape()
  if (!sideways) return null
  const stop = (event: { stopPropagation: () => void }): void => {
    event.stopPropagation()
  }
  return createPortal(
    <View
      testID="rotate-to-portrait"
      aria-modal
      role="dialog"
      accessibilityLiveRegion="assertive"
      onStartShouldSetResponder={() => true}
      onResponderGrant={stop}
      style={cover(theme.overlayBackgroundColor)}
    >
      {/* An opaque card: the blurred screen under the cover is dark in
          places and light in others, so text drawn straight on it is
          unreadable somewhere in every theme. */}
      <View
        testID="rotate-to-portrait-card"
        style={{
          backgroundColor: theme.backgroundColor,
          borderRadius: theme.rem(theme.radiusRem),
          paddingHorizontal: 24,
          paddingVertical: 16,
          maxWidth: 420
        }}
      >
        <Text
          accessibilityRole="alert"
          style={{
            color: theme.primaryTextColor,
            fontFamily: theme.boldTextFont,
            fontSize: 22,
            textAlign: 'center'
          }}
        >
          {lstrings.scoring_rotate_to_portrait}
        </Text>
      </View>
    </View>,
    document.body
  )
}
