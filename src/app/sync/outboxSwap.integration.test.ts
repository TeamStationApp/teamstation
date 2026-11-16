import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { REQUEST_DEADLINE_MS } from '../../common/api'
import { ScoringSession } from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { addGame, addScorableTeams } from '../../test/scoreboardKit'
import { seedSettingsCleanup3 } from '../../test/settingsCleanup3Fixture'
import { cacheFileName, openCacheStore } from './cacheStore'
import { CachingClient } from './cachingClient'

/**
 * A phone with a save of plays on its way and another queued behind it,
 * when another device's swap (or reset and swap) of the game is accepted
 * first (#260): against the real server, the save on its way reaches it
 * after the swap and is refused, the queued one is given up and never sent,
 * and the server holds no play or lineup of the old sides under the new.
 */

interface Post {
  path: string
  status: number
}

/** A phone whose posts of plays wait at `gate` while it is shut. */
function phoneOn(
  f: GroupFixture,
  dir: string
): {
  client: CachingClient
  posts: Post[]
  shut: () => void
  open: () => void
  waiting: () => number
  /** Runs the queue's timers of `ms` it set and has not cleared. */
  run: (ms: number) => void
  /**
   * From now on a post of plays reaches the server and commits, and its
   * answer is held from the phone until `answer`.
   */
  holdAnswers: () => void
  answer: () => void
} {
  const posts: Post[] = []
  let gate: Promise<void> | undefined
  let opened: () => void = () => undefined
  let waiting = 0
  let answers: Promise<void> | undefined
  let answered: () => void = () => undefined
  const timers: Array<{ run: () => void; ms: number; cleared?: true }> = []
  const fetchThrough = (async (url: string, init: RequestInit) => {
    const path = url.replace(`${f.h.origin}/api/v1`, '').split('?')[0]
    if (init.method === 'POST' && path.endsWith('/events') && gate != null) {
      waiting++
      await gate
      waiting--
    }
    const response = await fetch(url, init)
    if (init.method === 'POST') posts.push({ path, status: response.status })
    if (init.method === 'POST' && path.endsWith('/events') && answers != null)
      await answers
    return response
  }) as unknown as typeof fetch
  const client = new CachingClient({
    baseUrl: `${f.h.origin}/api/v1`,
    token: f.h.tokens.get(101),
    fetch: fetchThrough,
    openCache: async userId =>
      await openCacheStore(
        nodeSqliteExecutor(join(dir, cacheFileName(userId)))
      ),
    // The queue's timers wait for the test, which runs them.
    outbox: {
      setTimer: (run, ms) => timers.push({ run, ms }),
      clearTimer: handle => {
        const timer = timers[Number(handle) - 1]
        if (timer != null) timer.cleared = true
      }
    }
  })
  client.openFor(userIdOfGumbo(101))
  return {
    client,
    posts,
    shut: () => {
      gate = new Promise<void>(resolve => {
        opened = resolve
      })
    },
    open: () => {
      gate = undefined
      opened()
    },
    waiting: () => waiting,
    holdAnswers: () => {
      answers = new Promise<void>(resolve => {
        answered = resolve
      })
    },
    answer: () => {
      answers = undefined
      answered()
    },
    run: ms => {
      for (const timer of timers)
        if (timer.ms === ms && timer.cleared !== true) {
          timer.cleared = true
          timer.run()
        }
    }
  }
}

describe("a phone's saves when another device's swap is accepted first (#260)", function () {
  this.timeout(60000)
  let f: GroupFixture
  let dir: string

  before(async () => {
    f = await groupFixture()
    await seedSettingsCleanup3(f)
    dir = mkdtempSync(join(tmpdir(), 'teamstation-outbox-swap-'))
  })
  after(async () => {
    rmSync(dir, { recursive: true, force: true })
    await f?.h.close()
  })

  it('answers a swap sent again under its key as it was answered, and never swaps it again after a swap back (3.harness-review.4)', async () => {
    const context = await addScorableTeams(f.h.db, {
      home: 'Herons',
      away: 'Terns'
    })
    const gameId = await addGame(f.h.db, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id,
      startAt: new Date()
    })
    const home = context.teams.home.id
    const away = context.teams.away.id
    const swap = async (
      key: string,
      sides: { homeTeamId: string; awayTeamId: string }
    ): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(
        `${f.h.origin}/api/v1/games/${gameId}/swap-sides`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${f.h.tokens.get(101)}`,
            'content-type': 'application/json',
            'idempotency-key': key
          },
          body: JSON.stringify(sides)
        }
      )
      return { status: response.status, body: await response.json() }
    }
    const sidesNow = async (): Promise<[string, string]> => {
      const row = await f.h.db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id'])
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      return [row.home_team_id, row.away_team_id]
    }
    const first = await swap('swap-once-1', {
      homeTeamId: home,
      awayTeamId: away
    })
    expect(first.status).equals(200)
    expect(await sidesNow()).deep.equals([away, home])
    // Another scorer swaps it back.
    const back = await swap('swap-once-2', {
      homeTeamId: away,
      awayTeamId: home
    })
    expect(back.status).equals(200)
    expect(await sidesNow()).deep.equals([home, away])
    // The first phone sends its swap again after its deadline: told what it
    // was told, and the sides stay as the swap back left them.
    const again = await swap('swap-once-1', {
      homeTeamId: home,
      awayTeamId: away
    })
    expect(again).deep.equals(first)
    expect(await sidesNow()).deep.equals([home, away])
  })

  for (const { reset, stalled } of [
    { reset: false, stalled: false },
    { reset: true, stalled: false },
    { reset: false, stalled: true }
  ])
    it(`${stalled ? 'gives up the save on its way once the request deadline passes with no answer, and the one queued behind it' : 'refuses the save on its way, gives up the one queued behind it'}, and keeps nothing of the old sides (${reset ? 'reset and swap' : 'swap'})`, async () => {
      const context = await addScorableTeams(f.h.db, {
        home: 'Owls',
        away: 'Gulls'
      })
      const gameId = await addGame(f.h.db, {
        homeTeamId: context.teams.home.id,
        awayTeamId: context.teams.away.id,
        startAt: new Date()
      })
      const a = phoneOn(f, mkdtempSync(join(dir, 'phone-')))
      const b = phoneOn(f, mkdtempSync(join(dir, 'other-')))
      const open = async (client: CachingClient): Promise<ScoringSession> =>
        await ScoringSession.open(
          {
            load: async id => await client.gameEvents(id),
            save: async (id, change) => await client.saveGameEvents(id, change)
          },
          gameId,
          { gamePk: gameId, ...context },
          { setTimer: () => null, clearTimer: () => undefined }
        )
      if (reset) {
        // The other device begins the game: a swap of it resets it.
        const peer = await open(b.client)
        expect(peer.apply({ type: 'pitch', call: 'B' }).problems).deep.equals(
          []
        )
        await peer.flush()
        peer.close()
      }
      await a.client.game(gameId)
      await a.client.roster(context.teams.home.id)
      await a.client.roster(context.teams.away.id)
      await a.client.gameLineups(gameId)
      const ours = await open(a.client)
      const read = await a.client.gameEvents(gameId)

      // This phone's pitch is on its way; the link holds it.
      a.shut()
      expect(ours.apply({ type: 'pitch', call: 'C' }).problems).deep.equals([])
      const saving = ours.flush().then(
        () => undefined,
        (error: unknown) => error
      )
      for (let i = 0; i < 2000 && a.waiting() === 0; i++)
        await new Promise(resolve => setTimeout(resolve, 1))
      expect(a.waiting()).equals(1)
      // Another write of the game's, queued behind it on the phone.
      await a.client.saveGameEvents(gameId, {
        plays: [],
        remove: [],
        currentPlay: ours.state.liveData.plays.currentPlay as Parameters<
          CachingClient['saveGameEvents']
        >[1]['currentPlay'],
        scoringBase: read.scoringMutation ?? null,
        lineupsBase: read.lineupsDigest,
        ...(read.generation == null ? {} : { generation: read.generation })
      })
      expect((await a.client.outboxSummary()).count).equals(1)

      // The other device swaps the game, and the server takes it first.
      const before = await b.client.gameEvents(gameId)
      const stored = async (): Promise<{
        currentPlay: unknown
        lineups_digest: string | null
        home_team_id: string
      }> =>
        await f.h.db
          .selectFrom('games')
          .select(['currentPlay', 'lineups_digest', 'home_team_id'])
          .where('id', '=', gameId)
          .executeTakeFirstOrThrow()
      const unswapped = await stored()
      const swapped = await b.client.swapGameSides(gameId, {
        homeTeamId: context.teams.home.id,
        awayTeamId: context.teams.away.id,
        ...(reset
          ? { playsDigest: before.playsDigest, generation: before.generation }
          : {})
      })
      expect(swapped.homeTeamId).equals(context.teams.away.id)
      const swappedAt = a.posts.length

      // As the scoring screen does on its notice.
      ours.close()
      const given = a.client.giveUpGame(gameId)
      a.client.wakeOutbox(true)
      await a.client.drainOutbox()
      if (stalled) {
        // The link never answers: from the request deadline on, the save
        // on its way is not waited for. It is given up with the one behind
        // it, and its request aborted.
        a.run(REQUEST_DEADLINE_MS)
        // The server's copy read after shows it never took the one cut
        // off: its scoring is still what the save was built on.
        expect(await given).deep.equals({ lost: 2, unsure: 0 })
        await saving
        a.open()
        for (let i = 0; i < 2000 && a.waiting() > 0; i++)
          await new Promise(resolve => setTimeout(resolve, 1))
        await new Promise(resolve => setTimeout(resolve, 50))
      } else {
        a.open()
        expect(await given).deep.equals({ lost: 1, unsure: 0 })
        await saving
      }
      a.client.wakeOutbox(true)
      await a.client.drainOutbox()
      expect((await a.client.outboxSummary()).count).equals(0)

      // The save on its way reached the server after the swap: refused,
      // with its one retry of the full history. Nothing else was sent.
      // Aborted, it never reached the server.
      const after = a.posts
        .slice(swappedAt)
        .filter(post => post.path.endsWith('/events'))
      if (stalled) expect(after).deep.equals([])
      else expect(after.length).within(1, 2)
      expect(after.map(post => post.status)).satisfies((statuses: number[]) =>
        statuses.every(status => status === 409)
      )
      // The server holds nothing of the phone's: no play, no at-bat, and
      // the lineups the swap left.
      const held = await stored()
      expect(held.home_team_id).equals(context.teams.away.id)
      expect(held.lineups_digest).equals(swapped.lineupsDigest ?? null)
      const plays = await f.h.db
        .selectFrom('events')
        .select('id')
        .where('gameId', '=', gameId)
        .execute()
      expect(plays).deep.equals([])
      // Reset, the game has no at-bat; swapped only, the one it had.
      expect(held.currentPlay ?? null, 'no pitch of the old sides').deep.equals(
        reset ? null : (unswapped.currentPlay ?? null)
      )
    })

  it('does not say a save on its way the server committed was lost, though its answer came after the request deadline (9.harness-review.2)', async () => {
    const context = await addScorableTeams(f.h.db, {
      home: 'Herons',
      away: 'Terns'
    })
    const gameId = await addGame(f.h.db, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id,
      startAt: new Date()
    })
    const a = phoneOn(f, mkdtempSync(join(dir, 'phone-')))
    const b = phoneOn(f, mkdtempSync(join(dir, 'other-')))
    await a.client.game(gameId)
    await a.client.roster(context.teams.home.id)
    await a.client.roster(context.teams.away.id)
    await a.client.gameLineups(gameId)
    const ours = await ScoringSession.open(
      {
        load: async id => await a.client.gameEvents(id),
        save: async (id, change) => await a.client.saveGameEvents(id, change)
      },
      gameId,
      { gamePk: gameId, ...context },
      { setTimer: () => null, clearTimer: () => undefined }
    )
    const digest = async (): Promise<string | null> =>
      (
        await f.h.db
          .selectFrom('games')
          .select('lineups_digest')
          .where('id', '=', gameId)
          .executeTakeFirstOrThrow()
      ).lineups_digest
    const unsaved = await digest()

    // Before the first pitch, this phone's lineups reach the server and
    // commit; the answer is held on the link.
    a.holdAnswers()
    expect(
      ours.apply({
        type: 'lineup',
        kind: 'roster',
        setup: setupOf(ours.state),
        confirmed: ['away', 'home']
      }).problems
    ).deep.equals([])
    const saving = ours.flush().then(
      () => undefined,
      (error: unknown) => error
    )
    for (let i = 0; i < 2000 && a.posts.length === 0; i++)
      await new Promise(resolve => setTimeout(resolve, 1))
    expect(a.posts.map(post => post.status)).deep.equals([200])
    expect(await digest(), 'the lineups are on the server').not.equals(unsaved)

    // The other device swaps the game after it.
    const swapped = await b.client.swapGameSides(gameId, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id
    })
    expect(swapped.homeTeamId).equals(context.teams.away.id)

    // As the scoring screen does on its notice. The answer never comes in
    // time: the save is cut off at the request deadline. It was taken, so
    // it is not counted as lost; the server's copy cannot say so of a save
    // with no scoring identity, so it may have been kept.
    ours.close()
    const given = a.client.giveUpGame(gameId)
    a.client.wakeOutbox(true)
    await a.client.drainOutbox()
    a.run(REQUEST_DEADLINE_MS)
    expect(await given).deep.equals({ lost: 0, unsure: 1 })
    await saving
    a.answer()
    await new Promise(resolve => setTimeout(resolve, 50))
    a.client.wakeOutbox(true)
    await a.client.drainOutbox()
    expect((await a.client.outboxSummary()).count).equals(0)
    // Sent once, and nothing more.
    expect(a.posts.filter(post => post.path.endsWith('/events'))).length(1)
  })
})
