import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  BackHandler,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'

import type {
  BoxScore as BoxScoreData,
  GameDetail,
  GameLineupsResponse,
  RosterEntry,
  SaveLineupsBody,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { begun } from '../../common/scoring/lineup'
import type { Lineup } from '../../common/scoring/lineupHistory'
import type { StagedRunner } from '../../common/scoring/rosterCommands'
import type { ScoringSession } from '../../common/scoring/session'
import {
  defaultPending,
  shownWithDefault
} from '../../common/scoring/startingSetup'
import {
  type GameState,
  POSITIONS,
  setupOf,
  type Side
} from '../../common/scoring/state'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import type { Route } from '../navigation/routes'
import { useInsets } from '../platform/safeArea'
import { guestRenames, sendGuestRenames } from '../scoring/guestRenames'
import { HeldGameNotice } from '../scoring/HeldGameNotice'
import { rosterPlayerBody } from '../scoring/playerDraft'
import type { RosterDictationOptions } from '../scoring/rosterDictation'
import { sameValue } from '../scoring/rosterDirty'
import { RosterEditor, type RosterEditorDraft } from '../scoring/RosterEditor'
import { type GameChanges, listen, useRosterLive } from '../scoring/rosterLive'
import { resumedScoringState } from '../scoring/scoringMachine'
import { scoringPreferences } from '../scoring/scoringPreferences'
import { withoutPrivateNames } from '../scoring/scoringRosterCache'
import {
  ScoringError,
  ScoringSheet,
  ScoringSheetHeight
} from '../scoring/ScoringSheet'
import { useScoringSheetTheme } from '../scoring/scoringSheetTheme'
import {
  type ScoringSource,
  ServerScoringSource
} from '../scoring/scoringSource'
import type { ScoringState } from '../scoring/scoringTypes'
import { type GameReplaced, useGameReplaced } from '../scoring/sidesSwapped'
import { dictationUrl } from '../scoring/useDictation'
import { useScoringExit } from '../scoring/useScoringExit'
import {
  OFFLINE_BANNER,
  SERVER_COPY_PENDING,
  useHeldGameControl,
  usePhoneOffline
} from '../sync/useOffline'
import { ScopedThemeProvider, useTheme } from '../theme/ThemeContext'
import { BoxScore, type LineupBatter } from './BoxScore'
import { PlayerSettingsTab } from './PlayerSettingsTab'

/** How often, at most, the box score is read again as plays arrive. */
export const BOX_SCORE_EVERY_MS = 5000

export interface CoachGameScreenProps {
  client: TeamStationClient
  gameId: string
  /** The coach's team in the game. */
  teamId: string
  /** Whose dictation model is used. */
  userId?: string | number
  /**
   * The app's game socket: another device's lineups, plays and score reach
   * the screen as they are saved.
   */
  socket?: GameChanges
  /** Where the game is read from: the server's copy, but for tests. */
  source?: ScoringSource
  /** Dictation's socket, microphone and timings, for tests. */
  dictation?: Pick<
    RosterDictationOptions,
    'openSocket' | 'openMicrophone' | 'tapMs' | 'tailMs'
  >
  /** How often, at most, the box score is read again: shorter in tests. */
  boxScoreEveryMs?: number
  /** Leaves for the game's Box score tab. */
  onExit: () => void
}

/**
 * One side's players, batting order and defence as `POST
 * /games/:gameId/lineups` takes them: each player by who he is, and every
 * other number an index into those players. A pinch hitter (`nextBatter`)
 * or runner of the other side's is not this side's to save, and is left out.
 */
export function lineupsBody(
  draft: GameState,
  side: Side,
  base: string,
  nextBatter?: number,
  runners: readonly StagedRunner[] = []
): SaveLineupsBody {
  const team = draft.liveData.boxscore.teams[side]
  const players = team.players.map(id => {
    const player = draft.gameData.players[id]
    return {
      gumboId: player.id,
      fullName: player.fullName,
      jersey: player.jersey
    }
  })
  const index = (id: number): number => team.players.indexOf(id)
  const defense: SaveLineupsBody['defense'] = {}
  for (const position of POSITIONS) {
    const id = team.defense[position]
    if (id != null && index(id) >= 0) defense[position] = index(id)
  }
  const staged = runners
    .filter(runner => index(runner.player) >= 0)
    .map(runner => ({ base: runner.base, player: index(runner.player) }))
  return {
    side,
    base,
    players,
    battingOrder: team.battingOrder.map(index).filter(at => at >= 0),
    defense,
    ...(nextBatter == null || index(nextBatter) < 0
      ? {}
      : { nextBatter: index(nextBatter) }),
    ...(staged.length === 0 ? {} : { runners: staged })
  }
}

/**
 * The batting orders as they stand of `sides`, for the box score: the
 * coach's own, and the opponent's once the game holds it. Before then the
 * session's order for a team whose default lineup he may not read is only
 * its roster.
 */
export function battingOrders(
  game: GameState,
  sides: readonly Side[] = ['away', 'home'],
  accounts: readonly RosterEntry[] = []
): Partial<Record<Side, LineupBatter[]>> {
  return Object.fromEntries(
    sides.map(side => [
      side,
      game.liveData.boxscore.teams[side].battingOrder.flatMap(id => {
        const player = game.gameData.players[id]
        return player == null
          ? []
          : [
              {
                userId:
                  accounts.find(row => row.gumboId === id)?.userId ?? null,
                shortName: player.fullName,
                gumboId: id
              }
            ]
      })
    ])
  )
}

/** The screen's state of the game, as the scoring screen builds its own. */
function scoringStateOf(session: ScoringSession): ScoringState {
  const resumed = session.resumable()
  return resumedScoringState(resumed.state, resumed.actions, false)
}

/**
 * The game the coach is shown. Before the first pitch, his side, when a
 * save left it unseen, comes from the default he may read. Once the game
 * has begun, he sees the lineup being scored. The session underneath stays
 * the stored game, so opening does not write that default into it.
 */
function presented(
  session: ScoringSession,
  side: Side,
  lineup: Lineup | null
): ScoringState {
  const next = scoringStateOf(session)
  if (begun(next.session)) return next
  return {
    ...next,
    session: shownWithDefault(next.session, next.log, side, lineup)
  }
}

interface Opened {
  game: GameDetail
  side: Side
  session: ScoringSession
  rosters: Record<string, RosterEntry[]>
}

/**
 * Coach Game: a head coach's own team in a game, on a screen of its own —
 * the box score, and the roster screen's Roster, Lineup and Defense, with
 * its bar and dictation. Save Rosters saves his side's lineup through
 * `client.saveLineups` and stays; Cancel discards what is staged and reads
 * the game again. The game is never scored here: the session is read, and
 * read again after each save.
 *
 * It leaves by its own back chevron, the browser's Back or Android's, each
 * first asking to discard changes not saved, for the game's Box score tab.
 */
export function CoachGameScreen(
  props: CoachGameScreenProps
): React.ReactElement {
  const theme = useScoringSheetTheme()
  return (
    <ScopedThemeProvider theme={theme}>
      <CoachGame {...props} />
    </ScopedThemeProvider>
  )
}

/** Whether the generation read is another than the one the screen opened. */
function replacedGeneration(
  read: number | undefined,
  opened: number | undefined
): boolean {
  return read != null && opened != null && read !== opened
}

/** Shown over a staged change when the game was swapped or reset under it. */
function replacedBanner(change: GameReplaced): string {
  if (!change.reset)
    return 'Home and away were swapped. Your unsaved changes are for your old side and are dropped when the game is read again.'
  return `${change.swapped ? 'Home and away were swapped and the game was reset.' : 'This game was reset.'} Your unsaved changes are for the plays it deleted and are dropped when the game is read again.`
}

function CoachGame(props: CoachGameScreenProps): React.ReactElement {
  const { client, gameId, teamId, socket, onExit } = props
  const theme = useTheme()
  const insets = useInsets()
  const fallback = useMemo(() => new ServerScoringSource(client), [client])
  const source = props.source ?? fallback
  const [opened, setOpened] = useState<Opened>()
  const [editingPlayer, setEditingPlayer] = useState<{
    userId: string
    name: string
    teamId: string
  }>()
  const [failed, setFailed] = useState<string>()
  const [state, setState] = useState<ScoringState>()
  // The editor is drawn again from the game when the game's lineups change
  // under a clean draft, after a save, and after Cancel takes another
  // device's change; the tab shown is kept.
  const [read, setRead] = useState(0)
  const [held, setHeld] = useState<RosterEditorDraft>()
  /** Guests made on this screen, whose accounts a rename finds too. */
  const createdGuests = useRef<RosterEntry[]>([])
  const mountedOn = useRef<GameState | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [unaccepted, setUnaccepted] = useState(false)
  // Whether the game holds the opponent's lineup, which the box score lists.
  const [theirsHeld, setTheirsHeld] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [detail, setDetail] = useState<GameDetail>()
  const [box, setBox] = useState<BoxScoreData>()
  const [asking, setAsking] = useState<(leave: boolean) => void>()
  const [height, setHeight] = useState<number>()
  // The lineups digest last read or saved, which a save names as its base.
  const digest = useRef('')
  // His team's default, for a side a save left unseen. Null when he has
  // none or it could not be read.
  const ownDefault = useRef<Lineup | null>(null)
  // The stored game, so a side still unseen can light Save on his default.
  const sessionRef = useRef<ScoringSession | undefined>(undefined)
  const side = opened?.side
  // A save offline is queued on the phone; a queue the server stopped says
  // why.
  const phoneOffline = usePhoneOffline(client)
  const heldGame = useHeldGameControl(client, gameId)
  const heldQueue = heldGame?.text
  // Read the game again once the phone gave its held edits up.
  const [reopened, setReopened] = useState(0)
  /** The phone gave up its edits, and the server's copy has not come. */
  const copyPending = useRef(false)

  /**
   * What the server's lineups say: the digest, and which are held. His own
   * side is not accepted while a save that could not see it left the roster
   * order, before the first pitch, so Save Rosters is lit on the default he
   * is shown. After the game has begun, that order is the one being scored,
   * and Save waits for an edit.
   */
  const heard = useCallback((lineups: GameLineupsResponse, of: Side): void => {
    digest.current = lineups.digest
    const resumed = sessionRef.current?.resumable()
    setUnaccepted(
      lineups[of].current == null ||
        (resumed != null &&
          !begun(resumed.state) &&
          defaultPending(
            resumed.state,
            resumed.actions,
            of,
            ownDefault.current
          ))
    )
    setTheirsHeld(lineups[of === 'home' ? 'away' : 'home'].current != null)
  }, [])
  const sideRef = useRef<Side | undefined>(undefined)
  sideRef.current = side

  // Home and away swapped, or the plays reset, under the open game: it is
  // read again, so his side, and the side his saves and guests go to, is his
  // team's new one. Over a staged change he is asked first, since it names
  // his old side or the deleted plays.
  const [replaced, setReplaced] = useState<GameReplaced>()
  const dirtyNow = useRef(dirty)
  dirtyNow.current = dirty
  const readSides = useCallback(
    async (): Promise<GameDetail> => await client.game(gameId),
    [client, gameId]
  )
  // Once for each opened game: the swap's notice, a resync's read and a
  // lineup reload can each find it.
  const openedNow = useRef(opened)
  openedNow.current = opened
  const reopenedFrom = useRef<Opened | undefined>(undefined)
  const reopenSwapped = useCallback((change: GameReplaced): void => {
    if (dirtyNow.current) {
      setReplaced(change)
      return
    }
    if (reopenedFrom.current === openedNow.current) return
    reopenedFrom.current = openedNow.current
    setReopened(value => value + 1)
  }, [])
  const reload = useCallback(
    async (remount = false): Promise<void> => {
      const session = opened?.session
      if (session == null) return
      // And whether the game holds his side's lineup now, which somebody
      // else's save may have given it.
      const [, lineups] = await Promise.all([
        session.reload(),
        client.gameLineups(gameId)
      ])
      // The screen moved on to another read of the game meanwhile.
      if (openedNow.current !== opened) return
      sessionRef.current = session
      // Home and away swapped under it: the session now replays on the new
      // teams, and his side is no longer the one the screen opened on.
      const teams = session.state.gameData.teams
      if (
        teams.home.id !== opened!.game.homeTeamId ||
        teams.away.id !== opened!.game.awayTeamId
      ) {
        reopenSwapped({
          swapped: true,
          reset: replacedGeneration(lineups.generation, opened!.game.generation)
        })
        return
      }
      // A reset that left the sides as they were.
      if (replacedGeneration(lineups.generation, opened!.game.generation)) {
        reopenSwapped({ swapped: false, reset: true })
        return
      }
      heard(lineups, opened!.side)
      const next = presented(session, opened!.side, ownDefault.current)
      setState(next)
      // A reload that leaves the setup as the editor was drawn from leaves
      // the editor, so its scroll and tab stay. A save draws it again even
      // then: a pinch runner keeps the order and the players, and the editor
      // would otherwise keep the runner it staged and stay dirty.
      const shown = mountedOn.current
      if (
        !remount &&
        shown != null &&
        sameValue(setupOf(shown), setupOf(next.session))
      )
        return
      mountedOn.current = next.session
      setHeld(last => ({
        draft: next.session,
        side: opened!.side,
        mode: last?.mode ?? 'boxScore',
        ...(last?.scrollOffsets == null
          ? {}
          : { scrollOffsets: last.scrollOffsets })
      }))
      setRead(value => value + 1)
    },
    [opened, client, gameId, heard, reopenSwapped]
  )

  const live = useRosterLive({
    socket,
    gameId,
    dirty,
    read: async () => {
      const lineups = await client.gameLineups(gameId)
      const of = sideRef.current
      if (of != null) heard(lineups, of)
      return lineups.digest
    },
    onReload: () => {
      reload().catch(() => undefined)
    }
  })
  const { start: startLive, stop: stopLive } = live

  // The game, both rosters and the lineups, read once as the screen opens.
  useEffect(() => {
    let current = true
    setOpened(undefined)
    setFailed(undefined)
    const load = async (): Promise<void> => {
      const game = await client.game(gameId)
      const of: Side | undefined =
        teamId === game.homeTeamId
          ? 'home'
          : teamId === game.awayTeamId
            ? 'away'
            : undefined
      if (of == null || !game.coachSides.includes(of)) {
        if (current) setFailed(lstrings.coach_not_coach)
        return
      }
      sideRef.current = of
      // Before the game is read, so a change saved meanwhile is heard.
      startLive()
      const roster = async (id: string): Promise<RosterEntry[]> =>
        id === teamId
          ? await client
              .roster(id, { includeFullNames: true })
              .catch(async () => withoutPrivateNames(await client.roster(id)))
          : withoutPrivateNames(await client.roster(id).catch(() => []))
      const [away, home, lineups, kept] = await Promise.all([
        roster(game.awayTeamId),
        roster(game.homeTeamId),
        client.gameLineups(gameId),
        client
          .defaultLineup(teamId)
          .then(found => found.lineup)
          .catch(() => null)
      ])
      ownDefault.current = kept
      const session = await source.open(game, away, home)
      if (!current) return
      sessionRef.current = session
      heard(lineups, of)
      const next = presented(session, of, kept)
      mountedOn.current = next.session
      setState(next)
      setHeld({ draft: next.session, side: of, mode: 'boxScore' })
      setDetail(game)
      copyPending.current = false
      setOpened({
        game,
        side: of,
        session,
        rosters: { [game.awayTeamId]: away, [game.homeTeamId]: home }
      })
    }
    load().catch(() => {
      if (current)
        setFailed(
          copyPending.current ? SERVER_COPY_PENDING : lstrings.coach_load_failed
        )
    })
    return () => {
      current = false
      stopLive()
    }
  }, [client, gameId, teamId, source, startLive, stopLive, heard, reopened])

  // The box score, read as the screen opens and again as plays and the
  // score change, at most once every five seconds.
  const lastRead = useRef(0)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const every = props.boxScoreEveryMs ?? BOX_SCORE_EVERY_MS
  const refreshBox = useCallback((): void => {
    if (pending.current != null) return
    const wait = Math.max(0, lastRead.current + every - Date.now())
    pending.current = setTimeout(() => {
      pending.current = null
      lastRead.current = Date.now()
      Promise.all([client.game(gameId), client.boxScore(gameId)])
        .then(([game, rows]) => {
          setDetail(game)
          setBox(rows)
        })
        .catch(() => {
          setBox(
            shown => shown ?? { batting: [], pitching: [], stats: undefined }
          )
        })
    }, wait)
  }, [client, gameId, every])
  useEffect(() => {
    refreshBox()
    return () => {
      if (pending.current != null) clearTimeout(pending.current)
      pending.current = null
    }
  }, [refreshBox])
  useEffect(() => {
    if (socket == null) return
    return listen(socket, gameId, event => {
      if (
        event.type === 'resync' ||
        (event.type === 'change' &&
          (event.kind === 'plays' || event.kind === 'game'))
      )
        refreshBox()
    })
  }, [socket, gameId, refreshBox])
  useGameReplaced(socket, gameId, opened?.game, readSides, reopenSwapped)

  // The dictation model the coach chose in the scoring screen's Settings.
  const [model, setModel] = useState<RosterDictationOptions['model']>()
  useEffect(() => {
    let current = true
    scoringPreferences
      .read(String(props.userId ?? 'local-scorer'))
      .then(value => {
        if (current) setModel(value.dictationModel)
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [props.userId])
  const health = useCallback(async () => await client.health(), [client])
  const url = useMemo(() => dictationUrl(client.baseUrl), [client])

  // Leaving with changes not saved asks first; Discard leaves, Keep
  // editing stays.
  const confirm = useCallback(
    async (): Promise<boolean> =>
      !dirty ||
      (await new Promise<boolean>(resolve => {
        setAsking(() => resolve)
      })),
    [dirty]
  )
  const returnTo = useMemo<Route>(
    () => ({ name: 'game', gameId, tab: 'boxScore' }),
    [gameId]
  )
  const exit = useScoringExit(
    gameId,
    dirty,
    onExit,
    confirm,
    true,
    undefined,
    undefined,
    returnTo
  )
  // Android's Back, over changes not saved, asks as the chevron does; with
  // nothing staged it is the shell's, as for any screen.
  useEffect(() => {
    if (Platform.OS !== 'android' || !dirty) return
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      exit()
      return true
    })
    return () => {
      back.remove()
    }
  }, [dirty, exit])
  const answer = (leave: boolean): void => {
    asking?.(leave)
    setAsking(undefined)
  }

  const save = (
    draft: GameState,
    nextBatter: number | undefined,
    runners: StagedRunner[] | undefined,
    openedOver: GameState
  ): void | Promise<void> => {
    if (opened == null || state == null) return
    const saving = opened
    setProblem(undefined)
    // A game-only player's corrected name is his account's: renamed first,
    // then the lineup that shows it is saved. The corrections are told
    // against the game the editor was opened over (`mountedOn`).
    const renamed = sendGuestRenames(
      client,
      gameId,
      guestRenames(openedOver, draft),
      [
        ...Object.values((detail ?? saving.game).guestPlayers).flat(),
        ...createdGuests.current
      ]
    )
    // Made on the plays the screen opened: a reset since refuses it.
    const posted = renamed.then(
      async () =>
        await client.saveLineups(gameId, {
          ...lineupsBody(
            draft,
            saving.side,
            digest.current,
            nextBatter,
            runners
          ),
          generation: saving.game.generation
        })
    )
    live.saving(posted.then(lineups => lineups.digest))
    // The chat closes when this resolves and stays when it is refused, so
    // what was staged and said is still there to read.
    return posted
      .then(async lineups => {
        heard(lineups, saving.side)
        await reload(true)
      })
      .catch((caught: unknown) => {
        setProblem(
          caught instanceof HttpError
            ? caught.message
            : lstrings.coach_save_failed
        )
        throw caught
      })
  }

  /** A player just put on team `id`'s roster joins the rosters this game holds. */
  const holdRosterEntry = (id: string, entry: RosterEntry): void => {
    setOpened(current =>
      current?.game.id !== gameId
        ? current
        : {
            ...current,
            rosters: {
              ...current.rosters,
              [id]: [
                ...(current.rosters[id] ?? []).filter(
                  person => person.userId !== entry.userId
                ),
                entry
              ]
            }
          }
    )
  }

  const team =
    side == null || opened == null
      ? ''
      : side === 'home'
        ? opened.game.homeTeamName
        : opened.game.awayTeamName
  const text = {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont
  }
  return (
    <View
      testID="Coach game"
      style={{
        flex: 1,
        backgroundColor: theme.backgroundColor,
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 8,
        paddingLeft: insets.left + 16,
        paddingRight: insets.right + 16,
        gap: 8
      }}
    >
      <View
        testID="Coach header"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.common_back}
          hitSlop={8}
          onPress={exit}
          style={{ marginLeft: -8 }}
        >
          <Icon name="chevron_left" size={2.5} color={theme.primaryTextColor} />
        </Pressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            ...text,
            flex: 1,
            textAlign: 'right',
            fontFamily: theme.boldTextFont,
            fontSize: 20
          }}
        >
          {team}
        </Text>
      </View>
      {problem != null && <ScoringError message={problem} />}
      {replaced != null && (
        <View style={{ padding: 12, gap: 8 }}>
          <Text accessibilityRole="alert" style={text}>
            {replacedBanner(replaced)}
          </Text>
          <Button
            label="Read the game again"
            accessibilityLabel="Read the game again"
            onPress={() => {
              setReplaced(undefined)
              setReopened(value => value + 1)
            }}
          />
        </View>
      )}
      {heldGame != null ? (
        <HeldGameNotice
          held={heldGame}
          onSettled={arrived => {
            copyPending.current = !arrived
            setReopened(value => value + 1)
          }}
        >
          <Text
            accessibilityRole="alert"
            testID="heldGameMessage"
            style={{ ...text, color: theme.dangerColor }}
          >
            {heldQueue}
          </Text>
        </HeldGameNotice>
      ) : (
        phoneOffline && (
          <Text accessibilityRole="text" testID="coachOffline" style={text}>
            {OFFLINE_BANNER}
          </Text>
        )
      )}
      {failed != null ? (
        <Text accessibilityRole="alert" style={{ ...text, padding: 16 }}>
          {failed}
        </Text>
      ) : opened == null || state == null || side == null ? (
        <ActivityIndicator
          accessibilityLabel="Loading game"
          color={theme.primaryTextColor}
        />
      ) : (
        <View
          style={{ flex: 1, minHeight: 0 }}
          onLayout={event => {
            setHeight(event.nativeEvent.layout.height)
          }}
        >
          <ScoringSheetHeight.Provider value={height}>
            <RosterEditor
              key={read}
              state={state}
              audience="coach"
              fixedSide={side}
              initialDraft={held}
              onDraftChange={setHeld}
              rosters={opened.rosters}
              guests={Object.values(
                (detail ?? opened.game).guestPlayers
              ).flat()}
              unrostered={(detail ?? opened.game).unrostered}
              onRosteredChange={async (side, userId, rostered) => {
                const posted = client.setRostered(gameId, {
                  side,
                  userId,
                  rostered
                })
                live.saving(
                  posted
                    .then(async () => {
                      const lineups = await client.gameLineups(gameId)
                      heard(lineups, side)
                      return lineups.digest
                    })
                    .catch(() => digest.current)
                )
                const unrostered = await posted
                setDetail(current => ({
                  ...(current ?? opened.game),
                  unrostered
                }))
                setOpened(current =>
                  current == null
                    ? current
                    : { ...current, game: { ...current.game, unrostered } }
                )
                return unrostered
              }}
              onEditPlayer={(userId, name, id) => {
                if (id === teamId)
                  setEditingPlayer({ userId, name, teamId: id })
              }}
              onCreatePlayer={async (id, player) => {
                const entry = await client.createRosterPlayer(
                  id,
                  rosterPlayerBody(player)
                )
                holdRosterEntry(id, entry)
                return entry
              }}
              client={client}
              onAddExistingRosterPlayer={async (id, body) => {
                const answer = await client.addExistingRosterPlayer(id, body)
                if ('entry' in answer) holdRosterEntry(id, answer.entry)
                return answer
              }}
              onAddExistingGuest={async (side, body) =>
                await client.addExistingGuest(gameId, side, body, teamId)
              }
              onCreateGuest={async (side, player) => {
                const entry = await client.createGuestPlayer(
                  gameId,
                  side,
                  rosterPlayerBody(player),
                  teamId
                )
                createdGuests.current.push(entry)
                return entry
              }}
              unaccepted={unaccepted}
              conflict={live.conflict}
              onDirtyChange={setDirty}
              renderBoxScore={() => (
                <ScrollView testID="Coach box score">
                  <BoxScore
                    game={detail ?? opened.game}
                    box={box}
                    theme={theme}
                    sideBySide={false}
                    first={side}
                    lineups={battingOrders(
                      state.session,
                      theirsHeld ? ['away', 'home'] : [opened.side],
                      [
                        ...Object.values(opened.rosters).flat(),
                        ...Object.values(
                          (detail ?? opened.game).guestPlayers
                        ).flat()
                      ]
                    )}
                  />
                </ScrollView>
              )}
              dictate={{
                health,
                url,
                token: client.token,
                gameId,
                model,
                log: state.log,
                ...props.dictation
              }}
              onReload={() => {
                setProblem(undefined)
                live.clear()
                reload().catch(() => undefined)
              }}
              onSave={save}
            />
          </ScoringSheetHeight.Provider>
        </View>
      )}
      {editingPlayer != null && (
        <ScoringSheet
          title={`${editingPlayer.name} — Settings`}
          onClose={() => {
            setEditingPlayer(undefined)
          }}
        >
          <PlayerSettingsTab
            client={client}
            userId={String(editingPlayer.userId)}
            teamId={editingPlayer.teamId}
            onSaved={(_hands, entry) => {
              if (entry == null) return
              const id = editingPlayer.teamId
              setOpened(current =>
                current == null
                  ? current
                  : {
                      ...current,
                      rosters: {
                        ...current.rosters,
                        [id]: current.rosters[id].map(row =>
                          row.userId === entry.userId ? entry : row
                        )
                      }
                    }
              )
            }}
          />
        </ScoringSheet>
      )}
      {asking != null && (
        <Modal
          transparent
          visible
          animationType="fade"
          onRequestClose={() => {
            answer(false)
          }}
        >
          <View
            style={{
              flex: 1,
              justifyContent: 'center',
              padding: 24,
              backgroundColor: theme.overlayBackgroundColor
            }}
          >
            <View
              accessibilityViewIsModal
              testID="Coach discard"
              style={{
                gap: 12,
                padding: 16,
                borderRadius: theme.rem(theme.radiusLargeRem),
                backgroundColor: theme.scoringSurface.background,
                borderWidth: 1,
                borderColor: theme.scoringSurface.border
              }}
            >
              <Text
                accessibilityRole="header"
                style={{
                  ...text,
                  fontFamily: theme.boldTextFont,
                  fontSize: 18
                }}
              >
                {lstrings.coach_discard_title}
              </Text>
              <Button
                label={lstrings.coach_discard}
                accessibilityLabel={lstrings.coach_discard}
                color={theme.dangerColor}
                onPress={() => {
                  answer(true)
                }}
              />
              <Button
                label={lstrings.coach_keep_editing}
                accessibilityLabel={lstrings.coach_keep_editing}
                kind="secondary"
                onPress={() => {
                  answer(false)
                }}
              />
            </View>
          </View>
        </Modal>
      )}
    </View>
  )
}
