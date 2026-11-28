import React from 'react'
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from 'react-native-reanimated'

import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useContentInset } from './contentInset'
import { GlassView } from './GlassView'
import type { PillTabsProps } from './PillTabs'

/**
 * The glass tab strip: bare labels, and one pill that slides to the selected
 * one and takes its width.
 *
 * Only the selected tab has a pill, so the labels sit as close as their own
 * targets allow rather than a pill's width and a gap apart. The pill keeps the
 * strip's rule that a label stays between its two rounded ends
 * (`pillPadding`); only one side of any gap holds a pill, so that clearance
 * still costs a single side's worth, not two and a gap.
 *
 * On iOS the pill is the system's Liquid Glass (`GlassView`, interactive),
 * like the tab bar's capsule, tinted the strip's green so the selected tab
 * still carries the app's colour. Elsewhere it is the strip's filled pill.
 * Either way the selected label is the filled pill's label colour.
 *
 * The pill's two ends travel on different springs, the leading one quicker,
 * so it stretches toward the new tab and settles into its width. Pressing a
 * tab grows the pill a little until the finger lifts.
 */
export function GlassTabs<Id extends string = string>(
  props: PillTabsProps<Id>
): React.ReactElement {
  const { tabs, selected, onSelect, bleed = true } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const inset = useContentInset()
  const reach =
    bleed && (inset.left > 0 || inset.right > 0)
      ? {
          strip: { marginLeft: -inset.left, marginRight: -inset.right },
          content: { paddingLeft: inset.left, paddingRight: inset.right }
        }
      : undefined

  const scroll = React.useRef<React.ComponentRef<typeof ScrollView>>(null)
  const [stripWidth, setStripWidth] = React.useState(0)
  const [frames, setFrames] = React.useState<
    Record<string, { x: number; width: number }>
  >({})

  const left = useSharedValue(0)
  const right = useSharedValue(0)
  const lift = useSharedValue(1)
  const shown = useSharedValue(0)
  const placed = React.useRef(false)
  const lastX = React.useRef(0)

  const frame = frames[selected]
  React.useEffect(() => {
    if (frame == null) return
    const pad = pillPadding(theme.rem(PILL_HEIGHT_REM))
    const nextLeft = frame.x + TARGET_SIDE(theme) - pad
    const nextRight = frame.x + frame.width - TARGET_SIDE(theme) + pad
    if (!placed.current) {
      left.value = nextLeft
      right.value = nextRight
      shown.value = withTiming(1, { duration: 150 })
      placed.current = true
    } else {
      const forward = frame.x > lastX.current
      const fast = { damping: 18, stiffness: 260, mass: 0.8 }
      const slow = { damping: 20, stiffness: 150, mass: 0.9 }
      left.value = withSpring(nextLeft, forward ? slow : fast)
      right.value = withSpring(nextRight, forward ? fast : slow)
    }
    lastX.current = frame.x
    // Keep the selected tab whole on screen, centred when the strip scrolls.
    if (stripWidth > 0) {
      scroll.current?.scrollTo({
        x: Math.max(0, frame.x + frame.width / 2 - stripWidth / 2),
        animated: true
      })
    }
  }, [frame?.x, frame?.width, stripWidth])

  const pillStyle = useAnimatedStyle(() => ({
    left: left.value,
    width: Math.max(0, right.value - left.value),
    opacity: shown.value,
    transform: [{ scale: lift.value }]
  }))

  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={props.accessibilityLabel}
      style={[reach?.strip, props.style]}
      onLayout={(event: LayoutChangeEvent) => {
        setStripWidth(event.nativeEvent.layout.width)
      }}
      contentContainerStyle={[styles.scrollContent, reach?.content]}
    >
      <View style={styles.row}>
        <Animated.View
          pointerEvents="none"
          testID="glass-tab-pill"
          style={[styles.pill, !GLASS_PILL && styles.pillFilled, pillStyle]}
        >
          {GLASS_PILL && (
            <GlassView
              interactive
              tint={theme.pillActiveBackground}
              radius={theme.rem(PILL_HEIGHT_REM) / 2}
              style={styles.pillGlass}
            />
          )}
        </Animated.View>
        {tabs.map(tab => {
          const isSelected = tab.id === selected
          const role = tab.role ?? 'tab'
          return (
            <Pressable
              key={tab.id}
              accessibilityRole={role}
              accessibilityState={
                role === 'tab' ? { selected: isSelected } : undefined
              }
              aria-selected={role === 'tab' ? isSelected : undefined}
              accessibilityLabel={tab.label}
              onLayout={(event: LayoutChangeEvent) => {
                const { x, width } = event.nativeEvent.layout
                setFrames(old =>
                  old[tab.id]?.x === x && old[tab.id]?.width === width
                    ? old
                    : { ...old, [tab.id]: { x, width } }
                )
              }}
              onPressIn={() => {
                if (isSelected) lift.value = withSpring(1.08)
              }}
              onPressOut={() => {
                lift.value = withSpring(1)
              }}
              onPress={() => {
                onSelect(tab.id)
              }}
              style={styles.target}
            >
              <View style={styles.labelBox}>
                {/* Both faces of the label, unseen, hold each tab at the
                    wider of its two widths, so selecting one never pushes
                    its neighbours or cuts its label short. */}
                {[styles.labelActive, styles.labelIdle].map((face, i) => (
                  <View
                    key={i}
                    style={[styles.sizer, i > 0 && styles.sizerUnder]}
                    aria-hidden
                  >
                    {tab.live === true && <View style={styles.liveDot} />}
                    <Text selectable={false} style={[styles.label, face]}>
                      {tab.label}
                    </Text>
                    {tab.badge != null && (
                      <Text style={styles.badge}>{tab.badge}</Text>
                    )}
                  </View>
                ))}
                <View style={styles.shown}>
                  {tab.live === true && (
                    <View testID="pill-live-dot" style={styles.liveDot} />
                  )}
                  <Text
                    selectable={false}
                    style={[
                      styles.label,
                      isSelected ? styles.labelActive : styles.labelIdle
                    ]}
                  >
                    {tab.label}
                  </Text>
                  {tab.badge != null && (
                    <Text
                      style={[
                        styles.badge,
                        isSelected ? styles.labelActive : styles.labelIdle
                      ]}
                    >
                      {tab.badge}
                    </Text>
                  )}
                </View>
              </View>
            </Pressable>
          )
        })}
      </View>
    </ScrollView>
  )
}

/** The compact pill's height: 36 points, as the strip's. */
const PILL_HEIGHT_REM = 2.25

/** Where the pill clears the 48-point target above and below. */
const PILL_INSET_REM = (3 - PILL_HEIGHT_REM) / 2

/** Liquid Glass for the pill where the system draws it. */
const GLASS_PILL = Platform.OS === 'ios'

/** Each target's side: half the 28 points between two labels. */
function TARGET_SIDE(theme: Theme): number {
  return theme.rem(0.875)
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrollContent: {
    paddingHorizontal: theme.rem(theme.spaceXsRem)
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  // 48 tall, as every tab; the side is half the space to the next label, so
  // two targets meet in the middle of it.
  target: {
    paddingVertical: theme.rem(PILL_INSET_REM),
    paddingHorizontal: TARGET_SIDE(theme)
  },
  // The pill's own height, with the label centred in it exactly as the
  // filled strip centres its label: the pill is drawn over this box.
  labelBox: {
    height: theme.rem(PILL_HEIGHT_REM),
    justifyContent: 'center'
  },
  sizer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem),
    opacity: 0
  },
  // The second face sits under the first, so the box takes the wider.
  sizerUnder: {
    height: 0,
    overflow: 'hidden'
  },
  shown: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  pill: {
    position: 'absolute',
    top: theme.rem(PILL_INSET_REM),
    height: theme.rem(PILL_HEIGHT_REM),
    borderRadius: theme.radiusPill
  },
  pillGlass: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0
  },
  pillFilled: {
    backgroundColor: theme.pillActiveBackground,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    shadowColor: theme.buttonShadowColor,
    shadowOpacity: 1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },
  liveDot: {
    width: theme.rem(0.5),
    height: theme.rem(0.5),
    borderRadius: theme.rem(0.25),
    backgroundColor: theme.liveColor
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600'
  },
  labelIdle: {
    color: theme.pillTextColor,
    fontFamily: theme.regularTextFont,
    fontWeight: '400',
    opacity: 0.72
  },
  labelActive: {
    color: theme.pillActiveTextColor
  },
  badge: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '700'
  }
}))
