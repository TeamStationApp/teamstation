import React, { useEffect, useLayoutEffect, useState } from 'react'
import { View, type ViewStyle } from 'react-native'
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

/**
 * A card's view inside its slot. In an animated slot the card is laid out out
 * of flow, so Yoga sizes it from its own content whatever height the slot is
 * animating through: in flow, a phone measures it against the slot's definite
 * height, so a lifted card measured 0, reopened to 0 after its drop and drew
 * over the card below it. The slot's own height gives the card its room. A
 * slot that does not animate keeps its card in flow and follows it.
 */
export const rosterSlotCardStyle = (animated: boolean): ViewStyle =>
  animated ? { position: 'absolute', top: 0, left: 0, right: 0 } : {}

export interface RosterSlotLayout {
  /** Whether the slot animates at all: a player's card, or a lineup target. */
  animated: boolean
  height: number
  marginTop: number
  marginBottom: number
  opacity: number
  /** Milliseconds to reach this layout; 0 settles it at once. */
  duration: number
}

/**
 * Where a card's slot is headed. A lifted card's slot closes; the lineup card
 * under the pointer opens one card and one gap before or after itself. While
 * a drag is live the slots move over 160 ms. With no drag, at rest, after a
 * drop or a cancel, every slot settles at once: the dropped card lands in the
 * space the drag held open for it, so nothing around it moves.
 */
export function rosterSlotLayout({
  preview,
  source,
  target,
  player,
  height,
  reduced
}: {
  preview: RosterPreview | null
  source: string
  target?: string
  player?: number
  height: number
  reduced: boolean
}): RosterSlotLayout {
  const lineup = target?.startsWith('lineup') === true
  const collapsed = preview?.source === source && preview.cardRect != null
  const extent =
    preview?.target === target &&
    preview?.cardRect != null &&
    lineup &&
    !collapsed
      ? preview.cardRect.height + ROSTER_CARD_GAP
      : 0
  return {
    animated: player != null || lineup,
    height: collapsed ? 0 : height,
    marginTop: preview?.edge !== 'after' ? extent : 0,
    marginBottom: preview?.edge === 'after' ? extent : 0,
    opacity: collapsed ? 0 : 1,
    duration: preview == null || reduced ? 0 : 160
  }
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
  const layout = rosterSlotLayout({
    preview,
    source,
    target,
    player,
    height,
    reduced
  })
  const slotHeight = useSharedValue(layout.height)
  const top = useSharedValue(0)
  const bottom = useSharedValue(0)
  useEffect(() => {
    engine.listeners.add(setPreview)
    return () => {
      engine.listeners.delete(setPreview)
    }
  }, [engine])
  // Before the commit is shown, so a dropped card's new place and its slot's
  // height arrive in the same frame.
  useLayoutEffect(() => {
    const move = (value: number): number =>
      layout.duration === 0
        ? value
        : withTiming(value, {
            duration: layout.duration,
            reduceMotion: ReduceMotion.Never
          })
    slotHeight.value = move(layout.height)
    top.value = move(layout.marginTop)
    bottom.value = move(layout.marginBottom)
  }, [
    layout.height,
    layout.marginTop,
    layout.marginBottom,
    layout.duration,
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
    <Animated.View style={layout.animated ? style : undefined}>
      <View
        onLayout={event => {
          setHeight(event.nativeEvent.layout.height)
        }}
        style={{
          ...rosterSlotCardStyle(layout.animated),
          opacity: layout.opacity
        }}
      >
        {children}
      </View>
    </Animated.View>
  )
}
