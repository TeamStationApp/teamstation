import React, { useEffect, useRef } from 'react'
import {
  I18nManager,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, {
  FadeIn,
  FadeOut,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue
} from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'

import { lightHaptic } from '../scoring/lightHaptic'
import { elevationFor } from '../theme/elevation'
import { useTheme } from '../theme/ThemeContext'
import type { AppNavProps } from './AppNav'
import { capsuleMotion } from './capsuleMotion'
import { GlassView } from './GlassView'
import {
  NAV_COMPACT_HEIGHT,
  NAV_COMPACT_WIDTH,
  NAV_HEIGHT,
  NAV_PILL_PAD,
  NAV_SIDE_INSET
} from './navGeometry'
import {
  capsuleLabels,
  highlightWidth,
  NAV_TABS,
  type NavTabId,
  navTabId,
  pillFrame,
  tabContentOffset
} from './tabBarModel'
import { TAB_GLYPH_VIEW_BOX, TAB_GLYPHS } from './tabGlyphs'
import { useCapsuleDrag } from './useCapsuleDrag'
import { useMotionPreference } from './useMotionPreference'

/**
 * The highlight of the bar on screen. Moving between a signed-out screen and
 * Search (or any public page) swaps the screen tree, and the bar with it. The
 * new bar starts its highlight where the old one's is at that moment, which
 * may be partway to the next tab, and slides on to its own.
 */
let current: SharedValue<number> | undefined

export function AppNavCapsule(
  props: AppNavProps & { bottom: number; reduced: boolean; compact: boolean }
): React.ReactElement {
  const { selected, onSelect, dots, bottom, compact, reduced, onHeight } = props
  const theme = useTheme()
  const reducedMotion = useMotionPreference(true)
  const window = useWindowDimensions()
  const expandedWidth = Math.max(0, window.width - 2 * NAV_SIDE_INSET)
  const width = compact
    ? Math.min(expandedWidth, NAV_COMPACT_WIDTH)
    : expandedWidth
  const height = compact ? NAV_COMPACT_HEIGHT : NAV_HEIGHT
  const labels = capsuleLabels(
    expandedWidth,
    NAV_HEIGHT - 2 * NAV_PILL_PAD,
    window.fontScale
  )
  const separate = !compact && labels.separate
  const pillBottom = separate
    ? labels.lineHeight + 2 * NAV_PILL_PAD
    : NAV_PILL_PAD
  const pillRadius = (height - NAV_PILL_PAD - pillBottom) / 2
  const labelSpace = compact ? 0 : labels.lineHeight
  const maxIconSize = Math.max(
    0,
    Math.min(
      width / NAV_TABS.length - 2 * NAV_PILL_PAD,
      height - 2 * NAV_PILL_PAD - labelSpace - (separate ? NAV_PILL_PAD : 0)
    )
  )
  const rtl = I18nManager.isRTL
  const bounds = useRef({ width, height, count: NAV_TABS.length, rtl })
  const row = useRef<React.ComponentRef<typeof View>>(null)
  const initialIndex = NAV_TABS.findIndex(tab => tab.id === selected)
  const { dragged, press, gesture } = useCapsuleDrag(
    bounds,
    initialIndex,
    onSelect,
    () => {
      if (Platform.OS !== 'web') lightHaptic(row.current)
    }
  )
  const index = dragged ?? initialIndex
  const animatedIndex = useSharedValue(current?.value ?? index)
  const scale = useSharedValue(1)
  const shellWidth = useSharedValue(width)
  const shellHeight = useSharedValue(height)
  // A label on its own row leaves the highlight to its equal slot. The width
  // eases with the shell, so it shrinks or grows steadily through a resize
  // even where UIKit's rule would jump between its two spacings.
  const highlightTarget = separate
    ? Math.max(0, width / NAV_TABS.length - 2 * NAV_PILL_PAD)
    : highlightWidth(width, NAV_TABS.length, NAV_PILL_PAD)
  const highlight = useSharedValue(highlightTarget)
  useEffect(() => {
    shellWidth.value = capsuleMotion(width, reducedMotion)
    shellHeight.value = capsuleMotion(height, reducedMotion)
    highlight.value = capsuleMotion(highlightTarget, reducedMotion)
  }, [
    height,
    width,
    highlightTarget,
    reducedMotion,
    shellHeight,
    shellWidth,
    highlight
  ])
  const shellStyle = useAnimatedStyle(() => ({
    width: shellWidth.value,
    height: shellHeight.value
  }))
  useEffect(() => {
    current = animatedIndex
    return () => {
      if (current === animatedIndex) current = undefined
    }
  }, [animatedIndex])
  useEffect(() => {
    animatedIndex.value = capsuleMotion(index, reducedMotion)
    const magnification = dragged == null || reducedMotion ? 1 : 1.18
    scale.value = capsuleMotion(magnification, reducedMotion)
  }, [index, reducedMotion, dragged, animatedIndex, scale])
  const animated = useAnimatedStyle(() => {
    const frame = pillFrame(
      animatedIndex.value,
      shellWidth.value,
      highlight.value,
      NAV_TABS.length,
      NAV_PILL_PAD,
      rtl
    )
    return {
      width: frame.width,
      transform: [{ translateX: frame.x }, { scale: scale.value }]
    }
  })
  const pan = usePanGesture({
    runOnJS: true,
    minDistance: 4,
    shouldCancelWhenOutside: false,
    onTouchesDown: gesture.onTouchesDown,
    onActivate: gesture.onActivate,
    onUpdate: gesture.onUpdate,
    onDeactivate: gesture.onDeactivate,
    onFinalize: gesture.onFinalize
  })
  const Surface = reduced ? View : GlassView
  // Only iOS draws real glass. Elsewhere glass over the glass platter is all
  // but invisible, so the highlight is a filled capsule, as UIKit's looks.
  const PillSurface = reduced || Platform.OS !== 'ios' ? View : GlassView
  // Android draws an elevation shadow only for a view with a fill, and paints
  // an elevated child over its later siblings, so there the shell carries the
  // platter's fill and its shadow and the platter inside keeps the hairline.
  const android = Platform.OS === 'android'
  return (
    <View
      pointerEvents="box-none"
      testID="tab-bar-capsule"
      accessibilityRole="tablist"
      onLayout={event => onHeight?.(event.nativeEvent.layout.height)}
      style={{
        position: 'absolute',
        bottom,
        left: 0,
        right: 0,
        alignItems: 'center',
        justifyContent: 'flex-end',
        height: NAV_HEIGHT,
        zIndex: 5,
        elevation: elevationFor(12)
      }}
    >
      <GestureDetector gesture={pan}>
        <Animated.View
          ref={row}
          onLayout={event => {
            const layout = event.nativeEvent.layout
            bounds.current = {
              width: layout.width,
              height: layout.height,
              count: NAV_TABS.length,
              rtl
            }
          }}
          style={[
            { justifyContent: 'center' },
            android && {
              borderRadius: height / 2,
              backgroundColor: reduced
                ? theme.navOpaqueBackgroundColor
                : theme.glassFallbackColor,
              elevation: elevationFor(12)
            },
            shellStyle
          ]}
        >
          <Surface
            testID="tab-bar-platter"
            {...(reduced
              ? {}
              : {
                  clear: true,
                  interactive: true,
                  radius: height / 2,
                  fallbackFill: !android
                })}
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: height / 2,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.glassBorderColor
              },
              // The system material draws its own shadow on iOS.
              Platform.OS === 'web' && {
                boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.18)'
              },
              reduced && { backgroundColor: theme.navOpaqueBackgroundColor }
            ]}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                start: 0,
                top: NAV_PILL_PAD,
                bottom: pillBottom
              },
              animated
            ]}
          >
            <PillSurface
              testID="tab-bar-pill"
              {...(PillSurface === GlassView && {
                interactive: true,
                fallbackFill: false,
                radius: pillRadius
              })}
              style={[
                StyleSheet.absoluteFill,
                {
                  borderRadius: pillRadius,
                  backgroundColor: reduced
                    ? theme.navOpaqueSelectedColor
                    : theme.navSelectedColor
                }
              ]}
            />
          </Animated.View>
          <View style={{ flex: 1, flexDirection: 'row' }}>
            {NAV_TABS.map((tab, tabIndex) => (
              <CapsuleTab
                key={tab.id}
                tab={tab}
                index={tabIndex}
                active={selected === tab.id}
                dot={dots?.[tab.id] === true}
                reduced={reduced}
                compact={compact}
                separate={separate}
                labels={labels}
                pillBottom={pillBottom}
                maxIconSize={maxIconSize}
                reducedMotion={reducedMotion}
                shellWidth={shellWidth}
                highlight={highlight}
                rtl={rtl}
                onPress={press}
              />
            ))}
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  )
}

/** One tab, its icon and inline label centred on its highlight as UIKit centres them. */
function CapsuleTab(props: {
  tab: (typeof NAV_TABS)[number]
  index: number
  active: boolean
  dot: boolean
  reduced: boolean
  compact: boolean
  separate: boolean
  labels: { points: number; lineHeight: number }
  pillBottom: number
  maxIconSize: number
  reducedMotion: boolean
  shellWidth: SharedValue<number>
  highlight: SharedValue<number>
  rtl: boolean
  onPress: (id: NavTabId) => void
}): React.ReactElement {
  const { tab, index, active, reduced, compact, separate, labels } = props
  const { shellWidth, highlight, rtl, reducedMotion } = props
  const theme = useTheme()
  const offset = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: tabContentOffset(
          index,
          shellWidth.value,
          highlight.value,
          NAV_TABS.length,
          NAV_PILL_PAD,
          rtl
        )
      }
    ]
  }))
  const color = reduced
    ? active
      ? theme.navOpaqueActiveColor
      : theme.navOpaqueInactiveColor
    : active
      ? theme.navTabActiveColor
      : theme.navTabInactiveColor
  const slot = {
    paddingTop: separate ? NAV_PILL_PAD : 0,
    paddingBottom: separate ? props.pillBottom : 0,
    alignItems: 'center',
    justifyContent: 'center'
  } as const
  const glyph = useGlyphPoints(props.maxIconSize)
  return (
    <>
      <Pressable
        testID={navTabId(tab.id)}
        accessibilityRole="tab"
        accessibilityLabel={tab.label}
        accessibilityState={{ selected: active }}
        accessibilityValue={props.dot ? { text: UNREAD } : undefined}
        aria-selected={active}
        aria-valuetext={props.dot ? UNREAD : undefined}
        onPress={() => {
          props.onPress(tab.id)
        }}
        style={{ flex: 1, minHeight: 44, ...slot }}
      >
        <Animated.View style={offset}>
          <TabGlyph
            d={TAB_GLYPHS[tab.id][active ? 'filled' : 'outlined']}
            points={glyph}
            color={color}
          />
        </Animated.View>
        {!compact && (
          <Animated.Text
            entering={reducedMotion ? undefined : FadeIn.duration(160)}
            exiting={reducedMotion ? undefined : FadeOut.duration(120)}
            allowFontScaling={false}
            numberOfLines={1}
            style={[
              {
                color,
                // The shared layout already applies the user's type scale.
                fontSize: labels.points,
                lineHeight: labels.lineHeight,
                ...(separate && {
                  position: 'absolute',
                  bottom: NAV_PILL_PAD,
                  start: tab.id === 'home' ? 3 * NAV_PILL_PAD : 0,
                  end: tab.id === 'chat' ? 3 * NAV_PILL_PAD : 0,
                  textAlign: 'center'
                }),
                // UIKit sets every label in the same medium weight.
                fontWeight: '500',
                fontFamily: theme.regularTextFont
              },
              !separate && offset
            ]}
          >
            {tab.label}
          </Animated.Text>
        )}
      </Pressable>
      {props.dot && (
        // The unread dot, over this tab's slot of the row and laid out as the
        // tab lays out its glyph, but beside the tab: an accessible tab hides
        // what is inside it, and the tab already says Unread itself.
        <View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              top: 0,
              bottom: 0,
              start: `${(100 * index) / NAV_TABS.length}%`,
              width: `${100 / NAV_TABS.length}%`
            },
            slot
          ]}
        >
          <Animated.View style={offset}>
            <View style={{ width: glyph, height: glyph }}>
              <View
                testID={tab.id + '-unread'}
                style={{
                  position: 'absolute',
                  top: -1,
                  right: -2,
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: theme.liveColor
                }}
              />
            </View>
          </Animated.View>
          {!compact && !separate && (
            <View style={{ height: labels.lineHeight }} />
          )}
        </View>
      )}
    </>
  )
}

/** What a tab with something unread says after its name. */
export const UNREAD = 'Unread'

/** A tab's glyph size: 1.3 rem, scaled with the type on a phone, as the icon font was. */
function useGlyphPoints(maxSize: number): number {
  const theme = useTheme()
  const { fontScale } = useWindowDimensions()
  const scale = Platform.OS === 'web' ? 1 : fontScale
  return Math.min(theme.rem(1.3) * scale, maxSize)
}

/** A tab's glyph, `points` square. */
function TabGlyph(props: {
  d: string
  points: number
  color: string
}): React.ReactElement {
  const { points } = props
  return (
    <View
      accessible={false}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: points, height: points }}
    >
      <Svg width={points} height={points} viewBox={TAB_GLYPH_VIEW_BOX}>
        <Path d={props.d} fill={props.color} />
      </Svg>
    </View>
  )
}
