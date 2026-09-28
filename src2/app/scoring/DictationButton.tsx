import React, { type RefObject, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import type { DictationButtonProps } from './dictationTypes'
import { ScoringButton } from './ScoringSheet'
import { useDictation } from './useDictation'

/**
 * The dictation control on the scoring screen: a switch that turns it on,
 * a button held while speaking, what was heard, and the LLM's question when
 * it has one.
 */
export function DictationButton(
  props: DictationButtonProps
): React.ReactElement | null {
  const theme = useTheme()
  const [available, setAvailable] = useState(false)
  const {
    health,
    url,
    gameId,
    session,
    log,
    problem,
    spaceTalks = true,
    onActions,
    openSocket,
    openMicrophone
  } = props
  const dictation = useDictation({
    url,
    gameId,
    session,
    log,
    onActions,
    openSocket,
    openMicrophone
  })
  useEffect(() => {
    let live = true
    health().then(
      reply => {
        if (live) setAvailable(reply.dictation)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [health])
  const keys = useRef({ hold: () => {}, release: () => {} })
  keys.current = {
    hold: () => {
      if (dictation.enabled && dictation.connected && !dictation.busy)
        dictation.hold()
    },
    release: dictation.release
  }
  useSpaceToTalk(available && dictation.enabled, spaceTalks, keys)
  if (!available) return null

  const { enabled, connected, holding, busy, text, ask } = dictation
  const message = dictation.message ?? problem?.message ?? null
  const ready = enabled && connected && !busy
  const label = !enabled
    ? 'Dictation off'
    : !connected
      ? 'Connecting…'
      : holding
        ? 'Listening…'
        : busy
          ? 'Working it out…'
          : 'Hold to talk'
  const hold = (): void => {
    if (ready) dictation.hold()
  }
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        right: 12,
        bottom: 150,
        maxWidth: 260,
        alignItems: 'flex-end',
        gap: 8
      }}
    >
      {(text != null && text !== '') || message != null ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            borderRadius: theme.rem(theme.radiusRem),
            borderWidth: 2,
            borderColor: theme.scoringInstructionBorder,
            backgroundColor: theme.scoringInstructionBackground,
            padding: 8,
            gap: 4
          }}
        >
          {text != null && text !== '' && (
            <Text
              accessibilityLabel="Dictated text"
              style={{
                color: theme.scoringInstructionText,
                fontFamily: theme.regularTextFont,
                fontSize: 15
              }}
            >
              {text}
            </Text>
          )}
          {message != null && (
            <Text
              accessibilityLabel="Dictation message"
              style={{
                color: theme.scoringCountdownColor,
                fontFamily: theme.semiBoldTextFont,
                fontSize: 15
              }}
            >
              {message}
            </Text>
          )}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Dictation"
          aria-checked={enabled}
          onPress={() => {
            dictation.setEnabled(!enabled)
          }}
          style={{
            borderRadius: 999,
            paddingVertical: 10,
            paddingHorizontal: 14,
            backgroundColor: enabled
              ? theme.scoringMenuActiveBackground
              : theme.scoringControlBackground
          }}
        >
          <Text
            style={{
              color: enabled
                ? theme.scoringMenuActiveText
                : theme.scoringControlText,
              fontFamily: theme.semiBoldTextFont
            }}
          >
            {enabled ? 'Mic on' : 'Mic off'}
          </Text>
        </Pressable>
        {enabled && !holding && !busy && (
          <Text
            accessibilityLabel="Or hold Space"
            style={{
              color: theme.scoringInstructionText,
              fontFamily: theme.regularTextFont,
              fontSize: 13
            }}
          >
            or hold Space
          </Text>
        )}
        <View
          accessibilityRole="button"
          accessibilityLabel="Hold to dictate"
          aria-disabled={!ready && !holding}
          focusable={ready}
          onPointerDown={event => {
            const target = event.currentTarget as unknown as {
              setPointerCapture?: (id: number) => void
            }
            try {
              // Keeps the release on this button when the finger drifts off it.
              target.setPointerCapture?.(event.nativeEvent.pointerId)
            } catch {
              /* A pointer the browser no longer knows; the hold still counts. */
            }
            hold()
          }}
          onPointerUp={() => {
            dictation.release()
          }}
          onPointerCancel={() => {
            dictation.release()
          }}
          // Space is the page-wide talk key (useSpaceToTalk); Enter works here.
          onKeyDown={event => {
            const key = (event.nativeEvent as { key?: string }).key
            if (key === 'Enter' && !holding) hold()
          }}
          onKeyUp={event => {
            const key = (event.nativeEvent as { key?: string }).key
            if (key === 'Enter') dictation.release()
          }}
          style={{
            borderRadius: 999,
            paddingVertical: 14,
            paddingHorizontal: 18,
            opacity: ready || holding ? 1 : 0.5,
            backgroundColor: holding
              ? theme.scoringOutColor
              : theme.scoringSafeColor
          }}
        >
          <Text
            style={{
              color: theme.scoringDecisionText,
              fontFamily: theme.semiBoldTextFont,
              fontSize: 16,
              userSelect: 'none'
            }}
          >
            {label}
          </Text>
        </View>
      </View>
      {ask != null && (
        <View
          accessibilityRole="alert"
          accessibilityLabel="Dictation question"
          style={{
            borderRadius: theme.rem(theme.radiusRem),
            borderWidth: 2,
            borderColor: theme.scoringInstructionBorder,
            backgroundColor: theme.backgroundColor,
            padding: 10,
            gap: 6,
            minWidth: 220
          }}
        >
          <Text
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.semiBoldTextFont,
              fontSize: 16
            }}
          >
            {ask.question}
          </Text>
          {ask.options.map((option, index) => (
            <ScoringButton
              key={`${index}:${option.label}`}
              label={option.label}
              onPress={() => {
                dictation.answer(index)
              }}
            />
          ))}
          <ScoringButton
            label="Dismiss question"
            text="Neither — dismiss"
            onPress={() => {
              dictation.dismiss()
            }}
          />
        </View>
      )}
    </View>
  )
}

/** Keys that type rather than act, where Space must stay a space. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
    ) != null ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  )
}

/**
 * Space is push-to-talk anywhere on the page while dictation is on: held, it
 * holds the button; released, or when the window loses focus, it lets go. It
 * listens before anything else on the page, so the key it takes goes nowhere
 * else — no scroll, no click on a focused button, no player grabbed on a
 * focused field. It leaves Space alone while `talks` is off (the field is
 * drawing a play or dragging a player), for typing, and with a modifier.
 */
function useSpaceToTalk(
  active: boolean,
  talks: boolean,
  keys: RefObject<{ hold: () => void; release: () => void }>
): void {
  const now = useRef(talks)
  now.current = talks
  useEffect(() => {
    if (!active) return
    let talking = false
    const letGo = (): void => {
      if (!talking) return
      talking = false
      keys.current.release()
    }
    const down = (event: KeyboardEvent): void => {
      if (
        event.key !== ' ' ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        typing(event.target) ||
        (!now.current && !talking)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat || talking) return
      talking = true
      keys.current.hold()
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key !== ' ' || !talking) return
      event.preventDefault()
      event.stopPropagation()
      letGo()
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', letGo)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', letGo)
      letGo()
    }
  }, [active, keys])
}
