import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import {
  Platform,
  Pressable,
  StatusBar,
  useWindowDimensions,
  View
} from 'react-native'

import {
  type BoxScore,
  type GameDetail,
  parseStoredGame
} from '../../common/api'
import type { GameSocketListener } from '../../common/gameSocket'
import { namesOf } from '../../common/replay/replayNames'
import {
  readReplaySource,
  replayScore,
  replaySourceOf
} from '../../common/replay/replaySource'
import {
  extendTimeline,
  isReplayable,
  type ReplayTimeline
} from '../../common/replay/replayTimeline'
import type { SessionContext, StoredGame } from '../../common/scoring/session'
import { Icon } from '../components/Icon'
import { SCORING_CAMERA } from '../field/BaseballScreen'
import type { ScreenRect } from '../field/catcherBounds'
import { FieldCanvas } from '../field/FieldCanvas'
import type { FieldPlayer } from '../field/fieldModel'
import { useFieldSurface } from '../field/useFieldSurface'
import { lstrings } from '../locales/strings'
import { scoringAudio } from '../scoring/scoringAudio'
import { CONTROL_COLORS } from '../scoring/scoringControlStyle'
import { scoringFieldPlayers } from '../scoring/scoringMotion'
import { scoreboardFor } from '../scoring/scoringSelectors'
import { ScoringButton } from '../scoring/ScoringSheet'
import { useScoringSheetTheme } from '../scoring/scoringSheetTheme'
import { scoringSurface as surface } from '../theme/scoringSurface'
import { ScopedThemeProvider } from '../theme/ThemeContext'
import { useNarrationPlayer } from './narrationPlayer'
import type { NarrationClient } from './narrationPlayerTypes'
import { NarrationQueue, type NarrationStep, PREFETCH } from './narrationQueue'
import { ReplayBoxScore } from './ReplayBoxScore'
import {
  catchingUp,
  noticeOpacity,
  ready,
  replayCard,
  type ReplayEvent,
  type ReplayMode,
  replayReducer,
  SLOT_MS,
  startReplay
} from './replayMachine'
import { ReplayPlayCard, type ReplayPlayCardProps } from './ReplayPlayCard'

/** The box score's column beside the field on a wide window. */
export const SIDE_DECK_WIDTH = 360
/** Of a tall window's height, what the field leaves below for the box score. */
export const DECK_SHARE = 0.45
/** On a wide window, what the field leaves below the catcher for the card. */
export const SIDE_CARD_ROOM = 150
const TICK_MS = 100
/** How often a fading rewind notice is drawn. */
const FADE_FRAME_MS = 33
/** While the socket is down, how often a live replay reads the game. */
export const POLL_MS = 5000

/** The app's game socket, as a live replay uses it. */
export interface ReplaySocket {
  readonly connected: boolean
  onStatus: (listener: (connected: boolean) => void) => () => void
  subscribe: (gameId: string, listener: GameSocketListener) => () => void
}

export interface ReplayClient extends NarrationClient {
  game: (gameId: string) => Promise<GameDetail>
  gameEvents: (gameId: string) => Promise<StoredGame>
  /** Who on this game the reader may open; a replay plays on without it. */
  boxScore?: (gameId: string) => Promise<BoxScore>
  /** Says, among other things, whether the server has an announcer. */
  health: () => Promise<{ narration?: boolean; replayPitchSec?: number }>
}

export interface GameReplayScreenProps {
  client: ReplayClient
  gameId: string
  onExit: () => void
  /** A name in the box score, opened: a line the reader may open. */
  onOpenPlayer?: (userId: string, name: string) => void
  /** The game has nothing to replay: show the game instead. */
  onNotReplayable: () => void
  /** The app's one game socket, which a live replay follows. */
  socket?: ReplaySocket
  /** How often to read the game while the socket is down. POLL_MS. */
  pollMs?: number
  /** The replay's clock; the screen's own in a test. */
  clock?: () => number
}

/** How far the rewind and pause buttons sit from the bottom and their side. */
export const FLOATING_MARGIN = 16

/** Rewind at the bottom left and pause at the bottom right: one look. */
export const FLOATING_BUTTON = {
  position: 'absolute',
  bottom: FLOATING_MARGIN,
  width: 56,
  height: 56,
  borderRadius: 28,
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: surface.active,
  borderWidth: 2,
  borderColor: surface.accent,
  shadowColor: '#000000',
  shadowOpacity: 0.4,
  shadowRadius: 6,
  shadowOffset: { width: 0, height: 2 },
  elevation: 6
} as const

/** What the speaker takes across, upper left, from the window's left edge. */
export const SPEAKER_RESERVE = 16 + 44 + 8

/** What Exit takes across, upper right, from the field column's right edge. */
export const EXIT_RESERVE = 16 + 76 + 8

/** The row Exit and the speaker sit in, under the safe area. */
export const CONTROLS_ROW = 56

/**
 * Where the field starts, from the window's top. When the 3D scoreboard
 * leaves room for the speaker on its left (when there is one) and for Exit
 * on its right, at the top; when it runs under either (a phone), under their
 * row, so they cover neither the board nor a fielder.
 */
export function fieldTop(
  board: ScreenRect | null,
  safeTop: number,
  /** The field column's right edge, inside its safe padding, where Exit ends. */
  width: number,
  /** The speaker is drawn: the announcer is offered. */
  speaker: boolean
): number {
  if (board == null) return 0
  const underSpeaker = speaker && board.x < SPEAKER_RESERVE
  const underExit = board.x + board.width > width - EXIT_RESERVE
  return underSpeaker || underExit ? safeTop + CONTROLS_ROW : 0
}

/**
 * How far the play, pause, rewind and announcer glyphs sit below their
 * box's middle: a phone's icon font draws them high, the web's centred.
 */
export function replayIconDrop(os: string): number {
  return os === 'ios' || os === 'android' ? 2 : 0
}

/** A glyph moved down by the platform's drop, to meet its button's centre. */
function Dropped(props: { children: React.ReactNode }): React.ReactElement {
  const drop = replayIconDrop(Platform.OS)
  return (
    <View
      testID="replay-icon"
      style={drop === 0 ? undefined : { transform: [{ translateY: drop }] }}
    >
      {props.children}
    </View>
  )
}

/** The field's framing for a window: the box score's share below it. */
export function replayLayout(
  width: number,
  height: number
): { side: boolean; bottomExtension: number; deckTop: number } {
  const side = width > height
  const bottomExtension = side
    ? SIDE_CARD_ROOM
    : Math.round(DECK_SHARE * height)
  return { side, bottomExtension, deckTop: height - bottomExtension }
}

/**
 * A game replayed in 3D, full screen and dark: the field, the play card
 * below the catcher, the box score below that, Exit and the speaker at the
 * top left, rewind at the bottom left and pause at the bottom right.
 */
/**
 * The lines a reader may open, by their scoring id: the box score's own answer,
 * so a replay offers exactly the names the box score does.
 */
export function openablePlayers(box: BoxScore): Map<number, string> {
  const players = new Map<number, string>()
  for (const line of [...box.batting, ...box.pitching]) {
    if (line.userId == null || !line.openable) continue
    for (const id of line.gumboIds) players.set(id, line.userId)
  }
  return players
}

export function GameReplayScreen(
  props: GameReplayScreenProps
): React.ReactElement {
  const theme = useScoringSheetTheme()
  const { client, gameId } = props
  // The shell hands a fresh callback on every render; the game is read once.
  const notReplayable = useRef(props.onNotReplayable)
  notReplayable.current = props.onNotReplayable
  const [loaded, setLoaded] = useState<{
    game: GameDetail
    timeline: ReplayTimeline
    mode: ReplayMode
    narration: boolean
    pitchSlotMs: number
    context: SessionContext
  } | null>(null)
  useEffect(() => {
    let live = true
    // A server that cannot say has no announcer to offer, and plays each
    // pitch at the default delay.
    const health = client.health().then(
      answer => ({
        announcer: answer.narration === true,
        pitchSlotMs: (answer.replayPitchSec ?? SLOT_MS.pitch / 1000) * 1000
      }),
      () => ({ announcer: false, pitchSlotMs: SLOT_MS.pitch })
    )
    Promise.all([readReplaySource(client, gameId), health])
      .then(([{ game, stored }, { announcer, pitchSlotMs }]) => {
        if (!live) return
        const source = replaySourceOf(game, stored)
        if (!isReplayable(game, game.replayable) || source == null) {
          notReplayable.current()
          return
        }
        setLoaded({
          game,
          timeline: source.timeline,
          mode: game.status === 'inProgress' ? 'live' : 'replay',
          narration: announcer,
          pitchSlotMs,
          context: source.context
        })
      })
      .catch(() => {
        if (live) notReplayable.current()
      })
    return () => {
      live = false
    }
  }, [client, gameId])
  return (
    <ScopedThemeProvider theme={theme}>
      <StatusBar barStyle="light-content" />
      {loaded == null ? (
        <View style={{ flex: 1, backgroundColor: surface.canvas }} />
      ) : (
        <ReplayView
          {...loaded}
          client={client}
          socket={props.socket}
          pollMs={props.pollMs ?? POLL_MS}
          onExit={props.onExit}
          onOpenPlayer={props.onOpenPlayer}
          clock={props.clock ?? Date.now}
        />
      )}
    </ScopedThemeProvider>
  )
}

function ReplayView(props: {
  client: ReplayClient
  socket?: ReplaySocket
  pollMs: number
  context: SessionContext
  game: GameDetail
  timeline: ReplayTimeline
  mode: ReplayMode
  narration: boolean
  /** The node's pitch delay, for whatever plays at replay pace. */
  pitchSlotMs: number
  onExit: () => void
  onOpenPlayer?: (userId: string, name: string) => void
  clock: () => number
}): React.ReactElement {
  const [openable, setOpenable] = useState<ReadonlyMap<number, string>>()
  const { client: boxClient, onOpenPlayer } = props
  const gameId = props.game.id
  useEffect(() => {
    if (onOpenPlayer == null) return
    let live = true
    Promise.resolve(boxClient.boxScore?.(gameId))
      .then(box => {
        if (live && box != null) setOpenable(openablePlayers(box))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [boxClient, gameId, onOpenPlayer])
  const [state, dispatch] = useReducer(replayReducer, undefined, () =>
    startReplay(
      props.mode,
      props.timeline,
      props.game.status === 'final',
      props.pitchSlotMs
    )
  )
  const { clock } = props
  useEffect(() => {
    const timer = setInterval(() => {
      dispatch({ type: 'TICK', now: clock() })
    }, TICK_MS)
    return () => {
      clearInterval(timer)
    }
  }, [clock])
  useLiveGame(props, state.timeline, state.gameOver, dispatch)
  const [muted, setMuted] = useState(true)
  useEffect(() => {
    scoringAudio.setEnabled(false)
    return () => {
      scoringAudio.setEnabled(true)
    }
  }, [])
  // The announcer: it reads each step as it is shown, and the replay waits
  // for it while the speaker is on.
  const player = useNarrationPlayer(props.client, props.game.id)
  const [unavailable, setUnavailable] = useState(false)
  const narration = useMemo(
    () =>
      new NarrationQueue(player.output, {
        speaking: speaking => {
          dispatch({ type: 'SPEAKING', speaking })
        },
        unavailable: () => {
          scoringAudio.setEnabled(false)
          setMuted(true)
          setUnavailable(true)
        }
      }),
    [player.output]
  )
  useEffect(
    () => () => {
      narration.dispose()
    },
    [narration]
  )
  useEffect(() => {
    narration.setMuted(muted)
  }, [narration, muted])
  useEffect(() => {
    narration.setPaused(state.paused)
  }, [narration, state.paused])
  const shownKey = state.shown?.key
  const { shownCount, narrations } = state
  // A step is read when it has something to say that it has not said since
  // the last rewind: a step that grows only by the scorer's close keeps its
  // sentence, and is not read twice, and every step a rewind queues again is
  // read again. A live view opens on the step the game stands at, which
  // counts as said.
  const { rewinds } = state
  const said = useRef(
    new Map<string, { text: string; rewinds: number }>(
      shownKey == null
        ? []
        : [[shownKey, { text: narrations.get(shownKey)?.text ?? '', rewinds }]]
    )
  )
  const saidSince = (key: string, text: string): boolean => {
    const entry = said.current.get(key)
    return entry?.text === text && entry.rewinds === rewinds
  }
  const fresh = (key: string): boolean => {
    const text = narrations.get(key)?.text ?? ''
    return text !== '' && !saidSince(key, text)
  }
  const spoken = useRef(`${shownKey}#${shownCount}`)
  // A rewind: the announcer stops, and the step before the half is not read
  // on the way. Declared before the effect that reads the shown step, so it
  // runs first.
  const rewound = useRef(rewinds)
  useEffect(() => {
    if (rewound.current === rewinds) return
    rewound.current = rewinds
    narration.interrupt()
    if (shownKey != null)
      said.current.set(shownKey, {
        text: narrations.get(shownKey)?.text ?? '',
        rewinds
      })
    spoken.current = `${shownKey}#${shownCount}`
    // Only a new rewind does this; the step shown is as it left it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narration, rewinds])
  const sentence =
    shownKey == null ? '' : (narrations.get(shownKey)?.text ?? '')
  // A live view hurrying to catch the scorer up reads only where it lands.
  const { hurrying } = state
  const behind = catchingUp(state)
  useEffect(() => {
    const id = `${shownKey}#${shownCount}`
    if (shownKey == null || spoken.current === id) return
    spoken.current = id
    if (sentence === '' || saidSince(shownKey, sentence)) return
    said.current.set(shownKey, { text: sentence, rewinds })
    if (!hurrying) narration.speak({ key: shownKey, count: shownCount })
    // `saidSince` reads `rewinds`, which the dependencies name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narration, shownKey, shownCount, sentence, hurrying, rewinds])
  // A replay fetches the next two sentences; a live game all it has queued,
  // or, while it is catching up, the step it will land on. A ball in play
  // the scorer has yet to place has no sentence to fetch.
  const playable = state.queue.filter(entry => ready(state, entry.step))
  const upcoming: NarrationStep[] = (
    state.mode === 'replay'
      ? playable.slice(0, PREFETCH)
      : behind
        ? playable.slice(-1)
        : playable
  )
    .filter(entry => fresh(entry.step.key))
    .map(entry => ({
      key: entry.step.key,
      count: (state.applied[entry.step.key] ?? 0) + entry.actions.length
    }))
  const upcomingIds = upcoming.map(step => `${step.key}#${step.count}`).join()
  useEffect(() => {
    narration.upcoming(upcoming)
    // The ids say everything the steps do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narration, upcomingIds, muted])
  const toggleSound = (): void => {
    if (muted) {
      scoringAudio.unlock()
      scoringAudio.setEnabled(true)
      player.unlock()
      setUnavailable(false)
    } else scoringAudio.setEnabled(false)
    setMuted(!muted)
  }
  const { width, height } = useWindowDimensions()
  const layout = replayLayout(width, height)
  const [catcher, setCatcher] = useState<ScreenRect | null>(null)
  const surfaceStyle = useFieldSurface()
  const [scoreboardRect, setScoreboardRect] = useState<ScreenRect | null>(null)
  // Settled once for a window width: moving the field changes the board's
  // measure, which must not move the field again.
  const [offset, setOffset] = useState(0)
  const safeTop =
    typeof surfaceStyle.safe.paddingTop === 'number'
      ? surfaceStyle.safe.paddingTop
      : 0
  const safeRight =
    typeof surfaceStyle.safe.paddingRight === 'number'
      ? surfaceStyle.safe.paddingRight
      : 0
  const fieldWidth = layout.side ? width - SIDE_DECK_WIDTH : width
  // Exit sits in the field's column, inside its safe padding, and the board
  // is measured across that column, not the window.
  const exitEdge = fieldWidth - safeRight
  useEffect(() => {
    setOffset(0)
  }, [width])
  useEffect(() => {
    if (offset === 0) {
      const top = fieldTop(scoreboardRect, safeTop, exitEdge, props.narration)
      if (top > 0) setOffset(top)
    }
  }, [scoreboardRect, offset, safeTop, exitEdge, props.narration])
  const [cardBottom, setCardBottom] = useState(0)

  const session = state.scoring.session
  // Everyone is named as the card and the box score name them: first name
  // and last initial, never a full surname.
  const roster = session.gameData.players
  // Names change only with the roster, not with every step.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const names = useMemo(() => namesOf(session), [roster])
  const previousPlayers = useRef<FieldPlayer[]>([])
  const { phase, pendingPlay, motions, runnerAction, presentation } =
    state.scoring
  const players = useMemo(() => {
    const next = scoringFieldPlayers(
      { session, phase, pendingPlay, motions, runnerAction, presentation },
      previousPlayers.current
    ).map(player => {
      const person = session.gameData.players[player.playerId ?? 0]
      return person == null
        ? player
        : {
            ...player,
            name: names.get(person.id) ?? person.fullName,
            displayName: names.get(person.id) ?? person.fullName,
            jersey: person.jersey
          }
    })
    previousPlayers.current = next
    return next
  }, [session, phase, pendingPlay, motions, runnerAction, presentation, names])
  const celebration = state.scoring.celebration
  const line = session.liveData.linescore
  const shortName = (id: number | undefined, full: string): string =>
    id == null ? full : (names.get(id) ?? full)
  const board = scoreboardFor(session)
  const scoreboard = {
    ...board,
    batter: {
      firstName: shortName(line.offense.batter?.id, board.batter.firstName),
      lastName: ''
    },
    pitcher: {
      firstName: shortName(line.defense.P?.id, board.pitcher.firstName),
      lastName: ''
    },
    celebration:
      celebration == null ? undefined : { ...celebration, paused: state.paused }
  }
  const box = useMemo(
    () => replayScore(session, state.timeline),
    [session, state.timeline]
  )
  const card = replayCard(state, {
    playBall: lstrings.replay_play_ball,
    waiting: lstrings.replay_waiting,
    paused: lstrings.replay_paused,
    changed: lstrings.replay_play_changed
  })
  const field = (
    <FieldCanvas
      {...SCORING_CAMERA}
      bottomExtension={layout.bottomExtension}
      view="home"
      selected=""
      onSelect={() => undefined}
      teams={session.gameData.teams}
      players={players}
      scoreboard={scoreboard}
      presentation={state.scoring.presentation ?? null}
      presentationPaused={state.paused}
      onPresentationContact={(id, generation) => {
        dispatch({
          type: 'FIELD',
          event: { type: 'PRESENTATION_CONTACT', id, generation }
        })
      }}
      onPresentationDone={(id, generation, stage) => {
        dispatch({
          type: 'FIELD',
          event: { type: 'PRESENTATION_DONE', id, generation, stage }
        })
      }}
      onMovementComplete={(id, generation) => {
        dispatch({
          type: 'FIELD',
          event: { type: 'MOTION_DONE', id, generation }
        })
      }}
      onCatcherBounds={setCatcher}
      onScoreboardBounds={setScoreboardRect}
      interaction={{
        generation: state.scoring.generation,
        selectableIds: [],
        gestures: []
      }}
    />
  )
  // The speaker alone upper left, Exit upper right.
  const topControls = (
    <>
      {props.narration && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            muted ? lstrings.replay_announcer_on : lstrings.replay_announcer_off
          }
          testID="replay-speaker"
          onPress={toggleSound}
          style={{
            position: 'absolute',
            top: 0,
            left: 16,
            width: 44,
            height: 44,
            borderRadius: 12,
            borderWidth: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: muted
              ? CONTROL_COLORS.micOff.bottom
              : CONTROL_COLORS.micOn.bottom,
            borderColor: muted
              ? CONTROL_COLORS.micOff.border
              : CONTROL_COLORS.micOn.border
          }}
        >
          <Dropped>
            <Icon
              name={muted ? 'volume_off' : 'volume_up'}
              size={1.5}
              color={
                muted ? CONTROL_COLORS.micOff.text : CONTROL_COLORS.micOn.text
              }
            />
          </Dropped>
        </Pressable>
      )}
      <View
        testID="replay-exit"
        pointerEvents="box-none"
        style={{ position: 'absolute', top: 0, right: 16, minWidth: 76 }}
      >
        <ScoringButton
          label={lstrings.replay_exit}
          color={surface.dangerFill}
          shape="pill"
          onPress={props.onExit}
        />
      </View>
    </>
  )
  const pauseButton = state.final ? null : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        state.paused ? lstrings.replay_play : lstrings.replay_pause
      }
      testID="replay-pause"
      onPress={() => {
        dispatch({ type: state.paused ? 'PLAY' : 'PAUSE', now: clock() })
      }}
      style={[FLOATING_BUTTON, { right: FLOATING_MARGIN }]}
    >
      <Dropped>
        <Icon
          name={state.paused ? 'play_arrow' : 'pause'}
          size={1.75}
          color={surface.activeText}
        />
      </Dropped>
    </Pressable>
  )
  const rewindButton =
    state.timeline.steps.length === 0 ? null : (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={lstrings.replay_rewind}
        testID="replay-rewind"
        onPress={() => {
          dispatch({
            type: 'REWIND',
            now: clock(),
            words: {
              top: lstrings.replay_rewind_top,
              bottom: lstrings.replay_rewind_bottom
            }
          })
        }}
        style={[FLOATING_BUTTON, { left: FLOATING_MARGIN }]}
      >
        <Dropped>
          <Icon name="skip_previous" size={1.75} color={surface.activeText} />
        </Dropped>
      </Pressable>
    )
  const playCard = (
    <FadingPlayCard
      notice={state.notice}
      clock={clock}
      line={card.line}
      detail={unavailable ? lstrings.replay_announcer_unavailable : card.detail}
      catcher={catcher == null ? null : { ...catcher, y: catcher.y + offset }}
      width={fieldWidth}
      height={height}
      onBottom={setCardBottom}
    />
  )
  const deckTop = Math.max(layout.deckTop, cardBottom + 8)
  return (
    <View
      testID="game-replay"
      style={[
        surfaceStyle.root,
        {
          backgroundColor: surface.canvas,
          flexDirection: layout.side ? 'row' : 'column'
        }
      ]}
    >
      <View style={{ flex: 1 }}>
        {player.element}
        <View testID="replay-field" style={{ flex: 1, marginTop: offset }}>
          {field}
        </View>
        {playCard}
        <View
          pointerEvents="box-none"
          style={[{ position: 'absolute', inset: 0 }, surfaceStyle.safe]}
        >
          <View pointerEvents="box-none" style={{ flex: 1 }}>
            {topControls}
          </View>
        </View>
        {!layout.side && (
          <View
            style={{
              position: 'absolute',
              top: deckTop,
              left: 0,
              right: 0,
              bottom: 0
            }}
          >
            <ReplayBoxScore
              box={box}
              players={openable}
              onOpenPlayer={onOpenPlayer}
            />
          </View>
        )}
      </View>
      {layout.side && (
        <View style={[{ width: SIDE_DECK_WIDTH }, surfaceStyle.safe]}>
          <ReplayBoxScore
            box={box}
            players={openable}
            onOpenPlayer={onOpenPlayer}
          />
        </View>
      )}
      <View
        pointerEvents="box-none"
        style={[{ position: 'absolute', inset: 0 }, surfaceStyle.safe]}
      >
        <View pointerEvents="box-none" style={{ flex: 1 }}>
          {rewindButton}
          {pauseButton}
        </View>
      </View>
    </View>
  )
}

/**
 * The play card, redrawn on its own while a rewind's words fade, so the
 * field and the box score are not drawn again with it.
 */
function FadingPlayCard(
  props: Omit<ReplayPlayCardProps, 'lineOpacity'> & {
    notice: { endsAt: number } | null
    clock: () => number
  }
): React.ReactElement {
  const { notice, clock, ...card } = props
  const [, setFrame] = useState(0)
  const up = notice != null
  useEffect(() => {
    if (!up) return
    const timer = setInterval(() => {
      setFrame(frame => frame + 1)
    }, FADE_FRAME_MS)
    return () => {
      clearInterval(timer)
    }
  }, [up])
  return (
    <ReplayPlayCard {...card} lineOpacity={noticeOpacity(notice, clock())} />
  )
}

/**
 * Keeps a live replay up with the scorer: every change to the plays, and
 * every reconnect, reads the game again and queues what is new; a change
 * of the game to final ends it. While the socket is down, or the server
 * failed to subscribe the game, it reads the game every five seconds.
 */
/** The game a `plays` change carries; nothing when it carries no game. */
function carriedGame(data: unknown): StoredGame | undefined {
  try {
    return parseStoredGame(data)
  } catch {
    return undefined
  }
}

function useLiveGame(
  props: {
    client: ReplayClient
    socket?: ReplaySocket
    pollMs: number
    context: SessionContext
    game: GameDetail
    mode: ReplayMode
  },
  timeline: ReplayTimeline,
  /** The game is over: nothing more to poll for. */
  gameOver: boolean,
  dispatch: (event: ReplayEvent) => void
): void {
  const { client, socket, context, mode, pollMs } = props
  const gameId = props.game.id
  const latest = useRef(timeline)
  latest.current = timeline
  const read = useMemo(() => {
    // One read at a time, each from the timeline the last one left.
    let chain: Promise<void> = Promise.resolve()
    return async (carried?: StoredGame): Promise<void> => {
      chain = chain
        .then(async () => {
          const stored = carried ?? (await client.gameEvents(gameId))
          const change = extendTimeline(latest.current, stored, context)
          latest.current = change.timeline
          dispatch({ type: 'CHANGED', change })
        })
        .catch(() => undefined)
      await chain
    }
  }, [client, gameId, context, dispatch])
  const over = useCallback(async (): Promise<void> => {
    await read()
    dispatch({ type: 'GAME_OVER' })
  }, [read, dispatch])
  const [connected, setConnected] = useState(socket?.connected ?? false)
  const [refused, setRefused] = useState(false)
  useEffect(() => {
    if (mode !== 'live' || socket == null) return
    setConnected(socket.connected)
    const stopStatus = socket.onStatus(setConnected)
    const unsubscribe = socket.subscribe(gameId, event => {
      if (event.type === 'error') {
        if (event.code === 'internal') setRefused(true)
        return
      }
      if (event.type === 'subscribed') setRefused(false)
      // The plays changed: they come with the change.
      if (event.type === 'change' && event.kind === 'plays') {
        read(carriedGame(event.data)).catch(() => undefined)
        return
      }
      // Subscribed or reconnected: read the game.
      if (event.type !== 'change') {
        read().catch(() => undefined)
        return
      }
      if (event.kind === 'game' && event.data.status === 'final')
        over().catch(() => undefined)
    })
    return () => {
      stopStatus()
      unsubscribe()
    }
  }, [mode, socket, gameId, read, over])
  useEffect(() => {
    if (mode !== 'live' || gameOver) return
    if (socket != null && connected && !refused) return
    const timer = setInterval(() => {
      read().catch(() => undefined)
      client
        .game(gameId)
        .then(async game => {
          if (game.status === 'final') await over()
        })
        .catch(() => undefined)
    }, pollMs)
    return () => {
      clearInterval(timer)
    }
  }, [
    mode,
    gameOver,
    socket,
    connected,
    refused,
    read,
    over,
    client,
    gameId,
    pollMs
  ])
}
