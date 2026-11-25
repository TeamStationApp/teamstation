import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { MyRoles, SeasonGame } from '../../common/api'
import { HttpError } from '../../common/errors'
import type {
  GameSocketEvent,
  UserTopic,
  UserTopicListener
} from '../../common/gameSocket'
import {
  type OfflineManifestAnswer,
  type OfflineManifestGame,
  OfflineScoringSet,
  type OfflineSetHost,
  type OfflineSetState
} from './offlineSet'

/** A record the set never reads into, of any shape. */
function stub<T>(): T {
  return JSON.parse('{}') as T
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++)
    await new Promise(resolve => setTimeout(resolve, 0))
}

function entry(
  id: string,
  home: string,
  away: string,
  more: Partial<OfflineManifestGame> = {}
): OfflineManifestGame {
  return {
    id,
    startAt: '2026-11-24T18:00:00.000Z',
    homeTeamId: home,
    awayTeamId: away,
    started: false,
    schedule: {
      ...stub<SeasonGame>(),
      id,
      startAt: '2026-11-24T18:00:00.000Z'
    },
    ...more
  }
}

/** A phone the test drives: what it reads, forgets, keeps and hears. */
function phone(answers: OfflineManifestAnswer[]): {
  host: OfflineSetHost
  reads: string[]
  forgotten: string[]
  listed: Array<[string, string[]]>
  held: Set<string>
  saved: () => OfflineSetState | undefined
  subscribed: () => string[]
  tell: (gameId: string, event: GameSocketEvent) => void
  ring: () => void
  refuse: Set<string>
  manifests: string[][]
  stored: string[]
} {
  const reads: string[] = []
  const forgotten: string[] = []
  const listed: Array<[string, string[]]> = []
  const held = new Set<string>()
  const refuse = new Set<string>()
  const manifests: string[][] = []
  const stored: string[] = []
  let state: OfflineSetState | undefined
  const games = new Map<string, (event: GameSocketEvent) => void>()
  const topic = new Set<UserTopicListener>()
  const host: OfflineSetHost = {
    manifest: async kept => {
      manifests.push(kept)
      return answers.length > 1 ? answers.shift()! : answers[0]
    },
    read: async path => {
      reads.push(path)
      if (refuse.has(path)) throw new HttpError('forbidden', 'Not yours')
      if (path.endsWith('/events')) return { lineupsDigest: 'D1' }
      if (path.endsWith('/lineups')) return { digest: 'D1' }
      return {}
    },
    roles: async (): Promise<MyRoles> => ({
      teams: { home: ['scorekeeper'] },
      guardianOf: []
    }),
    forget: async paths => {
      forgotten.push(...paths)
    },
    storedGames: async () => stored,
    keepSchedule: async (rows, window) => {
      listed.push([window, rows.map(row => row.id)])
    },
    loadState: async () => state,
    saveState: async next => {
      state = JSON.parse(JSON.stringify(next)) as OfflineSetState
    },
    heldOpen: gameId => held.has(gameId),
    subscribeGame: (gameId, listener) => {
      games.set(gameId, listener)
      return () => {
        games.delete(gameId)
      }
    },
    onTopic: (name: UserTopic, listener: UserTopicListener) => {
      if (name === 'offlineSet') topic.add(listener)
      return () => {
        topic.delete(listener)
      }
    }
  }
  return {
    host,
    reads,
    forgotten,
    listed,
    held,
    saved: () => state,
    subscribed: () => [...games.keys()],
    tell: (gameId, event) => games.get(gameId)?.(event),
    ring: () => {
      for (const listener of [...topic]) listener({ type: 'changed' })
    },
    refuse,
    manifests,
    stored
  }
}

describe('the games a phone keeps to score with no signal', () => {
  it('keeps nothing and reads nothing more for an empty choice', async () => {
    const p = phone([{ games: [], nextBoundary: null, digest: 'empty' }])
    const set = new OfflineScoringSet(p.host)
    await set.started
    expect(p.reads).deep.equals([])
    expect(p.subscribed()).deep.equals([])
    expect(set.kept).deep.equals([])
  })

  it('stores each game’s package once, its shared team once, lists it in Upcoming and follows it', async () => {
    const p = phone([
      {
        games: [entry('g1', 'home', 'away'), entry('g2', 'home', 'other')],
        nextBoundary: null,
        digest: 'two'
      }
    ])
    const set = new OfflineScoringSet(p.host)
    await set.started
    expect(set.status('g1')).equals('ready')
    expect(set.status('g2')).equals('ready')
    expect(set.status('g3')).equals('none')
    expect(p.reads).includes('/games/g1/events')
    expect(p.reads).includes('/events/g2/info')
    // A scorekeeper reads the team's whole names too; others the plain roster.
    expect(p.reads).includes('/teams/home/roster?includeFullNames=true')
    expect(p.reads).includes('/teams/home/roster')
    expect(p.reads).includes('/teams/away/roster')
    expect(p.reads).not.includes('/teams/away/roster?includeFullNames=true')
    expect(
      p.reads.filter(path => path === '/teams/home/default-lineup'),
      'a shared team read once'
    ).length(1)
    expect(p.listed).deep.equals([['upcoming', ['g1', 'g2']]])
    expect(p.subscribed().sort()).deep.equals(['g1', 'g2'])
    // Unchanged and ready: the next choice reads nothing more.
    const before = p.reads.length
    p.ring()
    await settle()
    expect(p.reads.length).equals(before)
    expect(p.manifests.at(-1), 'held ids are sent').deep.equals(['g1', 'g2'])
  })

  it('reads again only the document a change names, and nothing while a scoring screen has the game', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    const set = new OfflineScoringSet(p.host)
    await set.started
    p.reads.length = 0
    const at = ''
    p.tell('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'lineups',
      at,
      data: stub<never>()
    })
    p.tell('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'roster',
      at,
      data: { teamId: 'away' }
    })
    p.tell('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'defaultLineup',
      at,
      data: { teamId: 'home' }
    })
    await settle()
    expect(p.reads).deep.equals([
      '/games/g1/lineups',
      '/teams/away/roster',
      '/teams/home/default-lineup'
    ])
    p.held.add('g1')
    p.reads.length = 0
    p.tell('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'playEdits',
      at,
      data: stub<never>()
    })
    await settle()
    expect(p.reads).deep.equals([])
  })

  it('lets a departing game go before taking its place, keeping what another game or a scoring screen still holds', async () => {
    const p = phone([
      {
        games: [entry('g1', 'home', 'away'), entry('g2', 'home', 'b')],
        nextBoundary: null,
        digest: 'first'
      },
      {
        games: [entry('g2', 'home', 'b'), entry('g4', 'home', 'c')],
        nextBoundary: null,
        digest: 'second'
      }
    ])
    const set = new OfflineScoringSet(p.host)
    await set.started
    p.ring()
    await settle()
    expect(set.kept.map(game => game.id)).deep.equals(['g2', 'g4'])
    expect(p.subscribed().sort()).deep.equals(['g2', 'g4'])
    expect(p.forgotten).includes('/games/g1/events')
    expect(p.forgotten, 'home is still kept').not.includes(
      '/teams/home/default-lineup'
    )
    expect(p.forgotten).includes('/teams/away/default-lineup')
    // A game a scoring screen has open keeps its documents.
    const q = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' },
      { games: [], nextBoundary: null, digest: 'none' }
    ])
    const kept = new OfflineScoringSet(q.host)
    await kept.started
    q.held.add('g1')
    q.ring()
    await settle()
    expect(kept.kept).deep.equals([])
    expect(q.forgotten).deep.equals([])
  })

  it('forgets a game whose documents are refused, and does not call it ready', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    p.refuse.add('/games/g1/events')
    const set = new OfflineScoringSet(p.host)
    await set.started
    expect(set.status('g1')).equals('staged')
    expect(p.forgotten).includes('/games/g1')
  })

  it('keeps a ready game’s team documents when another game of that team is refused', async () => {
    const p = phone([
      {
        games: [entry('g1', 'home', 'a1'), entry('g2', 'home', 'a2')],
        nextBoundary: null,
        digest: 'a'
      }
    ])
    p.refuse.add('/games/g2/events')
    const set = new OfflineScoringSet(p.host)
    await set.started
    expect(set.status('g1')).equals('ready')
    expect(set.status('g2')).equals('staged')
    expect(p.forgotten).includes('/games/g2')
    expect(
      p.forgotten.filter(path => path.startsWith('/teams/home')),
      'the team g1 still keeps'
    ).deep.equals([])
  })

  it('keeps a game ready though the other team’s documents are not this person’s to read', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    p.refuse.add('/teams/away/default-lineup')
    const set = new OfflineScoringSet(p.host)
    await set.started
    expect(set.status('g1')).equals('ready')
    expect(p.forgotten).deep.equals([])
  })

  it('stays staged when a read fails, and tries again on the next choice', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    const read = p.host.read
    let fail = true
    p.host.read = async path => {
      if (fail && path.endsWith('/plans')) throw new HttpError('offline', 'x')
      return await read(path)
    }
    const set = new OfflineScoringSet(p.host)
    await set.started
    expect(set.status('g1')).equals('staged')
    fail = false
    p.ring()
    await settle()
    expect(set.status('g1')).equals('ready')
  })

  it('reads a game a failed read left staged once the network comes back, with no notice', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    const read = p.host.read
    let fail = true
    p.host.read = async path => {
      if (fail && path.endsWith('/plans')) throw new HttpError('offline', 'x')
      return await read(path)
    }
    const back: Array<() => void> = []
    p.host.whenBack = again => {
      back.push(again)
      return () => {
        back.splice(back.indexOf(again), 1)
      }
    }
    const set = new OfflineScoringSet(p.host)
    await set.started
    expect(set.status('g1')).equals('staged')
    expect(back, 'one wait').length(1)
    fail = false
    back.shift()!()
    await settle()
    expect(set.status('g1')).equals('ready')
    expect(back, 'ready: nothing to wait for').length(0)
    set.stop()
  })

  it('reads the lineups once more when the plays name others, and lists a game under way in Past with its box score', async () => {
    const p = phone([
      {
        games: [entry('g1', 'home', 'away', { started: true })],
        nextBoundary: null,
        digest: 'a'
      }
    ])
    const read = p.host.read
    let first = true
    p.host.read = async path => {
      if (path === '/games/g1/lineups' && first) {
        first = false
        p.reads.push(path)
        return { digest: 'D0' }
      }
      return await read(path)
    }
    const set = new OfflineScoringSet(p.host)
    await set.started
    expect(p.reads.filter(path => path === '/games/g1/lineups')).length(2)
    expect(p.reads).includes('/games/g1/box-score')
    expect(p.listed).deep.equals([['past', ['g1']]])
    expect(set.status('g1')).equals('ready')
  })

  it('lets an earlier build’s read-ahead go once, reading nothing for it', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    p.stored.push('g1', 'old')
    const set = new OfflineScoringSet(p.host)
    await set.started
    expect(p.forgotten).includes('/games/old/events')
    expect(p.forgotten).not.includes('/games/g1/events')
    expect(p.reads.filter(path => path.includes('old'))).deep.equals([])
    expect(p.saved()?.upgraded).equals(true)
  })

  it('reads nothing once stopped, and keeps what a manifest that fails leaves', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    const set = new OfflineScoringSet(p.host)
    await set.started
    p.host.manifest = async () => {
      throw new HttpError('offline', 'No signal')
    }
    p.ring()
    await settle()
    expect(set.status('g1')).equals('ready')
    set.stop()
    const before = p.reads.length
    p.tell('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'game',
      at: '',
      data: stub<never>()
    })
    p.ring()
    await settle()
    expect(p.reads.length).equals(before)
    expect(p.subscribed()).deep.equals([])
  })

  it('reads a kept game again when one of its teams changes, and nothing for the others when one starts', async () => {
    const p = phone([
      {
        games: [
          entry('g1', 'home', 'away'),
          entry('g2', 'home', 'b'),
          entry('g3', 'home', 'c')
        ],
        nextBoundary: null,
        digest: 'a'
      },
      {
        games: [
          entry('g1', 'home', 'away'),
          entry('g2', 'home', 'b', { started: true }),
          entry('g3', 'home', 'c')
        ],
        nextBoundary: null,
        digest: 'b'
      },
      {
        games: [
          entry('g1', 'home', 'other'),
          entry('g2', 'home', 'b', { started: true }),
          entry('g3', 'home', 'c')
        ],
        nextBoundary: null,
        digest: 'c'
      }
    ])
    const set = new OfflineScoringSet(p.host)
    await set.started
    p.reads.length = 0
    p.ring()
    await settle()
    expect(
      p.reads.filter(path =>
        ['/games/g1', '/games/g3', '/teams/away/', '/teams/c/'].some(other =>
          path.startsWith(other)
        )
      ),
      'a game starting reads nothing only the others keep'
    ).deep.equals([])
    expect(['g1', 'g2', 'g3'].map(id => set.status(id))).deep.equals([
      'ready',
      'ready',
      'ready'
    ])
    p.reads.length = 0
    p.ring()
    await settle()
    expect(p.reads).includes('/teams/other/roster')
    expect(p.reads.some(path => path.startsWith('/games/g1/'))).equals(true)
    expect(
      p.reads.some(
        path => path.startsWith('/games/g2/') || path.startsWith('/games/g3/')
      ),
      'the others'
    ).equals(false)
    expect(set.status('g1')).equals('ready')
  })

  it('knows the person’s roles after a launch that changed nothing, so a roster notice reads the full names', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    const first = new OfflineScoringSet(p.host)
    await first.started
    first.stop()
    const again = new OfflineScoringSet(p.host)
    await again.started
    expect(again.status('g1')).equals('ready')
    p.reads.length = 0
    p.tell('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'roster',
      at: '',
      data: { teamId: 'home' }
    })
    await settle()
    expect(p.reads).includes('/teams/home/roster?includeFullNames=true')
  })

  it('reads once more what it kept ready at the last launch, though the choice did not change, and nothing on the next choice', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    const first = new OfflineScoringSet(p.host)
    await first.started
    const kept = p.saved()!.games[0].paths
    first.stop()
    p.reads.length = 0
    const again = new OfflineScoringSet(p.host)
    await again.started
    expect(again.status('g1')).equals('ready')
    expect(
      [...p.reads].sort(),
      'an edit made while the app was closed'
    ).deep.equals([...kept].sort())
    p.reads.length = 0
    p.ring()
    await settle()
    expect(p.reads, 'once a launch').deep.equals([])
  })

  it('restores what it kept at the last launch, and reads once per outage', async () => {
    const p = phone([
      { games: [entry('g1', 'home', 'away')], nextBoundary: null, digest: 'a' }
    ])
    const first = new OfflineScoringSet(p.host)
    await first.started
    first.stop()
    const again = new OfflineScoringSet(p.host)
    await again.started
    expect(again.status('g1')).equals('ready')
    const asked = p.manifests.length
    const listeners: UserTopicListener[] = []
    p.host.onTopic = (_name, listener) => {
      listeners.push(listener)
      return () => undefined
    }
    const third = new OfflineScoringSet(p.host)
    await third.started
    const base = p.manifests.length
    expect(base).equals(asked + 1)
    listeners[0]({ type: 'unreachable', outage: 1 })
    listeners[0]({ type: 'unreachable', outage: 1 })
    listeners[0]({ type: 'subscribed', afterGap: false })
    await settle()
    expect(p.manifests.length).equals(base + 1)
    listeners[0]({ type: 'subscribed', afterGap: true })
    await settle()
    expect(p.manifests.length).equals(base + 2)
  })
})
