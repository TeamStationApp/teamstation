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
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type { BoxScore, GameDetail } from '../../common/api'
import type { GameSocketListener } from '../../common/gameSocket'
import {
  type GameStatistics,
  statisticsForCount
} from '../../common/gameStatistics'
import { publicNamesOf } from '../../common/replay/replayNames'
import {
  readReplaySource,
  replaySourceOf
} from '../../common/replay/replaySource'
import {
  extendTimeline,
  isReplayable,
  type ReplayTimeline
} from '../../common/replay/replayTimeline'
import type { SessionContext } from '../../common/scoring/session'
import { ButtonIcon } from '../components/ButtonIcon'
import { GlassView } from '../components/GlassView'
import {
  fieldHolderStyle,
  SCORING_BOTTOM_EXTENSION,
  SCORING_CAMERA
} from '../field/BaseballScreen'
import type { ScreenRect } from '../field/catcherBounds'
import { FieldCanvas } from '../field/FieldCanvas'
import type { FieldPlayer } from '../field/fieldModel'
import {
  FIELD_EDGE_GAP,
  FLOATING_MARGIN,
  FLOATING_SIZE,
  floatingBottom,
  liftedSafePadding,
  topLift
} from '../field/fieldSafeArea'
import { useFieldInsets, useFieldSurface } from '../field/useFieldSurface'
import { VolumeButton } from '../field/VolumeButton'
import { lstrings } from '../locales/strings'
import { scoringAudio } from '../scoring/scoringAudio'
import { scoringFieldPlayers } from '../scoring/scoringMotion'
import { scoreboardFor } from '../scoring/scoringSelectors'
import { scoringSheetTheme } from '../scoring/scoringSheetTheme'
import { scoringSurface as surface } from '../theme/scoringSurface'
import { ScopedThemeProvider, useTheme } from '../theme/ThemeContext'
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
import {
  BELOW_NAMEPLATE,
  ReplayPlayCard,
  type ReplayPlayCardProps
} from './ReplayPlayCard'

/** The box score's column beside the field on a wide window. */
export const SIDE_DECK_WIDTH = 360
/** The least of a tall window the box score keeps below the play card. */
export const DECK_MIN = 160
/** The gap between the play card and the box score below it. */
const DECK_GAP = 8

/** A tall window's deck, and whether the play card is drawn. */
export interface TallDeck {
  top: number
  card: boolean
}
/**
 * Where a tall window's deck starts. The play card hangs below the catcher's
 * nameplate when that leaves the box score DECK_MIN below it, and the deck
 * starts DECK_GAP below the card. Otherwise no card is drawn, and the deck
 * starts below the nameplate, keeping DECK_MIN. Until the catcher and the
 * card are measured, the card hangs to be measured and the deck keeps
 * DECK_MIN.
 */
export function tallDeck(
  height: number,
  catcher: ScreenRect | null,
  cardHeight: number
): TallDeck {
  if (catcher == null || cardHeight <= 0)
    return { top: height - DECK_MIN, card: true }
  const below = catcher.y + catcher.height + BELOW_NAMEPLATE
  const hungBottom = below + cardHeight + DECK_GAP
  return height - hungBottom >= DECK_MIN
    ? { top: hungBottom, card: true }
    : { top: Math.min(below, height - DECK_MIN), card: false }
}
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
  gameStatistics: (gameId: string) => Promise<GameStatistics>
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

/**
 * Rewind at the bottom left and pause at the bottom right: one look. Each
 * sits `floatingBottom` from the window's bottom.
 */
export const FLOATING_BUTTON = {
  position: 'absolute',
  width: FLOATING_SIZE,
  height: FLOATING_SIZE,
  borderRadius: FLOATING_SIZE / 2,
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

/**
 * The narrowest window that puts the box score beside the field even when it
 * is taller than wide: a tablet in portrait, whose scoring framing leaves too
 * little room below the catcher for the card and a box score.
 */
export const SIDE_MIN_WIDTH = 768

/** A wide window, or a tablet's, puts the box score and the play card beside the field. */
export function replayLayout(width: number, height: number): { side: boolean } {
  return { side: width > height || width >= SIDE_MIN_WIDTH }
}

/**
 * The box score's bottom padding: its last row scrolls to 8 points above the
 * floating buttons' tops, from a container that ends `containerBottom` above
 * the window's bottom.
 */
export function boxScoreInset(
  insetBottom: number,
  containerBottom: number
): number {
  return floatingBottom(insetBottom) + FLOATING_SIZE + 8 - containerBottom
}

/**
 * A game replayed in 3D, full screen and dark: the field, the play card
 * below the catcher, the box score below that, the volume button at the top
 * left and the X at the top right, rewind at the bottom left and pause at the
 * bottom right.
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
  // The app's own theme, which the scoring screen draws in, and the replay's
  // dark sheet over it.
  const appTheme = useTheme()
  const theme = scoringSheetTheme(appTheme)
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
    statistics: GameStatistics
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
      .then(([{ game, stored, statistics }, { announcer, pitchSlotMs }]) => {
        if (!live) return
        const source = replaySourceOf(game, stored)
        if (!isReplayable(game, game.replayable) || source == null) {
          notReplayable.current()
          return
        }
        setLoaded({
          statistics,
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
          glyphColor={appTheme.primaryTextColor}
        />
      )}
    </ScopedThemeProvider>
  )
}

function ReplayView(props: {
  statistics: GameStatistics
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
  /** The X's glyph: the scoring screen's ☰ colour, dark on the glass. */
  glyphColor: string
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
  const [statistics, setStatistics] = useState(props.statistics)
  useLiveGame(props, state.timeline, state.gameOver, dispatch, setStatistics)
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
        // The announcer alone gives up: the cues play on.
        unavailable: () => {
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
  // The announcer follows the volume button, but only where the server has
  // one, and not once it has failed until the button is turned on again.
  const announcerMuted = muted || !props.narration || unavailable
  useEffect(() => {
    narration.setMuted(announcerMuted)
  }, [narration, announcerMuted])
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
  }, [narration, upcomingIds, announcerMuted])
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
  const surfaceStyle = useFieldSurface()
  const insets = useFieldInsets()
  // The scoring screen's picture: the top controls and the whole scene rise
  // half a button into the top inset (not on Android).
  const lift = topLift(insets.top, Platform.OS)
  // The top controls' padding: the scoring screen's rule for its header row.
  const topPadding = liftedSafePadding(insets, lift)
  const [catcher, setCatcher] = useState<ScreenRect | null>(null)
  const fieldWidth = layout.side ? width - SIDE_DECK_WIDTH : width
  const [cardHeight, setCardHeight] = useState(0)

  const session = state.scoring.session
  // Everyone is named as the card and the box score name them: first name
  // and last initial, never a full surname.
  const roster = session.gameData.players
  // Names change only with the roster, not with every step.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const names = useMemo(() => publicNamesOf(session), [roster])
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
    () =>
      statisticsForCount(
        statistics,
        Object.values(state.applied).reduce((sum, count) => sum + count, 0)
      ),
    [statistics, state.applied]
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
      bottomExtension={SCORING_BOTTOM_EXTENSION}
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
      interaction={{
        generation: state.scoring.generation,
        selectableIds: [],
        gestures: []
      }}
    />
  )
  // The volume button upper left, the X upper right.
  const topControls = (
    <>
      <View style={{ position: 'absolute', top: 0, left: 0 }}>
        <VolumeButton
          testID="replay-speaker"
          on={!muted}
          onToggle={toggleSound}
        />
      </View>
      <GlassView
        radius={24}
        interactive
        androidBlur
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 48,
          height: 48,
          borderRadius: 24,
          overflow: 'hidden'
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.replay_close}
          testID="replay-exit"
          onPress={props.onExit}
          style={{
            width: 48,
            height: 48,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <ButtonIcon name="close" size={1.5} color={props.glyphColor} />
        </Pressable>
      </GlassView>
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
      style={[
        FLOATING_BUTTON,
        {
          right: FLOATING_MARGIN + insets.right,
          bottom: floatingBottom(insets.bottom)
        }
      ]}
    >
      <ButtonIcon
        name={state.paused ? 'play_arrow' : 'pause'}
        size={1.75}
        color={surface.activeText}
      />
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
        style={[
          FLOATING_BUTTON,
          {
            left: FLOATING_MARGIN + insets.left,
            bottom: floatingBottom(insets.bottom)
          }
        ]}
      >
        <ButtonIcon
          name="skip_previous"
          size={1.75}
          color={surface.activeText}
        />
      </Pressable>
    )
  const cardProps = {
    notice: state.notice,
    clock,
    line: card.line,
    detail: unavailable ? lstrings.replay_announcer_unavailable : card.detail,
    width: fieldWidth,
    height
  }
  // A tall window: the card below the catcher, the canvas's report moved up
  // with the lifted scene, or no card when hanging there would leave the box
  // score less than DECK_MIN.
  const lifted = catcher == null ? null : { ...catcher, y: catcher.y - lift }
  const deck = tallDeck(height, lifted, cardHeight)
  const boxScore = (containerBottom: number): React.ReactElement =>
    box === null ? (
      <Text>Statistics are unavailable for this recorded play.</Text>
    ) : (
      <ReplayBoxScore
        box={box}
        players={openable}
        onOpenPlayer={onOpenPlayer}
        bottomInset={boxScoreInset(insets.bottom, containerBottom)}
      />
    )
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
        <View testID="replay-field" style={fieldHolderStyle(-lift)}>
          {field}
        </View>
        {!layout.side && deck.card && (
          <FadingPlayCard
            {...cardProps}
            catcher={lifted}
            onHeight={setCardHeight}
          />
        )}
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            inset: 0,
            paddingTop: topPadding.paddingTop,
            paddingLeft: topPadding.paddingLeft,
            paddingRight: layout.side ? FIELD_EDGE_GAP : topPadding.paddingRight
          }}
        >
          <View pointerEvents="box-none" style={{ flex: 1 }}>
            {topControls}
          </View>
        </View>
        {!layout.side && (
          <View
            testID="replay-deck"
            style={{
              position: 'absolute',
              top: deck.top,
              left: 0,
              right: 0,
              bottom: 0
            }}
          >
            {boxScore(0)}
          </View>
        )}
      </View>
      {layout.side && (
        <View
          testID="replay-side"
          style={[{ width: SIDE_DECK_WIDTH }, surfaceStyle.safe]}
        >
          <FadingPlayCard {...cardProps} catcher={null} placement="column" />
          <View style={{ flex: 1, marginTop: DECK_GAP }}>
            {boxScore(insets.bottom + FIELD_EDGE_GAP)}
          </View>
        </View>
      )}
      <View pointerEvents="box-none" style={{ position: 'absolute', inset: 0 }}>
        {rewindButton}
        {pauseButton}
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
  dispatch: (event: ReplayEvent) => void,
  onStatistics: (statistics: GameStatistics) => void
): void {
  const { client, socket, context, mode, pollMs } = props
  const gameId = props.game.id
  const latest = useRef(timeline)
  latest.current = timeline
  const read = useMemo(() => {
    // One read at a time, each from the timeline the last one left.
    let chain: Promise<void> = Promise.resolve()
    return async (): Promise<void> => {
      chain = chain
        .then(async () => {
          const statistics = await client.gameStatistics(gameId)
          const stored = statistics.source
          const change = extendTimeline(latest.current, stored, context)
          latest.current = change.timeline
          onStatistics(statistics)
          dispatch({ type: 'CHANGED', change })
        })
        .catch(() => undefined)
      await chain
    }
  }, [client, gameId, context, dispatch, onStatistics])
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
      // The plays changed: fetch one coherent scoring revision, which the
      // statistics carry with the game itself. Each change re-reads them,
      // because the server builds the box scores and the edits cannot be
      // applied here: one statistics read per pitch for every viewer.
      if (event.type === 'change' && event.kind === 'playEdits') {
        read().catch(() => undefined)
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
