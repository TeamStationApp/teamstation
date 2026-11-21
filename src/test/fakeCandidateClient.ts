import type {
  FoundRosterCandidate,
  RosterCandidate,
  TeamStationClient
} from '../common/api'
import type { SearchFrame, SearchPersonResult } from '../common/search/types'
import { asUserId, userIdOfGumbo } from '../common/userId'
import { FakeSearchServer } from './fakeSearchSocket'

/** A roster candidate named like an MLB player. */
export function candidate(
  name: string,
  extra: Partial<RosterCandidate> = {}
): RosterCandidate {
  const [first, last = ''] = name.split(' ')
  // A canonical id, the same for the same name, as the search socket's
  // cleaner takes only those.
  let hash = 7
  for (const char of name)
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_007
  const userId: string = userIdOfGumbo(hash + 1)
  return {
    userId,
    gumboId: null,
    externalIds: [],
    shortName: `${first} ${last.slice(0, 1)}`.trim(),
    shortParts: { first, last: last.slice(0, 1) },
    avatarUrl: null,
    bats: null,
    throws: null,
    teams: [],
    affiliations: '',
    tier: 'mine',
    ...extra
  }
}
export const page = (count: number, from = 0): RosterCandidate[] =>
  Array.from({ length: count }, (_, index) =>
    candidate(`Player${from + index} Ohtani`)
  )

export interface CandidateAsk {
  teamId: string
  gameId?: string
  q?: string
  limit?: number
  capped?: boolean
  signal?: AbortSignal
  resolve: (rows: FoundRosterCandidate[]) => void
  reject: (error: unknown) => void
}

/**
 * A candidate as the search socket carries it, in mode `people` with
 * `forTeam`: a person row with its card (`roster`).
 */
export function candidateResult(
  row: RosterCandidate,
  /** The folded typed words the server says found him. */
  matched?: string[]
): SearchPersonResult {
  return {
    kind: 'person',
    userId: asUserId(row.userId),
    name: row.shortName,
    avatarUrl: row.avatarUrl,
    associations: row.affiliations,
    roster: {
      gumboId: row.gumboId,
      shortName: row.shortName,
      ...(row.nameFormat == null ? {} : { nameFormat: row.nameFormat }),
      ...(row.compactName == null ? {} : { compactName: row.compactName }),
      ...(row.compactFormat == null
        ? {}
        : { compactFormat: row.compactFormat }),
      shortParts: row.shortParts,
      bats: row.bats,
      throws: row.throws,
      teams: row.teams,
      tier: row.tier === 'other' ? 'league' : row.tier,
      ...(matched == null ? {} : { matched })
    }
  }
}

/**
 * The fake search socket's server for Add Existing Player: each `search`
 * frame is answered at once with `answer`'s rows for it, as candidates;
 * without `answer`, the test answers by hand with `replyCandidates`.
 */
export class FakeCandidateSearch extends FakeSearchServer {
  constructor(answer?: (frame: SearchFrame) => RosterCandidate[]) {
    super(
      answer == null
        ? undefined
        : frame => ({ results: answer(frame).map(row => candidateResult(row)) })
    )
  }

  /** Answers a frame (the last, by default) with these candidates. */
  replyCandidates(
    rows: RosterCandidate[],
    options: Parameters<FakeSearchServer['reply']>[1] = {}
  ): void {
    this.reply({ results: rows.map(row => candidateResult(row)) }, options)
  }
}

/** A client whose candidate pages answer when the test says. */
export class FakeCandidateClient {
  /** An address the search socket is made for; no socket opens there. */
  baseUrl = 'https://api.example.test/api/v1'
  token: string | null = null
  /** How many times a refused session was reported, as a REST 401 is. */
  refusedSessions = 0
  onSessionRefused = (): void => {
    this.refusedSessions++
  }

  asks: CandidateAsk[] = []
  /** The answers kept for the phone, as `keepRosterCandidates` was told. */
  keeps: Array<{
    teamId: string
    rows: Array<RosterCandidate & { matched?: string[] }>
  }> = []

  private readonly listeners = new Set<(offline: boolean) => void>()
  private down = false
  get offline(): boolean {
    return this.down
  }

  set offline(value: boolean) {
    this.down = value
    for (const listener of [...this.listeners]) listener(value)
  }

  subscribeOffline(listener: (offline: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The people the phone keeps, by team: `candidates.<teamId>`. */
  kept: Record<string, RosterCandidate[]> = {}
  /** The keys the cache was read for. */
  cacheReads: string[] = []

  async cached<T>(
    key: string,
    cleaner: (raw: unknown) => T
  ): Promise<T | undefined> {
    this.cacheReads.push(key)
    const team = key.startsWith('candidates.') ? key.slice(11) : undefined
    const held = team == null ? undefined : this.kept[team]
    return held == null ? undefined : cleaner(held)
  }

  async keepRosterCandidates(
    teamId: string,
    rows: ReadonlyArray<RosterCandidate & { matched?: string[] }>
  ): Promise<void> {
    this.keeps.push({ teamId, rows: [...rows] })
  }

  async rosterCandidates(
    ask: Omit<CandidateAsk, 'resolve' | 'reject'>
  ): Promise<FoundRosterCandidate[]> {
    return await new Promise((resolve, reject) => {
      this.asks.push({ ...ask, resolve, reject })
    })
  }

  get client(): TeamStationClient {
    return this as unknown as TeamStationClient
  }

  last(): CandidateAsk {
    return this.asks[this.asks.length - 1]
  }
}
