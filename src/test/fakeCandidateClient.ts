import type { RosterCandidate, TeamStationClient } from '../common/api'

/** A roster candidate named like an MLB player. */
export function candidate(
  name: string,
  extra: Partial<RosterCandidate> = {}
): RosterCandidate {
  const [first, last = ''] = name.split(' ')
  const userId = `usr_${name.replace(/\W/g, '')}`
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
  resolve: (rows: RosterCandidate[]) => void
  reject: (error: unknown) => void
}

/** A client whose candidate pages answer when the test says. */
export class FakeCandidateClient {
  asks: CandidateAsk[] = []
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

  async rosterCandidates(
    ask: Omit<CandidateAsk, 'resolve' | 'reject'>
  ): Promise<RosterCandidate[]> {
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
