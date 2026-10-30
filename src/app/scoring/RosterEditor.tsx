import React, {
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Platform,
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
import {
  type ExistingRosterPlayer,
  PLAYER_POSITIONS as STORED_POSITIONS
} from '../../common/playerSettings'
import {
  type ChosenRosterCommand,
  ROSTER_TAB,
  type RosterQuestion,
  type RosterTab,
  type StagedRunner
} from '../../common/scoring/rosterCommands'
import { rosterError } from '../../common/scoring/rules'
import {
  reconcileRoster,
  type ScoringRosterEntry
} from '../../common/scoring/startingSetup'
import { setupOf } from '../../common/scoring/state'
import type { Unrostered } from '../../common/unroster'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { lstrings, plural, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { withRosterDetails } from './currentSetup'
import { DefensiveField } from './DefensiveField'
import { EditRosterList } from './EditRosterList'
import { ExistingPlayerSheet } from './ExistingPlayerSheet'
import { GameRosterHeader } from './GameRosterHeader'
import type { LineupQrResult } from './lineupQrImport'
import { LineupShareSheet } from './LineupShareSheet'
import { addPlaceholderPlayers } from './placeholderPlayers'
import { PlaceholderPlayersSheet } from './PlaceholderPlayersSheet'
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
import { rosterDirty, rosterSavable } from './rosterDirty'
import { RosterDrag, RosterDragGroup, RosterScrollArea } from './RosterDrag'
import { RosterConflictBanner } from './rosterLive'
import { byJersey } from './rosterOrder'
import { RosterRemoveButton } from './RosterRemoveButton'
import { RosterSelector } from './RosterSelector'
import { CONTROL_COLORS } from './scoringControlStyle'
import { copyState } from './scoringMachine'
import { ScoringPlayerCard, scoringPlayerCardStyle } from './ScoringPlayerCard'
import { editRosterRows, lineupQrOffer } from './scoringRosterEdit'
import { baseIds, battingSide } from './scoringSelectors'
import { ScoringError, ScoringSheetHeight } from './ScoringSheet'
import type {
  Position,
  ScoringSessionState,
  ScoringState,
  Side
} from './scoringTypes'

/** The roster screen's tabs: a coach's begins with the game's box score. */
export type RosterMode = 'boxScore' | RosterTab
/**
 * Who the roster screen is for. A scorekeeper edits either team's roster for
 * the scoring screen, and leaves by Save or Cancel; a coach edits his own
 * team's, saves without leaving, and leaves by the screen's back chevron.
 */
export type RosterAudience = 'scorekeeper' | 'coach'
/** Each tab's label, which is also its accessible name. */
export const ROSTER_MODE_LABELS: Record<RosterMode, string> = {
  boxScore: 'Box',
  editRoster: lstrings.scoring_roster_tab,
  lineup: 'Lineup',
  defense: 'Defense'
}
/** The tabs the mode slider offers, in order. */
export const rosterModes = (audience: RosterAudience): RosterMode[] =>
  audience === 'coach'
    ? ['boxScore', 'editRoster', 'lineup', 'defense']
    : ['editRoster', 'lineup', 'defense']
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
/**
 * A roster, lineup or defence card's name, on one line. A phone scales text
 * by the reader's text size (the iPhone 13 Pro on the bench reads 12% larger
 * than the web), which wrapped "1. #27 Trey H" after "Trey" in a column
 * 159 points wide; the phone shrinks the line to fit instead, down to three
 * quarters. The web keeps its wrap, as a browser cannot shrink to fit.
 */
export const rosterNameProps = (
  os: string
): {
  numberOfLines?: number
  adjustsFontSizeToFit?: boolean
  minimumFontScale?: number
} =>
  os === 'web'
    ? {}
    : { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.75 }
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
  /** Add to Roster for an existing player, on a team the caller manages. */
  onAddExistingRosterPlayer?: (
    teamId: string,
    body: ExistingRosterPlayer
  ) => Promise<ExistingPlayerAnswer>
  /** Add as Pool Player: this game only, on this side. */
  onAddExistingGuest?: (
    side: Side,
    body: ExistingRosterPlayer
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
  // The roster first: who is on the team and how to add somebody, then the
  // lineup. A draft reopened on another tab keeps it.
  const [mode, setMode] = useState<RosterMode>(
    initialDraft != null && modes.includes(initialDraft.mode)
      ? initialDraft.mode
      : 'editRoster'
  )
  const boxScore = mode === 'boxScore'
  const [scrollOffsets, setScrollOffsets] = useState(
    initialDraft?.scrollOffsets ?? {}
  )
  const defense = mode === 'defense'
  const dense = availableHeight > 0 && availableHeight < (defense ? 440 : 330)
  const narrowDefense = dense && defense && width < 600
  const inlineValidation = dense && defense && !narrowDefense
  const [areaHeight, setAreaHeight] = useState(0)
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
  const [editingLocal, setEditingLocal] = useState<number>()
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
  const [rosterBusy, setRosterBusy] = useState(false)
  const [savingRoster, setSavingRoster] = useState(false)
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
      next.liveData.boxscore.teams[of].players
        .map(id => next.gameData.players[id])
        .filter(player => player.local === local)
        .map(player => ({
          gumboId: player.id,
          shortName: player.fullName,
          jersey: player.jersey,
          positions: player.positions,
          bats: player.bats,
          throws: player.throws,
          isPlayer: true,
          role: 'player',
          section: 'player',
          staffRoles: [],
          inheritedFrom: null
        }))
    const roster = (of: Side): readonly ScoringRosterEntry[] =>
      rosters?.[next.gameData.teams[of].id] ?? entries(of, false)
    const setup = reconcileRoster(
      setupOf(next),
      next.gameData.teams,
      { away: roster('away'), home: roster('home') },
      { away: entries('away', true), home: entries('home', true) },
      lists
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
    if (onRosteredChange == null || rosterBusy || savingRoster) return
    setRosterBusy(true)
    setRosterProblem(undefined)
    try {
      const lists = await onRosteredChange(side, userId, rostered)
      setExclusions(lists)
      setDraft(previous => applyAvailability(previous, lists))
      setBase(previous => applyAvailability(previous, lists))
      if (!rostered) {
        const gumboId = rosters?.[draft.gameData.teams[side].id]?.find(
          row => row.userId === userId
        )?.gumboId
        setNextBatter(previous => (previous === gumboId ? undefined : previous))
        setRunners(previous =>
          previous.filter(runner => runner.player !== gumboId)
        )
      }
    } catch (error) {
      setRosterProblem(
        error instanceof Error
          ? error.message
          : 'Could not change game availability'
      )
    } finally {
      setRosterBusy(false)
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
      const player: PlayerDraft = {
        firstName: candidate.shortParts.first,
        lastName: candidate.shortParts.last,
        jersey: choice.jersey,
        bats: candidate.bats ?? 'right',
        throws: candidate.throws,
        positions: choice.positions
      }
      const teamId = draft.gameData.teams[side].id
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
          answer.noticeId == null
            ? `${candidate.shortName} was added.`
            : `${candidate.shortName} was added. Their guardians were notified.`
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
  const names = useMemo(
    () =>
      rosters == null
        ? draft.gameData.players
        : withRosterDetails(draft, rosters).gameData.players,
    [draft, rosters]
  )
  const display = (id: number): string =>
    `${names[id].jersey === '' ? '' : `#${names[id].jersey} `}${names[id].fullName}`
  const assigned = defense ? Object.values(team.defense) : team.battingOrder
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
  const validation = rosterError(state.session, setupOf(draft), nextBatter)
  const dirty = rosterDirty(base, draft, runners, nextBatter)
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  const sizes = rosterFooterSizes(dense, defense)
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
  const nameProps = rosterNameProps(Platform.OS)
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
  const rosterRows = editRosterRows(teamRoster, draft, side)
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
  return (
    <View
      pointerEvents={spoken.busy ? 'none' : 'auto'}
      style={{
        flex: 1,
        minHeight: 0,
        gap: dense && defense ? 2 : dense ? 4 : 8
      }}
    >
      {conflict && dirty && <RosterConflictBanner />}
      {shown?.chat}
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
            <RosterSelector
              fitContent={!narrowDefense}
              compact={narrowDefense}
              labels={modes.map(each => ROSTER_MODE_LABELS[each])}
              value={Math.max(0, modes.indexOf(mode))}
              onChange={index => {
                setMode(modes[index])
              }}
            />
          </View>
        </View>
        {mode === 'editRoster' ? (
          <GameRosterHeader information={coach} />
        ) : (
          !boxScore && (
            <Text numberOfLines={defense ? 1 : undefined} style={text}>
              {defense
                ? 'Drag player into position. On touch, hold briefly first.'
                : 'Tap to add to lineup. Hold briefly, then drag to reorder.'}
            </Text>
          )
        )}
        {state.phase === 'awaitingBatter' && !boxScore && (
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
          rosterBusy={rosterBusy || savingRoster}
          onRosteredChange={
            coach && onRosteredChange != null
              ? (userId, rostered) => {
                  toggleRostered(userId, rostered).catch(() => undefined)
                }
              : undefined
          }
          onRetry={onRetryRoster}
          adding={
            state.readOnly === true ||
            rosterLoading === true ||
            rosterBusy ||
            savingRoster
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
                  setEditingLocal(id)
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
                display={display}
                onPlace={(player, position) => {
                  if (
                    !team.players.includes(player) ||
                    assigned.includes(player)
                  )
                    return
                  edit(next => {
                    next.liveData.boxscore.teams[side].defense[position] =
                      player
                  })
                }}
                onClear={(position: Position) => {
                  edit(next => {
                    next.liveData.boxscore.teams[side].defense[position] = null
                  })
                }}
              />
            )}
            <View
              style={{
                flex: 1,
                minHeight: rosterMinimum,
                gap: 6
              }}
            >
              {!dense && (
                <Text style={{ ...text, fontWeight: '700' }}>Roster</Text>
              )}
              <RosterScrollArea name="Roster players">
                <RosterDrag
                  targetId="roster"
                  onDropPlayer={defense ? undefined : remove}
                >
                  <View
                    testID={defense ? 'Defense roster grid' : undefined}
                    style={
                      defense
                        ? { flexDirection: 'row', flexWrap: 'wrap', gap: 16 }
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
                            immediateMouseDrag={defense}
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
                              <Text
                                selectable={false}
                                {...nameProps}
                                style={{ ...text, flex: 1 }}
                              >
                                {display(id)}
                              </Text>
                            </View>
                          </RosterDrag>
                        )
                        return defense ? (
                          <View key={id} style={{ width: '47%' }}>
                            {card}
                          </View>
                        ) : (
                          card
                        )
                      })}
                  </View>
                  {!defense && (
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
                {!dense && (
                  <Text style={{ ...text, fontWeight: '700' }}>Lineup</Text>
                )}
                <RosterScrollArea name="Batting lineup">
                  <>
                    {team.battingOrder.map((id, index) => (
                      <RosterDrag
                        key={id}
                        playerId={id}
                        label={`Reorder ${names[id].fullName}`}
                        targetId={`lineup-${index}`}
                        insertion="row"
                        onDropPlayer={(player, edge) => {
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
                          <Text
                            selectable={false}
                            accessibilityLabel={`Drag ${names[id].fullName}`}
                            style={{ ...text, fontSize: 24 }}
                          >
                            ≡
                          </Text>
                          <Text
                            selectable={false}
                            {...nameProps}
                            style={{ ...text, flex: 1 }}
                          >
                            {index + 1}. {display(id)}
                          </Text>
                          <RosterRemoveButton
                            label={`Remove ${names[id].fullName}`}
                            onPress={() => {
                              remove(id)
                            }}
                          />
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
                            body
                          ),
                        false
                      )
                    }
                  : {}),
                onAddAsPool: joinExisting(
                  chosen,
                  async body => await onAddExistingGuest(side, body),
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
          key={`edit:${side}:${editingLocal}`}
          initialDraft={draftOfLocalPlayer(
            draft.gameData.players[editingLocal]
          )}
          onClose={() => {
            setEditingLocal(undefined)
          }}
          onAdd={player => {
            edit(next => {
              editLocalPlayerDraft(next, side, editingLocal, player)
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
      <View testID="Roster footer" style={{ gap: dense && defense ? 2 : 6 }}>
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
        <View
          testID="Roster footer bar"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
        >
          {/* Adding a player is a row at the end of the Roster tab; this
              half keeps the microphone where it was. */}
          <View style={{ flex: 1 }} />
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
          <View style={{ flex: 1 }}>
            <Button
              color={theme.scoringMenuActiveBackground}
              textColor={theme.scoringMenuActiveText}
              compact
              style={dense && defense ? { minHeight: sizes.save } : undefined}
              accessibilityLabel="Save Rosters"
              label="Save Rosters"
              disabled={
                rosterBusy ||
                savingRoster ||
                spoken.busy ||
                !rosterSavable(dirty, unaccepted, validation)
              }
              onPress={() => {
                const saving = onSave(
                  draft,
                  nextBatter,
                  runners.length === 0 ? undefined : runners,
                  openedOver
                )
                if (saving instanceof Promise) {
                  setSavingRoster(true)
                  saving.then(
                    () => {
                      setSavingRoster(false)
                      spoken.clear()
                    },
                    (error: unknown) => {
                      setSavingRoster(false)
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
        <View
          style={{
            flexDirection: inlineValidation ? 'row' : 'column',
            alignItems: inlineValidation ? 'center' : undefined
          }}
        >
          {inlineValidation && (
            <View style={{ flex: 1, minWidth: 0 }}>
              {validation != null && (
                <Text
                  accessibilityRole="alert"
                  numberOfLines={1}
                  style={{ color: theme.dangerColor, fontSize: 11 }}
                >
                  {validation}
                </Text>
              )}
            </View>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
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
            style={{
              minHeight: dense ? (defense ? 28 : 36) : 44,
              minWidth: inlineValidation ? 80 : undefined,
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Text
              style={{
                ...text,
                color: theme.dangerColor,
                fontFamily: theme.semiBoldTextFont
              }}
            >
              Cancel
            </Text>
          </Pressable>
          {inlineValidation && <View style={{ flex: 1 }} />}
        </View>
      </View>
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
      <Icon name="mic_off" size={1.5} color={CONTROL_COLORS.micOff.text} />
    </View>
  )
}
