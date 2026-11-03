import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import {
  asPostedEdits,
  liveEventsBody,
  type PostedEdits,
  TeamStationClient
} from '../../common/api'
import type { PitchCall } from '../../common/scoring/actions'
import { type EventStore, ScoringSession } from '../../common/scoring/session'
import { startingSetup, teamsOf } from '../../common/scoring/startingSetup'
import type { GameState } from '../../common/scoring/state'

/**
 * Scores one pitch on a game being played, through the scoring screen's own
 * session against a running API, and prints what the post answered:
 *
 *   npm run live-pitch -- --api <api url> --game <gameId> --token-file <file>
 *
 * The token file holds the bearer token of someone who may score the game.
 * The session reads the game as it stands, so the pitch always fits it: a
 * called third strike at two strikes, otherwise a ball, so that the count
 * ends the batter's turn, and the pitch after that writes his play. Its
 * store posts the save itself, asking for the edits answer as the app does
 * (`?answer=edits`), and prints the request line, the answer's top-level keys, how many plays or
 * edits it holds and its size in bytes, then reads it as the app does
 * (`asPostedEdits`). It reads either answer: a server's edits, or every
 * stored play from one that does not know the edits answer.
 */

/** What one post answered, as `livePitch` prints it. */
export interface PitchAnswer {
  keys: string[]
  /** Plays in an answer of every stored play. */
  plays?: number
  /** Edits in an answer of only what the post wrote. */
  edits?: { puts: number; removes: number }
  bytes: number
  posted: PostedEdits
}

export interface LivePitchOptions {
  api: string
  gameId: string
  token: string
  fetch?: typeof globalThis.fetch
  print?: (line: string) => void
}

/** The pitch `livePitch` throws: one that ends the turn at a full count. */
export function pitchFor(state: GameState): PitchCall {
  const strikes = state.liveData.plays.currentPlay?.count?.strikes ?? 0
  return strikes >= 2 ? 'C' : 'B'
}

/** What a post's raw answer holds, by its shape. */
export function describeAnswer(text: string): Omit<PitchAnswer, 'posted'> {
  const raw = JSON.parse(text) as Record<string, unknown>
  const bytes = Buffer.byteLength(text)
  const keys = Object.keys(raw)
  if (Array.isArray(raw.edits)) {
    const ops = (raw.edits as Array<{ op?: unknown }>).map(edit => edit.op)
    return {
      keys,
      edits: {
        puts: ops.filter(op => op === 'put').length,
        removes: ops.filter(op => op === 'remove').length
      },
      bytes
    }
  }
  return {
    keys,
    ...(Array.isArray(raw.plays) ? { plays: raw.plays.length } : {}),
    bytes
  }
}

/** Scores one pitch on `gameId` and answers what its post answered. */
export async function livePitch(
  options: LivePitchOptions
): Promise<PitchAnswer> {
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const print =
    options.print ??
    ((line: string) => {
      console.log(line)
    })
  const api = options.api.replace(/\/+$/, '')
  const client = new TeamStationClient({
    baseUrl: api,
    token: options.token,
    fetch
  })
  const game = await client.game(options.gameId)
  const [away, home] = await Promise.all([
    client.roster(game.awayTeamId),
    client.roster(game.homeTeamId)
  ])
  let answered: PitchAnswer | undefined
  const store: EventStore = {
    load: async id => await client.gameEvents(id),
    save: async (id, change) => {
      // Only what the post wrote, as the app asks.
      const url = `${api}/games/${encodeURIComponent(id)}/events?answer=edits`
      print(`POST ${url}`)
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.token}`
        },
        body: JSON.stringify(liveEventsBody(change))
      })
      const text = await response.text()
      if (!response.ok) {
        print(`${response.status} ${text}`)
        throw new Error(`The post answered ${response.status}`)
      }
      const described = describeAnswer(text)
      print(`${response.status} answer keys: ${described.keys.join(', ')}`)
      if (described.edits != null)
        print(
          `edits: ${described.edits.puts + described.edits.removes} ` +
            `(${described.edits.puts} put, ${described.edits.removes} remove)`
        )
      if (described.plays != null) print(`plays: ${described.plays}`)
      print(`bytes: ${described.bytes}`)
      const posted = asPostedEdits(JSON.parse(text))
      print(`read as: ${JSON.stringify(posted)}`)
      answered = { ...described, posted }
      return posted
    }
  }
  const session = await ScoringSession.open(
    store,
    game.id,
    {
      gamePk: game.id,
      teams: teamsOf(game),
      setup: startingSetup(game, away, home),
      fenceDistanceFt: game.fenceDistanceFt
    },
    { setTimer: () => null, clearTimer: () => undefined }
  )
  try {
    const call = pitchFor(session.state)
    print(`pitch: ${call === 'C' ? 'called strike' : 'ball'}`)
    const problems = session.apply({ type: 'pitch', call }).problems
    if (problems.length > 0) throw new Error(problems[0].message)
    await session.flush()
    if (session.problem != null) throw new Error(session.problem)
  } finally {
    session.close()
  }
  if (answered == null) throw new Error('The pitch was not saved')
  return answered
}

/** The command: `--api`, `--game` and `--token-file`, as the header says. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      api: { type: 'string' },
      game: { type: 'string' },
      'token-file': { type: 'string' }
    }
  })
  if (values.api == null || values.game == null || values['token-file'] == null)
    throw new Error(
      'Usage: npm run live-pitch -- --api <url> --game <gameId> --token-file <file>'
    )
  await livePitch({
    api: values.api,
    gameId: values.game,
    token: readFileSync(values['token-file'], 'utf8').trim()
  })
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
