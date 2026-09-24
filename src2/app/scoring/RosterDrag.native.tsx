import React, { useContext, useEffect, useRef, useState } from 'react'
import { type GestureResponderEvent, View, type ViewProps } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import {
  measureRosterView,
  RosterClipContext,
  useRosterGesture
} from './RosterDragContext'
import type { RosterDragProps } from './rosterDragProps'
import type { RosterGesture } from './rosterGesture'
export { RosterDragGroup, RosterScrollArea } from './RosterDragContext'
/** Extracted responder adapter also exercised with native page coordinates in unit tests. */
export function rosterResponder(
  engine: RosterGesture,
  props: RosterDragProps
): ViewProps {
  const point = (e: GestureResponderEvent): { x: number; y: number } => ({
    x: e.nativeEvent.pageX,
    y: e.nativeEvent.pageY
  })
  return {
    onStartShouldSetResponder: () =>
      props.playerId != null && props.disabled !== true,
    onResponderGrant: (e: GestureResponderEvent) => {
      engine.begin(props.playerId!, props.label ?? '', point(e))
    },
    onResponderMove: (e: GestureResponderEvent) => {
      engine.move(point(e)).catch(() => {
        engine.cancel()
      })
    },
    onResponderRelease: (e: GestureResponderEvent) => {
      if (engine.active?.id !== props.playerId) return
      engine
        .release(point(e))
        .then(moved => {
          if (!moved && props.disabled !== true) props.onTap?.()
        })
        .catch(() => {
          engine.cancel()
        })
    },
    onResponderTerminate: () => {
      engine.cancel()
    },
    onResponderTerminationRequest: () => false
  }
}
export function rosterAccessibilityAction(
  props: RosterDragProps,
  action: string
): void {
  if (props.disabled === true) return
  if (action === 'activate') props.onTap?.()
  else if (action === 'increment' || action === 'decrement')
    props.onReorder?.(action === 'increment' ? 1 : -1)
}
export function RosterDrag(props: RosterDragProps): React.ReactElement {
  const engine = useRosterGesture()
  const clip = useContext(RosterClipContext)
  const theme = useTheme()
  const ref = useRef<React.ComponentRef<typeof View>>(null)
  const latest = useRef(props)
  latest.current = props
  const [hover, setHover] = useState<false | 'before' | 'after' | 'row'>(false)
  const token = props.targetId
  useEffect(() => {
    if (token == null || props.onDropPlayer == null) return
    engine.targets.set(token, {
      measure: async () => await measureRosterView(ref.current),
      clip,
      insertion: props.insertion,
      drop: (id, edge) => {
        latest.current.onDropPlayer?.(id, edge)
      }
    })
    const timer = setInterval(() => {
      const preview = engine.preview
      setHover(preview?.target === token ? (preview.edge ?? 'row') : false)
    }, 40)
    return () => {
      clearInterval(timer)
      engine.targets.delete(token)
    }
  }, [engine, clip, token, props.onDropPlayer, props.insertion])
  return (
    <View
      ref={ref}
      {...rosterResponder(engine, props)}
      accessibilityRole={props.onTap != null ? 'button' : undefined}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      accessibilityActions={
        props.onReorder == null
          ? undefined
          : [
              { name: 'increment', label: 'Move down' },
              { name: 'decrement', label: 'Move up' }
            ]
      }
      onAccessibilityAction={event => {
        rosterAccessibilityAction(props, event.nativeEvent.actionName)
      }}
      style={{
        opacity: props.disabled === true ? 0.4 : 1,
        borderWidth: 2,
        borderColor:
          hover === 'row'
            ? theme.scoringMenuActiveBackground
            : theme.backgroundColor,
        borderRadius: 6
      }}
    >
      {props.children}
      {(hover === 'before' || hover === 'after') && (
        <View
          pointerEvents="none"
          accessibilityLabel="Lineup insertion point"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: 3,
            top: hover === 'before' ? -2 : undefined,
            bottom: hover === 'after' ? -2 : undefined,
            backgroundColor: theme.scoringMenuActiveBackground
          }}
        />
      )}
    </View>
  )
}
