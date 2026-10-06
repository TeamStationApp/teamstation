import React, { useState } from 'react'
import { View } from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'

import { swipeOffset, swipeReplies } from './chatModel'

export interface SwipeToReplyProps {
  /** On a phone; the web has no swipe, only the long press. */
  enabled: boolean
  onReply: () => void
  children: React.ReactNode
}

/**
 * A message dragged to the right far enough is replied to, as in every
 * phone's messages app. Vertical drags stay the list's, so scrolling never
 * replies to anything.
 */
export function SwipeToReply(props: SwipeToReplyProps): React.ReactElement {
  const { enabled, onReply, children } = props
  const [dx, setDx] = useState(0)
  const swipe = swipeHandlers(setDx, onReply)
  // Each callback written out: the worklets Babel plugin refuses a spread
  // in a gesture hook's options.
  const pan = usePanGesture({
    runOnJS: true,
    enabled,
    activeOffsetX: 16,
    failOffsetY: [-12, 12],
    onUpdate: event => {
      swipe.onUpdate(event)
    },
    onDeactivate: event => {
      swipe.onDeactivate(event)
    },
    onFinalize: () => {
      swipe.onFinalize()
    }
  })
  if (!enabled) return <>{children}</>
  return (
    <GestureDetector gesture={pan}>
      <View style={{ transform: [{ translateX: dx }] }}>{children}</View>
    </GestureDetector>
  )
}

/** What the pan does: follow the finger, reply past the threshold, spring back. */
export function swipeHandlers(
  setDx: (dx: number) => void,
  onReply: () => void
): {
  onUpdate: (event: { translationX: number }) => void
  onDeactivate: (event: { translationX: number; canceled: boolean }) => void
  onFinalize: () => void
} {
  return {
    onUpdate: event => {
      setDx(swipeOffset(event.translationX))
    },
    onDeactivate: event => {
      if (!event.canceled && swipeReplies(event.translationX)) onReply()
    },
    onFinalize: () => {
      setDx(0)
    }
  }
}
