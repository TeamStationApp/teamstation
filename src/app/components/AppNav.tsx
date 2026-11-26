import React from 'react'
import { Platform, Pressable, View } from 'react-native'

import { useChatVisualViewport } from '../chat/useChatVisualViewport'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AppNavCapsule } from './AppNavCapsule'
import { ButtonIcon } from './ButtonIcon'
import { GlassView } from './GlassView'
import type { IconName } from './Icon'
import { floatingNavBottom } from './navClearance'
import { useNavCompact } from './navCompact'
import { NAV_BOTTOM_GAP, NAV_HEIGHT } from './navGeometry'
import { supportsSystemTabBar } from './supportsSystemTabBar'
import { SystemTabBar } from './SystemTabBar'
import { NAV_TABS, type NavTabId, navTabId } from './tabBarModel'
import { useNavTransparency } from './useNavTransparency'

export { NAV_TABS, type NavTabId } from './tabBarModel'
export interface NavTab {
  id: NavTabId
  label: string
  icon: IconName
}
export type NavMode = 'floating' | 'header'
export const FLOATING_BOTTOM_REM = NAV_BOTTOM_GAP / 16
export const FLOATING_HEIGHT_REM = NAV_HEIGHT / 16
export const NAV_CLEARANCE_REM = FLOATING_BOTTOM_REM + FLOATING_HEIGHT_REM + 2

export interface AppNavProps {
  selected: NavTabId
  onSelect: (id: NavTabId) => void
  /** A capsule floating over the content, or a row inside the header. */
  mode: NavMode
  /** Chat can be opened on an entity page's navigation stack. */
  chatActive?: boolean
  /** Tabs with something unread, which carry a dot. */
  dots?: Partial<Record<NavTabId, boolean>>
  onHeight?: (height: number) => void
  /**
   * The offline banner's height while it shows. It sits on the bottom inset,
   * and the capsule sits on it.
   */
  bannerHeight?: number
}

export function AppNav(props: AppNavProps): React.ReactElement {
  const { selected, onSelect, mode, dots } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const compact = useNavCompact()
  const reduced = useNavTransparency()
  const floating = mode === 'floating'
  const visual = useChatVisualViewport(
    Platform.OS === 'web' &&
      floating &&
      (props.chatActive ?? selected === 'chat')
  )
  const insets = useInsets()
  if (floating) {
    if (visual?.keyboardOpen === true) return <></>
    if (supportsSystemTabBar())
      return <SystemTabBar {...props} reduced={reduced} compact={compact} />
    const bottom = floatingNavBottom(
      Platform.OS,
      NAV_BOTTOM_GAP,
      insets.bottom,
      props.bannerHeight
    )
    return (
      <AppNavCapsule
        {...props}
        reduced={reduced}
        bottom={bottom}
        compact={compact}
      />
    )
  }
  const Surface = reduced ? View : GlassView
  return (
    <Surface
      accessibilityRole="tablist"
      {...(reduced ? {} : { radius: theme.rem(1.25), fallbackFill: false })}
      onLayout={event => props.onHeight?.(event.nativeEvent.layout.height)}
      style={[
        styles.header,
        reduced && { backgroundColor: theme.navOpaqueBackgroundColor }
      ]}
    >
      {NAV_TABS.map(tab => {
        const active = tab.id === selected
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: active }}
            aria-selected={active}
            testID={navTabId(tab.id)}
            onPress={() => {
              onSelect(tab.id)
            }}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            <View
              style={[
                styles.disc,
                active && {
                  backgroundColor: reduced
                    ? theme.navOpaqueSelectedColor
                    : theme.containerBackgroundColor
                }
              ]}
            >
              <ButtonIcon
                name={tab.icon}
                color={
                  reduced
                    ? active
                      ? theme.navOpaqueActiveColor
                      : theme.navOpaqueInactiveColor
                    : active
                      ? theme.navActiveColor
                      : theme.navInactiveColor
                }
              />
            </View>
            {dots?.[tab.id] === true && (
              <View testID={tab.id + '-unread'} style={styles.dot} />
            )}
          </Pressable>
        )
      })}
    </Surface>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem),
    borderRadius: theme.rem(1.25),
    overflow: 'hidden',
    ...Platform.select({
      ios: { paddingHorizontal: theme.rem(theme.spaceXsRem) }
    })
  },
  item: {
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center'
  },
  disc: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(1),
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { opacity: 0.6 },
  dot: {
    position: 'absolute',
    top: theme.rem(0.375),
    right: theme.rem(0.375),
    width: theme.rem(0.5),
    height: theme.rem(0.5),
    borderRadius: theme.rem(0.25),
    backgroundColor: theme.liveColor
  }
}))
