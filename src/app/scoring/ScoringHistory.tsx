import React, { useEffect, useRef, useState } from 'react'
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'

import type { TagTarget } from '../../common/eventTags'
import { useTheme } from '../theme/ThemeContext'
import { MODAL_ORIENTATIONS } from './modalOrientations'

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

export function HistoryPopup({
  bounds,
  rows,
  latest,
  viewport,
  onSelect,
  onClose
}: {
  bounds: HistoryBounds
  rows: TagTarget[]
  latest?: { primary: string; secondary?: string }
  viewport: { width: number; height: number }
  onSelect: (target: TagTarget) => void
  onClose: () => void
}): React.ReactElement {
  const theme = useTheme()
  const surface = theme.scoringSurface
  const newest = rows.at(-1)
  const overlayRef = useRef<React.ComponentRef<typeof View>>(null)
  // Fixed web modals may start at a different safe viewport origin.
  const [origin, setOrigin] = useState({ x: 0, y: 0 })
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
            // A native modal can rotate independently of the scoring controller.
            if (
              Platform.OS !== 'web' &&
              prior != null &&
              (prior.width !== width || prior.height !== height)
            ) {
              onClose()
              return
            }
            setOrigin(current =>
              current.x === x && current.y === y ? current : { x, y }
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
          style={{
            position: 'absolute',
            left: bounds.x - origin.x,
            top: bounds.y - origin.y,
            width: bounds.width,
            minHeight: bounds.height
          }}
        >
          <ScoringHistory
            rows={rows}
            onSelect={onSelect}
            maxHeight={Math.max(0, bounds.y - origin.y - 12)}
          />
          {newest != null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Tag event: ${newest.title}`}
              testID={`tag-history-${newest.id}`}
              onPress={() => {
                onSelect(newest)
              }}
              style={{
                minHeight: bounds.height,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                padding: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: surface.border,
                backgroundColor: surface.idle
              }}
            >
              <PencilBox />
              <View pointerEvents="none" style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: surface.text,
                    fontSize: 12,
                    fontWeight: '900'
                  }}
                >
                  {latest?.primary ?? newest.title}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{ color: surface.secondaryText, fontSize: 9 }}
                >
                  {newest.tag ?? latest?.secondary ?? ''}
                </Text>
              </View>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  )
}

/** Five older rows sit immediately above the existing newest-event button. */
export function ScoringHistory({
  rows,
  onSelect,
  maxHeight
}: {
  rows: TagTarget[]
  onSelect: (target: TagTarget) => void
  maxHeight?: number
}): React.ReactElement {
  const theme = useTheme()
  const surface = theme.scoringSurface
  const [headingHeight, setHeadingHeight] = useState(32)
  const rise = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true
    }).start()
  }, [rise])
  return (
    <Animated.View
      testID="scoring-tag-history"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 4,
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
        testID="scoring-history-older-scroll"
        style={{
          maxHeight:
            maxHeight == null
              ? undefined
              : Math.max(0, maxHeight - headingHeight - 2)
        }}
      >
        {rows.slice(0, -1).map(target => (
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
              alignItems: 'center',
              gap: 8,
              padding: 8,
              minHeight: 44,
              borderTopColor: surface.divider,
              borderTopWidth: 1
            }}
          >
            <PencilBox />
            <View pointerEvents="none" style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{
                  color: surface.text,
                  fontFamily: theme.regularTextFont,
                  fontSize: 12,
                  fontWeight: '700'
                }}
              >
                {target.title}
              </Text>
              {target.tag != null && (
                <Text
                  numberOfLines={1}
                  style={{ color: surface.badges.amber.text, fontSize: 11 }}
                >
                  {target.tag}
                </Text>
              )}
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </Animated.View>
  )
}
