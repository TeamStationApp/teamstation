import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { RosterCandidate, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  candidate,
  type CandidateAsk,
  FakeCandidateClient,
  page
} from '../../test/fakeCandidateClient'
import { heldTimers } from '../../test/fakeScreenScope'
import {
  CANDIDATE_PAGE,
  candidateMatches,
  type RosterCandidates,
  useRosterCandidates
} from './useRosterCandidates'

let root: Root | undefined
let timers: ReturnType<typeof heldTimers> | undefined
let state: RosterCandidates

function Probe({
  client,
  query,
  gameId,
  cacheFirst
}: {
  client: TeamStationClient
  query: string
  gameId?: string
  cacheFirst?: boolean
}): null {
  state = useRosterCandidates({
    client,
    teamId: 'tem_falcons',
    gameId,
    query,
    ...(cacheFirst == null ? {} : { cacheFirst })
  })
  return null
}

async function show(
  fake: FakeCandidateClient,
  query: string,
  gameId?: string,
  cacheFirst?: boolean
): Promise<void> {
  await act(async () => {
    root!.render(
      <Probe
        client={fake.client}
        query={query}
        gameId={gameId}
        cacheFirst={cacheFirst}
      />
    )
  })
}
async function settle(): Promise<void> {
  await act(async () => {
    timers!.fire()
  })
}
async function answer(
  ask: CandidateAsk,
  rows: RosterCandidate[]
): Promise<void> {
  await act(async () => {
    ask.resolve(rows)
  })
}
async function fail(ask: CandidateAsk, error: unknown): Promise<void> {
  await act(async () => {
    ask.reject(error)
  })
}

describe('useRosterCandidates', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    timers?.restore()
    timers = undefined
  })
  const open = async (
    fake = new FakeCandidateClient(),
    gameId?: string
  ): Promise<FakeCandidateClient> => {
    timers = heldTimers(500)
    root = createRoot(document.createElement('div'))
    await show(fake, '', gameId)
    return fake
  }

  it('asks for the first page of 30 on open, and the next after the last row', async () => {
    const fake = await open(undefined, 'gam_one')
    expect(fake.asks).has.length(1)
    expect(fake.last()).to.include({
      teamId: 'tem_falcons',
      gameId: 'gam_one',
      q: '',
      limit: CANDIDATE_PAGE
    })
    expect(fake.last().after).equals(undefined)
    expect(state.loading).equals(true)
    await answer(fake.last(), page(30))
    expect(state.loading).equals(false)
    expect(state.rows).has.length(30)
    expect(state.ended).equals(false)

    await act(async () => {
      state.loadMore()
    })
    // One page at a time.
    await act(async () => {
      state.loadMore()
    })
    expect(fake.asks).has.length(2)
    expect(fake.last().after).equals(page(30)[29].cursor)
    expect(state.loadingMore).equals(true)
    await answer(fake.last(), page(4, 30))
    expect(state.rows).has.length(34)
    expect(state.loadingMore).equals(false)
    // A short page ends the list.
    expect(state.ended).equals(true)
    await act(async () => {
      state.loadMore()
    })
    expect(fake.asks).has.length(2)
  })

  it('keeps the rows over a failed page and retries just that page', async () => {
    const fake = await open()
    await answer(fake.last(), page(30))
    await act(async () => {
      state.loadMore()
    })
    await fail(fake.last(), new Error('socket hang up'))
    expect(state.rows).has.length(30)
    expect(state.error).equals('Unable to load players. Please try again.')
    expect(state.loadingMore).equals(false)
    await act(async () => {
      state.retry()
    })
    expect(fake.asks).has.length(3)
    expect(fake.last().after).equals(page(30)[29].cursor)
    expect(state.error).equals(undefined)
    await answer(fake.last(), page(2, 30))
    expect(state.rows).has.length(32)
  })

  it("shows the server's message for a refused first page, and retries the first page", async () => {
    const fake = await open()
    await fail(fake.last(), new HttpError('forbidden', 'Not found'))
    expect(state.error).equals('Not found')
    expect(state.rows).deep.equals([])
    // No rows: nothing to load more of.
    await act(async () => {
      state.loadMore()
    })
    expect(fake.asks).has.length(1)
    await act(async () => {
      state.retry()
    })
    expect(fake.asks).has.length(2)
    expect(fake.last().after).equals(undefined)
    expect(state.loading).equals(true)
    await answer(fake.last(), page(3))
    expect(state.rows).has.length(3)
    expect(state.ended).equals(true)
  })

  it('sends one request for "Be", "Bet", "Betts" typed within half a second, and aborts the one before', async () => {
    const fake = await open()
    const first = fake.last()
    await show(fake, 'Be')
    await show(fake, 'Bet')
    await show(fake, 'Betts ')
    expect(fake.asks).has.length(1)
    await settle()
    expect(fake.asks).has.length(2)
    expect(fake.last().q).equals('Betts')
    expect(first.signal?.aborted).equals(true)
    expect(state.query).equals('Betts')
  })

  it('drops an older answer that arrives last, and returns to the unfiltered first page when cleared', async () => {
    const fake = await open()
    const unfiltered = fake.last()
    await show(fake, 'Betts')
    await settle()
    const betts = fake.last()
    await answer(betts, [candidate('Mookie Betts')])
    await answer(unfiltered, page(30))
    expect(state.rows.map(row => row.shortName)).deep.equals(['Mookie B'])

    // One match is a short page: there is nothing more to ask for.
    expect(state.ended).equals(true)
    await act(async () => {
      state.loadMore()
    })
    expect(fake.asks).has.length(2)

    await show(fake, '')
    await settle()
    expect(fake.asks).has.length(3)
    expect(fake.last().q).equals('')
    expect(state.rows).deep.equals([])
    await answer(fake.last(), page(5))
    expect(state.rows).has.length(5)
  })

  it('drops a further page for a search that has since changed', async () => {
    const fake = await open()
    await answer(fake.last(), page(30))
    await act(async () => {
      state.loadMore()
    })
    const stale = fake.last()
    await show(fake, 'Trout')
    await settle()
    await answer(stale, page(30, 30))
    await fail(stale, new Error('late'))
    expect(state.rows).deep.equals([])
    expect(state.loadingMore).equals(false)
    expect(state.error).equals(undefined)
  })

  it('asks nothing while offline, and asks again once back', async () => {
    const fake = new FakeCandidateClient()
    fake.offline = true
    await open(fake)
    expect(state.offline).equals(true)
    expect(fake.asks).has.length(0)
    await act(async () => {
      fake.offline = false
    })
    expect(state.offline).equals(false)
    expect(fake.asks).has.length(1)
    await answer(fake.last(), page(1))
    await act(async () => {
      fake.offline = true
    })
    expect(fake.last().signal?.aborted).equals(true)
  })

  describe('cache first (U43)', function () {
    const kept = [
      candidate('Mookie Betts', { cursor: 'kept-1' }),
      candidate('Shohei Ohtani', { cursor: 'kept-2' })
    ]
    const openFirst = async (
      fake = new FakeCandidateClient()
    ): Promise<FakeCandidateClient> => {
      fake.kept.tem_falcons = kept
      timers = heldTimers(500)
      root = createRoot(document.createElement('div'))
      await show(fake, '', undefined, true)
      await act(async () => {
        await Promise.resolve()
      })
      return fake
    }

    it('lists the kept people at once, and pages on from the server’s own last row', async () => {
      const fake = await openFirst()
      expect(state.rows.map(row => row.shortName)).deep.equals([
        'Mookie B',
        'Shohei O'
      ])
      expect(state.loading).equals(false)
      expect(state.loadingMore).equals(true)
      // No server row yet: nothing to page on from.
      await act(async () => {
        state.loadMore()
      })
      expect(fake.asks).has.length(1)
      await answer(fake.last(), page(30))
      expect(state.rows).has.length(32)
      expect(state.loadingMore).equals(false)
      await act(async () => {
        state.loadMore()
      })
      expect(fake.last().after).equals(page(30)[29].cursor)
      await answer(fake.last(), page(2, 30))
      expect(state.rows.slice(30, 32).map(row => row.shortName)).deep.equals([
        'Player30 O',
        'Player31 O'
      ])
    })

    it('pages a new search on only from its own first page', async () => {
      const fake = await openFirst()
      await answer(fake.last(), page(30))
      // A new search: its first page has not come when the end is reached.
      await show(fake, 'Mookie', undefined, true)
      await settle()
      expect(fake.asks).has.length(2)
      expect(fake.last().q).equals('Mookie')
      await act(async () => {
        state.loadMore()
      })
      expect(fake.asks).has.length(2)
      await answer(fake.last(), [candidate('Mookie Betts')])
      expect(state.ended).equals(true)
      await act(async () => {
        state.loadMore()
      })
      expect(fake.asks).has.length(2)
    })

    it('takes no signal as no failure, and asks nothing offline', async () => {
      const fake = await openFirst()
      await fail(fake.last(), new HttpError('offline', 'No connection'))
      expect(state.error).equals(undefined)
      expect(state.ended).equals(true)
      expect(state.rows).has.length(2)
      await act(async () => {
        fake.offline = true
      })
      expect(state.offline).equals(false)
      expect(state.rows).has.length(2)
      expect(state.loading).equals(false)
      await show(fake, 'sho', undefined, true)
      await settle()
      expect(fake.asks).has.length(1)
      expect(state.rows.map(row => row.shortName)).deep.equals(['Shohei O'])
      // A refusal is still one.
      await act(async () => {
        fake.offline = false
      })
      await fail(fake.last(), new HttpError('forbidden', 'Not yours'))
      expect(state.error).equals('Not yours')
    })

    it('lists what this session found for the team at once where the client keeps no file', async () => {
      const fake = new FakeCandidateClient()
      timers = heldTimers(500)
      root = createRoot(document.createElement('div'))
      await show(fake, '', undefined, true)
      expect(state.rows).deep.equals([])
      expect(state.loading).equals(true)
      await answer(fake.last(), page(3))
      await act(async () => {
        root!.unmount()
      })
      // Opened again: the people found a moment ago, before any answer.
      root = createRoot(document.createElement('div'))
      await show(fake, '', undefined, true)
      expect(state.rows.map(row => row.shortName)).deep.equals(
        page(3).map(row => row.shortName)
      )
      expect(state.loading).equals(false)
      expect(fake.asks).has.length(2)
      // Another client's session finds none of them.
      await act(async () => {
        root!.unmount()
      })
      root = createRoot(document.createElement('div'))
      await show(new FakeCandidateClient(), '', undefined, true)
      expect(state.rows).deep.equals([])
    })

    it('matches a query word by word at the start of a name', () => {
      const mookie = candidate('Mookie Betts')
      expect(candidateMatches(mookie, '')).equals(true)
      expect(candidateMatches(mookie, 'moo')).equals(true)
      expect(candidateMatches(mookie, 'MOOKIE b')).equals(true)
      expect(candidateMatches(mookie, 'ookie')).equals(false)
      expect(candidateMatches(mookie, 'moo x')).equals(false)
    })
  })
})
