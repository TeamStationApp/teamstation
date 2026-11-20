import { expect } from 'chai'
import type { Kysely, KyselyPlugin } from 'kysely'
import { after, before, describe, it } from 'mocha'

import type { SearchAsk, SearchGroupResult } from '../../common/search/types'
import { type FakeJev, fakeJev } from '../../test/fakeJev'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { makeNonce } from '../dev/fixtures/accounts'
import { runSearch } from '../dev/fixtures/search'
import { type SearchDeps, searchJev, searchOnce } from './engine'
import { warmLocations } from './locations'
import { READER_CACHE_MS, type ReaderCache, readerCache } from './readerCache'

/**
 * How many queries a search reads, and how many of them wait on another:
 * the e2e `search` world, searched by its coach, signed in, in mode `all`.
 * Every query is slowed by `ROUND_TRIP_MS` after it answers, so the time a
 * search takes, in round trips, is its longest chain of queries that wait on
 * one another. `TS_QUERY_REPORT=1` prints what each search took.
 *
 * A search socket keeps what it reads about the reader alone
 * (`readerCache`): its first search reads it beside the rest (`cold`), a
 * second within `READER_CACHE_MS` reads none of it (`warm`). With no socket,
 * as Add Existing Player's route searches, every search reads it
 * (`uncached`). What is left of a search that finds people is naming the
 * people found (`readerNaming`) and their affiliation lines
 * (`personAffiliations`), read side by side, each a fixed number of reads
 * however many people are found.
 */

/** Each query's added wait, as a droplet's round trip to its database. */
const ROUND_TRIP_MS = 60

interface Bound {
  queries: number
  rounds: number
}

/**
 * Each search, whether it finds people, and the most queries and round
 * trips its lexicographic answer (`searchOnce`) and Jev's facts
 * (`searchJev`) may take.
 */
const CASES: Array<{
  text: string
  people: boolean
  uncached: Bound
  cold: Bound
  warm: Bound
  jev: Bound
}> = [
  {
    text: 'hawk ',
    people: true,
    uncached: { queries: 57, rounds: 21 },
    cold: { queries: 60, rounds: 21 },
    warm: { queries: 40, rounds: 10 },
    jev: { queries: 9, rounds: 5 }
  },
  {
    text: 'hawks ',
    people: false,
    uncached: { queries: 10, rounds: 5 },
    cold: { queries: 17, rounds: 5 },
    warm: { queries: 7, rounds: 4 },
    jev: { queries: 2, rounds: 3 }
  }
]

interface Counted {
  db: Kysely<Database>
  queries: () => number
}

/** `db`, counting each query it answers and slowing each by `delayMs`. */
function counted(db: Kysely<Database>, delayMs: number): Counted {
  let queries = 0
  const plugin: KyselyPlugin = {
    transformQuery: args => args.node,
    transformResult: async args => {
      queries++
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return args.result
    }
  }
  return {
    db: db.withPlugin(plugin),
    queries: () => queries
  }
}

describe('search engine queries', function () {
  this.timeout(120000)

  let f: GroupFixture
  let jev: FakeJev
  let deps: SearchDeps
  let coach: Actor
  let nonce: string

  before(async function () {
    // The server warms its place catalog at startup. Measure database waits
    // with that index ready and each test's per-reader cache still cold.
    await warmLocations()
    f = await groupFixture()
    jev = await fakeJev()
    deps = {
      space: f.h.space,
      log: () => undefined,
      jevBaseUrl: jev.baseUrl
    }
    nonce = makeNonce()
    const world = await runSearch({
      db: f.h.db,
      mailbox: 'testmailbox@example.test',
      nonce
    })
    coach = {
      userId: world.accounts.coach.userId,
      isAdmin: false,
      scopes: []
    }
  })

  after(async function () {
    await jev.close()
    await f.h.close()
  })

  const ask = (text: string, more: Partial<SearchAsk> = {}): SearchAsk => ({
    text,
    location: null,
    mode: 'all',
    ...more
  })

  /** The queries a search reads and the round trips it waits, in turn. */
  async function measure(
    run: (db: Kysely<Database>) => Promise<unknown>
  ): Promise<{ queries: number; rounds: number }> {
    const counter = counted(f.h.db, ROUND_TRIP_MS)
    const started = Date.now()
    await run(counter.db)
    const rounds = Math.floor((Date.now() - started) / ROUND_TRIP_MS)
    return { queries: counter.queries(), rounds }
  }

  const peopleIn = (answer: Awaited<ReturnType<typeof searchOnce>>): string[] =>
    answer.results.flatMap(result =>
      result.kind === 'person' ? [result.name] : []
    )

  const within = (measured: Bound, bound: Bound): void => {
    expect(measured.queries).lessThanOrEqual(bound.queries)
    expect(measured.rounds).lessThanOrEqual(bound.rounds)
  }

  for (const { text, people, uncached, cold, warm, jev } of CASES) {
    it(`"${text}<nonce>" signed in reads at most ${warm.queries} queries in ${warm.rounds} round trips once the socket keeps the reader's reads, ${cold.queries} in ${cold.rounds} before, ${uncached.queries} in ${uncached.rounds} with no socket, and Jev's facts ${jev.queries} in ${jev.rounds}`, async function () {
      const typed = ask(`${text}${nonce}`)
      let answer: Awaited<ReturnType<typeof searchOnce>> | undefined
      const none = await measure(async db => {
        answer = await searchOnce(db, coach, typed, deps)
      })
      const unkept = answer!
      const cache = readerCache()
      const socket: SearchDeps = { ...deps, reader: cache }
      const first = await measure(async db => {
        answer = await searchOnce(db, coach, typed, socket)
      })
      const read = cache.reads()
      const second = await measure(async db => {
        answer = await searchOnce(db, coach, typed, socket)
      })
      // The second search read nothing of the reader's again.
      expect(cache.reads()).equals(read)
      expect(peopleIn(answer!).length > 0).equals(people)
      expect(answer!.results).deep.equals(unkept.results)
      let ranked: unknown
      const ranking = await measure(async db => {
        ranked = await searchJev(db, coach, typed, answer!.context, socket)
      })
      expect(ranked).not.equals(null)
      if (process.env.TS_QUERY_REPORT === '1')
        console.log(
          `      searchOnce ${none.queries} queries, ${none.rounds} round trips with no socket; ${first.queries}, ${first.rounds} first on a socket; ${second.queries}, ${second.rounds} after; searchJev ${ranking.queries}, ${ranking.rounds}`
        )
      within(none, uncached)
      within(first, cold)
      within(second, warm)
      within(ranking, jev)
    })
  }

  /** A second search world, whose coach the next case changes. */
  async function otherCoach(): Promise<{ coach: Actor; nonce: string }> {
    const other = makeNonce()
    const world = await runSearch({
      db: f.h.db,
      mailbox: 'testmailbox@example.test',
      nonce: other
    })
    return {
      coach: {
        userId: world.accounts.coach.userId,
        isAdmin: false,
        scopes: []
      },
      nonce: other
    }
  }

  it(`keeps the reader's reads for ${READER_CACHE_MS / 1000} s: a membership taken away loses the people it found once they are that old`, async function () {
    const { coach: reader, nonce: other } = await otherCoach()
    let clock = 1_000_000
    const cache: ReaderCache = readerCache({ now: () => clock })
    const socket: SearchDeps = { ...deps, reader: cache }
    const typed = ask(`hawk ${other}`)
    const hawkins = (names: string[]): boolean =>
      names.some(name => name.includes('Hawkins'))
    expect(
      hawkins(peopleIn(await searchOnce(f.h.db, reader, typed, socket)))
    ).equals(true)
    const read = cache.reads()

    // The coach leaves every team and gives up every role.
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', reader.userId)
      .execute()
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', reader.userId)
      .execute()

    clock += READER_CACHE_MS - 1
    expect(
      hawkins(peopleIn(await searchOnce(f.h.db, reader, typed, socket)))
    ).equals(true)
    expect(cache.reads()).equals(read)

    clock += 1
    expect(
      peopleIn(await searchOnce(f.h.db, reader, typed, socket))
    ).deep.equals([])
    expect(cache.reads()).greaterThan(read)
  })

  it("keeps one reader's reads at a time, and none that failed", async function () {
    const cache = readerCache()
    const failing = f.h.db.withPlugin({
      transformQuery: () => {
        throw new Error('the database is gone')
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    let failed = false
    await cache
      .of(failing, coach)
      .scopes()
      .catch(() => {
        failed = true
      })
    expect(failed).equals(true)
    // The failed read was not kept: it is read again.
    const scopes = await cache.of(f.h.db, coach).scopes()
    expect(scopes.teamIds.size).greaterThan(0)
    expect(cache.reads()).equals(2)
    await cache.of(f.h.db, coach).scopes()
    expect(cache.reads()).equals(2)

    // Another reader, or the same one as an admin, starts again.
    const { coach: other } = await otherCoach()
    await cache.of(f.h.db, other).guarded()
    await cache.of(f.h.db, { ...other, isAdmin: true }).guarded()
    await cache.of(f.h.db, coach).scopes()
    expect(cache.reads()).equals(5)

    cache.clear()
    await cache.of(f.h.db, coach).scopes()
    expect(cache.reads()).equals(6)
  })

  it('shows a Follow made over REST on the next search, inside the cache window', async function () {
    const { coach: reader, nonce: other } = await otherCoach()
    const clock = 2_000_000
    const socket: SearchDeps = {
      ...deps,
      reader: readerCache({ now: () => clock })
    }
    const typed = ask(`desert hawks ${other}`)
    const desert = async (): Promise<SearchGroupResult | undefined> =>
      (await searchOnce(f.h.db, reader, typed, socket)).results.find(
        (result): result is SearchGroupResult =>
          result.kind === 'league' && result.name.startsWith('Desert Hawks')
      )
    const before = await desert()
    expect(before?.follow).equals('follow')

    // The reader taps Follow; the clock has not moved.
    await f.h.db
      .insertInto('follows')
      .values({
        user_id: reader.userId as never,
        group_type: 'league',
        group_id: before!.id
      })
      .execute()
    expect((await desert())?.follow).equals('following')

    await f.h.db
      .deleteFrom('follows')
      .where('user_id', '=', reader.userId as never)
      .execute()
    expect((await desert())?.follow).equals('follow')
  })
})
