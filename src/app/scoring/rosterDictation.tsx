import React, { type ReactNode, useEffect, useRef, useState } from 'react'

import type { DictationModel, Health } from '../../common/api'
import { promptContext, type ScoringAction } from '../../common/scoring/actions'
import {
  applyRosterCommands,
  type ChosenRosterCommand,
  explicitPlaceholders,
  resolveRosterCommands,
  rosterPrompt,
  type RosterQuestion,
  rosterSituation,
  type StagedRoster,
  type StagedRunner
} from '../../common/scoring/rosterCommands'
import type { GameState } from '../../common/scoring/state'
import { lstrings, sprintf } from '../locales/strings'
import {
  createDictatedPlayers,
  type CreateRosterPlayer
} from './createDictatedPlayers'
import { AskCard, useDictationControls } from './DictationButton'
import { upcoming } from './dictationHook'
import type { DictationSocket, OpenMicrophone } from './dictationTypes'
import { type ChatTurn, RosterChat } from './RosterChat'
import type { Side } from './scoringTypes'

/** What the roster screen needs to dictate: the server, and the scorer's choices. */
export interface RosterDictationOptions {
  /** Whether this server takes dictation. The microphone shows only when it does. */
  health: () => Promise<Health>
  url: string
  gameId: string
  /** The game's actions so far, which retarget the recogniser as they change. */
  log: readonly ScoringAction[]
  model?: DictationModel
  token?: string
  /** On from the start, as the scoring screen's was when the sheet opened. */
  startEnabled?: boolean
  tapMs?: number
  tailMs?: number
  openSocket?: (url: string) => DictationSocket
  openMicrophone?: OpenMicrophone
}

/**
 * What the model is told with each sentence on the roster screen: the game
 * line once the game has begun — the inning, the side at bat, the batter due
 * and the runners — and the rosters of the draft, both sides for a
 * scorekeeper and his own for a coach.
 */
export function rosterDictationContext(
  game: GameState,
  draft: GameState,
  sides: readonly Side[]
): string {
  const line = rosterSituation(game).live
    ? promptContext(upcoming(game).state)
    : 'The game has not begun.'
  return `${line}\nROSTERS\n${rosterPrompt(draft, sides)}`
}

/**
 * The microphone of a screen handed to a sheet that has its own: while
 * `open`, the screen's dictation is suspended (switched off); the sheet's
 * starts on if the screen's was on as the sheet opened, which this returns;
 * and when the sheet closes, however it closes, the screen's is switched
 * back on, so the scorer need not tap it again.
 */
export function useDictationHandover(
  open: boolean,
  controls: { enabled: boolean; setEnabled: (on: boolean) => void }
): boolean {
  const handed = useRef(false)
  const wasOpen = useRef(false)
  // Read as the sheet opens, before the suspension switches it off.
  if (open && !wasOpen.current) handed.current = controls.enabled
  const { setEnabled } = controls
  useEffect(() => {
    wasOpen.current = open
    if (open || !handed.current) return
    handed.current = false
    setEnabled(true)
  }, [open, setEnabled])
  return handed.current
}

const NO_DICTATION = async (): Promise<Health> => ({
  status: 'ok',
  version: '',
  database: 'ok',
  migrations: 0,
  dictation: false,
  dictationModels: []
})

/**
 * Dictation on the roster screen: the round microphone for the bottom bar
 * and the chat for the top. A sentence's players are found on the draft
 * (`resolveRosterCommands`), and when one said fits two or more, the chat
 * asks which; then its commands are staged on the draft in one go, through
 * `onStage`, or refused with nothing staged. A sentence that is a play is
 * refused, as plays are scored on the scoring screen. Without `options`
 * there is neither.
 */
export function useRosterDictation({
  options,
  game,
  draft,
  fixedSide,
  runners,
  nextBatter,
  size,
  chat,
  question: asked,
  pending,
  onCreatePlayer,
  onStage
}: {
  options?: RosterDictationOptions
  /** The game as saved, for its situation: begun, the side at bat, the runners. */
  game: GameState
  draft: GameState
  /** A coach's side, the only one he may change. */
  fixedSide?: Side
  runners: readonly StagedRunner[]
  nextBatter?: number
  size: number
  /** The turns the chat opens with: a substitution said on the scoring screen. */
  chat?: readonly ChatTurn[]
  /** What the chat opens asking, about the last of those turns. */
  question?: RosterQuestion
  pending?: readonly ChosenRosterCommand[]
  onCreatePlayer?: CreateRosterPlayer
  onStage: (staged: StagedRoster) => void
}): {
  control: ReactNode
  chat: ReactNode
  /** Closes the chat: the draft it talked about is saved. */
  clear: () => void
  /** Adds a line of its own to an open chat, such as the changes being discarded. */
  note: (text: string) => void
  /** Shows a refusal in the chat, opening one when the scorer had not dictated. */
  problem: (text: string) => void
  busy: boolean
} {
  const [busy, setBusy] = useState(false)
  const pendingWrite = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [turns, setTurns] = useState<ChatTurn[]>(() => [...(chat ?? [])])
  const next = useRef(chat?.length ?? 0)
  // An answer to the question it opens with goes under the turn it is about.
  const current = useRef<number | null>(
    asked == null ? null : (chat?.at(-1)?.key ?? null)
  )
  const addLines = (lines: ChatTurn['lines']): void => {
    const key = current.current
    setTurns(list =>
      key != null && list.some(turn => turn.key === key)
        ? list.map(turn =>
            turn.key === key
              ? { ...turn, lines: [...turn.lines, ...lines] }
              : turn
          )
        : [...list, { key: next.current++, lines }]
    )
  }
  // Which player the scorer meant, when one said fits two or more.
  const [question, setQuestion] = useState<RosterQuestion | undefined>(asked)
  const stage = async (said: readonly ChosenRosterCommand[]): Promise<void> => {
    if (pendingWrite.current) return
    const situation = { ...rosterSituation(game), runners, nextBatter }
    const found = resolveRosterCommands(draft, said, {
      ...situation,
      fixedSide
    })
    if ('question' in found) {
      setQuestion(found.question)
      return
    }
    if ('problem' in found) {
      addLines([{ kind: 'problem', text: found.problem }])
      return
    }
    // A coach's players are his own side's, but a pinch hitter or runner
    // comes in for the side at bat, which may be the other team.
    if (
      fixedSide != null &&
      found.commands.some(
        command =>
          ('side' in command ? command.side : situation.battingSide) !==
          fixedSide
      )
    ) {
      addLines([
        {
          kind: 'problem',
          text: sprintf(
            lstrings.dictation_roster_other_team,
            draft.gameData.teams[fixedSide].name
          )
        }
      ])
      return
    }
    if (
      !found.commands.some(
        command => command.type === 'addPlayer' && command.placeholder !== true
      )
    ) {
      const staged = applyRosterCommands(draft, found.commands, situation)
      if ('problem' in staged)
        addLines([{ kind: 'problem', text: staged.problem }])
      else {
        onStage(staged)
        addLines(staged.lines.map(text => ({ kind: 'done' as const, text })))
      }
      return
    }
    pendingWrite.current = true
    setBusy(true)
    try {
      const staged = await createDictatedPlayers(
        draft,
        found.commands,
        situation,
        onCreatePlayer,
        () => mounted.current
      )
      if (!mounted.current) return
      if ('problem' in staged)
        addLines([{ kind: 'problem', text: staged.problem }])
      else {
        onStage(staged)
        addLines(staged.lines.map(text => ({ kind: 'done' as const, text })))
      }
    } catch (error: unknown) {
      if (mounted.current)
        addLines([
          {
            kind: 'problem',
            text:
              error instanceof Error
                ? error.message
                : 'Unable to create the player. Please try again.'
          }
        ])
    } finally {
      pendingWrite.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const started = useRef(false)
  const stagePending = useRef(stage)
  stagePending.current = stage
  useEffect(() => {
    if (started.current || pending == null) return
    started.current = true
    stagePending.current(pending).catch(() => undefined)
  }, [pending])
  const sides: Side[] = fixedSide == null ? ['away', 'home'] : [fixedSide]
  const controls = useDictationControls({
    shape: 'round',
    size,
    startEnabled: options?.startEnabled,
    suspended: options == null,
    health: options?.health ?? NO_DICTATION,
    url: options?.url ?? '',
    gameId: options?.gameId ?? '',
    token: options?.token,
    model: options?.model,
    tapMs: options?.tapMs,
    tailMs: options?.tailMs,
    openSocket: options?.openSocket,
    openMicrophone: options?.openMicrophone,
    scope: 'roster',
    target:
      fixedSide == null
        ? { gameId: options?.gameId ?? '' }
        : { gameId: options?.gameId ?? '', side: fixedSide },
    contextOf: () => rosterDictationContext(game, draft, sides),
    session: draft,
    log: options?.log ?? [],
    onActions: (transcript, actions, roster) => {
      const key = current.current
      setTurns(list =>
        list.map(turn =>
          turn.key === key ? { ...turn, said: transcript } : turn
        )
      )
      if (actions.length > 0)
        addLines([{ kind: 'problem', text: lstrings.dictation_roster_play }])
      else
        stage(explicitPlaceholders(roster, transcript)).catch(() => undefined)
    }
  })
  const { dictation } = controls
  // A hold begins a turn, and drops a question left unanswered; what is
  // heard fills in its words.
  useEffect(() => {
    if (!dictation.holding) return
    setQuestion(undefined)
    const key = next.current++
    current.current = key
    setTurns(list => [
      ...list,
      { key, said: lstrings.dictation_ellipsis, lines: [] }
    ])
  }, [dictation.holding])
  useEffect(() => {
    const key = current.current
    const text = dictation.text
    if (key == null || text == null || text === '') return
    setTurns(list =>
      list.map(turn => (turn.key === key ? { ...turn, said: text } : turn))
    )
  }, [dictation.text])
  useEffect(() => {
    if (dictation.message != null)
      addLines([{ kind: 'problem', text: dictation.message }])
  }, [dictation.message])
  const { ask } = dictation
  return {
    busy,
    control: controls.control,
    chat: (
      <RosterChat
        turns={turns}
        ask={
          ask != null ? (
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
          ) : question != null ? (
            <AskCard
              question={question.question}
              options={question.options.map(option => option.label)}
              onChoose={index => {
                setQuestion(undefined)
                stage(question.options[index].commands).catch(() => undefined)
              }}
              onDismiss={() => {
                setQuestion(undefined)
              }}
            />
          ) : undefined
        }
      />
    ),
    clear: () => {
      current.current = null
      setTurns([])
    },
    note: text => {
      current.current = null
      const key = next.current++
      setTurns(list =>
        list.length === 0
          ? list
          : [...list, { key, lines: [{ kind: 'done', text }] }]
      )
    },
    problem: text => {
      current.current = null
      const key = next.current++
      setTurns(list => [...list, { key, lines: [{ kind: 'problem', text }] }])
    }
  }
}
