import React, { useRef } from 'react'
import { ActivityIndicator, Platform, View } from 'react-native'

import { ButtonIcon } from '../components/ButtonIcon'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { TessMicrophone } from './useTessMicrophone'

/**
 * When a touch happened, by its own clock: a phone's touch has `timestamp`
 * (its system's, set as the finger moved), a browser's pointer `timeStamp`.
 */
function stampOf(event: unknown): number | undefined {
  const { nativeEvent, timeStamp } = (event ?? {}) as {
    nativeEvent?: { timestamp?: unknown }
    timeStamp?: unknown
  }
  const stamp = Platform.OS === 'web' ? timeStamp : nativeEvent?.timestamp
  return typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : undefined
}

/** What the button says it is doing, for assistive technology and tests. */
function stateText(state: TessMicrophone['state']): string {
  switch (state) {
    case 'idle':
      return lstrings.tess_mic_off
    case 'opening':
      return lstrings.tess_mic_opening
    case 'recording':
      return lstrings.tess_mic_recording
    case 'transcribing':
      return lstrings.tess_mic_transcribing
  }
}

/**
 * The round microphone right of Send: closed until pressed. A tap records
 * until the next tap; a press held past half a second records until it is
 * let go. Red while it records, a spinner while the words are worked out.
 * Assistive technology gets "activate", which toggles it, and "pushToTalk",
 * which does the same, by name.
 */
export function TessMicButton({
  mic
}: {
  mic: TessMicrophone
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  // One press, one release. A browser reports them as pointer events; a phone
  // through the responder system only, since it reports a touch both ways
  // and not at once: a press reported again after the release would read as
  // a second tap, and stop what the first started. Each carries when it
  // happened: opening the microphone can hold a phone's release back, and
  // the hook tells a tap from a hold by these times.
  const web = Platform.OS === 'web'
  const down = useRef(false)
  const begin = (event: unknown, capture?: () => void): void => {
    if (down.current) return
    down.current = true
    capture?.()
    mic.press(stampOf(event))
  }
  const finish = (event: unknown): void => {
    if (!down.current) return
    down.current = false
    mic.lift(stampOf(event))
  }
  const cancel = (event: unknown): void => {
    if (!down.current) return
    down.current = false
    mic.cancel(stampOf(event))
  }
  const { state } = mic
  const recording = state === 'recording'
  return (
    <View
      testID="Tess mic"
      accessibilityRole="button"
      accessibilityLabel={lstrings.tess_mic}
      aria-valuetext={stateText(state)}
      accessibilityState={{
        selected: state !== 'idle',
        busy: state === 'transcribing'
      }}
      aria-pressed={state === 'opening' || recording}
      focusable
      accessibilityActions={[
        { name: 'activate' },
        { name: 'pushToTalk', label: lstrings.tess_mic_push }
      ]}
      onAccessibilityTap={() => {
        mic.toggle()
      }}
      onAccessibilityAction={event => {
        const { actionName } = event.nativeEvent
        if (actionName === 'activate' || actionName === 'pushToTalk')
          mic.toggle()
      }}
      onPointerDown={event => {
        if (!web) return
        begin(event, () => {
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
      onPointerUp={web ? finish : undefined}
      onPointerCancel={web ? cancel : undefined}
      onStartShouldSetResponder={() => !web}
      onResponderTerminationRequest={() => false}
      onResponderGrant={event => {
        begin(event)
      }}
      onResponderRelease={finish}
      onResponderTerminate={cancel}
      onKeyDown={event => {
        const key = (event.nativeEvent as { key?: string }).key
        if (key === 'Enter') mic.toggle()
      }}
      style={[
        styles.round,
        recording && styles.recording,
        state === 'opening' && styles.opening
      ]}
    >
      {state === 'transcribing' ? (
        <ActivityIndicator size="small" color={theme.secondaryTextColor} />
      ) : (
        <ButtonIcon
          name="mic"
          size={1.5}
          color={recording ? theme.buttonTextColor : theme.primaryTextColor}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  round: {
    width: theme.rem(3),
    height: theme.rem(3),
    borderRadius: theme.rem(1.5),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.pillBackground
  },
  recording: { backgroundColor: theme.dangerColor },
  opening: { opacity: 0.7 }
}))
