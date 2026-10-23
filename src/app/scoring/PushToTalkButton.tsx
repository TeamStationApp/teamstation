import React, { useEffect, useRef } from 'react'
import { View } from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import type { Dictation } from './dictationTypes'
import { ControlBackdrop } from './ScoringControlArt'
import {
  CONTROL_COLORS,
  CONTROL_HEIGHT,
  controlFrame
} from './scoringControlStyle'

/** A press shorter than this is a tap: it switches dictation off. */
export const TAP_MS = 300

export interface PushToTalkButtonProps {
  dictation: Dictation
  /**
   * The scoring screen's pill, or a round button `size` across: the roster
   * screen's in its bottom bar, and Tess's under her text field.
   */
  shape?: 'pill' | 'round'
  size?: number
  /** A press shorter than this is a tap. Tests shorten it. */
  tapMs?: number
}

/**
 * The microphone button. A tap switches dictation on, or off when it is on;
 * a press that outlasts a tap holds, and its release ends the sentence. The
 * audio heard since the press began leads it, so the first word is not lost
 * to the wait. Assistive technology gets the same two actions by name.
 */
export function PushToTalkButton(
  props: PushToTalkButtonProps
): React.ReactElement {
  const {
    dictation,
    shape = 'pill',
    size = CONTROL_HEIGHT,
    tapMs = TAP_MS
  } = props
  const latest = useRef(dictation)
  latest.current = dictation
  const pressed = useRef<number | null>(null)
  // Pointer events and the responder system can each report one press.
  // The second report in the same turn is the same press.
  const pressTurn = useRef(false)
  // A press becomes a hold once it outlasts a tap; a tap never starts one.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  const endPress = (): number | null => {
    clearTimeout(pressTimer.current)
    const since = pressed.current
    pressed.current = null
    return since
  }
  useEffect(
    () => () => {
      clearTimeout(pressTimer.current)
    },
    []
  )

  const { enabled, connected, holding, busy } = dictation
  const ready = enabled && connected && !busy
  const beginPress = (capture?: () => void): void => {
    if (pressTurn.current) return
    pressTurn.current = true
    queueMicrotask(() => {
      pressTurn.current = false
    })
    const since = Date.now()
    pressed.current = since
    capture?.()
    if (!ready) return
    if (tapMs <= 0) dictation.hold(since)
    else
      pressTimer.current = setTimeout(() => {
        // Still ready once the press has become a hold.
        const now = latest.current
        if (
          pressed.current === since &&
          now.enabled &&
          now.connected &&
          !now.busy
        )
          now.hold(since)
      }, tapMs)
  }
  const finishPress = (): void => {
    const since = endPress()
    if (since == null) return
    if (!enabled) dictation.setEnabled(true)
    else if (Date.now() - since < tapMs) dictation.setEnabled(false)
    else dictation.release()
  }
  const kind = !enabled ? 'micOff' : holding ? 'micLive' : 'micOn'
  const round = shape === 'round'
  return (
    <View
      accessibilityRole="button"
      accessibilityLabel={lstrings.dictation_button}
      accessibilityState={{ selected: enabled }}
      aria-pressed={enabled}
      focusable
      accessibilityActions={[
        { name: 'activate' },
        { name: 'pushToTalk', label: lstrings.dictation_push }
      ]}
      onAccessibilityTap={() => {
        dictation.setEnabled(!enabled)
      }}
      onAccessibilityAction={event => {
        if (event.nativeEvent.actionName !== 'pushToTalk') return
        if (!enabled) {
          dictation.setEnabled(true)
          return
        }
        if (holding) dictation.release()
        else if (ready) dictation.hold(Date.now())
      }}
      onPointerDown={event => {
        beginPress(() => {
          const target = event.currentTarget as unknown as {
            setPointerCapture?: (id: number) => void
          }
          try {
            // Keeps the release on this button when the finger drifts off it.
            target.setPointerCapture?.(event.nativeEvent.pointerId)
          } catch {
            /* A pointer the browser no longer knows; the press still counts. */
          }
        })
      }}
      onPointerUp={() => {
        finishPress()
      }}
      onPointerCancel={() => {
        endPress()
        dictation.release()
      }}
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={() => {
        beginPress()
      }}
      onResponderRelease={() => {
        finishPress()
      }}
      onResponderTerminate={() => {
        endPress()
        dictation.release()
      }}
      onKeyDown={event => {
        const key = (event.nativeEvent as { key?: string }).key
        if (key === 'Enter') dictation.setEnabled(!enabled)
      }}
      style={
        round
          ? {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: 1,
              borderColor: CONTROL_COLORS[kind].border,
              backgroundColor: CONTROL_COLORS[kind].bottom,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: enabled && !ready && !holding ? 0.7 : 1
            }
          : {
              ...controlFrame,
              borderColor: CONTROL_COLORS[kind].border,
              backgroundColor: CONTROL_COLORS[kind].bottom,
              opacity: enabled && !ready && !holding ? 0.7 : 1
            }
      }
    >
      {!round && <ControlBackdrop kind={kind} />}
      <Icon
        name={enabled ? 'mic' : 'mic_off'}
        size={round ? 1.5 : 1.75}
        color={CONTROL_COLORS[kind].text}
      />
    </View>
  )
}
