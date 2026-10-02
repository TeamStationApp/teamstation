import React, { useEffect, useState } from 'react'
import { View } from 'react-native'
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'

import { useMotionPreference } from '../components/useMotionPreference'
import { useRosterGesture } from './RosterDragContext'
import type { RosterPreview } from './rosterGesture'
import { ROSTER_CARD_GAP } from './rosterLayout'

/**
 * Whether the card for `source` is lifted out of its list by a drag. The list
 * item itself takes back the card gap then: a margin inside the item cannot
 * leave it, so only the item can close its place to one gap.
 */
export function useRosterLifted(source: string): boolean {
  const engine = useRosterGesture()
  const [lifted, setLifted] = useState(
    engine.preview?.source === source && engine.preview.cardRect != null
  )
  useEffect(() => {
    const listen = (preview: RosterPreview | null): void => {
      setLifted(preview?.source === source && preview.cardRect != null)
    }
    engine.listeners.add(listen)
    return () => {
      engine.listeners.delete(listen)
    }
  }, [engine, source])
  return lifted
}

/** Animate layout slots while the source responder and target registrations stay mounted. */
export function RosterCardSlot({
  source,
  target,
  player,
  children
}: {
  source: string
  target?: string
  player?: number
  children: React.ReactNode
}): React.ReactElement {
  const engine = useRosterGesture()
  const [preview, setPreview] = useState<RosterPreview | null>(engine.preview)
  const [height, setHeight] = useState(48)
  const reduced = useMotionPreference()
  const collapsed = preview?.source === source && preview.cardRect != null
  const gap =
    preview?.target === target &&
    preview?.cardRect != null &&
    target?.startsWith('lineup') === true &&
    !collapsed
  const before = gap && preview?.edge !== 'after'
  const after = gap && preview?.edge === 'after'
  const extent = (preview?.cardRect?.height ?? 48) + ROSTER_CARD_GAP
  const slotHeight = useSharedValue(height)
  const top = useSharedValue(0)
  const bottom = useSharedValue(0)
  useEffect(() => {
    engine.listeners.add(setPreview)
    return () => {
      engine.listeners.delete(setPreview)
    }
  }, [engine])
  useEffect(() => {
    const config = {
      duration: reduced ? 0 : 160,
      reduceMotion: ReduceMotion.Never
    }
    slotHeight.value = withTiming(collapsed ? 0 : height, config)
    top.value = withTiming(before ? extent : 0, config)
    bottom.value = withTiming(after ? extent : 0, config)
  }, [
    collapsed,
    height,
    before,
    after,
    extent,
    reduced,
    slotHeight,
    top,
    bottom
  ])
  const style = useAnimatedStyle(() => ({
    height: slotHeight.value,
    marginTop: top.value,
    marginBottom: bottom.value
  }))
  return (
    <Animated.View
      style={
        player == null && target?.startsWith('lineup') !== true
          ? undefined
          : style
      }
    >
      <View
        onLayout={event => {
          setHeight(event.nativeEvent.layout.height)
        }}
        style={{ opacity: collapsed ? 0 : 1 }}
      >
        {children}
      </View>
    </Animated.View>
  )
}
