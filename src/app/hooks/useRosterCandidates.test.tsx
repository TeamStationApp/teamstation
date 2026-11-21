import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  type FoundRosterCandidate,
  ROSTER_CANDIDATE_MAX,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  candidate,
  type CandidateAsk,
  candidateResult,
  FakeCandidateClient,
  FakeCandidateSearch,
  page
} from '../../test/fakeCandidateClient'
import { heldTimers } from '../../test/fakeScreenScope'
import {
  type SearchSocketFactory,
  SearchSocketFactoryContext
} from './searchSocketFactory'
import {
  candidateMatches,
  type KeptCandidate,
  rosterCandidateOf,
  type RosterCandidates,
  useRosterCandidates,
  withMatched
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

/** The socket factory the probe is given; none asks over HTTP. */
let factory: SearchSocketFactory | undefined

async function show(
  fake: FakeCandidateClient,
  query: string,
  gameId?: string,
  cacheFirst?: boolean
): Promise<void> {
  await act(async () => {
    root!.render(
      <SearchSocketFactoryContext.Provider value={factory}>
        <Probe
          client={fake.client}
          query={query}
          gameId={gameId}
          cacheFirst={cacheFirst}
        />
      </SearchSocketFactoryContext.Provider>
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
  rows: FoundRosterCandidate[]
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

function Excluding({ client }: { client: TeamStationClient }): null {
  state = useRosterCandidates({
    client,
    teamId: 'tem_falcons',
    query: '',
    excluded: new Set([candidate('Mookie Betts').userId])
  })
  return null
}

describe('useRosterCandidates', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    timers?.restore()
    timers = undefined
    factory = undefined
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
    // As many as the search socket answers.
    expect(fake.last().limit).equals(ROSTER_CANDIDATE_MAX)
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

  it('shows the first 50 of a longer answer over HTTP, as its notice says', async () => {
    const fake = await open()
    expect(fake.last().limit).equals(ROSTER_CANDIDATE_MAX)
    await answer(fake.last(), page(60))
    expect(state.rows).has.length(ROSTER_CANDIDATE_MAX)
    expect(state.capped).equals(true)
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

  describe('over the search socket', function () {
    /** Lets the fake sockets open and answer: they do so on the next tick. */
    async function tick(): Promise<void> {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    const openSocket = async (
      server = new FakeCandidateSearch(),
      {
        fake = new FakeCandidateClient(),
        query = '',
        gameId,
        cacheFirst
      }: {
        fake?: FakeCandidateClient
        query?: string
        gameId?: string
        cacheFirst?: boolean
      } = {}
    ): Promise<{ server: FakeCandidateSearch; fake: FakeCandidateClient }> => {
      factory = server.factory
      root = createRoot(document.createElement('div'))
      await show(fake, query, gameId, cacheFirst)
      await tick()
      return { server, fake }
    }

    it('asks the engine for people on every change, with no pause, and never over HTTP', async () => {
      const { server, fake } = await openSocket(undefined, {
        gameId: 'gam_one'
      })
      expect(server.made).has.length(1)
      expect(server.made[0].url).equals('wss://api.example.test/api/v1/search')
      expect(server.frames.map(frame => frame.text)).deep.equals([''])
      expect(server.last).to.include({
        type: 'search',
        mode: 'people',
        forTeam: 'tem_falcons',
        forGame: 'gam_one',
        location: null
      })
      expect(state.loading).equals(true)
      for (const typed of ['B', 'Be', 'Bet', 'Betts '])
        await show(fake, typed, 'gam_one')
      // One frame a keystroke, at once: no timer stands between them.
      expect(server.frames.map(frame => frame.text)).deep.equals([
        '',
        'B',
        'Be',
        'Bet',
        'Betts'
      ])
      expect(state.query).equals('Betts')
      await act(async () => {
        server.replyCandidates([candidate('Mookie Betts')])
      })
      expect(state.rows.map(row => row.shortName)).deep.equals(['Mookie B'])
      expect(state.loading).equals(false)
      expect(state.updating).equals(false)
      expect(fake.asks).has.length(0)
    })

    it('draws each answer as the card the route answers, and Jev’s replaces the first', async () => {
      const { server, fake } = await openSocket(undefined, { query: 'b' })
      const betts = candidate('Mookie Betts', {
        gumboId: 7,
        shortName: 'Mookie Betts',
        nameFormat: 'full',
        compactName: 'M B',
        compactFormat: 'initials',
        bats: 'right',
        throws: 'right',
        teams: [{ teamId: 'tem_owls', name: 'Demo Owls' }],
        affiliations: 'Demo Owls',
        tier: 'season'
      })
      const bellinger = candidate('Cody Bellinger', { tier: 'league' })
      await act(async () => {
        server.replyCandidates([bellinger, betts])
      })
      expect(state.rows).deep.equals([bellinger, betts])
      await act(async () => {
        server.replyCandidates([betts, bellinger], { stage: 'jev' })
      })
      expect(state.rows).deep.equals([betts, bellinger])
      // Each answer is kept, for this session and for the phone's file.
      expect(fake.keeps.map(keep => keep.teamId)).deep.equals([
        'tem_falcons',
        'tem_falcons'
      ])
      expect(fake.keeps[1].rows).deep.equals([betts, bellinger])
      // Rows that carry no card are no candidates.
      expect(
        rosterCandidateOf({
          kind: 'team',
          id: 'tem_owls',
          name: 'Demo Owls',
          imageUrl: null,
          cityLine: null,
          associations: '',
          follow: null
        })
      ).equals(null)
      const { roster: _roster, ...bare } = candidateResult(betts)
      expect(rosterCandidateOf(bare)).equals(null)
    })

    it('keeps with each answered person only the typed words that found him', async () => {
      const { server, fake } = await openSocket(undefined, {
        query: 'José Smith'
      })
      // "smith" found Jane, "jose" found José; neither found the other.
      const jane = candidate('Jane Smithson')
      const jose = candidate('José Abreu')
      const nobody = candidate('Max Fried')
      await act(async () => {
        server.reply({
          results: [
            candidateResult(jane, ['smith']),
            candidateResult(jose, ['jose']),
            candidateResult(nobody)
          ]
        })
      })
      expect(state.rows).deep.equals([jane, jose, nobody])
      expect(fake.keeps[0].rows).deep.equals([
        { ...jane, matched: ['smith'] },
        { ...jose, matched: ['josé'] },
        nobody
      ])
      // Later, before the server answers, "josé" lists José only.
      await act(async () => {
        root!.unmount()
      })
      fake.kept.tem_falcons = fake.keeps[0].rows
      const later = new FakeCandidateSearch()
      later.online = false
      await openSocket(later, { fake, query: 'josé', cacheFirst: true })
      await act(async () => {
        await Promise.resolve()
      })
      expect(state.rows.map(row => row.shortName)).deep.equals(['José A'])
      await show(fake, 'smith', undefined, true)
      expect(state.rows.map(row => row.shortName)).deep.equals(['Jane S'])
      expect(withMatched(jane, 'smith-jones x', ['smith', 'x'])).deep.equals({
        ...jane,
        matched: ['x']
      })
      expect(withMatched(jane, 'Jane S', ['jane', 's'])).deep.equals({
        ...jane,
        matched: ['jane', 's']
      })
      expect(withMatched(jane, 'Jane S', [])).deep.equals(jane)
    })

    it('shows no row of an older query while the new one is unanswered (#210)', async () => {
      const kept = [candidate('Mookie Betts'), candidate('Shohei Ohtani')]
      const fake = new FakeCandidateClient()
      fake.kept.tem_falcons = kept
      const { server } = await openSocket(undefined, {
        fake,
        query: 'sho',
        cacheFirst: true
      })
      const shoFrame = server.last!
      await act(async () => {
        server.replyCandidates([
          candidate('Shohei Ohtani'),
          candidate('Shota Imanaga')
        ])
      })
      expect(state.rows.map(row => row.shortName)).deep.equals([
        'Shohei O',
        'Shota I'
      ])
      // Typed on: until "mook" is answered, only the phone's kept people
      // that match it are listed, nobody the "sho" answer found.
      await show(fake, 'mook', undefined, true)
      expect(state.rows.map(row => row.shortName)).deep.equals(['Mookie B'])
      expect(state.updating).equals(true)
      // A late answer for "sho" never lands: the socket drops its seq.
      await act(async () => {
        server.replyCandidates([candidate('Shota Imanaga')], {
          frame: shoFrame
        })
      })
      expect(state.rows.map(row => row.shortName)).deep.equals(['Mookie B'])
      await act(async () => {
        server.replyCandidates([candidate('Mookie Betts')])
      })
      expect(state.rows.map(row => row.shortName)).deep.equals(['Mookie B'])
      expect(state.updating).equals(false)
      // Not cache first, nothing at all is listed before the answer.
      await act(async () => {
        root!.unmount()
      })
      const plain = await openSocket(undefined, { query: 'sho' })
      await act(async () => {
        plain.server.replyCandidates([candidate('Shota Imanaga')])
      })
      expect(state.rows).has.length(1)
      await show(plain.fake, 'mook')
      expect(state.rows).deep.equals([])
      expect(state.loading).equals(true)
    })

    it('lists the phone’s kept people offline, and asks again once back', async () => {
      const fake = new FakeCandidateClient()
      fake.kept.tem_falcons = [
        candidate('Mookie Betts'),
        candidate('Shohei Ohtani')
      ]
      const server = new FakeCandidateSearch()
      server.online = false
      await openSocket(server, { fake, cacheFirst: true })
      await act(async () => {
        await Promise.resolve()
      })
      expect(state.offline).equals(false)
      expect(state.loading).equals(false)
      expect(state.updating).equals(false)
      expect(state.error).equals(undefined)
      expect(state.rows.map(row => row.shortName)).deep.equals([
        'Mookie B',
        'Shohei O'
      ])
      await show(fake, 'moo', undefined, true)
      expect(state.rows.map(row => row.shortName)).deep.equals(['Mookie B'])
      expect(fake.asks).has.length(0)
      // Back: the socket opens again and asks what is typed now.
      server.online = true
      server.answer = () => ({
        results: [candidateResult(candidate('Mookie Wilson'))]
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 1100))
      })
      await tick()
      expect(server.last?.text).equals('moo')
      expect(state.rows.map(row => row.shortName)).deep.equals([
        'Mookie W',
        'Mookie B'
      ])
    })

    it('says a search needs a connection where nothing is kept', async () => {
      const server = new FakeCandidateSearch()
      const { fake } = await openSocket(server, { query: 'moo' })
      await act(async () => {
        server.disconnect()
      })
      expect(state.offline).equals(true)
      expect(state.loading).equals(false)
      expect(state.rows).deep.equals([])
      expect(fake.asks).has.length(0)
    })

    it('shows a refusal, asks again on retry, and says when the answer is full', async () => {
      const { server } = await openSocket()
      await act(async () => {
        server.refuse('forbidden', 'Only a roster manager may add players')
      })
      expect(state.error).equals('Only a roster manager may add players')
      expect(state.loading).equals(false)
      await act(async () => {
        state.retry()
      })
      expect(server.frames).has.length(2)
      expect(state.error).equals(undefined)
      expect(state.loading).equals(true)
      await act(async () => {
        server.replyCandidates(page(ROSTER_CANDIDATE_MAX))
      })
      expect(state.rows).has.length(ROSTER_CANDIDATE_MAX)
      expect(state.capped).equals(true)
      await act(async () => {
        server.replyCandidates(page(ROSTER_CANDIDATE_MAX - 1), { stage: 'jev' })
      })
      expect(state.capped).equals(false)
    })

    it('fails as the route’s 401 does once the server closes for a refused session, and asks again with a new sign-in', async () => {
      const fake = new FakeCandidateClient()
      fake.token = 'tok_dead'
      const { server } = await openSocket(undefined, { fake, query: 'moo' })
      await act(async () => {
        server.replyCandidates([candidate('Mookie Betts')])
      })
      expect(state.rows).has.length(1)
      await act(async () => {
        server.signOut()
      })
      expect(fake.refusedSessions).equals(1)
      expect(state.error).equals('Sign in to continue')
      expect(state.loading).equals(false)
      expect(state.offline).equals(false)
      expect(state.rows).deep.equals([])
      const sockets = server.sockets.length
      // Signed in again: the socket connects with the new token and asks.
      fake.token = 'tok_new'
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 1100))
      })
      expect(server.sockets.length).equals(sockets + 1)
      await act(async () => {
        server.replyCandidates([candidate('Mookie Betts')])
      })
      expect(state.error).equals(undefined)
      expect(state.rows).has.length(1)
      expect(fake.asks).has.length(0)
    })

    it('lists nobody already on the roster or in the game', async () => {
      const server = new FakeCandidateSearch(() => [
        candidate('Mookie Betts'),
        candidate('Aaron Judge')
      ])
      factory = server.factory
      const fake = new FakeCandidateClient()
      root = createRoot(document.createElement('div'))
      await act(async () => {
        root!.render(
          <SearchSocketFactoryContext.Provider value={factory}>
            <Excluding client={fake.client} />
          </SearchSocketFactoryContext.Provider>
        )
      })
      await tick()
      await tick()
      expect(state.rows.map(row => row.shortName)).deep.equals(['Aaron J'])
    })

    it('asks over HTTP where no socket can be made', async () => {
      factory = () => {
        throw new Error('This platform has no WebSocket')
      }
      timers = heldTimers(500)
      root = createRoot(document.createElement('div'))
      const fake = new FakeCandidateClient()
      await show(fake, '')
      await act(async () => {
        await Promise.resolve()
      })
      expect(fake.asks).has.length(1)
      await answer(fake.last(), page(2))
      expect(state.rows).has.length(2)
    })
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

    it('matches a kept person by the words of a search that found him, which his short name hides', () => {
      // The server found "Jordan Q" for "Quill": his last name starts so.
      const jordan = { ...candidate('Jordan Quillfeather'), matched: ['quill'] }
      expect(
        candidateMatches(candidate('Jordan Quillfeather'), 'Quill')
      ).equals(false)
      expect(candidateMatches(jordan, 'Quill')).equals(true)
      expect(candidateMatches(jordan, 'qui')).equals(true)
      expect(candidateMatches(jordan, 'jor QUILL')).equals(true)
      // A longer word than the server matched is not known to match.
      expect(candidateMatches(jordan, 'quillf')).equals(false)
      expect(candidateMatches(jordan, 'quill x')).equals(false)
    })

    it('finds offline, by the search that found him, a person the phone kept', async () => {
      const fake = new FakeCandidateClient()
      // As the phone stored him: his search words beside his row.
      const jordan: KeptCandidate = {
        ...candidate('Jordan Quillfeather'),
        matched: ['quill']
      }
      fake.kept.tem_falcons = [jordan, ...kept]
      fake.offline = true
      timers = heldTimers(500)
      root = createRoot(document.createElement('div'))
      await show(fake, 'Quill', undefined, true)
      await act(async () => {
        await Promise.resolve()
      })
      await settle()
      expect(fake.asks).has.length(0)
      expect(state.rows.map(row => row.shortName)).deep.equals(['Jordan Q'])
      // Listed as the server lists him: no search words on the row.
      expect(state.rows[0]).not.has.property('matched')
    })

    it('keeps with each person the route found only the typed words that found him', async () => {
      const fake = new FakeCandidateClient()
      timers = heldTimers(500)
      root = createRoot(document.createElement('div'))
      await show(fake, 'John Smith', undefined, true)
      await act(async () => {
        await Promise.resolve()
      })
      await settle()
      // The route keeps a person any one typed word found.
      const john = candidate('John Smithson')
      const jane = candidate('Jane Smith')
      await answer(fake.last(), [
        { ...john, matched: ['john', 'smith'] },
        { ...jane, matched: ['smith'] }
      ])
      // Listed as the route lists them: no search words on the rows.
      expect(state.rows.map(row => row.shortName)).deep.equals([
        'John S',
        'Jane S'
      ])
      expect(state.rows[0]).not.has.property('matched')
      await act(async () => {
        root!.unmount()
      })
      // Later, with no signal: "john" finds John only, "smith" both.
      fake.offline = true
      for (const [typed, names] of [
        ['john', ['John S']],
        ['smith', ['John S', 'Jane S']]
      ] as const) {
        root = createRoot(document.createElement('div'))
        await show(fake, typed, undefined, true)
        await act(async () => {
          await Promise.resolve()
        })
        await settle()
        expect(
          state.rows.map(row => row.shortName),
          typed
        ).deep.equals(names)
        await act(async () => {
          root!.unmount()
        })
      }
      expect(fake.asks).has.length(1)
    })

    it('keeps this session’s search words with what it found, beside the phone’s', async () => {
      const fake = new FakeCandidateClient()
      const jordan: KeptCandidate = {
        ...candidate('Jordan Quillfeather'),
        matched: ['jor']
      }
      fake.kept.tem_falcons = [jordan]
      timers = heldTimers(500)
      root = createRoot(document.createElement('div'))
      await show(fake, 'Quill', undefined, true)
      await act(async () => {
        await Promise.resolve()
      })
      await settle()
      await answer(fake.last(), [
        { ...candidate('Jordan Quillfeather'), matched: ['quill'] }
      ])
      await act(async () => {
        root!.unmount()
      })
      // Opened again with no signal: found by either search's words.
      fake.offline = true
      for (const typed of ['Quill', 'jor']) {
        root = createRoot(document.createElement('div'))
        await show(fake, typed, undefined, true)
        await act(async () => {
          await Promise.resolve()
        })
        await settle()
        expect(
          state.rows.map(row => row.shortName),
          typed
        ).deep.equals(['Jordan Q'])
        await act(async () => {
          root!.unmount()
        })
      }
      expect(fake.asks).has.length(1)
    })
  })
})
