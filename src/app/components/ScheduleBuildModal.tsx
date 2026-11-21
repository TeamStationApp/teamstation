import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  Text,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { isRecord } from '../../common/groupCreation'
import type {
  PreviewRequest,
  SchedulePreview
} from '../../common/schedulePreviews'
import {
  type EngineDecision,
  EngineFailureError,
  type EngineLimit
} from '../../common/scheduler/wire'
import { developBuild } from '../platform/developBuild'
import {
  type BuildLog,
  type BuildLogAction,
  FULL_LOG,
  FULL_LOG_BREAK,
  limitText,
  lineText,
  logClock,
  logReducer,
  startLog,
  ticking
} from '../scheduling/buildLog'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { Modal } from './Modal'

/** Where a build stands, as the modal shows it. */
export type ScheduleBuildState =
  | {
      kind: 'building'
      /**
       * The admin chose to use the best schedule at a limit that had none
       * yet, so the solver's first schedule will be used, if it comes
       * within one more time limit.
       */
      awaitingFirst?: boolean
    }
  | {
      /** The solver's time limit passed before it proved its best. */
      kind: 'limit'
      /** The solve time so far, not counting time spent waiting here. */
      solvedMs: number
      /** The best schedule's games, or null while none has been found. */
      bestGames: number | null
      boundGames: number
    }
  | { kind: 'noSolver'; reason: string }
  | { kind: 'failed'; message: string }

/** Under the title once the admin uses a limit's best before there is one. */
export const AWAITING_FIRST =
  'Waiting for the solver’s first schedule, which will be used as soon as it is found. If none is found within another time limit, the build stops.'

/** The log's line for the same choice. */
export const USING_FIRST = 'Using the first schedule found'

/** How many lines of the log the modal shows at once. */
export const LOG_ROWS = 4

/**
 * A build of the league's schedule, in a card in the middle of the screen:
 * its log in a box four lines high, as a terminal shows it (the first line
 * on the bottom row, each new one pushing the others up, scrolled smoothly),
 * with each running step's time ticking each second; Cancel while it runs;
 * and, at the time limit, whether to go on. A new line, or a line that grows
 * while the box is at its foot, scrolls back to the foot; scrolled up, the
 * admin can read earlier lines until the next one comes. The whole log, every
 * step's start and end, is also in the modal for tests and timing logs to
 * read, hidden from screen readers: on the web always, and on a phone only in
 * a develop build, `driverLog`.
 */
export function ScheduleBuildModal({
  state,
  log,
  onCancel,
  onContinue,
  onUse,
  onClose,
  driverLog = developBuild
}: {
  state: ScheduleBuildState
  log: BuildLog
  onCancel: () => void
  onContinue: () => void
  onUse: () => void
  onClose: () => void
  /**
   * Whether a phone carries the whole log for the end-to-end drivers: a
   * develop build, which the test phones run. The log is a test id, sent to
   * native whole on every line, so a stable build never carries it.
   */
  driverLog?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const box = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const lines = log.lines
  // The whole log, built again only when a line is logged.
  const web = Platform.OS === 'web'
  const carried = web || driverLog
  const full = useMemo(
    () =>
      carried
        ? [FULL_LOG, ...log.transcript.map(lineText)].join(
            web ? '\n' : FULL_LOG_BREAK
          )
        : '',
    [log.transcript, web, carried]
  )
  // Whether the box is at its foot, or on its way there; how many lines it
  // last scrolled to; and where the last scroll left it.
  const atFoot = useRef(true)
  const scrolledTo = useRef(0)
  const scrolledY = useRef(0)
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const up = contentOffset.y < scrolledY.current
    scrolledY.current = contentOffset.y
    // Within half a line of the foot is at it. Only a scroll up leaves it:
    // the box's own smooth scroll to a new line passes through offsets short
    // of the foot on its way down, and is still at its foot.
    if (
      contentOffset.y + layoutMeasurement.height >=
      contentSize.height - theme.rem(LINE_REM) / 2
    )
      atFoot.current = true
    else if (up) atFoot.current = false
  }
  const onContentSizeChange = (): void => {
    if (lines.length === scrolledTo.current && !atFoot.current) return
    scrolledTo.current = lines.length
    atFoot.current = true
    box.current?.scrollToEnd({ animated: true })
  }
  const title =
    state.kind === 'building'
      ? 'Building schedule'
      : state.kind === 'limit'
        ? 'Time limit reached'
        : state.kind === 'noSolver'
          ? 'This device can’t run the scheduler'
          : 'The schedule couldn’t be built'
  const ended = state.kind === 'noSolver' || state.kind === 'failed'
  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={ended ? onClose : onCancel}
    >
      <View style={styles.scrim}>
        <View
          style={styles.card}
          accessibilityViewIsModal
          testID="schedule-build-modal"
        >
          <Text accessibilityRole="header" style={styles.heading}>
            {title}
          </Text>
          {state.kind === 'building' && state.awaitingFirst === true && (
            <Text style={styles.text}>{AWAITING_FIRST}</Text>
          )}
          {state.kind === 'limit' && (
            <Text style={styles.text}>{limitText(state)}</Text>
          )}
          {state.kind === 'noSolver' && (
            <Text style={styles.text}>{state.reason}</Text>
          )}
          {state.kind === 'failed' && (
            <Text style={styles.text}>{state.message}</Text>
          )}
          <ScrollView
            ref={box}
            style={styles.log}
            testID="schedule-build-log"
            scrollEventThrottle={50}
            onScroll={onScroll}
            onContentSizeChange={onContentSizeChange}
          >
            {/* A box of space above the lines: the first sits on the bottom
                row, and each new one scrolls the rest up. */}
            <View style={styles.logRoom} />
            <LogLines log={log} style={styles.line} />
          </ScrollView>
          {/* The whole log, for the drivers, never for a screen reader. The
              web's drivers read the page's text content, so there it is a
              text the page never lays out: find in page, a selection, a copy
              and a screen reader all pass over it. A phone's read the
              accessibility tree, which
              leaves out what screen readers are told to skip, so there it is
              the test id of an empty view: one with no text or label, which
              VoiceOver and TalkBack pass over and never read the id of;
              only a develop build's, as a stable build has no drivers. */}
          {web ? (
            <Text
              testID="schedule-build-log-full"
              aria-hidden
              selectable={false}
              style={styles.fullLogText}
            >
              {full}
            </Text>
          ) : (
            carried && (
              <View testID={full} collapsable={false} style={styles.fullLog} />
            )
          )}
          {state.kind === 'limit' && (
            <>
              <Button label="Continue processing" onPress={onContinue} />
              <Button
                label="Use this schedule"
                kind="secondary"
                onPress={onUse}
              />
            </>
          )}
          {ended ? (
            <Button label="Close" kind="secondary" onPress={onClose} />
          ) : (
            <Button label="Cancel" kind="secondary" onPress={onCancel} />
          )}
        </View>
      </View>
    </Modal>
  )
}

/**
 * The box's lines, each running step's time ticking each second: only these
 * re-render on the clock, not the modal around them.
 */
function LogLines({
  log,
  style
}: {
  log: BuildLog
  style: ReturnType<typeof getStyles>['line']
}): React.ReactElement {
  const [now, setNow] = useState(() => Date.now())
  const runs = ticking(log)
  useEffect(() => {
    if (!runs) return
    const timer = setTimeout(
      () => {
        setNow(Date.now())
      },
      1000 - (logClock(log, Date.now()) % 1000)
    )
    return () => {
      clearTimeout(timer)
    }
  }, [log, now, runs])
  const { lines } = logReducer(log, { type: 'tick', at: now })
  return (
    <>
      {lines.map((line, i) => (
        <Text key={i} selectable style={style}>
          {lineText(line)}
        </Text>
      ))}
    </>
  )
}

/**
 * Runs a league's schedule builds in the modal: `run` builds a preview on
 * this device and resolves it, or nothing when the build was canceled or
 * failed, which the modal then says. Cancel stops the build and discards
 * its preparation, unless the server had already stored its result, which
 * is then handed back; at the time limit the admin chooses to go on, use the
 * best schedule found, or cancel. A refusal with details for the screen,
 * such as seasons that already have games, is thrown for it to answer.
 */
export function useScheduleBuild(
  client: TeamStationClient,
  leagueId: string
): {
  run: (request: PreviewRequest) => Promise<SchedulePreview | undefined>
  running: boolean
  modal: React.ReactElement | null
} {
  const [shown, setShown] = useState<{
    state: ScheduleBuildState
    log: BuildLog
  }>()
  const [running, setRunning] = useState(false)
  const controller = useRef<AbortController>(undefined)
  const decide = useRef<(decision: EngineDecision) => void>(undefined)
  /** The log after `action`, now; and the state, when given. */
  const logged = (
    action: BuildLogAction,
    state?: (current: ScheduleBuildState) => ScheduleBuildState
  ): void => {
    setShown(current =>
      current == null
        ? current
        : {
            state: state == null ? current.state : state(current.state),
            log: logReducer(current.log, action)
          }
    )
  }
  const answer = (decision: EngineDecision): void => {
    const resolve = decide.current
    decide.current = undefined
    resolve?.(decision)
  }
  // A screen that goes away mid-build cancels it: the engine stops (a
  // pause at the time limit is answered `cancel`), its preparation is
  // discarded, and nothing it built is handed back.
  const mounted = useRef(true)
  // Called once the modal has shown what was logged before it was set: a
  // finished build's last line, the upload's end, is put on screen (and so
  // in the full log the drivers keep) before the modal closes.
  const painted = useRef<() => void>(undefined)
  useEffect(() => {
    const resolve = painted.current
    painted.current = undefined
    resolve?.()
  }, [shown])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
      const resolve = decide.current
      decide.current = undefined
      resolve?.('cancel')
      painted.current?.()
      painted.current = undefined
    }
  }, [])
  const run = useCallback(
    async (request: PreviewRequest): Promise<SchedulePreview | undefined> => {
      if (controller.current != null) return undefined
      const abort = new AbortController()
      controller.current = abort
      setRunning(true)
      setShown({ state: { kind: 'building' }, log: startLog(Date.now()) })
      const show = (state: ScheduleBuildState): void => {
        if (!abort.signal.aborted && mounted.current)
          logged({ type: 'stop', at: Date.now() }, () => state)
      }
      try {
        const preview = await client.buildSchedulePreview(leagueId, request, {
          signal: abort.signal,
          onProgress: event => {
            if (abort.signal.aborted) return
            // The first schedule, or the step after it, ends the wait for one.
            const found =
              event.kind === 'phase' ||
              (event.kind === 'progress' && event.incumbentGames > 0)
            logged({ type: 'event', event, at: Date.now() }, state =>
              found && state.kind === 'building' && state.awaitingFirst === true
                ? { kind: 'building' }
                : state
            )
          },
          onLimit: async (limit: EngineLimit) =>
            await new Promise<EngineDecision>(resolve => {
              decide.current = resolve
              if (abort.signal.aborted || !mounted.current) return
              logged({ type: 'pause', at: Date.now() }, () => ({
                kind: 'limit',
                solvedMs: limit.solvedMs,
                bestGames: limit.bestGames,
                boundGames: limit.boundGames
              }))
            })
        })
        // The upload's end is logged as the preview returns, so closing at
        // once would batch it away unseen: the modal closes a render later.
        // Only Cancel, which aborts, closes it before then.
        if (mounted.current && !abort.signal.aborted)
          await new Promise<void>(resolve => {
            painted.current = resolve
            setShown(current => (current == null ? current : { ...current }))
          })
        // The screen went away: nothing it built is handed back.
        if (!mounted.current) return undefined
        setShown(undefined)
        // A preview that comes back after Cancel was already stored, and the
        // server kept it, so it opens rather than lingering unseen.
        return preview
      } catch (failure) {
        if (
          abort.signal.aborted ||
          (failure instanceof EngineFailureError &&
            failure.failure === 'canceled')
        ) {
          if (mounted.current) setShown(undefined)
          return undefined
        }
        if (
          failure instanceof EngineFailureError &&
          failure.failure === 'noSolver'
        ) {
          show({ kind: 'noSolver', reason: failure.message })
          return undefined
        }
        if (failure instanceof HttpError && isRecord(failure.details)) {
          // A refusal the screen answers, such as seasons that already
          // have games.
          setShown(undefined)
          throw failure
        }
        show({
          kind: 'failed',
          message:
            failure instanceof Error && failure.message !== ''
              ? failure.message
              : 'Try again.'
        })
        return undefined
      } finally {
        decide.current = undefined
        controller.current = undefined
        if (mounted.current) setRunning(false)
      }
    },
    [client, leagueId]
  )
  const modal =
    shown == null ? null : (
      <ScheduleBuildModal
        state={shown.state}
        log={shown.log}
        onCancel={() => {
          controller.current?.abort()
          answer('cancel')
          setShown(undefined)
        }}
        onContinue={() => {
          answer('continue')
          logged({ type: 'resume', at: Date.now() }, () => ({
            kind: 'building'
          }))
        }}
        onUse={() => {
          answer('use')
          const at = Date.now()
          setShown(current => {
            if (current == null) return current
            const log = logReducer(current.log, { type: 'resume', at })
            // With no schedule found yet, the engine waits for its first.
            if (
              current.state.kind === 'limit' &&
              current.state.bestGames == null
            )
              return {
                state: { kind: 'building', awaitingFirst: true },
                log: logReducer(log, { type: 'note', text: USING_FIRST, at })
              }
            return { state: { kind: 'building' }, log }
          })
        }}
        onClose={() => {
          setShown(undefined)
        }}
      />
    )
  return { run, running, modal }
}

/** A log line's height, in rem: each row of the box. */
const LINE_REM = 1.25

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.rem(1),
    backgroundColor: theme.overlayBackgroundColor
  },
  card: {
    width: '100%',
    maxWidth: theme.rem(32),
    maxHeight: '80%',
    padding: theme.rem(1.5),
    gap: theme.rem(0.75),
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem)
  },
  heading: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25)
  },
  text: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  },
  log: { height: theme.rem(LINE_REM * LOG_ROWS), flexGrow: 0 },
  logRoom: { height: theme.rem(LINE_REM * LOG_ROWS) },
  line: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    lineHeight: theme.rem(LINE_REM),
    fontVariant: ['tabular-nums' as const]
  },
  // On a phone's screen, for the drivers that read the accessibility tree,
  // but one pixel.
  fullLog: {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    overflow: 'hidden' as const
  },
  // Never laid out on the web: in the page's text content alone.
  fullLogText: {
    display: 'none' as const,
    userSelect: 'none' as const,
    pointerEvents: 'none' as const
  }
}))
