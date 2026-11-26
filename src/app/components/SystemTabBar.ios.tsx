import React from 'react'
import { View } from 'react-native'

import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import type { AppNavProps } from './AppNav'
import { floatingNavBottom } from './navClearance'
import { NAV_BOTTOM_GAP, NAV_NATIVE_HEIGHT_ABOVE_INSET } from './navGeometry'
import { NAV_TABS, type NavTabId, navTabId } from './tabBarModel'
import TSTabBar from './TSTabBarNativeComponent'

const symbols: Record<NavTabId, readonly [string, string]> = {
  home: ['house', 'house.fill'],
  videos: ['play.rectangle', 'play.rectangle.fill'],
  schedule: ['calendar', 'calendar'],
  search: ['magnifyingglass', 'magnifyingglass'],
  chat: ['bubble.left', 'bubble.left.fill']
}

export function SystemTabBar(
  props: AppNavProps & { reduced?: boolean }
): React.ReactElement {
  const theme = useTheme()
  const { bottom } = useInsets()
  // The banner stops at the safe area. UIKit's floating material normally
  // extends below that edge, so lift that part clear when the banner appears.
  const banner = props.bannerHeight ?? 0
  const materialGap = floatingNavBottom('ios', NAV_BOTTOM_GAP, bottom)
  const raisedBottom =
    floatingNavBottom('ios', NAV_BOTTOM_GAP, bottom, banner) - materialGap
  return (
    <View
      pointerEvents="box-none"
      accessibilityRole="tablist"
      style={{
        position: 'absolute',
        bottom: raisedBottom,
        left: 0,
        right: 0,
        height: NAV_NATIVE_HEIGHT_ABOVE_INSET + bottom,
        zIndex: 5
      }}
    >
      <TSTabBar
        style={{ flex: 1 }}
        selectedId={props.selected}
        items={NAV_TABS.map(({ id, label }) => ({
          id,
          title: label,
          symbol: symbols[id][0],
          selectedSymbol: symbols[id][1],
          badge: props.dots?.[id] === true,
          testID: navTabId(id)
        }))}
        activeColor={
          props.reduced === true
            ? theme.navOpaqueActiveColor
            : theme.navActiveColor
        }
        inactiveColor={
          props.reduced === true
            ? theme.navOpaqueInactiveColor
            : theme.navInactiveColor
        }
        opaqueBackgroundColor={
          props.reduced === true ? theme.navOpaqueBackgroundColor : undefined
        }
        badgeColor={theme.liveColor}
        dark={theme.isDark}
        compact={false}
        onSelectTab={({ nativeEvent: { id } }) => {
          const tab = NAV_TABS.find(tab => tab.id === id)
          if (tab != null) props.onSelect(tab.id)
        }}
        onBarHeight={({ nativeEvent: { height } }) => {
          // All renderers report the expanded material, excluding the space below it.
          props.onHeight?.(Math.max(0, height - materialGap))
        }}
      />
    </View>
  )
}
