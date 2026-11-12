import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  ROSTER_CANDIDATE_MAX,
  type RosterCandidate,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  candidate,
  type CandidateAsk,
  FakeCandidateClient,
  page
} from '../../test/fakeCandidateClient'
import { heldTimers } from '../../test/fakeScreenScope'
import {
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

  it('asks once per search, and draws the answer whole', async () => {
    const fake = await open(undefined, 'gam_one')
    expect(fake.asks).has.length(1)
    expect(fake.last()).to.include({
      teamId: 'tem_falcons',
      gameId: 'gam_one',
      q: '',
      // It tells the server it shows when the answer is full.
      capped: true
    })
    expect(fake.last()).not.have.property('after')
    expect(fake.last().limit).equals(undefined)
    expect(state.loading).equals(true)
    await answer(fake.last(), page(40))
    expect(state.loading).equals(false)
    expect(state.updating).equals(false)
    expect(state.rows).has.length(40)
    expect(state.capped).equals(false)
    // Nothing more is asked for the same search.
    await show(fake, '', 'gam_one')
    await settle()
    expect(fake.asks).has.length(1)
  })

  it('says a full answer may hold more, and typing more narrows it', async () => {
    const fake = await open()
    await answer(fake.last(), page(ROSTER_CANDIDATE_MAX))
    expect(state.rows).has.length(ROSTER_CANDIDATE_MAX)
    expect(state.capped).equals(true)
    await show(fake, 'Player1')
    await settle()
    expect(state.capped).equals(false)
    await answer(fake.last(), page(ROSTER_CANDIDATE_MAX - 1))
    expect(state.capped).equals(false)
  })

  it("shows the server's message for a refused search, and asks again on retry", async () => {
    const fake = await open()
    await fail(fake.last(), new HttpError('forbidden', 'Not found'))
    expect(state.error).equals('Not found')
    expect(state.rows).deep.equals([])
    expect(state.loading).equals(false)
    await act(async () => {
      state.retry()
    })
    expect(fake.asks).has.length(2)
    expect(fake.last().q).equals('')
    expect(state.loading).equals(true)
    expect(state.error).equals(undefined)
    await answer(fake.last(), page(3))
    expect(state.rows).has.length(3)
  })

  it('says a failure it cannot name plainly', async () => {
    const fake = await open()
    await fail(fake.last(), new Error('socket hang up'))
    expect(state.error).equals('Unable to load players. Please try again.')
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

  it('drops an older answer that arrives last, and returns to the unfiltered search when cleared', async () => {
    const fake = await open()
    const unfiltered = fake.last()
    await show(fake, 'Betts')
    await settle()
    const betts = fake.last()
    await answer(betts, [candidate('Mookie Betts')])
    await answer(unfiltered, page(30))
    await fail(unfiltered, new Error('late'))
    expect(state.rows.map(row => row.shortName)).deep.equals(['Mookie B'])
    expect(state.error).equals(undefined)

    await show(fake, '')
    await settle()
    expect(fake.asks).has.length(3)
    expect(fake.last().q).equals('')
    expect(state.rows).deep.equals([])
    await answer(fake.last(), page(5))
    expect(state.rows).has.length(5)
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
    const kept = [candidate('Mookie Betts'), candidate('Shohei Ohtani')]
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

    it('lists the kept people at once, then the server’s first and the rest of the phone’s', async () => {
      const fake = await openFirst()
      expect(state.rows.map(row => row.shortName)).deep.equals([
        'Mookie B',
        'Shohei O'
      ])
      expect(state.loading).equals(false)
      expect(state.updating).equals(true)
      await answer(fake.last(), [candidate('Shohei Ohtani'), ...page(2)])
      expect(state.updating).equals(false)
      expect(state.rows.map(row => row.shortName)).deep.equals([
        'Shohei O',
        'Player0 O',
        'Player1 O',
        'Mookie B'
      ])
      expect(fake.asks).has.length(1)
    })

    it('takes no signal as no failure, and asks nothing offline', async () => {
      const fake = await openFirst()
      await fail(fake.last(), new HttpError('offline', 'No connection'))
      expect(state.error).equals(undefined)
      expect(state.updating).equals(false)
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

    it('finds a row by the surname of the full name it carries', async () => {
      // Read in full, the row's name is the full one; its parts stay public.
      const full = candidate('Josh Smith', {
        shortName: 'Josh Smith',
        compactName: 'Josh S',
        affiliations: 'Guardians: Ken G · Demo Hawks'
      })
      const short = candidate('Josh Staumont')
      expect(full.shortParts).deep.equals({ first: 'Josh', last: 'S' })
      expect(candidateMatches(full, 'smith')).equals(true)
      expect(candidateMatches(full, 'josh smi')).equals(true)
      // A public row carries no surname to match.
      expect(candidateMatches(short, 'staumont')).equals(false)
      expect(candidateMatches(short, 'josh s')).equals(true)
      // The kept rows are listed by that match while the server is asked.
      const fake = new FakeCandidateClient()
      fake.kept.tem_falcons = [full, short]
      timers = heldTimers(500)
      root = createRoot(document.createElement('div'))
      await show(fake, 'Smith', undefined, true)
      await act(async () => {
        await Promise.resolve()
      })
      expect(state.rows.map(row => row.shortName)).deep.equals(['Josh Smith'])
      expect(state.rows[0].affiliations).equals('Guardians: Ken G · Demo Hawks')
    })
  })
})
