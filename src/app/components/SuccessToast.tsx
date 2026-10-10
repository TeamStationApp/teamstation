import React, { useEffect, useRef, useState } from 'react'
import { Animated, Platform, Text, View } from 'react-native'

import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { NAV_CLEARANCE_REM } from './AppNav'
import { GlassView } from './GlassView'
import { useBreakpoint } from './useBreakpoint'

export interface SuccessNotice {
  id: number
  message: string
}

/** Shell-level confirmation survives the screen that submitted the change. */
export function SuccessToast({
  notice
}: {
  notice?: SuccessNotice
}): React.ReactElement | null {
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const phone = useBreakpoint() === 'phone'
  const [visible, setVisible] = useState(false)
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (notice == null) {
      setVisible(false)
      return
    }
    setVisible(true)
    opacity.setValue(1)
    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 250,
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
      pointerEvents="none"
      style={[
        styles.position,
        {
          opacity,
          bottom: insets.bottom + theme.rem(phone ? NAV_CLEARANCE_REM - 1 : 2)
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
