import React, { type RefObject, useEffect, useRef, useState } from 'react'
import { Animated, Modal, Pressable, Text, View } from 'react-native'

import { dictationModelOf } from '../../common/api'
import { useTheme } from '../theme/ThemeContext'
import type { DictationButtonProps } from './dictationTypes'
import { MODAL_ORIENTATIONS } from './modalOrientations'
import { ControlBackdrop } from './ScoringControlArt'
import {
  CONTROL_COLORS,
  controlFrame,
  DICTATION_LOG_HEIGHT,
  DICTATION_LOG_LINE_HEIGHT,
  DICTATION_LOG_LINES
} from './scoringControlStyle'
import { ScoringButton } from './ScoringSheet'
import type { DictationQuestion } from './scoringTypes'
import { useDictation } from './useDictation'

/** A press shorter than this is a tap: it switches dictation off. */
export const TAP_MS = 300
/** The log shows at most this many lines; older ones scroll off the top. */
export const LOG_LINES = DICTATION_LOG_LINES
const LINE_HEIGHT = DICTATION_LOG_LINE_HEIGHT

interface LogEntry {
  key: number
  kind: 'said' | 'play' | 'message'
  text: string
}

/**
 * Dictation on the scoring screen, as two pieces for two places: the
 * microphone button that sits above Bunt and Swing, and the log that sits in
 * the top-left corner. Both come from the one hook that owns the socket.
 */
export function useDictationControls(props: DictationButtonProps): {
  control: React.ReactElement | null
  log: React.ReactElement | null
} {
  const theme = useTheme()
  const [available, setAvailable] = useState(false)
  const [offered, setOffered] = useState<readonly string[]>([])
  const {
    health,
    url,
    gameId,
    session,
    log: actions,
    problem,
    question,
    played,
    onAnswer,
    onDismissQuestion,
    spaceTalks = true,
    onActions,
    model,
    openSocket,
    openMicrophone,
    tapMs = TAP_MS,
    tailMs,
    lingerMs = LOG_LINGER_MS
  } = props
  const dictation = useDictation({
    url,
    gameId,
    session,
    log: actions,
    onActions,
    // The model settings show checked: the pick, or the default when there
    // is none, and one this server no longer offers falls back rather than
    // being refused on every sentence.
    model: dictationModelOf(model, offered),
    tailMs,
    openSocket,
    openMicrophone
  })
  useEffect(() => {
    let live = true
    health().then(
      reply => {
        if (!live) return
        setAvailable(reply.dictation)
        setOffered(reply.dictationModels)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [health])
  const keys = useRef<{
    hold: (since?: number) => void
    release: () => void
  }>({ hold: () => {}, release: () => {} })
  keys.current = {
    hold: since => {
      if (dictation.enabled && dictation.connected && !dictation.busy)
        dictation.hold(since)
    },
    release: dictation.release
  }
  useSpaceToTalk(available && dictation.enabled, spaceTalks, keys)
  const entries = useLog(dictation, problem?.message, played)
  const linger = useLinger(
    entries,
    dictation.holding ||
      dictation.busy ||
      dictation.ask != null ||
      question != null,
    lingerMs
  )
  const fade = useRef(new Animated.Value(1)).current
  useEffect(() => {
    Animated.timing(fade, {
      toValue: linger === 'fading' ? 0 : 1,
      duration: linger === 'fading' ? LOG_FADE_MS : 0,
      useNativeDriver: false
    }).start()
  }, [fade, linger])
  const pressed = useRef<number | null>(null)
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
  if (!available) return { control: null, log: null }

  const { enabled, connected, holding, busy, ask } = dictation
  const ready = enabled && connected && !busy
  const status = !enabled
    ? null
    : !connected
      ? 'Connecting…'
      : holding
        ? 'Listening…'
        : busy
          ? 'Working it out…'
          : 'Push to talk'
  const kind = !enabled ? 'micOff' : holding ? 'micLive' : 'micOn'
  const control = (
    <View pointerEvents="box-none" style={{ gap: 6 }}>
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          bottom: '100%',
          // Wider than the column, so the words sit centred on one line even
          // where the column is narrower than they are.
          left: -60,
          right: -60,
          alignItems: 'center',
          paddingBottom: 4
        }}
      >
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 60,
            gap: 6,
            alignItems: 'flex-end',
            paddingBottom: 6
          }}
        >
          {ask != null && (
            <AskCard
              question={ask.question}
              options={ask.options.map(option => option.label)}
              onChoose={index => {
                dictation.answer(index)
              }}
              onDismiss={() => {
                dictation.dismiss()
              }}
            />
          )}
        </View>
        {ask == null && question != null && (
          <ScreenQuestion
            key={`${question.transcript}:${question.question}`}
            question={question}
            onAnswer={answer => onAnswer?.(answer)}
            onDismiss={() => onDismissQuestion?.()}
          />
        )}
        {status != null && (
          <Text
            accessibilityLabel="Dictation status"
            accessibilityLiveRegion="polite"
            numberOfLines={1}
            style={{
              color: theme.scoringInstructionText,
              fontFamily: theme.semiBoldTextFont,
              fontSize: 13,
              textShadowColor: '#000000',
              textShadowRadius: 3
            }}
          >
            {status}
          </Text>
        )}
      </View>
      <View
        accessibilityRole="button"
        accessibilityLabel="Dictation"
        aria-pressed={enabled}
        focusable
        onPointerDown={event => {
          const since = Date.now()
          pressed.current = since
          const target = event.currentTarget as unknown as {
            setPointerCapture?: (id: number) => void
          }
          try {
            // Keeps the release on this button when the finger drifts off it.
            target.setPointerCapture?.(event.nativeEvent.pointerId)
          } catch {
            /* A pointer the browser no longer knows; the press still counts. */
          }
          if (!ready) return
          if (tapMs <= 0) dictation.hold(since)
          else
            pressTimer.current = setTimeout(() => {
              if (pressed.current === since) keys.current.hold(since)
            }, tapMs)
        }}
        onPointerUp={() => {
          const since = endPress()
          if (since == null) return
          if (!enabled) dictation.setEnabled(true)
          else if (Date.now() - since < tapMs) dictation.setEnabled(false)
          else dictation.release()
        }}
        onPointerCancel={() => {
          endPress()
          dictation.release()
        }}
        onKeyDown={event => {
          const key = (event.nativeEvent as { key?: string }).key
          if (key === 'Enter') dictation.setEnabled(!enabled)
        }}
        style={{
          ...controlFrame,
          borderColor: CONTROL_COLORS[kind].border,
          backgroundColor: CONTROL_COLORS[kind].bottom,
          opacity: enabled && !ready && !holding ? 0.7 : 1
        }}
      >
        <ControlBackdrop kind={kind} />
        <MicrophoneIcon crossed={!enabled} color={CONTROL_COLORS[kind].text} />
      </View>
    </View>
  )
  // Shown while dictation is on, and after it goes off with something to say
  // about why — a refused microphone; and, so it does not keep the scoreboard
  // under it hidden, only while something is said or asked and for a while
  // after its last new line.
  const showLog =
    entries.length > 0 &&
    (enabled || entries.at(-1)?.kind === 'message') &&
    linger !== 'gone'
  const log = !showLog ? null : (
    <Animated.View
      accessibilityLiveRegion="polite"
      accessibilityLabel="Dictation log"
      style={{
        opacity: fade,
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 2,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        paddingHorizontal: 8,
        paddingVertical: 4,
        height: DICTATION_LOG_HEIGHT,
        overflow: 'hidden',
        justifyContent: 'flex-end'
      }}
    >
      {entries.map((entry, index) => {
        const latest = !entries
          .slice(index + 1)
          .some(later => later.kind === entry.kind)
        return (
          <Text
            key={entry.key}
            accessibilityLabel={
              !latest
                ? undefined
                : entry.kind === 'said'
                  ? 'Dictated text'
                  : entry.kind === 'play'
                    ? 'Dictated play'
                    : 'Dictation message'
            }
            style={{
              color:
                entry.kind === 'message'
                  ? theme.scoringCountdownColor
                  : theme.scoringInstructionText,
              fontFamily:
                entry.kind === 'said'
                  ? theme.regularTextFont
                  : theme.semiBoldTextFont,
              fontStyle: entry.kind === 'said' ? 'italic' : 'normal',
              fontSize: 14,
              lineHeight: LINE_HEIGHT
            }}
          >
            {entry.kind === 'play' ? `• ${entry.text}` : entry.text}
          </Text>
        )
      })}
    </Animated.View>
  )
  return { control, log }
}

/**
 * The log's entries: each hold's words as they are heard, then the plays the
 * sentence made, then any message — newest last, the oldest dropped once the
 * log could only ever show more than it holds.
 */
function useLog(
  dictation: ReturnType<typeof useDictation>,
  problem: string | undefined,
  played: DictationButtonProps['played']
): LogEntry[] {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const next = useRef(0)
  const said = useRef<number | null>(null)
  const add = (kind: LogEntry['kind'], text: string): number => {
    const key = next.current++
    setEntries(list => [...list, { key, kind, text }].slice(-12))
    return key
  }
  // A hold begins a new line of words; what is heard fills it in.
  useEffect(() => {
    if (dictation.holding) said.current = add('said', '…')
  }, [dictation.holding])
  useEffect(() => {
    const key = said.current
    const text = dictation.text
    if (key == null || text == null || text === '') return
    setEntries(list =>
      list.map(entry => (entry.key === key ? { ...entry, text } : entry))
    )
  }, [dictation.text])
  useEffect(() => {
    if (dictation.message != null) add('message', dictation.message)
  }, [dictation.message])
  useEffect(() => {
    if (problem != null) add('message', problem)
  }, [problem])
  const shownPlay = useRef<number | null>(null)
  useEffect(() => {
    if (played == null || played.id === shownPlay.current) return
    shownPlay.current = played.id
    for (const line of played.lines) add('play', line)
  }, [played])
  useEffect(() => {
    if (!dictation.enabled) said.current = null
  }, [dictation.enabled])
  return entries
}

/** How long the log stays up after its last new line, and its fade. */
export const LOG_LINGER_MS = 8000
const LOG_FADE_MS = 400

/**
 * Whether the log is shown, fading, or gone: shown while `active` and for
 * `lingerMs` after the entries last changed, then faded out and removed.
 */
function useLinger(
  entries: readonly LogEntry[],
  active: boolean,
  lingerMs: number
): 'shown' | 'fading' | 'gone' {
  const [state, setState] = useState<'shown' | 'fading' | 'gone'>('shown')
  useEffect(() => {
    setState('shown')
    if (active) return
    const fade = setTimeout(() => {
      setState('fading')
    }, lingerMs)
    const gone = setTimeout(() => {
      setState('gone')
    }, lingerMs + LOG_FADE_MS)
    return () => {
      clearTimeout(fade)
      clearTimeout(gone)
    }
  }, [entries, active, lingerMs])
  return state
}

/** A microphone, crossed out while dictation is off. */
function MicrophoneIcon(props: {
  crossed: boolean
  color: string
}): React.ReactElement {
  const { crossed, color } = props
  return (
    <View pointerEvents="none">
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="9"
          y="3"
          width="6"
          height="11"
          rx="3"
          stroke={color}
          strokeWidth="2"
        />
        <path
          d="M5 11a7 7 0 0 0 14 0"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M12 18v3M8 21h8"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
        />
        {crossed && (
          <path
            d="M4 4l16 16"
            stroke={color}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        )}
      </svg>
    </View>
  )
}

/** The LLM's question: one button per option, and a dismissal. */
function AskCard(props: {
  question: string
  options: string[]
  onChoose: (index: number) => void
  onDismiss: () => void
}): React.ReactElement {
  const theme = useTheme()
  const { question, options, onChoose, onDismiss } = props
  return (
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
        {question}
      </Text>
      {options.map((label, index) => (
        <ScoringButton
          key={`${index}:${label}`}
          label={label}
          onPress={() => {
            onChoose(index)
          }}
        />
      ))}
      <ScoringButton
        label="Dismiss question"
        text="Neither — dismiss"
        onPress={onDismiss}
      />
    </View>
  )
}

/**
 * What the screen asks about a sentence it could not finish on its own: one
 * button per answer, or a toggle per runner and Record.
 */
function ScreenQuestion(props: {
  question: DictationQuestion
  onAnswer: (answer: { option?: number; picks?: number[] }) => void
  onDismiss: () => void
}): React.ReactElement {
  const theme = useTheme()
  const { question, onAnswer, onDismiss } = props
  const [picks, setPicks] = useState<number[]>([])
  // Modal: nothing else is scored until it is answered or dismissed, and a
  // stray tap beside it dismisses nothing.
  return (
    <Modal
      transparent
      animationType="fade"
      visible
      supportedOrientations={MODAL_ORIENTATIONS}
      onRequestClose={onDismiss}
    >
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          backgroundColor: 'rgba(0, 0, 0, 0.5)'
        }}
      >
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
            minWidth: 220,
            maxWidth: 420
          }}
        >
          <Text
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.semiBoldTextFont,
              fontSize: 16
            }}
          >
            {question.question}
          </Text>
          {question.options?.map((option, index) => (
            <ScoringButton
              key={`${index}:${option.label}`}
              label={option.label}
              onPress={() => {
                onAnswer({ option: index })
              }}
            />
          ))}
          {question.pick?.choices.map((choice, index) => {
            const on = picks.includes(index)
            return (
              <Pressable
                key={`${index}:${choice.label}`}
                accessibilityRole="checkbox"
                accessibilityLabel={choice.label}
                aria-checked={on}
                onPress={() => {
                  setPicks(
                    on
                      ? picks.filter(pick => pick !== index)
                      : [...picks, index]
                  )
                }}
                style={{
                  borderRadius: theme.rem(theme.radiusRem),
                  borderWidth: 2,
                  borderColor: on
                    ? theme.scoringOutColor
                    : theme.scoringInstructionBorder,
                  backgroundColor: on ? theme.scoringOutColor : 'transparent',
                  padding: 10
                }}
              >
                <Text
                  style={{
                    color: on
                      ? theme.scoringDecisionText
                      : theme.primaryTextColor,
                    fontFamily: theme.semiBoldTextFont
                  }}
                >
                  {on ? '✓ ' : ''}
                  {choice.label}
                </Text>
              </Pressable>
            )
          })}
          {question.pick != null && (
            <ScoringButton
              label="Record"
              text={picks.length === 0 ? 'Record — nobody out' : 'Record'}
              onPress={() => {
                onAnswer({ picks })
              }}
            />
          )}
          <ScoringButton
            label="Dismiss question"
            text="Dismiss — score nothing"
            onPress={onDismiss}
          />
        </View>
      </View>
    </Modal>
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
