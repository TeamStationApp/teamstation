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
  SidePlan,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  alignPlan,
  DEFAULT_PLAN_INNINGS,
  type GamePlan,
  inningDefense,
  planHasPositions
} from '../../common/gamePlan'
import { planWarnings, warningSummary } from '../../common/planWarnings'
import { begun } from '../../common/scoring/lineup'
import type { Lineup } from '../../common/scoring/lineupHistory'
import type { StagedRunner } from '../../common/scoring/rosterCommands'
import type { ScoringSession } from '../../common/scoring/session'
import {
  defaultPending,
  shownWithDefault
} from '../../common/scoring/startingSetup'
import {
  copyState,
  type GameState,
  POSITIONS,
  setupOf,
  type Side
} from '../../common/scoring/state'
import { Button } from '../components/Button'
import { ButtonIcon } from '../components/ButtonIcon'
import { type SuccessNotice, SuccessToast } from '../components/SuccessToast'
import { lstrings, sprintf } from '../locales/strings'
import type { Route } from '../navigation/routes'
import { useInsets } from '../platform/safeArea'
import { candidateNames } from '../scoring/candidateNames'
import { guestRenames, sendGuestRenames } from '../scoring/guestRenames'
import { HeldGameNotice } from '../scoring/HeldGameNotice'
import type { PlanContext } from '../scoring/plan/PlanTab'
import { rosterPlayerBody } from '../scoring/playerDraft'
import type { RosterDictationOptions } from '../scoring/rosterDictation'
import {
  planDirty,
  planLineup,
  planOrderStale,
  sameValue
} from '../scoring/rosterDirty'
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
  useOutboxNotice,
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

/** A side with no plan saved yet: six blank innings, not followed. */
const NO_PLAN: GamePlan = {
  enabled: false,
  innings: DEFAULT_PLAN_INNINGS,
  rows: []
}

/**
 * What the Plan tab's warnings are judged by: the side's rules and
 * same-day load as the server read them, and the game as the screen holds
 * it, final or not, and the innings it reached.
 */
export function planContextOf(side: SidePlan, session: GameState): PlanContext {
  const started = begun(session)
  return {
    rules: side.rules,
    sameDay: side.sameDay,
    status: session.final ? 'final' : started ? 'inProgress' : 'scheduled',
    ...(started
      ? { playedInnings: session.liveData.linescore.currentInning }
      : {})
  }
}

/**
 * Coach Game: a head coach's own team in a game, on a screen of its own —
 * the box score, and the roster screen's Roster, Lineup, Defense and Plan,
 * with its bar and dictation. Save Rosters saves his side's lineup through
 * `client.saveLineups` when it changed, then his game plan through
 * `client.saveGamePlan` when that changed, and stays; before the first
 * pitch, a plan he follows sets the lineup's defence to its inning 1.
 * Cancel discards what is staged, the plan's edits too, and reads the game
 * again. The game is never scored here: the session is read, and read again
 * after each save.
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
  // His side's game plan as the server answered it (undefined until read,
  // or when it could not be), the plan being edited and the one saved.
  const [sidePlan, setSidePlan] = useState<SidePlan>()
  const [plan, setPlan] = useState<GamePlan>()
  const [savedPlan, setSavedPlan] = useState<GamePlan>()
  const [planNotice, setPlanNotice] = useState<SuccessNotice>()
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
  /** Counts lineup saves: only the latest one's refusal is put back. */
  const saves = useRef(0)
  /** Counts availability changes: only the latest answer is the game's. */
  const rosteredRequests = useRef(0)
  // A save already shown that the server would not take once it was sent
  // (another device changed that lineup later), or an add that waits on
  // approval: said here, and the game read again to show the server's.
  const teams = state?.session.gameData.teams
  const outboxNotice = useOutboxNotice(
    client,
    gameId,
    teams == null ? [] : [teams.away.id, teams.home.id]
  )
  useEffect(() => {
    if (outboxNotice == null) return
    setProblem(outboxNotice.text)
    setReopened(value => value + 1)
    outboxNotice.dismiss()
  }, [outboxNotice])

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
  const shownSession = state?.session
  const planChanged = useMemo(
    () =>
      side != null &&
      shownSession != null &&
      planDirty(plan, savedPlan, planLineup(held?.draft ?? shownSession, side)),
    [plan, savedPlan, held, shownSession, side]
  )
  const planContext = useMemo(
    () =>
      sidePlan == null || shownSession == null
        ? undefined
        : planContextOf(sidePlan, shownSession),
    [sidePlan, shownSession]
  )
  const unsaved = dirty || planChanged
  const dirtyNow = useRef(unsaved)
  dirtyNow.current = unsaved
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
      const [away, home, lineups, kept, plans] = await Promise.all([
        roster(game.awayTeamId),
        roster(game.homeTeamId),
        client.gameLineups(gameId),
        client
          .defaultLineup(teamId)
          .then(found => found.lineup)
          .catch(() => null),
        // A plan that cannot be read leaves the Plan tab saying so, and
        // nothing of it is saved over the server's.
        client
          .gamePlans(gameId)
          .then(both => both[of] ?? undefined)
          .catch(() => undefined)
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
      const stored = plans == null ? undefined : (plans.plan ?? NO_PLAN)
      setSidePlan(plans)
      setPlan(stored)
      setSavedPlan(stored)
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
  // His side's plan, read again when a save of it is announced (his other
  // device's, or a scorekeeper's) and after the socket was down, since a
  // notice missed then is never sent again. The saved plan is replaced, so
  // Cancel goes back to the newer one; the plan being edited too, unless it
  // has changes not saved. Those are kept, and his next Save stores them
  // over the newer plan, as the last save of a plan always wins.
  const planReads = useRef(0)
  const planChangedNow = useRef(planChanged)
  planChangedNow.current = planChanged
  const rereadPlan = useCallback((): void => {
    const of = sideRef.current
    if (of == null) return
    const read = ++planReads.current
    client.gamePlans(gameId).then(
      both => {
        const answer = both[of]
        if (read !== planReads.current || answer == null) return
        const stored = answer.plan ?? NO_PLAN
        setSidePlan(answer)
        setSavedPlan(stored)
        if (!planChangedNow.current) setPlan(stored)
      },
      () => undefined
    )
  }, [client, gameId])
  useEffect(() => {
    if (socket == null) return
    return listen(socket, gameId, event => {
      if (
        event.type === 'resync' ||
        (event.type === 'change' &&
          (event.kind === 'playEdits' || event.kind === 'game'))
      )
        refreshBox()
      if (
        event.type === 'resync' ||
        (event.type === 'change' &&
          event.kind === 'plans' &&
          event.data.teamId === teamId)
      )
        rereadPlan()
    })
  }, [socket, gameId, teamId, refreshBox, rereadPlan])
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
      !unsaved ||
      (await new Promise<boolean>(resolve => {
        setAsking(() => resolve)
      })),
    [unsaved]
  )
  const returnTo = useMemo<Route>(
    () => ({ name: 'game', gameId, tab: 'boxScore' }),
    [gameId]
  )
  const exit = useScoringExit(
    gameId,
    unsaved,
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
    if (Platform.OS !== 'android' || !unsaved) return
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      exit()
      return true
    })
    return () => {
      back.remove()
    }
  }, [unsaved, exit])
  const answer = (leave: boolean): void => {
    asking?.(leave)
    setAsking(undefined)
  }

  const save = (
    edited: GameState,
    nextBatter: number | undefined,
    runners: StagedRunner[] | undefined,
    openedOver: GameState
  ): void | Promise<void> => {
    if (opened == null || state == null) return
    const saving = opened
    setProblem(undefined)
    // Before the game has begun, a plan that holds a position sets the
    // defence his lineup starts in: its first inning's column
    // (`inningDefense`, none while that inning is not planned), saved with
    // the lineup and shown on Defense. A column that leaves nobody pitching
    // is not applied, and the save's notice says so; so does one that
    // changes who plays any position from the Defense tab's, by putting
    // someone else there or by benching its fielder (a blank is the bench).
    // Later innings are the scorekeeper's, at each inning's end.
    const first =
      plan != null && planHasPositions(plan) && !begun(edited)
        ? inningDefense(
            plan,
            1,
            edited.liveData.boxscore.teams[saving.side],
            edited.gameData.players
          )
        : null
    const noPitcher = first != null && first.P == null
    const applied = first != null && !noPitcher ? first : undefined
    const edits = edited.liveData.boxscore.teams[saving.side].defense
    const overruled =
      applied != null &&
      POSITIONS.some(
        position => (applied[position] ?? null) !== (edits[position] ?? null)
      )
    const draft = applied == null ? edited : copyState(edited)
    if (applied != null)
      draft.liveData.boxscore.teams[saving.side].defense = applied
    /**
     * The save's notice: the column not applied, or applied over the Defense
     * tab's, and the plan's warnings.
     */
    const notify = (warnings: string): void => {
      const message = noPitcher
        ? warnings === ''
          ? lstrings.coach_plan_saved_no_pitcher
          : sprintf(lstrings.coach_plan_saved_no_pitcher_warnings, warnings)
        : overruled
          ? warnings === ''
            ? lstrings.coach_plan_saved_defense
            : sprintf(lstrings.coach_plan_saved_defense_warnings, warnings)
          : warnings === ''
            ? undefined
            : sprintf(lstrings.coach_plan_saved_warnings, warnings)
      if (message != null) setPlanNotice({ id: Date.now(), message })
    }
    // The plan as saved follows the order being saved with it: a changed
    // plan is saved, and a saved one whose rows bat in another order is
    // saved again with the lineup, so its first row is the leadoff.
    const order = planLineup(draft, saving.side)
    const planned =
      plan != null && (planChanged || planOrderStale(savedPlan, order))
        ? alignPlan(plan, order)
        : undefined
    const sendPlan = (): void => {
      if (planned == null) {
        notify('')
        return
      }
      const judged = planContext
      // A reread of the plan sent before this save could answer after it
      // with the plan this save replaces: it is dropped.
      planReads.current++
      client
        .saveGamePlan(gameId, teamId, planned)
        .then(answer => {
          const stored = answer.plan ?? planned
          setSidePlan(answer)
          setSavedPlan(stored)
          // An edit made while the save was out stays to be saved.
          setPlan(shown => (shown === plan ? stored : shown))
          notify(
            warningSummary(
              planWarnings({
                plan: stored,
                rules: answer.rules,
                sameDay: answer.sameDay,
                playedInnings: judged?.playedInnings,
                final: judged?.status === 'final'
              })
            ).text
          )
        })
        .catch(() => {
          setProblem(lstrings.coach_save_failed)
        })
    }
    // Only the plan changed, and not the defence it starts: the lineup is
    // not saved again.
    if (!dirty && !unaccepted && applied == null && planned != null) {
      sendPlan()
      return
    }
    const saveNumber = ++saves.current
    // When the change was made: the latest change of a side wins.
    const changedAt = new Date().toISOString()
    // A game-only player's corrected name is his account's: renamed first,
    // then the lineup that shows it is saved, both queued behind the
    // screen. The corrections are told against the game the editor was
    // opened over (`mountedOn`).
    const renamed = sendGuestRenames(
      client,
      gameId,
      guestRenames(openedOver, draft),
      [
        ...Object.values((detail ?? saving.game).guestPlayers).flat(),
        ...createdGuests.current
      ],
      undefined,
      { background: true }
    )
    // Made on the plays the screen opened: a reset since refuses it.
    const posted = renamed.then(
      async () =>
        await client.saveLineups(
          gameId,
          {
            ...lineupsBody(
              draft,
              saving.side,
              digest.current,
              nextBatter,
              runners
            ),
            generation: saving.game.generation,
            changedAt
          },
          { background: true }
        )
    )
    live.saving(posted.then(lineups => lineups.digest))
    // Shown at once: the game as saved, and the editor drawn again over it,
    // clean. The server's answer is read in behind it. A refusal puts the
    // game back as it was shown and the change back on the editor, staged,
    // with the server's reason.
    const shownBefore = { state, mountedOn: mountedOn.current }
    const redraw = (
      next: GameState,
      base?: GameState,
      staged = false
    ): void => {
      setHeld(last => ({
        draft: next,
        side: saving.side,
        mode: last?.mode ?? 'boxScore',
        ...(last?.scrollOffsets == null
          ? {}
          : { scrollOffsets: last.scrollOffsets }),
        ...(base == null ? {} : { base }),
        ...(staged && nextBatter != null ? { nextBatter } : {}),
        ...(staged && runners != null && runners.length > 0 ? { runners } : {})
      }))
      setRead(value => value + 1)
    }
    mountedOn.current = draft
    setState(current =>
      current == null ? current : { ...current, session: draft }
    )
    redraw(draft)
    posted
      .then(lineups => {
        heard(lineups, saving.side)
        reload().catch(() => undefined)
        sendPlan()
      })
      .catch((caught: unknown) => {
        setProblem(
          caught instanceof HttpError
            ? caught.message
            : lstrings.coach_save_failed
        )
        if (openedNow.current !== saving) return
        // A later save is on screen, and may still land: the server's
        // lineups are read in under it rather than this save's snapshot.
        if (saveNumber !== saves.current) {
          setReopened(value => value + 1)
          return
        }
        mountedOn.current = shownBefore.mountedOn
        setState(shownBefore.state)
        redraw(edited, openedOver, true)
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
        // Seven points over the Box Score pill, half the fourteen it had.
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          marginBottom: -1
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.common_back}
          hitSlop={8}
          onPress={exit}
          style={{ marginLeft: -8 }}
        >
          <ButtonIcon
            name="chevron_left"
            size={2.5}
            color={theme.primaryTextColor}
          />
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
              guests={[
                ...Object.values((detail ?? opened.game).guestPlayers).flat(),
                ...createdGuests.current
              ]}
              unrostered={(detail ?? opened.game).unrostered}
              onRosteredChange={async (side, userId, rostered) => {
                const posted = client.setRostered(
                  gameId,
                  { side, userId, rostered },
                  { background: true }
                )
                live.saving(
                  posted
                    .then(async () => {
                      const lineups = await client.gameLineups(gameId)
                      heard(lineups, side)
                      return lineups.digest
                    })
                    .catch(() => digest.current)
                )
                const request = ++rosteredRequests.current
                const unrostered = await posted
                // A change made since answers for the game itself: the
                // editor takes this answer's own player from it.
                if (request !== rosteredRequests.current) return unrostered
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
                  rosterPlayerBody(player),
                  { background: true }
                )
                holdRosterEntry(id, entry)
                return entry
              }}
              client={client}
              onAddExistingRosterPlayer={async (id, body, candidate) => {
                const answer = await client.addExistingRosterPlayer(id, body, {
                  background: true,
                  deviceNames: candidateNames(candidate)
                })
                if ('entry' in answer) holdRosterEntry(id, answer.entry)
                return answer
              }}
              onAddExistingGuest={async (side, body, candidate) => {
                const answer = await client.addExistingGuest(
                  gameId,
                  side,
                  body,
                  teamId,
                  { background: true, deviceNames: candidateNames(candidate) }
                )
                if ('entry' in answer) createdGuests.current.push(answer.entry)
                return answer
              }}
              onCreateGuest={async (side, player) => {
                const entry = await client.createGuestPlayer(
                  gameId,
                  side,
                  rosterPlayerBody(player),
                  teamId,
                  { background: true }
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
              plan={plan}
              planContext={planContext}
              planChanged={planChanged}
              onPlanChange={setPlan}
              onReload={() => {
                setProblem(undefined)
                setPlan(savedPlan)
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
      <SuccessToast notice={planNotice} />
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
