import React, { useEffect, useRef, useState } from 'react'
import { Animated, Modal, Platform, Text, View } from 'react-native'

import { dictationModelOf } from '../../common/api'
import { Checkbox } from '../components/Checkbox'
import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { dictationOn } from './dictationPlatform'
import type { Dictation, DictationButtonProps } from './dictationTypes'
import { MODAL_ORIENTATIONS } from './modalOrientations'
import { ControlBackdrop } from './ScoringControlArt'
import {
  CONTROL_COLORS,
  CONTROL_HEIGHT,
  controlFrame,
  DICTATION_LOG_HEIGHT,
  DICTATION_LOG_LINE_HEIGHT,
  DICTATION_LOG_LINES
} from './scoringControlStyle'
import { ScoringButton } from './ScoringSheet'
import type { DictationQuestion } from './scoringTypes'
import { useSpaceToTalk } from './spaceToTalk'
import { useDictation } from './useDictation'

/** A press shorter than this is a tap: it switches dictation off. */
export const TAP_MS = 300
/**
 * How soon a failed health check is asked again. The button stays hidden
 * until one succeeds.
 */
const HEALTH_RETRY_MS = 1000
/** The log shows at most this many lines; older ones scroll off the top. */
export const LOG_LINES = DICTATION_LOG_LINES
const LINE_HEIGHT = DICTATION_LOG_LINE_HEIGHT

interface LogEntry {
  key: number
  kind: 'said' | 'play' | 'message'
  text: string
}

export interface DictationControls {
  control: React.ReactElement | null
  log: React.ReactElement | null
  /** Whether dictation is on, and switching it, for a screen handing it over. */
  enabled: boolean
  setEnabled: (on: boolean) => void
  /** The hook itself, for a screen that shows the words and questions itself. */
  dictation: Dictation
}

/**
 * Dictation as two pieces for two places. On the scoring screen they are the
 * microphone pill that sits above Bunt and Swing and the log in the top-left
 * corner; on the roster screen, the round button in the bottom bar, whose
 * words and questions the screen's chat shows instead of a log. Both come
 * from the one hook that owns the socket.
 */
export function useDictationControls(
  props: DictationButtonProps
): DictationControls {
  const theme = useTheme()
  const [available, setAvailable] = useState(false)
  const [offered, setOffered] = useState<readonly string[]>([])
  const {
    shape = 'pill',
    size = CONTROL_HEIGHT,
    startEnabled = false,
    scope,
    target,
    contextOf,
    health,
    url,
    gameId,
    session,
    log: actions,
    problem,
    note,
    question,
    played,
    undone,
    refused,
    onAnswer,
    onDismissQuestion,
    spaceTalks = true,
    suspended,
    onActions,
    model,
    openSocket,
    openMicrophone,
    token,
    tapMs = TAP_MS,
    tailMs,
    lingerMs = LOG_LINGER_MS
  } = props
  const dictation = useDictation({
    url,
    gameId,
    scope,
    target,
    contextOf,
    session,
    log: actions,
    onActions,
    // The model settings show checked: the pick, or the default when there
    // is none, and one this server no longer offers falls back rather than
    // being refused on every sentence.
    model: dictationModelOf(model, offered),
    tailMs,
    token,
    openSocket,
    openMicrophone
  })
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (): void => {
      health().then(
        reply => {
          if (!live) return
          setAvailable(reply.dictation)
          setOffered(reply.dictationModels)
        },
        () => {
          if (!live) return
          timer = setTimeout(ask, HEALTH_RETRY_MS)
        }
      )
    }
    ask()
    return () => {
      live = false
      clearTimeout(timer)
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
  useSpaceToTalk(
    available && dictation.enabled && suspended !== true,
    spaceTalks,
    keys
  )
  const { setEnabled } = dictation
  useEffect(() => {
    if (suspended === true) setEnabled(false)
  }, [suspended, setEnabled])
  // Handed over switched on: on once the server is known to dictate, once.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !available || !startEnabled || suspended === true)
      return
    started.current = true
    setEnabled(true)
  }, [available, startEnabled, suspended, setEnabled])
  const entries = useLog(
    dictation,
    problem?.message,
    note,
    played,
    undone,
    refused
  )
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
  const handle = { enabled: dictation.enabled, setEnabled, dictation }
  if (!available || !dictationOn(Platform.OS))
    return { control: null, log: null, ...handle }

  const { enabled, connected, holding, busy, ask } = dictation
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
        if (pressed.current === since) keys.current.hold(since)
      }, tapMs)
  }
  const finishPress = (): void => {
    const since = endPress()
    if (since == null) return
    if (!enabled) dictation.setEnabled(true)
    else if (Date.now() - since < tapMs) dictation.setEnabled(false)
    else dictation.release()
  }
  const status = !enabled
    ? null
    : !connected
      ? lstrings.dictation_connecting
      : holding
        ? lstrings.dictation_listening
        : busy
          ? lstrings.dictation_working
          : lstrings.dictation_push
  const kind = !enabled ? 'micOff' : holding ? 'micLive' : 'micOn'
  const round = shape === 'round'
  const statusText = status != null && (
    <Text
      accessibilityLabel={lstrings.dictation_status}
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
  )
  const button = (
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
  // The round button's status sits over it, centred on one line, on a dark
  // chip so it reads over the list it may cover; its question is the
  // screen's to show.
  const control = round ? (
    <View pointerEvents="box-none">
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          bottom: '100%',
          left: -80,
          right: -80,
          alignItems: 'center',
          paddingBottom: 2
        }}
      >
        {statusText !== false && (
          <View
            style={{
              borderRadius: 8,
              paddingHorizontal: 6,
              backgroundColor: 'rgba(0, 0, 0, 0.6)'
            }}
          >
            {statusText}
          </View>
        )}
      </View>
      {button}
    </View>
  ) : (
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
        {statusText}
      </View>
      {button}
    </View>
  )
  // Shown while dictation is on, and after it goes off with something to say
  // about why — a refused microphone; and, so it does not keep the scoreboard
  // under it hidden, only while something is said or asked and for a while
  // after its last new line.
  const showLog =
    !round &&
    entries.length > 0 &&
    (enabled || entries.at(-1)?.kind === 'message') &&
    linger !== 'gone'
  const log = !showLog ? null : (
    <Animated.View
      accessibilityLiveRegion="polite"
      accessibilityLabel={lstrings.dictation_log}
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
                  ? lstrings.dictation_said
                  : entry.kind === 'play'
                    ? lstrings.dictation_play
                    : lstrings.dictation_message
            }
            // Two columns: what was said on the right, in white; what was
            // done on the left, in the log's yellow.
            style={{
              textAlign: entry.kind === 'said' ? 'right' : 'left',
              color:
                entry.kind === 'said'
                  ? SAID_COLOR
                  : entry.kind === 'message'
                    ? MESSAGE_COLOR
                    : theme.scoringCountdownColor,
              fontFamily:
                entry.kind === 'said'
                  ? theme.regularTextFont
                  : theme.semiBoldTextFont,
              fontStyle: entry.kind === 'said' ? 'italic' : 'normal',
              fontSize: 14,
              lineHeight: LINE_HEIGHT
            }}
          >
            {entry.text}
          </Text>
        )
      })}
    </Animated.View>
  )
  return { control, log, ...handle }
}

/**
 * The log's entries: each hold's words as they are heard, then the plays the
 * sentence made, then any message. The panel shows four lines. Twelve entries
 * are kept, so a sentence and what it scored stay together, and the oldest
 * are dropped past that.
 */
function useLog(
  dictation: ReturnType<typeof useDictation>,
  problem: string | undefined,
  note: string | undefined,
  played: DictationButtonProps['played'],
  undone: DictationButtonProps['undone'],
  refused: DictationButtonProps['refused']
): LogEntry[] {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const next = useRef(0)
  const said = useRef<number | null>(null)
  const add = (kind: LogEntry['kind'], text: string): number => {
    const key = next.current++
    setEntries(list => [...list, { key, kind, text }].slice(-LOG_LINES * 3))
    return key
  }
  // A hold begins a new line of words; what is heard fills it in.
  useEffect(() => {
    if (dictation.holding)
      said.current = add('said', lstrings.dictation_ellipsis)
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
  useEffect(() => {
    if (note != null) add('message', note)
  }, [note])
  // An undo is logged ahead of the plays that replaced it, as it happened.
  const shownUndo = useRef<number | null>(null)
  useEffect(() => {
    if (undone == null || undone.id === shownUndo.current) return
    shownUndo.current = undone.id
    add('play', undone.line)
  }, [undone])
  const shownRefusal = useRef<number | null>(null)
  useEffect(() => {
    if (refused == null || refused.id === shownRefusal.current) return
    shownRefusal.current = refused.id
    add('message', refused.message)
  }, [refused])
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

/** What the scorer said, in the log's right-hand column. */
export const SAID_COLOR = '#FFFFFF'
/** A message, told apart from the yellow plays; 5:1 on the log's brown. */
export const MESSAGE_COLOR = '#FFC9BD'

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

/** The LLM's question: one button per option, and a dismissal. */
export function AskCard(props: {
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
      accessibilityLabel={lstrings.dictation_question}
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
        label={lstrings.dictation_dismiss_question}
        text={lstrings.dictation_neither}
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
          accessibilityLabel={lstrings.dictation_question}
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
              <Checkbox
                key={`${index}:${choice.label}`}
                label={choice.label}
                checked={on}
                onPress={() => {
                  setPicks(
                    on
                      ? picks.filter(pick => pick !== index)
                      : [...picks, index]
                  )
                }}
              />
            )
          })}
          {question.pick != null && (
            <ScoringButton
              label={lstrings.dictation_record}
              text={
                picks.length === 0
                  ? lstrings.dictation_record_nobody
                  : lstrings.dictation_record
              }
              onPress={() => {
                onAnswer({ picks })
              }}
            />
          )}
          <ScoringButton
            label={lstrings.dictation_dismiss_question}
            text={lstrings.dictation_dismiss_score}
            onPress={onDismiss}
          />
        </View>
      </View>
    </Modal>
  )
}
