import React, {
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type {
  ExistingPlayerAnswer,
  RosterCandidate,
  RosterEntry,
  TeamStationClient
} from '../../common/api'
import type { GamePlan } from '../../common/gamePlan'
import { playerAddToldWords } from '../../common/notifications'
import {
  type ExistingRosterPlayer,
  PLAYER_POSITIONS as STORED_POSITIONS
} from '../../common/playerSettings'
import { pitchThrown } from '../../common/scoring/lineup'
import { withoutReaderNames } from '../../common/scoring/readerNames'
import { gameRosterEntries } from '../../common/scoring/rosterAvailability'
import {
  type ChosenRosterCommand,
  ROSTER_TAB,
  type RosterQuestion,
  type RosterTab,
  type StagedRunner
} from '../../common/scoring/rosterCommands'
import { rosterError } from '../../common/scoring/rules'
import {
  appearedIn,
  reconcileRoster,
  type ScoringRosterEntry
} from '../../common/scoring/startingSetup'
import { setupOf } from '../../common/scoring/state'
import type { Unrostered } from '../../common/unroster'
import { userIdOfGumbo } from '../../common/userId'
import { Button } from '../components/Button'
import { ButtonIcon } from '../components/ButtonIcon'
import { useSharedFit } from '../components/fittedText'
import { forgetFound } from '../hooks/useRosterCandidates'
import { lstrings, plural, sprintf } from '../locales/strings'
import type { Insets } from '../platform/insets'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import { BatIcon } from './BatIcon'
import { shortPlayerNames, withRosterDetails } from './currentSetup'
import { DefensiveField } from './DefensiveField'
import { EditRosterList } from './EditRosterList'
import { ExistingPlayerSheet } from './ExistingPlayerSheet'
import { GameRosterHeader } from './GameRosterHeader'
import { HelpSheet } from './HelpSheet'
import type { LineupQrResult } from './lineupQrImport'
import { LineupShareSheet } from './LineupShareSheet'
import { addPlaceholderPlayers } from './placeholderPlayers'
import { PlaceholderPlayersSheet } from './PlaceholderPlayersSheet'
import { type PlanContext, PlanTab } from './plan/PlanTab'
import {
  addPlayerDraft,
  addRosteredPlayer,
  draftOfLocalPlayer,
  editLocalPlayerDraft,
  type PlayerDraft
} from './playerDraft'
import {
  type ExistingChoice,
  type ExistingOutcome,
  PlayerEntrySheet
} from './PlayerEntrySheet'
import type { QrScannerProps } from './qrScannerProps'
import type { ChatTurn } from './RosterChat'
import {
  type RosterDictationOptions,
  useRosterDictation
} from './rosterDictation'
import { planLineup, rosterDirty, rosterSavable } from './rosterDirty'
import {
  RosterDrag,
  RosterDragGroup,
  RosterGrip,
  RosterScrollArea
} from './RosterDrag'
import { ROSTER_CARD_GAP, rosterGridColumns } from './rosterLayout'
import { RosterConflictBanner } from './rosterLive'
import { RosterName } from './RosterName'
import { byJersey } from './rosterOrder'
import { RosterRemoveButton } from './RosterRemoveButton'
import { RosterSelector } from './RosterSelector'
import { CONTROL_COLORS } from './scoringControlStyle'
import { copyState } from './scoringMachine'
import { ScoringPlayerCard, scoringPlayerCardStyle } from './ScoringPlayerCard'
import { editRosterRows, lineupQrOffer } from './scoringRosterEdit'
import { baseIds, battingSide } from './scoringSelectors'
import { ScoringError, ScoringSheetHeight } from './ScoringSheet'
import {
  type Position,
  POSITIONS,
  type ScoringSessionState,
  type ScoringState,
  type Side
} from './scoringTypes'

/**
 * The roster screen's modes: a coach's begins with the game's box score,
 * which is a pill of its own above the tabs, and ends with his game plan.
 */
export type RosterMode = 'boxScore' | RosterTab | 'plan'
/**
 * Who the roster screen is for. A scorekeeper edits either team's roster for
 * the scoring screen, and leaves by Save or Cancel; a coach edits his own
 * team's, saves without leaving, and leaves by the screen's back chevron.
 */
export type RosterAudience = 'scorekeeper' | 'coach'
/** Each tab's label, which is also its accessible name. */
export const ROSTER_MODE_LABELS: Record<RosterMode, string> = {
  boxScore: lstrings.coach_box_score,
  editRoster: lstrings.scoring_roster_tab,
  lineup: 'Lineup',
  defense: 'Defense',
  plan: lstrings.coach_plan_tab
}
/** The modes an audience may be in, in order. */
export const rosterModes = (audience: RosterAudience): RosterMode[] =>
  audience === 'coach'
    ? ['boxScore', 'editRoster', 'lineup', 'defense', 'plan']
    : ['editRoster', 'lineup', 'defense']
/** The tabs the mode slider offers: the box score is its own pill. */
export const rosterPillModes = (audience: RosterAudience): RosterMode[] =>
  rosterModes(audience).filter(mode => mode !== 'boxScore')
/**
 * The bottom bar's sizes: Save Rosters' height, which a crowded Defense tab
 * shrinks, and the round microphone's diameter, twelve points more.
 */
export function rosterFooterSizes(
  dense: boolean,
  defense: boolean
): { save: number; mic: number } {
  const save = dense && defense ? 28 : 36
  return { save, mic: save + 12 }
}
/**
 * The smallest share of Cancel's and Save Rosters' 14-point labels they
 * shrink to, together, on a narrow screen: 10.5 points. A 320-point screen
 * fits Save Rosters whole at about 11.5.
 */
export const ROSTER_SAVE_FIT = 0.75
/** The compact buttons' padding, both sides: half their 36-point shell. */
const ROSTER_FOOTER_INSET = 36
/**
 * How far the bottom bar lowers into the bottom safe area: ten points, or
 * the whole inset when it is smaller, so nothing moves on the web.
 */
export const rosterFooterDrop = (insets: Pick<Insets, 'bottom'>): number =>
  Math.min(10, insets.bottom)
/**
 * The gap under the scorekeeper's bar where the screen has no bottom inset,
 * as on the web: his sheet has no padding of its own there, so without it
 * the microphone would touch the bottom edge. The coach's screen pads itself.
 */
export const rosterFooterGap = (
  insets: Pick<Insets, 'bottom'>,
  audience: RosterAudience
): number => (audience === 'scorekeeper' && insets.bottom === 0 ? 8 : 0)
export interface RosterEditorDraft {
  draft: ScoringSessionState
  side: Side
  mode: RosterMode
  scrollOffsets?: Partial<Record<Side, number>>
  nextBatter?: number
  /** Pinch runners staged by dictation, saved with the draft. */
  runners?: StagedRunner[]
  /**
   * The chat's turns as the sheet opens: a substitution said on the scoring
   * screen opens the sheet with it staged and its words shown.
   */
  chat?: ChatTurn[]
  /**
   * What the chat asks as the sheet opens: which player a substitution said
   * on the scoring screen means, when the player said fits two or more.
   */
  question?: RosterQuestion
  /** Named creations from the scoring screen await the roster API here. */
  pending?: ChosenRosterCommand[]
  /**
   * The game the draft was opened over, when it is not the screen's own
   * session: Save Rosters lights when the draft differs from it.
   */
  base?: ScoringSessionState
}
/** The complete field takes priority when a wrapping error leaves less list room. */
export function defenseRosterMinimum(
  areaHeight: number,
  dense: boolean
): number {
  const preferred = dense ? 64 : 88
  return areaHeight <= 0
    ? preferred
    : Math.min(preferred, Math.max(0, areaHeight - 60 - (dense ? 2 : 8)))
}
export function RosterEditor({
  state,
  audience = 'scorekeeper',
  fixedSide,
  renderBoxScore,
  dictation,
  dictate,
  dictationAvailable = false,
  lineupScanner,
  initialDraft,
  defaultSide,
  scorekeeperSide,
  rosters,
  hiddenTeams,
  guests = [],
  unaccepted = false,
  conflict = false,
  onDraftChange,
  onDirtyChange,
  onEditPlayer,
  unrostered,
  onRosteredChange,
  rosterLoading,
  rosterError: editError,
  onRetryRoster,
  canEditTeams,
  onCreatePlayer,
  onCreateGuest,
  client,
  onAddExistingRosterPlayer,
  onAddExistingGuest,
  onCancel,
  onReload,
  bottomInset,
  plan,
  planContext,
  planChanged = false,
  onPlanChange,
  onSave
}: {
  /** A coach's state is never read-only, so his game's own players stay editable. */
  state: ScoringState
  audience?: RosterAudience
  /** A coach's team: the screen shows that side alone, with no Away/Home slider. */
  fixedSide?: Side
  /** The Box Score tab's content, offered to a coach. */
  renderBoxScore?: () => ReactNode
  /**
   * Dictation's round control, drawn in the bottom bar's centre, and its
   * chat, drawn above the tabs.
   */
  dictation?: { control: ReactNode; chat: ReactNode }
  /**
   * Dictation's server and the scorer's choices: the screen draws its own
   * round control and chat, and stages what is said on the draft.
   */
  dictate?: RosterDictationOptions
  /**
   * Whether the server dictates. Without a control, the bar shows the
   * microphone's glyph only when it does.
   */
  dictationAvailable?: boolean
  /**
   * The camera Share Lineup's scan step uses, and whether it can scan: the
   * platform's own by default (none on the web).
   */
  lineupScanner?: {
    component: React.ComponentType<QrScannerProps>
    supported: boolean
    devBuild?: boolean
  }
  /** A scorekeeper's Cancel: the screen closes the sheet, dropping the draft. */
  onCancel?: () => void
  /**
   * The bottom safe-area inset the bar lowers into: the safe area around
   * the editor (the scoring sheet's own, on a scorekeeper's) by default.
   */
  bottomInset?: number
  /**
   * A coach's game plan as it is being edited, which the Plan tab shows
   * over his side's batting order, and what its warnings are judged by.
   * Without them the tab says the plan could not be read.
   */
  plan?: GamePlan
  planContext?: PlanContext
  /** Whether the plan differs from the one saved: Save Rosters lights. */
  planChanged?: boolean
  onPlanChange?: (plan: GamePlan) => void
  /**
   * A coach's Cancel, after every staged change is discarded: the screen
   * reloads the game, so the draft starts again from the latest copy.
   */
  onReload?: () => void
  initialDraft?: RosterEditorDraft
  defaultSide?: Side
  /**
   * The one side this scorekeeper keeps score for. His roster row shares that
   * lineup and scans the other. Absent when he keeps score for both teams,
   * or for neither, and the row still offers the choice.
   */
  scorekeeperSide?: Side
  /** Current labels only; roster edits retain the game's saved player details. */
  rosters?: Readonly<Record<string, readonly RosterEntry[]>>
  /**
   * The teams whose players the game names in full for a reader who may no
   * longer read them: the sheet draws their public label.
   */
  hiddenTeams?: readonly string[]
  /**
   * The game does not hold this lineup yet: a scorekeeper's game that has
   * recorded nothing, opened on the teams' default lineups or rosters, or a
   * coach's side the game has no lineup for. Save Rosters is lit with no
   * change, as saving the lineup as it stands accepts it.
   */
  unaccepted?: boolean
  /**
   * Another device changed the lineups under this draft's unsaved changes:
   * the warning shows at the top while the draft stays dirty.
   */
  conflict?: boolean
  onDraftChange?: (draft: RosterEditorDraft) => void
  /** The game's guests: a pool player among them keeps their own name. */
  guests?: readonly RosterEntry[]
  /** Whether the draft differs from the game it was opened over, as it changes. */
  onDirtyChange?: (dirty: boolean) => void
  onEditPlayer?: (userId: string, name: string, teamId: string) => void
  unrostered?: Unrostered
  onRosteredChange?: (
    side: Side,
    userId: string,
    rostered: boolean
  ) => Promise<Unrostered>
  rosterLoading?: boolean
  rosterError?: string
  onRetryRoster?: () => void
  canEditTeams?: Readonly<Record<string, boolean>>
  /**
   * Create Player on this team: a real roster player, returned as the roster
   * entry the editor lists. Absent, the sheet reports that it could not add
   * the player.
   */
  onCreatePlayer?: (teamId: string, player: PlayerDraft) => Promise<RosterEntry>
  onCreateGuest?: (side: Side, player: PlayerDraft) => Promise<RosterEntry>
  /** Searches the players Add Existing Player offers; without it the row is off. */
  client?: TeamStationClient
  /**
   * Add to Roster for an existing player, on a team the caller manages.
   * `candidate` is the person as the search found him.
   */
  onAddExistingRosterPlayer?: (
    teamId: string,
    body: ExistingRosterPlayer,
    candidate?: RosterCandidate
  ) => Promise<ExistingPlayerAnswer>
  /** Add as Pool Player: this game only, on this side. */
  onAddExistingGuest?: (
    side: Side,
    body: ExistingRosterPlayer,
    candidate?: RosterCandidate
  ) => Promise<ExistingPlayerAnswer>
  /**
   * Save Rosters, lit when the draft validates and has changed or is
   * `unaccepted`. A scorekeeper's screen applies the draft and closes the
   * sheet; a coach's saves it and stays, answering once it is saved, or
   * failing when the save is refused. The chat closes once the draft is
   * saved, and stays over a save refused, to say what was staged.
   * `openedOver` is the game the draft was opened over (`base`), not the one
   * shown behind the sheet since: what the draft changes is told from it.
   */
  onSave: (
    draft: ScoringSessionState,
    nextBatter: number | undefined,
    runners: StagedRunner[] | undefined,
    openedOver: ScoringSessionState
  ) => void | Promise<void>
}): React.ReactElement {
  const coach = audience === 'coach'
  const theme = useTheme()
  const insets = useInsets()
  const footerDrop = rosterFooterDrop({ bottom: bottomInset ?? insets.bottom })
  const footerGap = rosterFooterGap(
    { bottom: bottomInset ?? insets.bottom },
    audience
  )
  const { height, width } = useWindowDimensions()
  const measuredHeight = useContext(ScoringSheetHeight)
  const availableHeight =
    measuredHeight != null && measuredHeight > 0 ? measuredHeight : height
  const [draft, setDraft] = useState(() =>
    copyState(initialDraft?.draft ?? state.session)
  )
  const [side, setSide] = useState<Side>(
    fixedSide ?? initialDraft?.side ?? defaultSide ?? battingSide(state.session)
  )
  const sideChosen = useRef(
    fixedSide != null || initialDraft != null || rosterLoading !== true
  )
  useEffect(() => {
    if (sideChosen.current || rosterLoading === true) return
    sideChosen.current = true
    if (defaultSide != null) setSide(defaultSide)
  }, [defaultSide, rosterLoading])
  const modes = rosterModes(audience)
  const pillModes = rosterPillModes(audience)
  // The roster first: who is on the team and how to add somebody, then the
  // lineup. A draft reopened on another tab keeps it.
  const [mode, setMode] = useState<RosterMode>(
    initialDraft != null && modes.includes(initialDraft.mode)
      ? initialDraft.mode
      : 'editRoster'
  )
  const boxScore = mode === 'boxScore'
  const planning = mode === 'plan'
  const [scrollOffsets, setScrollOffsets] = useState(
    initialDraft?.scrollOffsets ?? {}
  )
  const defense = mode === 'defense'
  const dense = availableHeight > 0 && availableHeight < (defense ? 440 : 330)
  const narrowDefense = dense && defense && width < 600
  const inlineValidation = dense && defense && !narrowDefense
  const [areaHeight, setAreaHeight] = useState(0)
  const [gridWidth, setGridWidth] = useState(0)
  const [helping, setHelping] = useState(false)
  // The phone's plan picker's close while it is open: a tap on the tabs or
  // the bar around the sheet closes it rather than acting.
  const [closePlanPicker, setClosePlanPicker] = useState<() => void>()
  /** The footer's height, which the dictation chat's overlay stays above. */
  const [footerHeight, setFooterHeight] = useState(0)
  const rosterMinimum = defense ? defenseRosterMinimum(areaHeight, dense) : 0
  const [adding, setAdding] = useState(false)
  const [searching, setSearching] = useState(false)
  const [chosen, setChosen] = useState<RosterCandidate>()
  const [sharing, setSharing] = useState(false)
  // The line under the lists after an import, held with the draft and side
  // it describes, so the next change or a switch of team clears it.
  /** The line an existing-player add leaves, until its draft lands. */
  const addedNote = useRef<{ side: Side; text: string } | undefined>(undefined)
  const [importNote, setImportNote] = useState<{
    draft: ScoringSessionState
    side: Side
    text: string
  }>()
  // The add's line names the draft it landed in, so the next change clears
  // it as an import's does.
  useEffect(() => {
    const held = addedNote.current
    if (held == null) return
    addedNote.current = undefined
    setImportNote({ draft, ...held })
  }, [draft])
  const [created, setCreated] = useState<Record<string, RosterEntry[]>>({})
  // The game-only player whose sheet is open, with the draft it opened on
  // and, if that was his public label, that label: the sheet keeps what
  // it opened on, though his name may be read in full or hidden since.
  const [editingLocal, setEditingLocal] = useState<{
    id: number
    opened: PlayerDraft
    shownAs?: PlayerDraft
  }>()
  // People added here through Add Existing Player, by user id: on the
  // roster or in the game now, though their ids may still be the phone's.
  const [joined, setJoined] = useState<ReadonlySet<string>>(new Set())
  // Pool players added here, whom the game's guests do not list yet.
  const [pooled, setPooled] = useState<
    ReadonlyMap<number, RosterEntry['bats']>
  >(new Map())
  const [nextBatter, setNextBatter] = useState<number | undefined>(
    initialDraft?.nextBatter
  )
  const [runners, setRunners] = useState<StagedRunner[]>(
    initialDraft?.runners ?? []
  )
  // The game as the editor opened: a newer one shown behind the sheet (the
  // scoring screen following another device) leaves the draft clean until
  // the screen opens the editor again over it.
  const [base, setBase] = useState(() => initialDraft?.base ?? state.session)
  const openedOver = base
  const [exclusions, setExclusions] = useState(
    unrostered ?? { away: [], home: [] }
  )
  // The lists as last set, between renders: a second change made while the
  // first is still out builds on the first.
  const exclusionsNow = useRef(exclusions)
  exclusionsNow.current = exclusions
  /** Counts availability changes: only the latest one's answer is whole. */
  const rosterRequests = useRef(0)
  const [rosterProblem, setRosterProblem] = useState<string>()
  useEffect(() => {
    if (unrostered != null) setExclusions(unrostered)
  }, [unrostered])
  const applyAvailability = (
    previous: ScoringSessionState,
    lists: Unrostered
  ): ScoringSessionState => {
    const next = copyState(previous)
    const entries = (of: Side, local: boolean): ScoringRosterEntry[] =>
      gameRosterEntries(next, of, local)
    const roster = (of: Side): readonly ScoringRosterEntry[] =>
      rosters?.[next.gameData.teams[of].id] ?? entries(of, false)
    const setup = reconcileRoster(
      setupOf(next),
      next.gameData.teams,
      { away: roster('away'), home: roster('home') },
      { away: entries('away', true), home: entries('home', true) },
      lists,
      appearedIn(next)
    )
    next.gameData.players = setup.players
    next.liveData.boxscore.teams[side] = setup.sides[side]
    next.meta.tagOrder = setup.tagOrder
    return next
  }
  const toggleRostered = async (
    userId: string,
    rostered: boolean
  ): Promise<void> => {
    if (onRosteredChange == null) return
    setRosterProblem(undefined)
    const gumboId = rosters?.[draft.gameData.teams[side].id]?.find(
      row => row.userId === userId
    )?.gumboId
    const apply = (lists: Unrostered): void => {
      exclusionsNow.current = lists
      setExclusions(lists)
      setDraft(previous => applyAvailability(previous, lists))
      setBase(previous => applyAvailability(previous, lists))
    }
    /** The lists now, with `gumboId` left off (`off`) or put back. */
    const toggled = (lists: Unrostered, off: boolean): Unrostered => {
      if (gumboId == null) return lists
      const others = lists[side].filter(id => id !== gumboId)
      return { ...lists, [side]: off ? [...others, gumboId] : others }
    }
    // Shown at once, as the server will answer; its answer replaces it. A
    // refusal undoes only this change, so one made meanwhile stays.
    const wasOff =
      gumboId != null && exclusionsNow.current[side].includes(gumboId)
    const before = { draft, base, nextBatter, runners }
    if (gumboId != null) apply(toggled(exclusionsNow.current, !rostered))
    if (!rostered) {
      setNextBatter(previous => (previous === gumboId ? undefined : previous))
      setRunners(previous =>
        previous.filter(runner => runner.player !== gumboId)
      )
    }
    const request = ++rosterRequests.current
    try {
      const answer = await onRosteredChange(side, userId, rostered)
      // A change made since has an answer of its own, which may come first:
      // this one says only where its own player stands.
      if (request === rosterRequests.current) apply(answer)
      else if (gumboId != null)
        apply(toggled(exclusionsNow.current, answer[side].includes(gumboId)))
    } catch (error) {
      if (gumboId != null) {
        apply(toggled(exclusionsNow.current, wasOff))
        if (!wasOff) {
          // Put back where he was: his slot, his position, on base, due up.
          const restore = (
            now: ScoringSessionState,
            was: ScoringSessionState | undefined
          ): ScoringSessionState => {
            if (was == null) return now
            const next = copyState(now)
            const team = next.liveData.boxscore.teams[side]
            const old = was.liveData.boxscore.teams[side]
            const at = old.battingOrder.indexOf(gumboId)
            if (at >= 0 && !team.battingOrder.includes(gumboId))
              team.battingOrder.splice(
                Math.min(at, team.battingOrder.length),
                0,
                gumboId
              )
            for (const position of POSITIONS)
              if (
                old.defense[position] === gumboId &&
                team.defense[position] == null
              )
                team.defense[position] = gumboId
            return next
          }
          setDraft(previous => restore(previous, before.draft))
          setBase(previous => restore(previous, before.base))
          setNextBatter(previous =>
            previous == null && before.nextBatter === gumboId
              ? gumboId
              : previous
          )
          setRunners(previous => [
            ...previous,
            ...before.runners.filter(
              runner =>
                runner.player === gumboId &&
                !previous.some(
                  held => held.player === gumboId || held.base === runner.base
                )
            )
          ])
        }
      }
      setRosterProblem(
        error instanceof Error
          ? error.message
          : 'Could not change game availability'
      )
    }
  }
  useEffect(() => {
    onDraftChange?.({
      draft,
      side,
      mode,
      nextBatter,
      scrollOffsets,
      ...(runners.length === 0 ? {} : { runners }),
      ...(openedOver == null ? {} : { base: openedOver })
    })
  }, [
    draft,
    side,
    mode,
    nextBatter,
    runners,
    scrollOffsets,
    onDraftChange,
    openedOver
  ])
  const edit = (change: (next: ScoringSessionState) => void): void => {
    setDraft(previous => {
      const next = copyState(previous)
      change(next)
      return next
    })
  }
  const team = draft.liveData.boxscore.teams[side]
  // Game-only players belong to this game's setup, including the opponent's
  // placeholders. Their edits use scoring permission, unlike team players.
  const canEditLocal = rosterLoading !== true && state.readOnly !== true
  const canCreateRosterPlayer =
    canEditTeams == null || canEditTeams[draft.gameData.teams[side].id]
  /**
   * Puts an existing player the server took into the draft, with the
   * candidate's short name and hands and the jersey and positions chosen,
   * and says so under the list. A pending add changes nothing.
   */
  const joinExisting =
    (
      candidate: RosterCandidate,
      send: (body: ExistingRosterPlayer) => Promise<ExistingPlayerAnswer>,
      pool: boolean
    ) =>
    async (choice: ExistingChoice): Promise<ExistingOutcome> => {
      const answer = await send({
        userId: candidate.userId,
        jersey: choice.jersey === '' ? null : choice.jersey,
        positions: STORED_POSITIONS.filter(position =>
          choice.positions.includes(position)
        )
      })
      if ('pendingRequestId' in answer) return 'pending'
      const { entry } = answer
      setJoined(held => new Set(held).add(candidate.userId))
      if (client != null)
        forgetFound(client, draft.gameData.teams[side].id, candidate.userId)
      // Somebody on the roster already plays as it holds them, not as typed.
      const held = answer.unchanged === true
      const player: PlayerDraft = {
        firstName: candidate.shortParts.first,
        lastName: candidate.shortParts.last,
        jersey: held ? (entry.jersey ?? '') : choice.jersey,
        bats: candidate.bats ?? 'right',
        throws: candidate.throws,
        positions: held ? [...entry.positions] : choice.positions
      }
      const teamId = draft.gameData.teams[side].id
      if (pool && entry.gumboId != null) {
        const { gumboId } = entry
        setPooled(held => new Map(held).set(gumboId, candidate.bats))
      }
      if (!pool)
        setCreated(held => ({
          ...held,
          [teamId]: [...(held[teamId] ?? []), entry]
        }))
      // Onto the draft as it stands now, not as it was before the request:
      // anything that changed meanwhile stays.
      addedNote.current = {
        side,
        text:
          answer.unchanged === true
            ? `${candidate.shortName} is already on the roster.`
            : answer.noticeId == null
              ? `${candidate.shortName} was added.`
              : `${candidate.shortName} was added. ${playerAddToldWords(answer.told)}`
      }
      edit(next => {
        if (pool) addPlayerDraft(next, side, player, entry.gumboId!)
        else addRosteredPlayer(next, side, entry, player)
      })
      return 'added'
    }
  const addPlaceholders = async (count: number): Promise<void> => {
    if (onCreateGuest == null) throw new Error('Unable to create a guest')
    const next = copyState(draft)
    try {
      await addPlaceholderPlayers(next, side, count, onCreateGuest)
    } finally {
      // Merge only acknowledged additions, preserving intervening draft edits
      // and successes even when a later request fails.
      const added = next.liveData.boxscore.teams[side].players.filter(
        id => !draft.liveData.boxscore.teams[side].players.includes(id)
      )
      edit(current => {
        for (const id of added) {
          current.gameData.players[id] = next.gameData.players[id]
          const players = current.liveData.boxscore.teams[side].players
          if (!players.includes(id)) players.push(id)
          if (!current.meta.tagOrder.includes(id))
            current.meta.tagOrder.push(id)
        }
      })
    }
  }
  // Everybody already in the game, either side or a guest, by user id: Add
  // Existing Player lists nobody of them.
  const inGame = useMemo(() => {
    const ids = new Set(joined)
    for (const id of Object.keys(draft.gameData.players))
      try {
        ids.add(userIdOfGumbo(Number(id)))
      } catch {
        // Not a gumbo id: nobody a search lists.
      }
    return ids
  }, [draft.gameData.players, joined])
  // The draft as its reader may read it now, for what the sheet draws.
  const readable = useMemo(
    () =>
      hiddenTeams == null || hiddenTeams.length === 0
        ? draft
        : withoutReaderNames(draft, teamId => hiddenTeams.includes(teamId)),
    [draft, hiddenTeams]
  )
  const names = useMemo(
    () =>
      rosters == null
        ? readable.gameData.players
        : withRosterDetails(readable, rosters).gameData.players,
    [readable, rosters]
  )
  // The field's cards name each player as the scoring screen's field does.
  const fieldNames = useMemo(
    () => shortPlayerNames(Object.values(names)),
    [names]
  )
  const fieldName = (id: number): string =>
    fieldNames.get(id) ?? names[id].fullName
  const assigned = defense ? Object.values(team.defense) : team.battingOrder
  // The plan's rows: his side's batting order, each batter by who he is.
  const planBatters = useMemo(() => {
    const players = planLineup(draft, side)
    return team.battingOrder
      .filter(id => draft.gameData.players[id] != null)
      .map((id, at) => ({
        id,
        player: players[at],
        name: names[id].fullName,
        jersey: names[id].jersey
      }))
  }, [draft, side, team.battingOrder, names])
  const place = (id: number, index: number, boundary = false): void => {
    if (!team.players.includes(id)) return
    edit(next => {
      const order = next.liveData.boxscore.teams[side].battingOrder
      const old = order.indexOf(id)
      if (old >= 0) order.splice(old, 1)
      order.splice(
        Math.max(
          0,
          Math.min(
            index - (boundary && old >= 0 && old < index ? 1 : 0),
            order.length
          )
        ),
        0,
        id
      )
    })
  }
  const remove = (id: number): void => {
    edit(next => {
      const list = next.liveData.boxscore.teams[side]
      list.battingOrder = list.battingOrder.filter(player => player !== id)
    })
  }
  // From the first pitch the lineup can't be reordered by insertion or have
  // players removed (no Clear and no X): a player dropped on a row replaces
  // the batter in that slot, and a late arrival can still be added at the end.
  const locked = pitchThrown(state.session)
  /**
   * Puts `id` in slot `index`: a bench player replaces the man there, who
   * goes back to the roster; a man already in the order swaps slots with him.
   */
  const replace = (id: number, index: number): void => {
    if (!team.players.includes(id)) return
    edit(next => {
      const order = next.liveData.boxscore.teams[side].battingOrder
      if (index < 0 || index >= order.length) return
      const old = order.indexOf(id)
      if (old >= 0) order[old] = order[index]
      order[index] = id
    })
  }
  /** Clear: the side bats nobody; every player stays on the roster. */
  const clearLineup = (): void => {
    const cleared = team.battingOrder
    setNextBatter(previous =>
      previous != null && cleared.includes(previous) ? undefined : previous
    )
    edit(next => {
      next.liveData.boxscore.teams[side].battingOrder = []
    })
  }
  /** Clear: every position, the pitcher's too, is empty. */
  const clearDefense = (): void => {
    edit(next => {
      const field = next.liveData.boxscore.teams[side].defense
      for (const position of POSITIONS) field[position] = null
    })
  }
  const validation = rosterError(
    state.session,
    setupOf(draft),
    nextBatter,
    locked
  )
  const dirty = rosterDirty(base, draft, runners, nextBatter)
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  const sizes = rosterFooterSizes(dense, defense)
  /** Cancel's and Save Rosters' shell, which a crowded Defense tab shrinks. */
  const footerButton = {
    height: sizes.save,
    minHeight: sizes.save,
    borderRadius: sizes.save / 2
  }
  // Cancel's label is drawn at Save Rosters' size, not left larger.
  const footerFit = useSharedFit(ROSTER_SAVE_FIT, ROSTER_FOOTER_INSET)
  const footerLabel = { fontSize: 14 * footerFit.scale }
  // A dictated sentence is staged whole: the draft, its runners and next
  // batter, and the tab, and for a scorekeeper the team, that show it.
  const spoken = useRosterDictation({
    onCreateGuest,
    options: dictate,
    game: state.session,
    draft,
    fixedSide,
    runners,
    nextBatter,
    size: sizes.mic,
    chat: initialDraft?.chat,
    question: initialDraft?.question,
    pending: initialDraft?.pending,
    onCreatePlayer:
      onCreatePlayer == null
        ? undefined
        : async (teamId, player) => {
            const entry = await onCreatePlayer(teamId, player)
            setCreated(held => ({
              ...held,
              [teamId]: [...(held[teamId] ?? []), entry]
            }))
            return entry
          },
    onStage: staged => {
      setDraft(staged.draft)
      setRunners(staged.runners)
      setNextBatter(staged.nextBatter)
      setMode(ROSTER_TAB[staged.category])
      if (fixedSide == null) {
        sideChosen.current = true
        setSide(staged.side)
      }
    }
  })
  const shown =
    dictation ??
    (dictate == null || spoken.control == null ? undefined : spoken)
  const text = {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: 14
  }
  const row = scoringPlayerCardStyle(theme)
  const teamId = draft.gameData.teams[side].id
  const heldRoster = rosters?.[teamId] ?? []
  // The team's roster as the editor shows it: what was read, and the players
  // created here since. Scan matches against the same list.
  const teamRoster = [
    ...heldRoster,
    ...(created[teamId] ?? []).filter(
      entry => !heldRoster.some(held => held.userId === entry.userId)
    )
  ]
  const rosterRows = editRosterRows(teamRoster, readable, side)
  const imported = (result: LineupQrResult): void => {
    const count = result.added.length + result.reused.length
    setDraft(result.draft)
    // As Cancel does: a chosen next batter or a staged runner may name a
    // player the import benched; the scorer chooses again on the new lineup.
    setNextBatter(undefined)
    setRunners([])
    setMode('lineup')
    setSharing(false)
    setImportNote({
      draft: result.draft,
      side,
      text:
        plural(
          count,
          lstrings.lineupQr_imported_one,
          lstrings.lineupQr_imported_other
        ) +
        (result.benched.length === 0
          ? ''
          : ' · ' + sprintf(lstrings.lineupQr_benched, result.benched.length))
    })
  }
  const note =
    importNote?.draft === draft && importNote.side === side
      ? importNote.text
      : undefined
  const gap = dense && defense ? 2 : dense ? 4 : 8
  return (
    <View
      pointerEvents={spoken.busy ? 'none' : 'auto'}
      style={{ flex: 1, minHeight: 0, gap }}
    >
      {conflict && dirty && <RosterConflictBanner />}
      <ScrollView
        testID="Roster editor top"
        // Browser chrome can leave much less room than the screen height.
        // Instructions remain reachable by scrolling this compact header.
        style={{
          flexGrow: 0,
          maxHeight: dense ? (defense ? 28 : 48) : height < 500 ? 113 : 230
        }}
        contentContainerStyle={{ gap: 4, marginTop: dense && defense ? -6 : 0 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: dense ? 'row' : 'column', gap: 4 }}>
          {fixedSide == null && (
            <View style={{ flex: dense ? 1 : undefined, minWidth: 0 }}>
              <RosterSelector
                labels={[
                  draft.gameData.teams.away.name,
                  draft.gameData.teams.home.name
                ]}
                captions={dense ? undefined : ['Away', 'Home']}
                compact={height < 500}
                accessibilityLabels={['Away Team', 'Home Team']}
                value={side === 'away' ? 0 : 1}
                onChange={index => {
                  sideChosen.current = true
                  setSide(index === 0 ? 'away' : 'home')
                  setImportNote(undefined)
                }}
              />
            </View>
          )}
          <View style={{ flex: dense ? 1 : undefined, minWidth: 0 }}>
            {modes.includes('boxScore') && (
              <BoxScorePill
                selected={boxScore}
                compact={narrowDefense}
                onPress={() => {
                  setMode('boxScore')
                }}
              />
            )}
            <RosterSelector
              fitContent={!narrowDefense}
              compact={narrowDefense}
              labels={pillModes.map(each => ROSTER_MODE_LABELS[each])}
              // On the box score no tab is chosen.
              value={pillModes.indexOf(mode)}
              onChange={index => {
                setMode(pillModes[index])
              }}
            />
          </View>
        </View>
        {mode === 'editRoster' ? (
          <GameRosterHeader information={coach} />
        ) : (
          // Defense has a Help button on its field instead, and Plan one
          // above its sheet.
          !boxScore &&
          !defense &&
          !planning && (
            <Text style={text}>
              Tap to add to lineup. Hold briefly, then drag to reorder.
            </Text>
          )
        )}
        {state.phase === 'awaitingBatter' && !boxScore && !planning && (
          <View style={{ gap: 6 }}>
            <Text style={text}>Choose Next Batter</Text>
            {draft.liveData.boxscore.teams[battingSide(draft)].battingOrder.map(
              id => (
                <ScoringPlayerCard
                  key={id}
                  label={`Next batter ${names[id].fullName}`}
                  disabled={baseIds(draft).includes(id)}
                  selected={nextBatter === id}
                  name={names[id].fullName}
                  onPress={() => {
                    setNextBatter(id)
                  }}
                />
              )
            )}
          </View>
        )}
      </ScrollView>
      {boxScore && (
        <View testID="Roster box score" style={{ flex: 1, minHeight: 0 }}>
          {renderBoxScore?.()}
        </View>
      )}
      {planning && (
        <View
          style={{
            flex: 1,
            minHeight: 0,
            zIndex: closePlanPicker == null ? undefined : 2
          }}
        >
          {plan == null || planContext == null ? (
            <ScoringError message={lstrings.coach_plan_load_failed} />
          ) : (
            <PlanTab
              plan={plan}
              batters={planBatters}
              context={planContext}
              onChange={next => {
                onPlanChange?.(next)
              }}
              onDrop={(player, index, edge) => {
                if (locked) replace(player, index)
                else place(player, index + (edge === 'after' ? 1 : 0), true)
              }}
              onReorder={(id, delta) => {
                place(id, team.battingOrder.indexOf(id) + delta)
              }}
              locked={locked}
              onPicker={close => {
                setClosePlanPicker(() => close)
              }}
            />
          )}
        </View>
      )}
      {planning && closePlanPicker != null && (
        <Pressable
          testID="Plan picker screen backdrop"
          accessibilityLabel={lstrings.plan_close_picker}
          onPress={closePlanPicker}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1
          }}
        />
      )}
      <View
        style={{
          flex: 1,
          minHeight: 0,
          display: mode === 'editRoster' ? 'flex' : 'none'
        }}
      >
        <EditRosterList
          key={side}
          visible={mode === 'editRoster'}
          initialScrollOffset={scrollOffsets[side]}
          onScrollOffset={offset => {
            setScrollOffsets(held =>
              held[side] === offset ? held : { ...held, [side]: offset }
            )
          }}
          rows={rosterRows}
          loading={rosterLoading}
          error={rosterProblem ?? editError}
          unrostered={exclusions[side]}
          onRosteredChange={
            coach && onRosteredChange != null
              ? (userId, rostered) => {
                  toggleRostered(userId, rostered).catch(() => undefined)
                }
              : undefined
          }
          onRetry={onRetryRoster}
          adding={
            state.readOnly === true || rosterLoading === true
              ? 'disabled'
              : 'enabled'
          }
          onCreatePlayer={() => {
            setAdding(true)
          }}
          {...(client == null || onAddExistingGuest == null
            ? {}
            : {
                onAddExisting: () => {
                  setSearching(true)
                }
              })}
          {...(coach
            ? {}
            : {
                lineupOffer: lineupQrOffer(scorekeeperSide, side),
                onShareLineup: () => {
                  setSharing(true)
                }
              })}
          onEditLocal={
            canEditLocal
              ? id => {
                  const opened = draftOfLocalPlayer(
                    readable.gameData.players[id]
                  )
                  setEditingLocal({
                    id,
                    opened,
                    // Drawn by his public label: left so, his name stays his.
                    ...(readable.gameData.players[id] ===
                    draft.gameData.players[id]
                      ? {}
                      : { shownAs: opened })
                  })
                }
              : undefined
          }
          onEdit={
            onEditPlayer == null ||
            (canEditTeams != null &&
              !canEditTeams[draft.gameData.teams[side].id]) ||
            rosterLoading === true
              ? undefined
              : (userId, name) => {
                  onEditPlayer(userId, name, draft.gameData.teams[side].id)
                }
          }
        />
      </View>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          display: mode === 'lineup' || defense ? 'flex' : 'none'
        }}
      >
        <RosterDragGroup key={`${side}:${mode}`}>
          <View
            onLayout={event => {
              setAreaHeight(event.nativeEvent.layout.height)
            }}
            style={{
              flex: 1,
              minHeight: 0,
              flexDirection: defense ? 'column' : 'row',
              gap: dense && defense ? 2 : 8
            }}
          >
            {defense && (
              <DefensiveField
                defense={team.defense}
                compact={height < 500}
                display={fieldName}
                // Short on the card, in full to a screen reader.
                spoken={id =>
                  `${names[id].jersey === '' ? '' : `#${names[id].jersey} `}${names[id].fullName}`
                }
                onPlace={(player, position) => {
                  if (!team.players.includes(player)) return
                  edit(next => {
                    const field = next.liveData.boxscore.teams[side].defense
                    const from = POSITIONS.find(p => field[p] === player)
                    if (from === position) return
                    // A fielder dropped on another position swaps with the
                    // man there; a roster card replaces him.
                    if (from != null) field[from] = field[position] ?? null
                    field[position] = player
                  })
                }}
                onClear={(position: Position) => {
                  edit(next => {
                    next.liveData.boxscore.teams[side].defense[position] = null
                  })
                }}
                onHelp={() => {
                  setHelping(true)
                }}
                onClearAll={clearDefense}
              />
            )}
            <View
              style={{
                flex: 1,
                minHeight: rosterMinimum,
                gap: 6
              }}
            >
              {/* Defense's list needs no title: its Clear is on the field. */}
              {!defense && (
                <Text
                  style={{
                    ...text,
                    fontWeight: '700',
                    // Level with the Lineup header beside it.
                    lineHeight: dense ? 20 : 28
                  }}
                >
                  Roster
                </Text>
              )}
              <RosterScrollArea
                name="Roster players"
                // Defense's two columns run from margin to margin.
                inset={defense ? 0 : undefined}
              >
                <RosterDrag
                  targetId="roster"
                  onDropPlayer={defense || locked ? undefined : remove}
                >
                  <View
                    testID={defense ? 'Defense roster grid' : undefined}
                    onLayout={
                      defense
                        ? event => {
                            setGridWidth(event.nativeEvent.layout.width)
                          }
                        : undefined
                    }
                    style={
                      defense
                        ? {
                            flexDirection: 'row',
                            flexWrap: 'wrap',
                            columnGap: ROSTER_CARD_GAP,
                            rowGap: 16
                          }
                        : { gap: 16 }
                    }
                  >
                    {byJersey(team.players, names)
                      .filter(id => !assigned.includes(id))
                      .map(id => {
                        const card = (
                          <RosterDrag
                            key={id}
                            playerId={id}
                            label={
                              defense
                                ? names[id].fullName
                                : `Add ${names[id].fullName} to Lineup`
                            }
                            onTap={
                              defense
                                ? undefined
                                : () => {
                                    place(id, team.battingOrder.length)
                                  }
                            }
                          >
                            <View style={row}>
                              <RosterGrip
                                label={`Drag ${names[id].fullName}`}
                                color={text.color}
                              />
                              <RosterName player={names[id]} style={text} />
                            </View>
                          </RosterDrag>
                        )
                        return defense ? (
                          <View
                            key={id}
                            style={{
                              // Two columns of the grid's measured width;
                              // nearly half until it is measured.
                              width:
                                gridWidth > 0
                                  ? rosterGridColumns(
                                      gridWidth,
                                      0,
                                      ROSTER_CARD_GAP
                                    )[0].width
                                  : '47%'
                            }}
                          >
                            {card}
                          </View>
                        ) : (
                          card
                        )
                      })}
                  </View>
                  {!defense && !locked && (
                    <Text
                      style={{
                        ...text,
                        color: theme.secondaryTextColor,
                        padding: 12
                      }}
                    >
                      Drop here to remove
                    </Text>
                  )}
                </RosterDrag>
              </RosterScrollArea>
            </View>
            {!defense && (
              <View style={{ flex: 1, minHeight: 0, gap: 6 }}>
                <View
                  testID="Lineup header"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    height: dense ? 20 : 28
                  }}
                >
                  <Text style={{ ...text, fontWeight: '700', flexShrink: 0 }}>
                    Lineup
                  </Text>
                  {!locked && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Clear Lineup"
                      hitSlop={8}
                      onPress={clearLineup}
                    >
                      <Text
                        selectable={false}
                        style={{
                          ...text,
                          fontWeight: '700',
                          flexShrink: 0,
                          color: theme.scoringOutColor
                        }}
                      >
                        Clear
                      </Text>
                    </Pressable>
                  )}
                </View>
                <RosterScrollArea name="Batting lineup">
                  <>
                    {team.battingOrder.map((id, index) => (
                      <RosterDrag
                        key={id}
                        playerId={id}
                        label={`Reorder ${names[id].fullName}`}
                        targetId={`lineup-${index}`}
                        insertion={locked ? undefined : 'row'}
                        onDropPlayer={(player, edge) => {
                          if (locked) replace(player, index)
                          else
                            place(
                              player,
                              index + (edge === 'after' ? 1 : 0),
                              true
                            )
                        }}
                        onReorder={delta => {
                          place(id, index + delta)
                        }}
                      >
                        <View style={row}>
                          <RosterGrip
                            label={`Drag ${names[id].fullName}`}
                            color={text.color}
                          />
                          <RosterName
                            player={names[id]}
                            prefix={`${index + 1}.`}
                            style={text}
                          />
                          {!locked ? (
                            <RosterRemoveButton
                              label={`Remove ${names[id].fullName}`}
                              onPress={() => {
                                remove(id)
                              }}
                            />
                          ) : index === team.battingIndex ? (
                            <BatIcon
                              label={`${names[id].fullName} bats`}
                              color={theme.primaryTextColor}
                            />
                          ) : (
                            <View style={{ width: 32, height: 32 }} />
                          )}
                        </View>
                      </RosterDrag>
                    ))}
                    <RosterDrag
                      targetId="lineup-end"
                      insertion="end"
                      onDropPlayer={id => {
                        place(id, team.battingOrder.length, true)
                      }}
                    >
                      <Text
                        style={{
                          ...text,
                          color: theme.secondaryTextColor,
                          padding: 18
                        }}
                      >
                        Drop at end of lineup
                      </Text>
                    </RosterDrag>
                  </>
                </RosterScrollArea>
              </View>
            )}
          </View>
        </RosterDragGroup>
      </View>
      {searching && client != null && onAddExistingGuest != null && (
        <ExistingPlayerSheet
          client={client}
          teamId={draft.gameData.teams[side].id}
          gameId={draft.gamePk}
          excluded={inGame}
          onChoose={setChosen}
          onClose={() => {
            setSearching(false)
          }}
        >
          {chosen != null && (
            <PlayerEntrySheet
              key={chosen.userId}
              existing={{
                candidate: chosen,
                ...(canCreateRosterPlayer && onAddExistingRosterPlayer != null
                  ? {
                      onAddToRoster: joinExisting(
                        chosen,
                        async body =>
                          await onAddExistingRosterPlayer(
                            draft.gameData.teams[side].id,
                            body,
                            chosen
                          ),
                        false
                      )
                    }
                  : {}),
                onAddAsPool: joinExisting(
                  chosen,
                  async body => await onAddExistingGuest(side, body, chosen),
                  true
                )
              }}
              onAddPlaceholders={addPlaceholders}
              onCancel={() => {
                setChosen(undefined)
              }}
              onClose={() => {
                setChosen(undefined)
                setSearching(false)
              }}
            />
          )}
        </ExistingPlayerSheet>
      )}
      {adding && !canCreateRosterPlayer && (
        <PlaceholderPlayersSheet
          onClose={() => {
            setAdding(false)
          }}
          onAdd={addPlaceholders}
        />
      )}
      {adding && canCreateRosterPlayer && (
        <PlayerEntrySheet
          onClose={() => {
            setAdding(false)
          }}
          onAddPlaceholders={addPlaceholders}
          onAdd={async player => {
            if (onCreatePlayer == null) {
              throw new Error('Unable to create the player.')
            }
            const teamId = draft.gameData.teams[side].id
            const entry = await onCreatePlayer(teamId, player)
            setCreated(held => ({
              ...held,
              [teamId]: [...(held[teamId] ?? []), entry]
            }))
            edit(next => {
              addRosteredPlayer(next, side, entry, player)
            })
          }}
        />
      )}
      {editingLocal != null && state.readOnly !== true && (
        <PlayerEntrySheet
          key={`edit:${side}:${editingLocal.id}`}
          ownIdentity={
            pooled.has(editingLocal.id) ||
            guests.some(
              guest => guest.pool === true && guest.gumboId === editingLocal.id
            )
          }
          ownBats={
            pooled.get(editingLocal.id) ??
            guests.find(guest => guest.gumboId === editingLocal.id)?.bats ??
            null
          }
          initialDraft={editingLocal.opened}
          onClose={() => {
            setEditingLocal(undefined)
          }}
          onAdd={player => {
            const { id, shownAs } = editingLocal
            edit(next => {
              editLocalPlayerDraft(next, side, id, player, shownAs)
            })
          }}
        />
      )}
      {sharing && (
        <LineupShareSheet
          side={side}
          offer={lineupQrOffer(scorekeeperSide, side)}
          draft={draft}
          game={state.session}
          nextBatter={nextBatter}
          roster={teamRoster}
          rosterLoading={rosterLoading}
          rosterError={editError}
          {...(lineupScanner == null
            ? {}
            : {
                scanner: lineupScanner.component,
                scannerSupported: lineupScanner.supported,
                devBuild: lineupScanner.devBuild
              })}
          {...(onCreateGuest == null ? {} : { onCreateGuest })}
          onImport={imported}
          onClose={() => {
            setSharing(false)
          }}
        />
      )}
      {helping && (
        <HelpSheet
          text={lstrings.roster_defense_help}
          onClose={() => {
            setHelping(false)
          }}
        />
      )}
      <View
        testID="Roster footer"
        onLayout={event => {
          setFooterHeight(event.nativeEvent.layout.height)
        }}
        style={{ gap: dense && defense ? 2 : 6 }}
      >
        {!inlineValidation && <ScoringError message={validation} />}
        {note != null && (
          <Text
            accessibilityRole="text"
            numberOfLines={1}
            style={{
              color: theme.successColor,
              fontFamily: theme.regularTextFont,
              fontSize: 13
            }}
          >
            {note}
          </Text>
        )}
        {/* A crowded Defense tab's problem, on one line of its own: the bar
            has no room for it beside two buttons and the microphone. */}
        {inlineValidation && validation != null && (
          <Text
            testID="Roster footer problem"
            accessibilityRole="alert"
            accessibilityLabel={validation}
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ color: theme.dangerColor, fontSize: 11 }}
          >
            {validation}
          </Text>
        )}
        <View
          testID="Roster footer bar"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            marginBottom: -footerDrop,
            paddingBottom: footerGap
          }}
        >
          {/* Cancel and Save Rosters, red and green, as wide as each other
              either side of the microphone. */}
          <View
            testID="Roster cancel box"
            style={{ flex: 1, minWidth: 0 }}
            onLayout={footerFit.handleRoom}
          >
            <Button
              testID="Roster cancel"
              textColor={theme.scoringMenuActiveText}
              compact
              labelStyle={footerLabel}
              // Red when pressed too, not the primary's pressed green.
              style={{
                ...footerButton,
                backgroundColor: theme.scoringOutColor
              }}
              accessibilityLabel={lstrings.roster_cancel}
              label={lstrings.roster_cancel}
              onPress={() => {
                if (!coach) {
                  onCancel?.()
                  return
                }
                setDraft(copyState(base))
                setNextBatter(undefined)
                setRunners([])
                setAdding(false)
                setEditingLocal(undefined)
                spoken.note(lstrings.dictation_changes_discarded)
                onReload?.()
              }}
            />
          </View>
          {shown != null ? (
            <View
              testID="Roster mic"
              style={{
                width: sizes.mic,
                height: sizes.mic,
                borderRadius: sizes.mic / 2,
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {shown.control}
            </View>
          ) : (
            dictationAvailable && <RosterMicGlyph size={sizes.mic} />
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Button
              color={theme.scoringMenuActiveBackground}
              textColor={theme.scoringMenuActiveText}
              compact
              // Beside Cancel and the microphone on a 320-point screen the
              // label gets smaller type rather than an ellipsis.
              labelStyle={footerLabel}
              style={footerButton}
              accessibilityLabel="Save Rosters"
              label="Save Rosters"
              disabled={
                spoken.busy ||
                !rosterSavable(dirty, unaccepted, validation, planChanged)
              }
              onPress={() => {
                const saving = onSave(
                  draft,
                  nextBatter,
                  runners.length === 0 ? undefined : runners,
                  openedOver
                )
                if (saving instanceof Promise) {
                  saving.then(
                    () => {
                      spoken.clear()
                    },
                    (error: unknown) => {
                      const message =
                        error instanceof Error ? error.message : ''
                      if (message !== '') spoken.problem(message)
                    }
                  )
                } else spoken.clear()
              }}
            />
          </View>
        </View>
      </View>
      {/* The dictation chat, over the top of the screen rather than pushing
          it down, and never over the footer. */}
      {shown?.chat != null && (
        <View
          testID="Roster chat overlay"
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: footerHeight + gap,
            zIndex: 1
          }}
        >
          {shown.chat}
        </View>
      )}
      {/* Cancel's and Save Rosters' labels at full size, unseen and
          unbounded, for the size the footer draws both at. */}
      <View
        pointerEvents="none"
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          width: 0,
          height: 0,
          overflow: 'hidden'
        }}
      >
        {/* Wide enough that neither wraps; one line of text is bounded by
            nothing here, as `numberOfLines` would bound it on the web. */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            width: 1000
          }}
        >
          {[lstrings.roster_cancel, 'Save Rosters'].map((label, at) => (
            <Text
              key={label}
              testID={`Roster footer label ${at}`}
              onLayout={footerFit.handleNatural(at)}
              style={{
                fontFamily: theme.semiBoldTextFont,
                fontWeight: '600',
                fontSize: 14
              }}
            >
              {label}
            </Text>
          ))}
        </View>
      </View>
    </View>
  )
}

/**
 * The coach's Box Score: a pill of its own on the row above the tabs,
 * styled as one of their segments, and lit while the box score is shown.
 */
function BoxScorePill({
  selected,
  compact,
  onPress
}: {
  selected: boolean
  compact: boolean
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  const height = compact ? 40 : 36
  return (
    // Straight under the screen's header, whose gap above it is seven
    // points: half the fourteen it had.
    <View style={{ alignSelf: 'center' }}>
      <Pressable
        testID="Box Score pill"
        accessibilityRole="tab"
        accessibilityLabel={lstrings.coach_box_score}
        accessibilityState={{ selected }}
        aria-selected={selected}
        hitSlop={{ top: 6, bottom: 6 }}
        onPress={onPress}
        style={{
          minHeight: height,
          // Clears the pill's rounded ends (docs/ui-rules.md).
          paddingHorizontal: height / 2,
          justifyContent: 'center',
          alignItems: 'center',
          borderRadius: theme.radiusPill,
          borderWidth: theme.scoringSheet === true ? 1 : 0,
          borderColor: theme.scoringSurface.badges.green.border,
          backgroundColor: selected
            ? theme.scoringMenuActiveBackground
            : theme.scoringSelectorIdle,
          shadowColor: theme.buttonShadowColor,
          shadowOpacity: 1,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
          elevation: 3
        }}
      >
        <Text
          selectable={false}
          numberOfLines={1}
          style={{
            fontFamily: theme.semiBoldTextFont,
            color: selected
              ? theme.scoringMenuActiveText
              : theme.primaryTextColor
          }}
        >
          {lstrings.coach_box_score}
        </Text>
      </Pressable>
    </View>
  )
}

/**
 * The scoring microphone's glyph, round, for a screen whose dictation is not
 * wired to the bar: it shows that the server dictates, and presses nothing.
 */
function RosterMicGlyph({ size }: { size: number }): React.ReactElement {
  return (
    <View
      testID="Roster mic"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1,
        borderColor: CONTROL_COLORS.micOff.border,
        backgroundColor: CONTROL_COLORS.micOff.bottom,
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <ButtonIcon
        name="mic_off"
        size={1.5}
        color={CONTROL_COLORS.micOff.text}
      />
    </View>
  )
}
