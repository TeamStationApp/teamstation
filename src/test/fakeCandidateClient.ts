import type { RosterCandidate, TeamStationClient } from '../common/api'

/** A roster candidate named like an MLB player, with a cursor of its own. */
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
    tier: 'mine',
    cursor: `cursor-${userId}`,
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
  after?: string
  limit?: number
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
