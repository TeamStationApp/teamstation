import React, { useContext, useEffect, useId, useRef, useState } from 'react'
import {
  type GestureResponderEvent,
  Text,
  View,
  type ViewProps
} from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { RosterCardSlot, useRosterLifted } from './RosterCardSlot'
import {
  measureRosterView,
  RosterClipContext,
  RosterGripContext,
  useRosterGesture
} from './RosterDragContext'
import type { RosterDragProps, RosterGripProps } from './rosterDragProps'
import type { RosterGesture } from './rosterGesture'
import { RosterHold } from './rosterHold'
import { ROSTER_CARD_GAP } from './rosterLayout'
export { RosterDragGroup, RosterScrollArea } from './RosterDragContext'
/**
 * Extracted responder adapter also exercised with native page coordinates in
 * unit tests. `grip` marks the next touch start as one on the card's grip.
 */
export function rosterResponder(
  engine: RosterGesture,
  props: RosterDragProps,
  current = (): RosterDragProps => props,
  source?: string
): ViewProps & { dispose: () => void; grip: () => void } {
  let owned = false
  let contact = false
  let gripped = false
  // A touch that started on the grip stays the grip's: the card follows it
  // by its touch events and never asks for it. React Native grants a view
  // the touch before asking the holder to let go, and the grip refuses.
  let onGrip = false
  const point = (e: GestureResponderEvent): { x: number; y: number } => ({
    x: e.nativeEvent.pageX,
    y: e.nativeEvent.pageY
  })
  // The lists lock the moment the hold fires, while the finger is still: on
  // iOS the first move would otherwise start the list's own pan, which takes
  // the touch before this row can be granted it.
  const hold = new RosterHold(
    p => {
      const latest = current()
      if (latest.playerId != null && latest.disabled !== true)
        engine.begin(latest.playerId, latest.label ?? '', p, source)
    },
    () => current().immediate === true
  )
  const cancel = (): void => {
    hold.cancel()
    owned = false
    contact = false
    if (engine.active?.id === current().playerId) engine.cancel()
  }
  const move = (e: GestureResponderEvent): void => {
    hold.move(point(e))
    if (hold.active) engine.move(point(e)).catch(cancel)
  }
  const end = (e: GestureResponderEvent): void => {
    if (!contact) return
    const active = hold.active
    const tap = hold.finish()
    contact = false
    owned = false
    // A tap on the grip lifted the card as it landed: put it back.
    if (tap) {
      if (active) engine.cancel()
      if (current().disabled !== true) current().onTap?.()
    } else if (active) engine.release(point(e)).catch(cancel)
  }
  return {
    dispose: cancel,
    grip: () => {
      gripped = true
    },
    onStartShouldSetResponder: () => false,
    onTouchStart: e => {
      const grip = gripped
      gripped = false
      onGrip = grip
      if (
        (current().playerId == null && current().onTap == null) ||
        current().disabled === true
      )
        return
      contact = true
      hold.start(point(e), grip)
    },
    onTouchMove: e => {
      if (!owned) move(e)
    },
    onTouchEnd: e => {
      if (!owned) end(e)
    },
    onTouchCancel: cancel,
    // An immediate card's drag starts on the move that crosses its distance;
    // it claims the touch on that same move, before a parent pan can.
    onMoveShouldSetResponder: e => {
      hold.move(point(e))
      return hold.active && !onGrip
    },
    onResponderGrant: () => {
      owned = true
    },
    onResponderMove: move,
    onResponderRelease: end,
    onResponderTerminate: cancel,
    onResponderTerminationRequest: () => !hold.active
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
/**
 * A roster list item's own layout: nothing but its card, so neighbouring cards
 * stand ROSTER_CARD_GAP apart, as on the web. While its card is lifted by a
 * drag, the item takes one gap back so the card's place closes to one gap.
 */
export function rosterItemLayout(
  lifted: boolean,
  disabled: boolean
): {
  gap: number
  marginBottom?: number
  opacity: number
  borderRadius: number
} {
  return {
    gap: ROSTER_CARD_GAP,
    ...(lifted ? { marginBottom: -ROSTER_CARD_GAP } : {}),
    opacity: disabled ? 0.4 : 1,
    borderRadius: 6
  }
}

/**
 * The three bars at a roster card's left, over the card's whole height and
 * its left padding (`scoringPlayerCardStyle`'s). A touch on them picks the
 * card up as it lands; anywhere else on the card holds first. The grip is
 * its own responder, and blocks the native one, so no list scrolls from it.
 */
export function RosterGrip({
  label,
  color
}: RosterGripProps): React.ReactElement {
  const grip = useContext(RosterGripContext)
  return (
    <View
      onTouchStart={grip}
      onStartShouldSetResponder={() => true}
      onResponderGrant={() => true}
      onResponderTerminationRequest={() => false}
      style={{
        alignSelf: 'stretch',
        justifyContent: 'center',
        marginVertical: -10,
        marginLeft: -8,
        paddingLeft: 8,
        paddingRight: 2
      }}
    >
      <Text
        selectable={false}
        accessibilityLabel={label}
        style={{ color, fontSize: 24 }}
      >
        ≡
      </Text>
    </View>
  )
}

export function RosterDrag(props: RosterDragProps): React.ReactElement {
  const engine = useRosterGesture()
  const source = useId()
  const lifted = useRosterLifted(source)
  const clip = useContext(RosterClipContext)
  const theme = useTheme()
  const ref = useRef<React.ComponentRef<typeof View>>(null)
  const latest = useRef(props)
  latest.current = props
  const [adapter] = useState(() =>
    rosterResponder(engine, props, () => latest.current, source)
  )
  useEffect(() => adapter.dispose, [adapter, props.disabled, props.playerId])
  const { dispose, grip, ...handlers } = adapter
  const [hover, setHover] = useState<false | 'before' | 'after' | 'row'>(false)
  useEffect(() => {
    if (props.playerId == null) return
    engine.sources.set(source, {
      measure: async () => await measureRosterView(ref.current),
      clip,
      content: props.children
    })
    return () => {
      engine.sources.delete(source)
    }
  }, [engine, source, clip, props.playerId, props.children])
  const token = props.targetId
  useEffect(() => {
    if (token == null || props.onDropPlayer == null) return
    engine.targets.set(token, {
      measure: async () => await measureRosterView(ref.current),
      clip,
      insertion: props.insertion,
      fixed: props.fixed,
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
  }, [engine, clip, token, props.onDropPlayer, props.insertion, props.fixed])
  return (
    <View
      ref={ref}
      {...handlers}
      accessible={
        props.onReorder == null && (props.label != null || props.onTap != null)
          ? true
          : undefined
      }
      onAccessibilityTap={
        props.onTap == null
          ? undefined
          : () => {
              rosterAccessibilityAction(latest.current, 'activate')
            }
      }
      accessibilityRole={props.onTap != null ? 'button' : undefined}
      accessibilityLabel={props.label}
      accessibilityValue={
        props.value == null ? undefined : { text: props.value }
      }
      accessibilityState={{ disabled: props.disabled }}
      accessibilityActions={[
        ...(props.onTap == null
          ? []
          : [{ name: 'activate' as const, label: props.label ?? 'Activate' }]),
        ...(props.onReorder == null
          ? []
          : [
              { name: 'increment' as const, label: 'Move down' },
              { name: 'decrement' as const, label: 'Move up' }
            ])
      ]}
      onAccessibilityAction={event => {
        rosterAccessibilityAction(props, event.nativeEvent.actionName)
      }}
      style={rosterItemLayout(lifted, props.disabled === true)}
    >
      <RosterGripContext.Provider value={grip}>
        {props.targetId === 'roster' ? (
          props.children
        ) : (
          <RosterCardSlot
            source={source}
            target={props.targetId}
            player={props.playerId}
          >
            {props.children}
          </RosterCardSlot>
        )}
      </RosterGripContext.Provider>
      {hover === 'row' && (
        // Drawn over the card, so like the web outline it takes no layout
        // space and cards stay ROSTER_CARD_GAP apart.
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderWidth: 2,
            borderRadius: 6,
            borderColor: theme.scoringMenuActiveBackground
          }}
        />
      )}
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
