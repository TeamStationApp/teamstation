import React, { useEffect, useRef, useState } from 'react'
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type ViewStyle
} from 'react-native'

import type { TagTarget } from '../../common/eventTags'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import { MODAL_ORIENTATIONS } from './modalOrientations'
import type { PlayDescription } from './playDescription'

export function PencilBox(): React.ReactElement {
  const { scoringSurface: surface } = useTheme()
  return (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        backgroundColor: surface.input,
        borderWidth: 1,
        borderColor: surface.border,
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <Text
        allowFontScaling={false}
        style={{
          color: surface.badges.amber.text,
          fontSize: 16,
          lineHeight: 19
        }}
      >
        ✎
      </Text>
    </View>
  )
}

export interface HistoryBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Display wording stays separate from the persistent tag target's identity. */
export interface HistoryRow extends TagTarget {
  display?: PlayDescription
}

export function HistoryPopup({
  bounds,
  rows,
  viewport,
  onSelect,
  onClose
}: {
  bounds: HistoryBounds
  rows: HistoryRow[]
  viewport: { width: number; height: number }
  onSelect: (target: TagTarget) => void
  onClose: () => void
}): React.ReactElement {
  const theme = useTheme()
  const insets = useInsets()
  const overlayRef = useRef<React.ComponentRef<typeof View>>(null)
  const [frame, setFrame] = useState({ x: 0, y: 0, ...viewport })
  const modalSize = useRef<{ width: number; height: number } | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const openedSize = useRef(viewport)
  useEffect(() => {
    if (
      viewport.width !== openedSize.current.width ||
      viewport.height !== openedSize.current.height
    )
      onClose()
  }, [viewport.width, viewport.height, onClose])
  const bottom = Math.max(12, frame.height - (bounds.y - frame.y) + 4)
  // The scoring web route uses viewport-fit=cover, unlike other web routes.
  // CSS env values follow browser safe-area changes without another measurement.
  const maxHeight =
    Platform.OS === 'web'
      ? (`max(0px, calc(${frame.height - bottom}px - max(12px, env(safe-area-inset-top, 0px))))` as ViewStyle['maxHeight'])
      : Math.max(0, frame.height - bottom - Math.max(12, insets.top))
  return (
    <Modal
      transparent
      animationType="none"
      onRequestClose={onClose}
      supportedOrientations={MODAL_ORIENTATIONS}
    >
      <View
        ref={overlayRef}
        testID="scoring-history-viewport"
        style={{ flex: 1 }}
        onLayout={() => {
          overlayRef.current?.measureInWindow((x, y, width, height) => {
            if (!alive.current || width <= 0 || height <= 0) return
            const prior = modalSize.current
            modalSize.current = { width, height }
            if (
              Platform.OS !== 'web' &&
              prior != null &&
              (prior.width !== width || prior.height !== height)
            ) {
              onClose()
              return
            }
            setFrame(current =>
              current.x === x &&
              current.y === y &&
              current.width === width &&
              current.height === height
                ? current
                : { x, y, width, height }
            )
          })
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss scoring history"
          onPress={onClose}
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: theme.overlayBackgroundColor
          }}
        />
        <View
          testID="scoring-history-frame"
          style={{
            position: 'absolute',
            left: Math.max(12, Math.max(12, insets.left) - frame.x),
            right: Math.max(
              12,
              frame.x +
                frame.width -
                viewport.width +
                Math.max(12, insets.right)
            ),
            bottom,
            ...(Platform.OS === 'web'
              ? {
                  left: `max(12px, calc(max(12px, env(safe-area-inset-left, 0px)) - ${frame.x}px))`,
                  right: `max(12px, calc(${frame.x + frame.width - viewport.width}px + max(12px, env(safe-area-inset-right, 0px))))`
                }
              : {})
          }}
        >
          <ScoringHistory
            rows={rows}
            onSelect={onSelect}
            maxHeight={maxHeight}
          />
        </View>
      </View>
    </Modal>
  )
}

/** Chronological rows end with the newest event, directly above Undo. */
export function ScoringHistory({
  rows,
  onSelect,
  maxHeight
}: {
  rows: HistoryRow[]
  onSelect: (target: TagTarget) => void
  maxHeight?: ViewStyle['maxHeight']
}): React.ReactElement {
  const theme = useTheme()
  const surface = theme.scoringSurface
  const [headingHeight, setHeadingHeight] = useState(32)
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const rise = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const animation = Animated.timing(rise, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [rise])
  return (
    <Animated.View
      testID="scoring-tag-history"
      style={{
        borderRadius: 8,
        backgroundColor: surface.idle,
        borderColor: surface.border,
        borderWidth: 1,
        opacity: rise,
        transform: [
          {
            translateY: rise.interpolate({
              inputRange: [0, 1],
              outputRange: [24, 0]
            })
          }
        ]
      }}
    >
      <Text
        onLayout={event => {
          if (event.nativeEvent.layout.height > 0)
            setHeadingHeight(event.nativeEvent.layout.height)
        }}
        style={{
          color: surface.text,
          fontFamily: theme.regularTextFont,
          fontSize: 12,
          padding: 8
        }}
      >
        Tap event to assign a tag.
      </Text>
      <ScrollView
        ref={scroll}
        testID="scoring-history-older-scroll"
        onLayout={() => {
          scroll.current?.scrollToEnd({ animated: false })
        }}
        onContentSizeChange={() => {
          scroll.current?.scrollToEnd({ animated: false })
        }}
        style={{
          maxHeight:
            maxHeight == null
              ? undefined
              : typeof maxHeight === 'number'
                ? Math.max(0, maxHeight - headingHeight - 2)
                : (`max(0px, calc(${maxHeight} - ${headingHeight + 2}px))` as ViewStyle['maxHeight'])
        }}
      >
        {rows.map(target => {
          const description =
            target.display == null
              ? target.description
              : target.display.secondary
          return (
            <Pressable
              key={target.id}
              accessibilityRole="button"
              accessibilityLabel={`Tag event: ${target.title}`}
              testID={`tag-history-${target.id}`}
              onPress={() => {
                onSelect(target)
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 8,
                padding: 8,
                minHeight: 48,
                borderTopColor: surface.divider,
                borderTopWidth: 1
              }}
            >
              <PencilBox />
              <View
                pointerEvents="none"
                style={{ flex: 1, minWidth: 0, gap: 3 }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    gap: 8
                  }}
                >
                  <Text
                    style={{
                      flex: 1,
                      color: surface.text,
                      fontFamily: theme.regularTextFont,
                      fontSize: 12,
                      fontWeight: '700'
                    }}
                  >
                    {target.display?.primary ?? target.title}
                  </Text>
                  {target.tag != null && (
                    <View
                      testID={`history-tag-${target.id}`}
                      style={{
                        maxWidth: '40%',
                        flexShrink: 1,
                        minHeight: 16,
                        borderRadius: 8,
                        paddingHorizontal: 8,
                        paddingVertical: 1,
                        borderWidth: 1,
                        borderColor: surface.border,
                        backgroundColor: surface.input
                      }}
                    >
                      <Text
                        style={{
                          color: surface.badges.amber.text,
                          fontFamily: theme.regularTextFont,
                          fontSize: 9,
                          lineHeight: 12
                        }}
                      >
                        {target.tag}
                      </Text>
                    </View>
                  )}
                </View>
                {description != null && description !== '' && (
                  <Text
                    testID={`history-description-${target.id}`}
                    style={{
                      color: surface.secondaryText,
                      fontFamily: theme.regularTextFont,
                      fontSize: 9
                    }}
                  >
                    {description}
                  </Text>
                )}
              </View>
            </Pressable>
          )
        })}
      </ScrollView>
    </Animated.View>
  )
}
