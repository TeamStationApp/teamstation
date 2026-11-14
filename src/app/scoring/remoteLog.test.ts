import { expect } from 'chai'
import { describe, it } from 'mocha'

import { chainOf, fnvMix } from '../../common/scoring/actionChain'
import type { ScoringAction } from '../../common/scoring/actions'
import type { RemovalRecord } from '../../common/scoring/authorship'
import { type AcceptedPicture, applyAction } from '../../common/scoring/session'
import { type GameState, setupOf } from '../../common/scoring/state'
import { scoringSession } from '../../test/scoringSession'
import { lstrings, sprintf } from '../locales/strings'
import { actionWords } from './actionWords'
import { gameFixture } from './isUnscoredGame.test'
import { describeLogSpans } from './playDescription'
import {
  dismissRemoteLog,
  nextRemoteLog,
  readableFor,
  REMOTE_LOG_LINES,
  type RemoteLogRow,
  type RemoteLogState,
  startRemoteLog
} from './remoteLog'

const VIEWER = 'viewer'
const ball: ScoringAction = { type: 'pitch', call: 'B' }
const called: ScoringAction = { type: 'pitch', call: 'C' }
const swinging: ScoringAction = { type: 'pitch', call: 'S' }
const foul: ScoringAction = { type: 'pitch', call: 'F' }
const contact: ScoringAction = { type: 'ballInPlay', contact: 'swing' }
const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const endHalf: ScoringAction = { type: 'gameFlow', kind: 'endHalf' }

type Step = [ScoringAction, string | null]

/** A confirmed history, as a session's `accepted` would hold it. */
class History {
  readonly opening: GameState = scoringSession(gameFixture)
  actions: ScoringAction[] = []
  authors: Array<string | null> = []
  removals: RemovalRecord[] = []
  state: GameState = this.opening
  private removed = 0

  /** True when the action applies; nothing changes when it does not. */
  tryAdd(action: ScoringAction, author: string | null): boolean {
    const applied = applyAction(this.state, action)
    if (applied.problems.length > 0) return false
    this.state = applied.state
    this.actions = [...this.actions, action]
    this.authors = [...this.authors, author]
    return true
  }

  add(...steps: Step[]): this {
    for (const [action, author] of steps)
      if (!this.tryAdd(action, author))
        throw new Error(`${JSON.stringify(action)} does not apply`)
    return this
  }

  /** The last `count` actions, removed by `by`. */
  undo(count: number, by: string): this {
    const removed = this.actions.slice(this.actions.length - count)
    this.removals = [
      ...this.removals,
      {
        id: `removal-${++this.removed}`,
        sequence: this.removed,
        userId: by,
        atBatIndex: 0,
        actions: removed
      }
    ]
    return this.replace(
      this.actions.slice(0, -count),
      this.authors.slice(0, -count)
    )
  }

  replace(actions: ScoringAction[], authors: Array<string | null>): this {
    this.actions = actions
    this.authors = authors
    this.state = actions.reduce(
      (game, action) => applyAction(game, action).state,
      this.opening
    )
    return this
  }

  picture(): AcceptedPicture {
    return {
      opening: this.opening,
      actions: [...this.actions],
      authors: [...this.authors],
      state: this.state,
      removals: [...this.removals],
      names: { ann: 'Ann A.', bob: 'Bob B.', [VIEWER]: 'Me' }
    }
  }
}

/** Strikeouts by `author`, with the flow the game needs, for `atBats`. */
function strikeouts(history: History, atBats: number, author: string): void {
  let done = 0
  while (done < atBats) {
    const index = history.state.liveData.plays.currentPlay?.about.atBatIndex
    if (!history.tryAdd(called, author)) {
      if (!history.tryAdd(close, author) && !history.tryAdd(endHalf, author))
        throw new Error('stuck')
      continue
    }
    if (history.state.liveData.plays.currentPlay?.about.atBatIndex !== index)
      done++
  }
}

const rows = (state: RemoteLogState): Array<[string, string[]]> =>
  state.rows.map(row => [row.name, row.lines])

describe('remote log', () => {
  it('groups one remote scorer’s at-bat into a named row with the pitches first', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, 'ann'], [called, 'ann'])
    nextRemoteLog(log, history.picture())
    expect(rows(log)).deep.equals([['Ann A.', ['Ball, called strike']]])
    history.add(
      [contact, 'ann'],
      [{ type: 'result', eventType: 'single' }, 'ann']
    )
    nextRemoteLog(log, history.picture())
    expect(log.rows).lengthOf(1)
    expect(log.rows[0].lines[0]).equals('Ball, called strike')
    expect(log.rows[0].lines.at(-1)).contains('single').and.not.contains('ball')
  })
  it('gives each scorer of one at-bat a row of their own actions', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, 'ann'], [ball, 'ann'], [called, 'bob'], [ball, 'ann'])
    nextRemoteLog(log, history.picture())
    expect(rows(log)).deep.equals([
      ['Ann A.', ['Ball, ball']],
      ['Bob B.', ['Called strike']],
      ['Ann A.', ['Ball']]
    ])
  })
  it('never shows the viewer’s own or unattributed spans', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, VIEWER], [ball, null])
    const { changed } = nextRemoteLog(log, history.picture())
    expect(changed).equals(false)
    expect(log.rows).deep.equals([])
  })
  it('re-credits a span when one reload undoes an author’s pitch and another re-enters it', () => {
    const history = new History().add([ball, 'ann'])
    const log = startRemoteLog(new History().picture(), VIEWER)
    nextRemoteLog(log, history.picture())
    expect(log.rows[0].userId).equals('ann')
    history.replace([ball], ['bob'])
    nextRemoteLog(log, history.picture())
    expect(log.rows.map(row => row.userId)).deep.equals(['bob'])
  })
  it('credits only the remote strikeout after the viewer’s offline at-bats are flushed', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    // Two at-bats the viewer completed offline arrive in the same read as
    // the other scorer's strikeout of the third batter.
    strikeouts(history, 2, VIEWER)
    history.add([called, 'ann'], [called, 'ann'], [swinging, 'ann'])
    nextRemoteLog(log, history.picture())
    // The viewer's last pitch opened the third at-bat; ann's pitches end it
    // and open the fourth. Every row is ann's, none the viewer's.
    expect(log.rows.map(row => row.userId)).deep.equals(['ann', 'ann'])
    expect(log.rows[0].lines).deep.equals([
      'Called strike, called strike',
      'Player 3 strikes out looking'
    ])
    expect(log.rows[1].lines).deep.equals(['Swinging strike'])
  })
  it('names every remote play acknowledged with the viewer’s pending lineup edit', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    const triple = { type: 'result', eventType: 'triple' } as const
    history.add(
      [
        { type: 'lineup', kind: 'roster', setup: setupOf(history.state) },
        VIEWER
      ],
      [called, 'ann'],
      [contact, 'ann'],
      [triple, 'ann']
    )
    nextRemoteLog(log, history.picture())
    expect(log.rows.map(row => row.userId)).deep.equals(['ann'])
    expect(log.rows[0].lines.join(' ')).contains('triple')
  })
  it('shows a remote removal in client words, but not the viewer’s or one present at mount', () => {
    const history = new History().add([ball, 'ann'], [called, 'ann'])
    history.undo(1, 'bob')
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([foul, 'ann'])
    history.undo(1, VIEWER)
    history.add([swinging, 'ann'])
    history.undo(1, 'bob')
    nextRemoteLog(log, history.picture())
    expect(rows(log)).deep.equals([
      ['Bob B.', [sprintf(lstrings.remote_log_undo, 'Swinging strike')]]
    ])
  })
  it('drops every row when a reset clears the history and its removals', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, 'ann'], [ball, 'ann'])
    history.undo(1, 'ann')
    nextRemoteLog(log, history.picture())
    expect(log.rows.map(row => row.id)).deep.equals([
      'seg:0:0',
      'undo:removal-1'
    ])
    // A side swap resets the game: no actions, no removals.
    expect(nextRemoteLog(log, new History().picture()).changed).equals(true)
    expect(log.rows).deep.equals([])
  })
  it('keeps an Undo row whose removal the record cap drops', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, 'ann'])
    history.undo(1, 'ann')
    nextRemoteLog(log, history.picture())
    history.add([called, 'bob'])
    history.undo(1, 'bob')
    // The oldest record ages out of the capped list.
    history.removals = history.removals.slice(1)
    nextRemoteLog(log, history.picture())
    expect(rows(log)).deep.equals([
      ['Ann A.', [sprintf(lstrings.remote_log_undo, 'Ball')]],
      ['Bob B.', [sprintf(lstrings.remote_log_undo, 'Called strike')]]
    ])
  })
  it('shows a removal below the mount point and the span re-entered after it', () => {
    const history = new History().add([ball, 'ann'], [called, 'ann'])
    const log = startRemoteLog(history.picture(), VIEWER)
    history.undo(1, 'ann')
    nextRemoteLog(log, history.picture())
    history.add([called, 'ann'])
    nextRemoteLog(log, history.picture())
    expect(rows(log)).deep.equals([
      ['Ann A.', [sprintf(lstrings.remote_log_undo, 'Called strike')]],
      // A span is shown whole once any of it is new.
      ['Ann A.', ['Ball, called strike']]
    ])
  })
  it('recomputes only the corrected at-bat of a long game', function () {
    this.timeout(60_000)
    const history = new History()
    strikeouts(history, 100, 'ann')
    const log = startRemoteLog(history.picture(), VIEWER)
    // The second pitch of the sixth batter becomes a swinging strike.
    const target = history.actions.findIndex(
      (action, index) =>
        index > 20 && action === called && history.actions[index + 1] === called
    )
    const corrected = [...history.actions]
    corrected[target] = swinging
    const authors = [...history.authors]
    authors[target] = 'bob'
    history.replace(corrected, authors)
    nextRemoteLog(log, history.picture())
    const atBats = new Set(log.rows.map(row => row.id.split(':')[1]))
    expect(atBats.size).equals(1)
    expect(log.rows.some(row => row.userId === 'bob')).equals(true)
  })
  it('keeps only rows it shows, and nothing for a row trimmed away', function () {
    this.timeout(60_000)
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    for (let i = 0; i < 80; i++) {
      history.add([foul, i % 2 === 0 ? 'ann' : 'bob'])
      nextRemoteLog(log, history.picture())
    }
    const lines = log.rows.reduce((sum, row) => sum + row.lines.length, 0)
    expect(lines).equals(REMOTE_LOG_LINES)
    expect([...log.basis.keys()].sort()).deep.equals(
      log.rows.map(row => row.id).sort()
    )
    // An at-bat that no longer exists leaves no seen count or key list.
    const shortened = new History()
    const reset = startRemoteLog(history.picture(), VIEWER)
    nextRemoteLog(reset, shortened.picture())
    expect(reset.seen.size).equals(0)
    expect(reset.keys.size).equals(0)
  })
  for (const [label, corrupt] of [
    ['a forced hash collision', (state: RemoteLogState) => state],
    [
      'a corrupted basis hash',
      (state: RemoteLogState) => {
        for (const basis of state.basis.values()) basis.hash = 'tampered'
        return state
      }
    ],
    [
      'a basis past the log',
      (state: RemoteLogState) => {
        for (const basis of state.basis.values()) basis.length = 10_000
        return state
      }
    ]
  ] as const)
    it(`rebuilds from the accepted history after ${label}`, () => {
      const history = new History()
      const mix = label === 'a forced hash collision' ? () => 'same' : fnvMix
      const log = startRemoteLog(history.picture(), VIEWER, { mix })
      const fresh = startRemoteLog(history.picture(), VIEWER)
      for (const step of [
        [ball, 'ann'],
        [called, 'bob'],
        [ball, 'ann']
      ] as Step[]) {
        history.add(step)
        corrupt(log)
        nextRemoteLog(log, history.picture(), { mix })
        nextRemoteLog(fresh, history.picture())
        expect(log.rows).deep.equals(fresh.rows)
      }
      history.undo(1, 'bob')
      corrupt(log)
      nextRemoteLog(log, history.picture(), { mix })
      nextRemoteLog(fresh, history.picture())
      expect(log.rows).deep.equals(fresh.rows)
    })
  it('falls back to action words, still credited, when the formatter fails', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, 'ann'], [called, 'ann'])
    const failing: typeof describeLogSpans = (...args) =>
      describeLogSpans(...args).map(span => ({ ...span, text: undefined }))
    nextRemoteLog(log, history.picture(), { describe: failing })
    expect(rows(log)).deep.equals([['Ann A.', ['Ball, called strike']]])
  })
  it('mixes once for an appended action and not at all for an unchanged reload', function () {
    this.timeout(60_000)
    const history = new History()
    strikeouts(history, 100, 'ann')
    let mixes = 0
    const mix = (previous: string, key: string): string => {
      mixes++
      return fnvMix(previous, key)
    }
    const log = startRemoteLog(history.picture(), VIEWER, { mix })
    history.add([ball, 'bob'])
    mixes = 0
    nextRemoteLog(log, history.picture(), { mix })
    expect(mixes).equals(1)
    mixes = 0
    nextRemoteLog(log, history.picture(), { mix })
    expect(mixes).equals(0)
  })
  it('words every action type and game flow kind from the locale', () => {
    const words = [
      actionWords(ball),
      actionWords(called),
      actionWords(swinging),
      actionWords(foul),
      actionWords({ type: 'pitch', call: 'T' }),
      actionWords({ type: 'pitch', call: 'L' }),
      actionWords({ type: 'lineup', kind: 'roster' }),
      actionWords(contact),
      actionWords({
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'line_drive',
        direction: 'left'
      }),
      actionWords({
        type: 'result',
        eventType: 'field_out',
        outBy: 'catch'
      }),
      actionWords({
        type: 'runnerMovement',
        runner: 1,
        to: '2B',
        reason: 'Wild Pitch'
      }),
      actionWords({
        type: 'runnerMovement',
        runner: 1,
        to: '3B',
        out: true
      }),
      actionWords({
        type: 'baseRunning',
        runner: 1,
        kind: 'steal',
        to: '2B'
      }),
      actionWords({
        type: 'baseRunning',
        runner: 1,
        kind: 'pickoff'
      }),
      actionWords({ type: 'batteryEvent', kind: 'wild_pitch' }),
      actionWords({ type: 'fieldingPlay', fielders: [] }),
      actionWords({
        type: 'fieldingPlay',
        fielders: [],
        error: 1
      }),
      ...(
        ['closePlay', 'endHalf', 'endGame', 'placeRunner', 'override'] as const
      ).map(kind => actionWords({ type: 'gameFlow', kind }))
    ]
    expect(words).deep.equals([
      lstrings.remote_log_pitch_ball,
      lstrings.remote_log_pitch_called,
      lstrings.remote_log_pitch_swinging,
      lstrings.remote_log_pitch_foul,
      lstrings.remote_log_pitch_foul_tip,
      lstrings.remote_log_pitch_foul_bunt,
      lstrings.remote_log_lineup,
      'Swing',
      'Line drive to left',
      'Field out (catch)',
      'Runner to 2B (Wild Pitch)',
      'Runner out at 3B',
      'Steal at 2B',
      'Pickoff',
      'Wild pitch',
      lstrings.remote_log_fielding_play,
      lstrings.remote_log_fielding_error,
      lstrings.remote_log_close_play,
      lstrings.remote_log_end_half,
      lstrings.remote_log_end_game,
      lstrings.remote_log_place_runner,
      lstrings.remote_log_override
    ])
  })
  it('keeps what the scorer dismissed dismissed, and shows only later work', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, 'ann'])
    nextRemoteLog(log, history.picture())
    history.undo(1, 'ann')
    nextRemoteLog(log, history.picture())
    expect(rows(log)).deep.equals([
      ['Ann A.', [sprintf(lstrings.remote_log_undo, 'Ball')]]
    ])
    dismissRemoteLog(log, history.picture())
    expect(log.rows).deep.equals([])
    history.add([called, 'ann'])
    nextRemoteLog(log, history.picture())
    expect(rows(log)).deep.equals([['Ann A.', ['Called strike']]])
    dismissRemoteLog(log, history.picture())
    history.add([foul, 'ann'])
    nextRemoteLog(log, history.picture())
    // The span grew, so it is new again, and shown whole.
    expect(rows(log)).deep.equals([['Ann A.', ['Called strike, foul']]])
    expect(log.rows.some(row => row.id.startsWith('undo:'))).equals(false)
  })
  it('shows a remote End of the half and Game over after that scorer’s own pitches', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    strikeouts(history, 2, VIEWER)
    while (history.tryAdd(called, 'ann')) {
      if (history.tryAdd(endHalf, 'ann')) break
    }
    nextRemoteLog(log, history.picture())
    expect(log.rows.flatMap(row => row.lines)).include('End of the half')
    const endGame: ScoringAction = { type: 'gameFlow', kind: 'endGame' }
    if (history.tryAdd(endGame, 'ann')) {
      nextRemoteLog(log, history.picture())
      expect(log.rows.flatMap(row => row.lines)).include('Game over')
    }
  })
  it('shows nothing new, and keeps its rows, when hashing throws', () => {
    const history = new History()
    let fail = false
    const mix = (previous: string, key: string): string => {
      if (fail) throw new Error('hash failed')
      return fnvMix(previous, key)
    }
    const log = startRemoteLog(history.picture(), VIEWER, { mix })
    history.add([ball, 'ann'])
    nextRemoteLog(log, history.picture(), { mix })
    const shown = log.rows
    fail = true
    history.add([called, 'ann'])
    // The chain cannot vouch for anything: every span is described afresh
    // from the confirmed history, which still credits Ann exactly.
    nextRemoteLog(log, history.picture(), { mix })
    expect(rows(log)).deep.equals([['Ann A.', ['Ball, called strike']]])
    expect(shown).lengthOf(1)
  })
  it('keeps its rows when the history cannot be described at all', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, 'ann'])
    nextRemoteLog(log, history.picture())
    const shown = log.rows
    history.add([called, 'ann'])
    const throwing: typeof describeLogSpans = () => {
      throw new Error('replay failed')
    }
    const { changed } = nextRemoteLog(log, history.picture(), {
      describe: throwing
    })
    expect(changed).equals(false)
    expect(log.rows).equals(shown)
  })
  it('opens empty when the mount cannot be described, and takes the next history as seen', () => {
    const history = new History().add([ball, 'ann'])
    const throwing: typeof describeLogSpans = () => {
      throw new Error('replay failed')
    }
    const log = startRemoteLog(history.picture(), VIEWER, {
      describe: throwing
    })
    expect(log.rows).deep.equals([])
    history.add([called, 'ann'])
    expect(nextRemoteLog(log, history.picture()).changed).equals(false)
    expect(log.rows).deep.equals([])
    history.add([foul, 'bob'])
    nextRemoteLog(log, history.picture())
    expect(rows(log)).deep.equals([['Bob B.', ['Foul']]])
  })
  it('compares every at-bat again after a notification that cannot be described', () => {
    const history = new History()
    strikeouts(history, 1, 'ann')
    history.add([ball, 'ann'])
    const log = startRemoteLog(history.picture(), VIEWER)
    // Bob corrects the first batter's first pitch; that read cannot be told.
    const corrected = [...history.actions]
    corrected[0] = swinging
    const authors = [...history.authors]
    authors[0] = 'bob'
    history.replace(corrected, authors)
    const throwing: typeof describeLogSpans = () => {
      throw new Error('replay failed')
    }
    nextRemoteLog(log, history.picture(), { describe: throwing })
    // The next read only appends to the second batter.
    history.add([ball, 'ann'])
    nextRemoteLog(log, history.picture())
    expect(log.rows.map(row => [row.userId, row.id])).deep.equals([
      ['bob', 'seg:0:0'],
      ['ann', 'seg:0:1'],
      ['ann', 'seg:1:0']
    ])
  })
  it('resumes from the authored chain after rebuilding from scratch', function () {
    this.timeout(60_000)
    const history = new History()
    strikeouts(history, 30, 'ann')
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, 'bob'])
    nextRemoteLog(log, history.picture())
    // A corrupted basis rebuilds every span from scratch.
    for (const basis of log.basis.values()) basis.hash = 'tampered'
    history.add([ball, 'bob'])
    nextRemoteLog(log, history.picture())
    let described = 0
    const counting: typeof describeLogSpans = (...args) => {
      const before = new Map(args[4]!.spans)
      const spans = describeLogSpans(...args)
      // A span described again is a new entry, even under the same key.
      described = [...args[4]!.spans].filter(
        ([key, entry]) => before.get(key) !== entry
      ).length
      return spans
    }
    history.add([ball, 'bob'])
    nextRemoteLog(log, history.picture(), { describe: counting })
    expect(described).equals(1)
  })
  it('keeps rows in the order they came once the line cap trims the oldest', function () {
    this.timeout(60_000)
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    const order = (): number[] =>
      log.rows.map(row => Number(row.id.split(':')[1]))
    for (let atBats = 1; atBats <= 40; atBats++) {
      strikeouts(history, 1, 'ann')
      nextRemoteLog(log, history.picture())
      const shown = order()
      expect(shown, `after at-bat ${atBats}`).deep.equals(
        [...shown].sort((a, b) => a - b)
      )
    }
    const lines = log.rows.reduce((sum, row) => sum + row.lines.length, 0)
    expect(lines).at.most(REMOTE_LOG_LINES)
    // Rows alternating within one at-bat keep their order across the cap too.
    for (let i = 0; i < 60; i++) {
      history.add([foul, i % 2 === 0 ? 'ann' : 'bob'])
      nextRemoteLog(log, history.picture())
      const ids = log.rows.map(row => row.id)
      expect(new Set(ids).size).equals(ids.length)
      const positions = log.rows
        .filter(row => row.id.startsWith('seg:'))
        .map(row => row.id.split(':').slice(1).map(Number))
      for (let k = 1; k < positions.length; k++)
        expect(
          positions[k][0] > positions[k - 1][0] ||
            (positions[k][0] === positions[k - 1][0] &&
              positions[k][1] > positions[k - 1][1]),
          JSON.stringify(positions)
        ).equals(true)
    }
  })
  it('names a scorer the reader may not read as another scorer', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([ball, 'stranger'])
    nextRemoteLog(log, history.picture())
    expect(log.rows[0].name).equals(lstrings.remote_log_another_scorer)
  })
  it('rewords a shown row when a roster change relabels its batter, crediting no editor', () => {
    const history = new History()
    const log = startRemoteLog(history.picture(), VIEWER)
    history.add([called, 'ann'], [called, 'ann'], [called, 'ann'])
    nextRemoteLog(log, history.picture())
    expect(rows(log)).deep.equals([
      [
        'Ann A.',
        [
          'Called strike, called strike, called strike',
          'Player 1 strikes out looking'
        ]
      ]
    ])
    // The coach renames the batter: no action, the same accepted history.
    const picture = history.picture()
    const batter = Object.values(picture.state.gameData.players).find(
      player => player.fullName === 'Player 1'
    )!
    picture.state = structuredClone(picture.state)
    picture.state.gameData.players[batter.id] = {
      ...batter,
      fullName: 'Changed Name',
      compactName: 'Changed N'
    }
    nextRemoteLog(log, picture)
    expect(rows(log)).deep.equals([
      [
        'Ann A.',
        [
          'Called strike, called strike, called strike',
          'Changed N strikes out looking'
        ]
      ]
    ])
  })
  it('shows no Undo row for a remote reopen of a closed play', () => {
    const history = new History().add(
      [called, 'ann'],
      [called, 'ann'],
      [called, 'ann'],
      [close, 'ann']
    )
    const log = startRemoteLog(history.picture(), VIEWER)
    history.undo(1, 'bob')
    const { changed } = nextRemoteLog(log, history.picture())
    expect(changed).equals(false)
    expect(log.rows).deep.equals([])
  })
  it('reopens a dismissed log for a scorer’s lineup change, but not for a coach’s', () => {
    const history = new History().add([ball, 'ann'])
    const log = startRemoteLog(new History().picture(), VIEWER)
    nextRemoteLog(log, history.picture())
    dismissRemoteLog(log, history.picture())
    const lineup: ScoringAction = {
      type: 'lineup',
      kind: 'roster',
      setup: setupOf(history.state)
    }
    // A coach's edit through the lineup screen carries no scoring user.
    history.add([lineup, null])
    expect(nextRemoteLog(log, history.picture()).changed).equals(false)
    expect(log.rows).deep.equals([])
    history.add([lineup, 'bob'])
    expect(nextRemoteLog(log, history.picture()).changed).equals(true)
    expect(rows(log)).deep.equals([['Bob B.', [actionWords(lineup)]]])
  })
  it('describes the game at mount on the chain the next notification passes', function () {
    this.timeout(60_000)
    const history = new History()
    strikeouts(history, 30, 'ann')
    const log = startRemoteLog(history.picture(), VIEWER)
    expect(log.cache.chain).deep.equals(
      chainOf(history.actions, history.authors)
    )
    // Only the appended pitch's at-bat is described again.
    let described = 0
    const counting: typeof describeLogSpans = (...args) => {
      const before = new Map(args[4]!.spans)
      const spans = describeLogSpans(...args)
      // A span described again is a new entry, even under the same key.
      described = [...args[4]!.spans].filter(
        ([key, entry]) => before.get(key) !== entry
      ).length
      return spans
    }
    history.add([ball, 'bob'])
    nextRemoteLog(log, history.picture(), { describe: counting })
    expect(described).equals(1)
  })
  it('does nothing before the first read', () => {
    const log = startRemoteLog(undefined, VIEWER)
    expect(nextRemoteLog(log, undefined).changed).equals(false)
  })
  it('matches a from-scratch reference over 500 seeded sequences', function () {
    this.timeout(300_000)
    const pool: ScoringAction[] = [ball, called, swinging, foul, contact, close]
    const people = ['ann', 'bob', VIEWER, null]
    for (let sequence = 0; sequence < 500; sequence++) {
      let seed = sequence * 7919 + 1
      const next = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 2 ** 32
      }
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(next() * items.length)]
      const history = new History()
      for (let i = 0; i < 3; i++) history.tryAdd(pick(pool), pick(people))
      const log = startRemoteLog(history.picture(), VIEWER)
      const reference = new Reference(history.picture())
      for (let step = 0; step < 10; step++) {
        const roll = next()
        if (roll < 0.15 && history.actions.length > 0)
          history.undo(1 + Math.floor(next() * 2), pick(['ann', 'bob', VIEWER]))
        else if (roll < 0.25 && history.actions.length > 1) {
          const at = Math.floor(next() * history.actions.length)
          const actions = [...history.actions]
          const authors = [...history.authors]
          actions[at] = pick(pool)
          authors[at] = pick(people)
          const before = history.picture()
          history.replace(actions, authors)
          let valid = true
          let game = history.opening
          for (const action of actions) {
            const applied = applyAction(game, action)
            if (applied.problems.length > 0) valid = false
            game = applied.state
          }
          if (!valid) history.replace([...before.actions], [...before.authors])
        } else if (roll < 0.3)
          history.replace(
            history.actions.map(
              action =>
                Object.fromEntries(
                  Object.entries(action).reverse()
                ) as unknown as ScoringAction
            ),
            history.authors
          )
        else history.tryAdd(pick(pool), pick(people))
        const picture = history.picture()
        nextRemoteLog(log, picture)
        reference.next(picture)
        expect(byId(log.rows), `sequence ${sequence} step ${step}`).deep.equals(
          byId(reference.rows())
        )
      }
    }
  })
})

/** A list of action words, only its first word capitalised. */
const listed = (actions: readonly ScoringAction[]): string =>
  actions
    .filter(action => action.type !== 'gameFlow' || action.kind !== 'closePlay')
    .map((action, index) => {
      const words = actionWords(action)
      return index === 0
        ? words
        : words.charAt(0).toLowerCase() + words.slice(1)
    })
    .join(', ')

const byId = (list: readonly RemoteLogRow[]): Record<string, unknown> =>
  Object.fromEntries(
    list.map(row => [row.id, { userId: row.userId, lines: row.lines }])
  )

/**
 * The remote log recomputed from nothing at every step: spans from a fresh
 * formatter, and each at-bat's seen count by comparing its actions directly
 * with the previous step's, with no chain and no divergence.
 */
class Reference {
  private readonly seen = new Map<number, number>()
  private previous = new Map<number, string[]>()
  private readonly mountRemovals: Set<string>
  private picture: AcceptedPicture

  constructor(picture: AcceptedPicture) {
    this.picture = picture
    this.mountRemovals = new Set(picture.removals.map(removal => removal.id))
    this.previous = this.keysOf(picture)
    for (const [atBat, keys] of this.previous) this.seen.set(atBat, keys.length)
  }

  private spans(picture: AcceptedPicture): ReturnType<typeof describeLogSpans> {
    return describeLogSpans(
      picture.opening,
      picture.actions,
      picture.authors,
      readableFor(picture.state).readable
    )
  }

  private keysOf(picture: AcceptedPicture): Map<number, string[]> {
    const keys = new Map<number, string[]>()
    for (const span of this.spans(picture)) {
      const list = keys.get(span.atBatIndex) ?? []
      for (let i = span.from; i < span.to; i++)
        list.push(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(picture.actions[i]).sort(([a], [b]) =>
                a < b ? -1 : 1
              )
            )
          ) +
            '|' +
            (picture.authors[i] ?? '')
        )
      keys.set(span.atBatIndex, list)
    }
    return keys
  }

  next(picture: AcceptedPicture): void {
    const keys = this.keysOf(picture)
    for (const [atBat, list] of keys) {
      const before = this.previous.get(atBat) ?? []
      let common = 0
      while (
        common < before.length &&
        common < list.length &&
        before[common] === list[common]
      )
        common++
      const seen = this.seen.get(atBat)
      if (seen != null) this.seen.set(atBat, Math.min(seen, common))
    }
    for (const atBat of [...this.seen.keys()])
      if (!keys.has(atBat)) this.seen.delete(atBat)
    this.previous = keys
    this.picture = picture
  }

  rows(): RemoteLogRow[] {
    const picture = this.picture
    const out: RemoteLogRow[] = []
    for (const span of this.spans(picture)) {
      if (span.author == null || span.author === VIEWER) continue
      if (
        span.position + (span.to - span.from) <=
        (this.seen.get(span.atBatIndex) ?? 0)
      )
        continue
      const text =
        span.text ?? listed(picture.actions.slice(span.from, span.to))
      if (text === '') continue
      out.push({
        id: `seg:${span.atBatIndex}:${span.position}`,
        userId: span.author,
        name: '',
        lines: text.split('\n')
      })
    }
    for (const removal of picture.removals)
      if (!this.mountRemovals.has(removal.id) && removal.userId !== VIEWER)
        out.push({
          id: `undo:${removal.id}`,
          userId: removal.userId,
          name: '',
          lines: [sprintf(lstrings.remote_log_undo, listed(removal.actions))]
        })
    return out
  }
}
