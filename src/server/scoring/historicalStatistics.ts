import type { StatisticsStep } from '../../common/gameStatistics'
import { asGumboPlay, type GumboPlay } from '../../common/gumboPlay'
import {
  type ReplayBoxScore,
  replayBoxScore,
  type ReplaySide
} from '../../common/replay/replayBoxScore'
import {
  type ReplayGame,
  replaySourceOf
} from '../../common/replay/replaySource'
import { boardLineOfPlays } from '../../common/scoring/boardLine'
import { currentDocumentOf, documentOf } from '../../common/scoring/document'
import { replayPlays, storedRecordOf } from '../../common/scoring/gumbo'
import { forPlayback } from '../../common/scoring/playbackTimes'
import type { StoredGame } from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { namesIn } from '../../common/scoring/storedNames'
import { inningsPitched } from '../../common/statExtras'
import { pitchersInOrder } from '../stats/boxScoreOrder'
import { expandedGameStatLines } from '../stats/expandedStats'
import { scoringIdsIn } from './projection'

const INCOMPLETE = 'Player statistics are incomplete in the recorded plays.'

/** Count only the supplied prefix, using the same scorer as the game's totals. */
export function importedStatistics(
  game: ReplayGame,
  plays: GumboPlay[],
  template?: ReplayBoxScore
): { box: ReplayBoxScore | null; message: string | null } {
  const names = new Map<number, string>()
  for (const play of plays)
    for (const [id, name] of namesIn(play)) names.set(id, name)
  for (const side of ['away', 'home'] as const)
    for (const row of [
      ...(template?.[side].batting ?? []),
      ...(template?.[side].pitching ?? [])
    ])
      names.set(row.id, row.name)
  const result = expandedGameStatLines(
    plays,
    {
      awayTeamId: game.awayTeamId,
      homeTeamId: game.homeTeamId
    },
    new Set([...scoringIdsIn({ plays, currentPlay: null }), ...names.keys()])
  )
  if (result.kind === 'incomplete') return { box: null, message: INCOMPLETE }
  const line = boardLineOfPlays(plays)
  const moundOrder = pitchersInOrder(plays)
  const side = (which: 'away' | 'home'): ReplaySide => {
    const teamId = which === 'away' ? game.awayTeamId : game.homeTeamId
    const rows = result.lines.filter(row => row.teamId === teamId)
    const existing = template?.[which]
    // First appearance is the recorded order when an import has no lineup log.
    const batting = rows
      .filter(row => row.pa > 0 || row.r > 0)
      .sort(
        (a, b) => (a.extra.firstPa ?? Infinity) - (b.extra.firstPa ?? Infinity)
      )
    const pitching = rows.filter(
      row => row.pitch_bf > 0 || row.pitch_outs > 0 || row.extra.appeared
    )
    // Native slot order includes substitution chains. Keep those intact,
    // then append imported-only people whose slot history was not recorded.
    const batters = [
      ...new Set([
        ...(existing?.batting.map(row => row.id) ?? []),
        ...batting.map(row => row.gumboId)
      ])
    ]
    const pitchers = [
      ...new Set([
        ...moundOrder.filter(id => pitching.some(row => row.gumboId === id)),
        ...pitching.map(row => row.gumboId),
        ...(existing?.pitching.map(row => row.id) ?? [])
      ])
    ]
    return {
      name: which === 'away' ? game.awayTeamName : game.homeTeamName,
      innings: line[which].innings,
      runs: line[which].r,
      hits: line[which].h,
      errors: line[which].e,
      batting: batters.map(id => {
        const row = rows.find(row => row.gumboId === id)
        const old = existing?.batting.find(row => row.id === id)
        return {
          id,
          name: names.get(id) ?? 'Unknown',
          ab: row?.ab ?? 0,
          r: row?.r ?? 0,
          h: row?.h ?? 0,
          rbi: row?.rbi ?? 0,
          bb: row?.bb ?? 0,
          k: row?.k ?? 0,
          sub: old?.sub ?? false,
          current: old?.current ?? false
        }
      }),
      pitching: pitchers.map(id => {
        const row = rows.find(row => row.gumboId === id)
        const old = existing?.pitching.find(row => row.id === id)
        const outs = row?.pitch_outs ?? 0
        return {
          id,
          name: names.get(id) ?? 'Unknown',
          outs,
          ip: inningsPitched(outs),
          h: row?.pitch_h ?? 0,
          r: row?.pitch_r ?? 0,
          er: row?.pitch_er ?? 0,
          bb: row?.pitch_bb ?? 0,
          k: row?.pitch_k ?? 0,
          pc: row === undefined ? (old?.pc ?? null) : row.extra.pitches,
          current: old?.current ?? false
        }
      })
    }
  }
  return {
    box: { away: side('away'), home: side('home'), from: null },
    message: null
  }
}

/** Historical boxes for both imported documents and native scoring actions. */
export function historicalStatistics(
  game: ReplayGame & { startAt?: string | null },
  stored: StoredGame
): { initial: ReplayBoxScore | null; boxes: StatisticsStep[] } {
  const plays = [...stored.plays]
    .filter(
      play => play.about.atBatIndex !== stored.currentPlay?.about.atBatIndex
    )
    .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
  const first = plays.findIndex(play => storedRecordOf(play) !== null)
  const prefix = first < 0 ? plays : plays.slice(0, first)
  const source = replaySourceOf(game, stored)
  const drafts: Array<Omit<StatisticsStep, 'at'> & { at?: number }> = []
  for (let index = 0; index < prefix.length; index++) {
    const play = prefix[index]
    drafts.push({
      at: timeOf(play.about.endTime) ?? timeOf(play.about.startTime),
      position: null,
      ...importedStatistics(game, prefix.slice(0, index + 1))
    })
  }
  let initial: ReplayBoxScore | null = null
  if (source !== null) {
    initial =
      prefix.length === 0
        ? replayBoxScore(source.timeline.start)
        : importedStatistics(game, prefix).box
    const indices = new Map<number, number>()
    replayPlays(
      {
        plays: plays.map(forPlayback),
        currentPlay: forPlayback(stored.currentPlay)
      },
      source.context,
      (state, atBatIndex, time) => {
        const actionIndex = indices.get(atBatIndex) ?? 0
        indices.set(atBatIndex, actionIndex + 1)
        const play =
          plays.find(play => play.about.atBatIndex === atBatIndex) ??
          stored.currentPlay
        let box = replayBoxScore(state)
        let message: string | null = null
        if (prefix.length > 0) {
          const importedIndices = new Set(
            prefix.map(play => play.about.atBatIndex)
          )
          const current = state.liveData.plays.currentPlay
          const native = [
            ...state.liveData.plays.allPlays,
            ...(current === null ? [] : [current])
          ]
            .filter(play => !importedIndices.has(play.about.atBatIndex))
            .map(play => {
              const stamp = { setupBefore: setupOf(state), actions: [] }
              if (play !== current) return documentOf(state, play, stamp)
              const document = currentDocumentOf(state, play, stamp)
              const completed = asGumboPlay({
                ...document,
                result: {
                  ...play.result,
                  eventType:
                    play.result.eventType === ''
                      ? 'game_advisory'
                      : play.result.eventType,
                  awayScore: state.liveData.linescore.teams.away.runs,
                  homeScore: state.liveData.linescore.teams.home.runs
                }
              })
              return completed
            })
          const combined = importedStatistics(game, [...prefix, ...native], box)
          // No partial native-only tables masquerade as complete game statistics.
          if (combined.box === null) {
            drafts.push({
              at:
                timeOf(time) ??
                timeOf(play?.about.endTime) ??
                timeOf(play?.about.startTime),
              position: { atBatIndex, actionIndex },
              ...combined
            })
            return
          }
          box = combined.box
          message = combined.message
        }
        drafts.push({
          at:
            timeOf(time) ??
            timeOf(play?.about.endTime) ??
            timeOf(play?.about.startTime),
          position: { atBatIndex, actionIndex },
          box,
          message
        })
      }
    )
  }
  let previous =
    drafts.find(step => step.at !== undefined)?.at ?? timeOf(game.startAt) ?? 0
  const boxes = drafts.map(step => {
    previous = Math.max(previous, step.at ?? previous)
    return { ...step, at: previous }
  })
  // Imported prehistory is not visible before its first dated play. Replay's
  // native starting position is selected separately by its action cursor.
  return { initial: prefix.length === 0 ? initial : null, boxes }
}

function timeOf(value: unknown): number | undefined {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : undefined
}
