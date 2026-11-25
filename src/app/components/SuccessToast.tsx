import React, { useEffect, useRef, useState } from 'react'
import { Animated, Platform, Text, View } from 'react-native'

import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { FLOATING_BOTTOM_REM, FLOATING_HEIGHT_REM } from './AppNav'
import { GlassView } from './GlassView'
import { navContentBottom } from './navClearance'
import { useBreakpoint } from './useBreakpoint'
import { useMotionPreference } from './useMotionPreference'

export interface SuccessNotice {
  id: number
  message: string
}

/** Shell-level confirmation survives the screen that submitted the change. */
export function SuccessToast({
  notice,
  bannerHeight = 0,
  navigationHeight
}: {
  notice?: SuccessNotice
  navigationHeight?: number
  /** The offline banner's height while it shows: the toast rides above it. */
  bannerHeight?: number
}): React.ReactElement | null {
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const phone = useBreakpoint() === 'phone'
  const [visible, setVisible] = useState(false)
  const opacity = useRef(new Animated.Value(0)).current
  const reduced = useMotionPreference()
  const reducedMotion = useRef(reduced)
  useEffect(() => {
    reducedMotion.current = reduced
  }, [reduced])
  useEffect(() => {
    if (notice == null) {
      setVisible(false)
      opacity.setValue(0)
      return
    }
    setVisible(true)
    Animated.timing(opacity, {
      toValue: 1,
      duration: reducedMotion.current ? 90 : 160,
      useNativeDriver: Platform.OS !== 'web'
    }).start()
    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: reducedMotion.current ? 90 : 250,
        useNativeDriver: Platform.OS !== 'web'
      }).start(({ finished }) => {
        if (finished) setVisible(false)
      })
    }, 5000)
    return () => {
      clearTimeout(timer)
      opacity.stopAnimation()
    }
  }, [notice, opacity])
  if (!visible || notice == null) return null
  return (
    <Animated.View
      dataSet={
        Platform.OS === 'web' ? { offlineBannerDock: 'true' } : undefined
      }
      pointerEvents="none"
      style={[
        styles.position,
        {
          opacity,
          bottom: phone
            ? (navigationHeight ?? theme.rem(FLOATING_HEIGHT_REM)) +
              navContentBottom(
                Platform.OS,
                theme.rem(FLOATING_BOTTOM_REM),
                insets.bottom,
                bannerHeight
              ) +
              theme.rem(1)
            : insets.bottom + bannerHeight + theme.rem(2)
        }
      ]}
    >
      <GlassView radius={theme.rem(2)} androidBlur style={styles.glass}>
        <View style={styles.tint}>
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
            style={styles.text}
          >
            {notice.message}
          </Text>
        </View>
      </GlassView>
    </Animated.View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  position: {
    position: 'absolute',
    left: theme.rem(1),
    right: theme.rem(1),
    alignItems: 'center',
    zIndex: 100
  },
  glass: {
    borderRadius: theme.rem(2),
    overflow: 'hidden',
    maxWidth: theme.rem(32)
  },
  tint: {
    backgroundColor: 'rgba(23, 105, 210, 0.82)',
    borderWidth: 1,
    borderColor: 'rgba(180, 214, 255, 0.65)',
    borderRadius: theme.rem(2),
    paddingHorizontal: theme.rem(1.5),
    paddingVertical: theme.rem(0.8)
  },
  text: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    textAlign: 'center'
  }
}))
