import { randomBytes } from 'node:crypto'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { defaultSponsorSettings } from '../../common/nodeSettings'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import type { Database } from '../db/database'
import { mediaUrl } from './credits'
import { gameSponsorsFor } from './logos'
import {
  gameTracks,
  HALF_WAIT_MS,
  halfInningHook,
  noteHalfInnings,
  placeDueReels,
  placePregameReels,
  placeReel,
  PREGAME_GRACE_MS
} from './reels'

const SEC = 1000
const MIN = 60 * SEC
const DAY = 24 * 60 * MIN
const START = new Date('2027-05-01T18:00:00.000Z').getTime()

/** U20: reel placements before games and between half-innings. */
describe('U20 sponsor reel placements', function () {
  this.timeout(120000)
  let f: GroupFixture
  let keys = 0
  const key = (): string => `${++keys}`
  // Each test's games start on a day of their own, so one test's sweep never
  // sees another's games in its window.
  let days = 0
  const nextDay = (): number => START + ++days * DAY
  let userIds: string[] = []

  const league = async (): Promise<string> => {
    const id = `lea_reels_${key()}`
    await f.h.db.insertInto('leagues').values({ id, name: id }).execute()
    return id
  }
  /** A team of `players` players (at most twelve). */
  const team = async (
    leagueId: string | null,
    players = 0
  ): Promise<string> => {
    const id = `tem_reels_${key()}`
    await f.h.db
      .insertInto('teams')
      .values({
        id,
        name: id,
        league_id: leagueId,
        kind: 'full',
        created_from: 'manual'
      })
      .execute()
    if (players > 0)
      await f.h.db
        .insertInto('memberships')
        .values(
          userIds.slice(0, players).map(userId => ({
            id: makeId('membership'),
            user_id: userId,
            team_id: id,
            is_player: true,
            joined_at: new Date(START)
          }))
        )
        .execute()
    return id
  }
  const game = async (
    home: string,
    away: string,
    startAt: number
  ): Promise<string> => {
    const id = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date(startAt)
      })
      .execute()
    return id
  }
  /** A league's reel, 12 s long. */
  const reel = async (
    leagueId: string,
    position: number,
    values: Partial<{ allocation: number; used: number; active: boolean }> = {}
  ): Promise<{ id: string; mediaId: string; key: string }> => {
    const mediaId = makeId('sponsorMedia')
    const objectKey = `sponsors/${leagueId}/${mediaId}.mp4`
    await f.h.db
      .insertInto('sponsor_media')
      .values({
        id: mediaId,
        league_id: leagueId,
        purpose: 'reel',
        object_key: objectKey,
        content_type: 'video/mp4',
        bytes: 1000,
        sha256: randomBytes(32).toString('hex'),
        width: 640,
        height: 360,
        duration_ms: 12000,
        created_by: null
      })
      .execute()
    const id = makeId('sponsorReel')
    await f.h.db
      .insertInto('sponsor_reels')
      .values({
        id,
        league_id: leagueId,
        media_id: mediaId,
        name: `Reel ${position}`,
        allocation: values.allocation ?? 10,
        used: values.used ?? 0,
        active: values.active ?? true,
        position,
        duration_ms: 12000,
        accepted_at: new Date(START)
      })
      .execute()
    return { id, mediaId, key: objectKey }
  }
  /** A camera of the game, live unless said. */
  const video = async (
    gameId: string,
    status: 'live' | 'ready' = 'live',
    hidden = false
  ): Promise<string> => {
    const id = makeId('video')
    await f.h.db
      .insertInto('videos')
      .values({
        id,
        game_id: gameId,
        kind: 'live',
        title: 'Home Plate',
        storage: 'spaces',
        status,
        start_at: new Date(START),
        duration_sec: status === 'live' ? null : 600,
        hidden,
        space_secret: randomBytes(16).toString('hex'),
        created_at: new Date(START),
        updated_at: new Date(START)
      })
      .execute()
    return id
  }
  /** A stored play: the outs after it in its half, and whether it ends the inning by a marker. */
  const play = async (
    gameId: string,
    atBatIndex: number,
    inning: number,
    half: 'top' | 'bottom',
    outs: number
  ): Promise<void> => {
    await f.h.db
      .insertInto('events')
      .values({
        id: makeId('event'),
        gameId,
        battingTeamId: null,
        source: 'teamstation',
        gumbo: {
          about: {
            atBatIndex,
            inning,
            halfInning: half,
            startTime: null,
            endTime: null
          },
          result: {
            eventType: 'strikeout',
            awayScore: 0,
            homeScore: 0,
            rbi: 0
          },
          count: { balls: 0, strikes: 3, outs },
          playEvents: []
        },
        createdAt: new Date(START),
        updatedAt: new Date(START)
      })
      .execute()
  }
  /** Takes a play back, as a remove post does. */
  const undo = async (gameId: string, atBatIndex: number): Promise<void> => {
    await f.h.db
      .deleteFrom('events')
      .where('gameId', '=', gameId)
      .where('atBatIndex', '=', atBatIndex)
      .execute()
  }
  /** The three plays of a half: three outs. */
  const half = async (
    gameId: string,
    from: number,
    inning: number,
    which: 'top' | 'bottom'
  ): Promise<void> => {
    for (let out = 1; out <= 3; out++)
      await play(gameId, from + out - 1, inning, which, out)
  }
  const placements = async (
    gameId: string
  ): Promise<
    Array<{
      league_id: string
      reel_id: string | null
      media_id: string
      slot: string
      inning: number | null
      half: string | null
      startsAt: number
    }>
  > =>
    (
      await f.h.db
        .selectFrom('game_reel_placements')
        .select([
          'league_id',
          'reel_id',
          'media_id',
          'slot',
          'inning',
          'half',
          'starts_at'
        ])
        .where('game_id', '=', gameId)
        .orderBy('starts_at')
        .orderBy('league_id')
        .execute()
    ).map(({ starts_at: startsAt, ...row }) => ({
      ...row,
      startsAt: new Date(startsAt).getTime()
    }))
  const ends = async (
    gameId: string
  ): Promise<
    Array<{
      inning: number
      half: string
      at_bat_index: number
      state: string
      fadeAt: number | null
    }>
  > =>
    (
      await f.h.db
        .selectFrom('game_half_ends')
        .select(['inning', 'half', 'at_bat_index', 'state', 'fade_at'])
        .where('game_id', '=', gameId)
        .orderBy('inning')
        .orderBy('half', 'desc')
        .execute()
    ).map(({ fade_at: fadeAt, ...row }) => ({
      ...row,
      fadeAt: fadeAt == null ? null : new Date(fadeAt).getTime()
    }))
  const usedOf = async (reelId: string): Promise<number> =>
    (
      await f.h.db
        .selectFrom('sponsor_reels')
        .select('used')
        .where('id', '=', reelId)
        .executeTakeFirstOrThrow()
    ).used
  /** A same-league game of two teams, the home one with nine players, recorded live. */
  const liveGame = async (
    leagueId: string,
    startAt: number
  ): Promise<string> => {
    const gameId = await game(
      await team(leagueId, 9),
      await team(leagueId),
      startAt
    )
    await video(gameId)
    return gameId
  }

  before(async function () {
    f = await groupFixture()
    const now = new Date(START)
    const users = Array.from({ length: 12 }, (_, i) => 880001 + i)
    await insertFixtureUsers(
      f.h.db,
      users.map(id => ({
        id,
        display_name: `Player ${id}`,
        created_at: now,
        updated_at: now
      }))
    )
    userIds = (
      await f.h.db
        .selectFrom('users')
        .select('id')
        .where('display_name', 'like', 'Player 8800%')
        .orderBy('display_name')
        .execute()
    ).map(row => row.id)
    expect(userIds).has.length(12)
  })

  after(async function () {
    await f?.h.close()
  })

  describe('the tracks', function () {
    it('gives a same-league game one track of both teams, ready when either has nine players', async function () {
      const id = await league()
      const home = await team(id, 8)
      const away = await team(id, 9)
      const gameId = await game(home, away, nextDay())
      expect(await gameTracks(f.h.db, gameId)).deep.equals([
        { leagueId: id, teamIds: [home, away], ready: true }
      ])
    })

    it('gives an interleague game a track a league, each by its own team, and none for a team in no league', async function () {
      const american = await league()
      const national = await league()
      const yankees = await team(american, 10)
      const cubs = await team(national, 8)
      const gameId = await game(cubs, yankees, nextDay())
      expect(await gameTracks(f.h.db, gameId)).deep.equals(
        [
          { leagueId: american, teamIds: [yankees], ready: true },
          { leagueId: national, teamIds: [cubs], ready: false }
        ].sort((a, b) => a.leagueId.localeCompare(b.leagueId))
      )
      const nobody = await game(
        await team(null, 9),
        await team(null),
        nextDay()
      )
      expect(await gameTracks(f.h.db, nobody)).deep.equals([])
      expect(await gameTracks(f.h.db, 'gam_missing')).deep.equals([])
    })
  })

  describe('pre-game', function () {
    it('places a reel at the official start while the game is live, unscored and its sponsored team has nine players', async function () {
      const id = await league()
      const first = await reel(id, 1)
      const startAt = nextDay()
      const gameId = await liveGame(id, startAt)
      // Too early: more than a second before the start.
      expect(
        await placePregameReels(f.h.db, new Date(startAt - 2 * SEC))
      ).deep.equals([])
      // A second before it, the fade begins and the reel is placed for the start.
      expect(
        await placePregameReels(f.h.db, new Date(startAt - SEC))
      ).deep.equals([gameId])
      expect(await placements(gameId)).deep.equals([
        {
          league_id: id,
          reel_id: first.id,
          media_id: first.mediaId,
          slot: 'pregame',
          inning: null,
          half: null,
          startsAt: startAt
        }
      ])
      expect(await usedOf(first.id)).equals(1)
      // Once placed, never again.
      expect(await placePregameReels(f.h.db, new Date(startAt))).deep.equals([])
      expect(await usedOf(first.id)).equals(1)
    })

    it('places nothing for eight players, a scored play, or past the five minutes, and a second from now for a late stream', async function () {
      const id = await league()
      const only = await reel(id, 1)
      const startAt = nextDay()
      const eight = await game(await team(id, 8), await team(id, 8), startAt)
      await video(eight)
      const scored = await liveGame(id, startAt)
      await play(scored, 0, 1, 'top', 1)
      const late = await liveGame(id, startAt)
      expect(
        await placePregameReels(
          f.h.db,
          new Date(startAt + PREGAME_GRACE_MS + SEC)
        )
      ).deep.equals([])
      // A stream that starts three minutes late gets its reel a second from now.
      const now = startAt + 3 * MIN
      expect(await placePregameReels(f.h.db, new Date(now))).deep.equals([late])
      expect((await placements(late))[0]?.startsAt).equals(now + SEC)
      expect(await placements(eight)).deep.equals([])
      expect(await placements(scored)).deep.equals([])
      expect(await usedOf(only.id)).equals(1)
    })

    it('places only the ready track of an interleague game, each from its own league', async function () {
      const american = await league()
      const national = await league()
      const al = await reel(american, 1)
      await reel(national, 1)
      const startAt = nextDay()
      const gameId = await game(
        await team(national, 8),
        await team(american, 9),
        startAt
      )
      await video(gameId)
      await placePregameReels(f.h.db, new Date(startAt))
      expect(
        (await placements(gameId)).map(row => [row.league_id, row.reel_id])
      ).deep.equals([[american, al.id]])
    })

    it('places an interleague game’s second track once it is ready inside the five minutes, the first kept', async function () {
      const american = await league()
      const national = await league()
      const al = await reel(american, 1)
      const nl = await reel(national, 1)
      const startAt = nextDay()
      const cubs = await team(national, 8)
      const gameId = await game(cubs, await team(american, 9), startAt)
      await video(gameId)
      await placePregameReels(f.h.db, new Date(startAt - SEC))
      expect(
        (await placements(gameId)).map(row => [row.league_id, row.reel_id])
      ).deep.equals([[american, al.id]])
      // The Cubs' ninth player arrives two minutes after the start.
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userIds[8],
          team_id: cubs,
          is_player: true,
          joined_at: new Date(START)
        })
        .execute()
      const now = startAt + 2 * MIN
      expect(await placePregameReels(f.h.db, new Date(now))).deep.equals([
        gameId
      ])
      expect(
        (await placements(gameId))
          .map(row => [row.league_id, row.reel_id, row.startsAt])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      ).deep.equals(
        [
          [american, al.id, startAt],
          [national, nl.id, now + SEC]
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      )
      expect(await usedOf(al.id)).equals(1)
      // Both placed: nothing more.
      expect(await placePregameReels(f.h.db, new Date(now + SEC))).deep.equals(
        []
      )
      expect(await usedOf(nl.id)).equals(1)
    })

    it('places nothing without a live recording: none, a hidden camera, or one finished', async function () {
      const id = await league()
      await reel(id, 1)
      const startAt = nextDay()
      const none = await game(await team(id, 9), await team(id), startAt)
      const hidden = await game(await team(id, 9), await team(id), startAt)
      await video(hidden, 'live', true)
      const done = await game(await team(id, 9), await team(id), startAt)
      await video(done, 'ready')
      expect(await placePregameReels(f.h.db, new Date(startAt))).deep.equals([])
      for (const gameId of [none, hidden, done])
        expect(await placements(gameId)).deep.equals([])
    })

    it('takes no credits lock, and makes no credits row, for a league with no reel to place, however often it sweeps', async function () {
      const bare = await league()
      const spent = await league()
      await reel(spent, 1, { allocation: 1, used: 1 })
      const startAt = nextDay()
      const games = [
        await liveGame(bare, startAt),
        await liveGame(spent, startAt)
      ]
      for (let second = 0; second < 5; second++)
        expect(
          await placePregameReels(f.h.db, new Date(startAt + second * SEC))
        ).deep.equals([])
      for (const gameId of games)
        expect(await placements(gameId)).deep.equals([])
      // `placeReel`'s lock makes the row first: no row, no lock taken.
      expect(
        await f.h.db
          .selectFrom('league_sponsor_credits')
          .select('league_id')
          .where('league_id', 'in', [bare, spent])
          .execute()
      ).deep.equals([])
    })

    it('places once when two sweeps run at once', async function () {
      const id = await league()
      const only = await reel(id, 1)
      const startAt = nextDay()
      const gameId = await liveGame(id, startAt)
      await Promise.all([
        placePregameReels(f.h.db, new Date(startAt)),
        placePregameReels(f.h.db, new Date(startAt))
      ])
      expect(await placements(gameId)).has.length(1)
      expect(await usedOf(only.id)).equals(1)
    })
  })

  describe('half-innings', function () {
    it('waits nine seconds after an end, then places the reel ten seconds after it', async function () {
      const id = await league()
      const only = await reel(id, 1)
      const T = nextDay()
      const gameId = await liveGame(id, T - 10 * MIN)
      await half(gameId, 0, 1, 'top')
      expect(await noteHalfInnings(f.h.db, gameId, new Date(T))).deep.equals([
        { inning: 1, half: 'top', atBatIndex: 2 }
      ])
      expect(await ends(gameId)).deep.equals([
        {
          inning: 1,
          half: 'top',
          at_bat_index: 2,
          state: 'waiting',
          fadeAt: T + HALF_WAIT_MS
        }
      ])
      expect(await placeDueReels(f.h.db, new Date(T + 8 * SEC))).not.include(
        gameId
      )
      expect(await placeDueReels(f.h.db, new Date(T + 9 * SEC))).include(
        gameId
      )
      expect(await placements(gameId)).deep.equals([
        {
          league_id: id,
          reel_id: only.id,
          media_id: only.mediaId,
          slot: 'half',
          inning: 1,
          half: 'top',
          startsAt: T + 10 * SEC
        }
      ])
      expect((await ends(gameId))[0].state).equals('placed')
      expect(await usedOf(only.id)).equals(1)
    })

    it('drops the wait on an undo inside it, places again after a re-entry, and keeps a placement an undo comes after', async function () {
      const id = await league()
      const only = await reel(id, 1)
      const T = nextDay()
      const gameId = await liveGame(id, T - 10 * MIN)
      await half(gameId, 0, 1, 'top')
      await noteHalfInnings(f.h.db, gameId, new Date(T))
      // The third out taken back at T + 5 s.
      await undo(gameId, 2)
      await noteHalfInnings(f.h.db, gameId, new Date(T + 5 * SEC))
      expect(await ends(gameId)).deep.equals([])
      expect(await placeDueReels(f.h.db, new Date(T + 9 * SEC))).not.include(
        gameId
      )
      expect(await placements(gameId)).deep.equals([])
      expect(await usedOf(only.id)).equals(0)
      // Entered again at T + 20 s: a new end, placed at T + 30 s.
      await play(gameId, 2, 1, 'top', 3)
      await noteHalfInnings(f.h.db, gameId, new Date(T + 20 * SEC))
      expect((await ends(gameId))[0].fadeAt).equals(T + 29 * SEC)
      await placeDueReels(f.h.db, new Date(T + 29 * SEC))
      expect((await placements(gameId)).map(row => row.startsAt)).deep.equals([
        T + 30 * SEC
      ])
      // An undo after the placement changes nothing.
      await undo(gameId, 2)
      await noteHalfInnings(f.h.db, gameId, new Date(T + 40 * SEC))
      expect((await ends(gameId))[0].state).equals('placed')
      expect(await placements(gameId)).has.length(1)
      expect(await usedOf(only.id)).equals(1)
    })

    it('leaves the wait as it was through other writes inside it, so the reel still starts ten seconds after the end', async function () {
      const id = await league()
      await reel(id, 1)
      const T = nextDay()
      const gameId = await liveGame(id, T - 10 * MIN)
      await half(gameId, 0, 1, 'top')
      await noteHalfInnings(f.h.db, gameId, new Date(T))
      // A lineup save at T + 4 s and an approval at T + 6 s change no play.
      expect(
        await noteHalfInnings(f.h.db, gameId, new Date(T + 4 * SEC))
      ).deep.equals([])
      await noteHalfInnings(f.h.db, gameId, new Date(T + 6 * SEC))
      expect((await ends(gameId))[0].fadeAt).equals(T + 9 * SEC)
      await placeDueReels(f.h.db, new Date(T + 9 * SEC))
      expect((await placements(gameId)).map(row => row.startsAt)).deep.equals([
        T + 10 * SEC
      ])
    })

    it('takes a play an undo reopened as not over, until it closes again', async function () {
      const id = await league()
      await reel(id, 1)
      const T = nextDay()
      const gameId = await liveGame(id, T - 10 * MIN)
      await half(gameId, 0, 1, 'top')
      await noteHalfInnings(f.h.db, gameId, new Date(T))
      // The third out's play reopened: its row stays, and the game scores it again.
      await f.h.db
        .updateTable('games')
        .set({
          currentPlay: JSON.stringify({
            about: {
              atBatIndex: 2,
              inning: 1,
              halfInning: 'top',
              isComplete: false
            }
          })
        })
        .where('id', '=', gameId)
        .execute()
      await noteHalfInnings(f.h.db, gameId, new Date(T + 3 * SEC))
      expect(await ends(gameId)).deep.equals([])
      await f.h.db
        .updateTable('games')
        .set({ currentPlay: null })
        .where('id', '=', gameId)
        .execute()
      await noteHalfInnings(f.h.db, gameId, new Date(T + 4 * SEC))
      expect((await ends(gameId))[0].fadeAt).equals(T + 4 * SEC + HALF_WAIT_MS)
    })

    it('forgets a wait whose end is gone by the time it is due, though no write said so', async function () {
      const id = await league()
      const only = await reel(id, 1)
      const T = nextDay()
      const gameId = await liveGame(id, T - 10 * MIN)
      await half(gameId, 0, 1, 'top')
      await noteHalfInnings(f.h.db, gameId, new Date(T))
      await undo(gameId, 2)
      expect(await placeDueReels(f.h.db, new Date(T + 9 * SEC))).not.include(
        gameId
      )
      expect(await ends(gameId)).deep.equals([])
      expect(await usedOf(only.id)).equals(0)
    })

    it('skips for good an end with no live recording, even once one starts', async function () {
      const id = await league()
      await reel(id, 1)
      const T = nextDay()
      const gameId = await game(await team(id, 9), await team(id), T)
      await half(gameId, 0, 1, 'top')
      expect(await noteHalfInnings(f.h.db, gameId, new Date(T))).deep.equals([])
      expect((await ends(gameId))[0].state).equals('skipped')
      await video(gameId)
      await noteHalfInnings(f.h.db, gameId, new Date(T + 2 * SEC))
      expect(await ends(gameId)).deep.equals([
        {
          inning: 1,
          half: 'top',
          at_bat_index: 2,
          state: 'skipped',
          fadeAt: null
        }
      ])
      await placeDueReels(f.h.db, new Date(T + 20 * SEC))
      expect(await placements(gameId)).deep.equals([])
    })

    it('notes nothing for a game no reel can follow, and skips an end plays have followed once one can', async function () {
      const id = await league()
      const T = nextDay()
      const gameId = await liveGame(id, T - 30 * MIN)
      await half(gameId, 0, 1, 'top')
      expect(await noteHalfInnings(f.h.db, gameId, new Date(T))).deep.equals([])
      expect(await ends(gameId)).deep.equals([])
      // A reel used up is none either.
      const spent = await reel(id, 1, { allocation: 1, used: 1 })
      expect(await noteHalfInnings(f.h.db, gameId, new Date(T))).deep.equals([])
      expect(await ends(gameId)).deep.equals([])
      // A reel with broadcasts left, added once the bottom has begun: the top
      // ended plays ago.
      await f.h.db
        .updateTable('sponsor_reels')
        .set({ allocation: 5 })
        .where('id', '=', spent.id)
        .execute()
      await play(gameId, 3, 1, 'bottom', 1)
      expect(
        await noteHalfInnings(f.h.db, gameId, new Date(T + MIN))
      ).deep.equals([])
      expect((await ends(gameId)).map(row => row.state)).deep.equals([
        'skipped'
      ])
      // The bottom's own end waits.
      await play(gameId, 4, 1, 'bottom', 2)
      await play(gameId, 5, 1, 'bottom', 3)
      expect(
        await noteHalfInnings(f.h.db, gameId, new Date(T + 2 * MIN))
      ).deep.equals([{ inning: 1, half: 'bottom', atBatIndex: 5 }])
    })

    it('skips both halves one post completes, and waits only on the newest half a later write completes alone', async function () {
      const id = await league()
      await reel(id, 1)
      const T = nextDay()
      const gameId = await liveGame(id, T - 30 * MIN)
      // An offline batch: the top and bottom of the first in one post.
      await half(gameId, 0, 1, 'top')
      await half(gameId, 3, 1, 'bottom')
      await play(gameId, 6, 2, 'top', 1)
      await noteHalfInnings(f.h.db, gameId, new Date(T))
      expect((await ends(gameId)).map(row => row.state)).deep.equals([
        'skipped',
        'skipped'
      ])
      // The next write ends the top of the second: that one waits.
      await play(gameId, 7, 2, 'top', 2)
      await play(gameId, 8, 2, 'top', 3)
      expect(
        await noteHalfInnings(f.h.db, gameId, new Date(T + MIN))
      ).deep.equals([{ inning: 2, half: 'top', atBatIndex: 8 }])
      expect((await ends(gameId)).map(row => row.state)).deep.equals([
        'skipped',
        'skipped',
        'waiting'
      ])
    })

    it('skips an older half that ends alone after a newer one', async function () {
      const id = await league()
      await reel(id, 1)
      const T = nextDay()
      const gameId = await liveGame(id, T - 30 * MIN)
      await half(gameId, 0, 1, 'top')
      await half(gameId, 3, 1, 'bottom')
      await f.h.db
        .insertInto('game_half_ends')
        .values({
          game_id: gameId,
          inning: 1,
          half: 'bottom',
          at_bat_index: 5,
          state: 'placed'
        })
        .execute()
      expect(await noteHalfInnings(f.h.db, gameId, new Date(T))).deep.equals([])
      expect((await ends(gameId)).map(row => row.state)).deep.equals([
        'skipped',
        'placed'
      ])
    })

    it('places once when two sweeps run at once', async function () {
      const id = await league()
      const only = await reel(id, 1)
      const T = nextDay()
      const gameId = await liveGame(id, T - 10 * MIN)
      await half(gameId, 0, 1, 'top')
      await noteHalfInnings(f.h.db, gameId, new Date(T))
      await Promise.all([
        placeDueReels(f.h.db, new Date(T + 9 * SEC)),
        placeDueReels(f.h.db, new Date(T + 9 * SEC))
      ])
      expect(await placements(gameId)).has.length(1)
      expect(await usedOf(only.id)).equals(1)
    })

    it('logs a failure of the hook and never throws', async function () {
      const logged: string[] = []
      const broken: Pick<Kysely<Database>, 'isTransaction'> & {
        transaction: () => never
        selectFrom: () => never
      } = {
        transaction: () => {
          throw new Error('no database')
        },
        selectFrom: () => {
          throw new Error('no database')
        },
        isTransaction: false
      }
      const hook = halfInningHook({
        db: broken as unknown as Kysely<Database>,
        log: message => logged.push(message),
        now: () => new Date(START)
      })
      hook('gam_hook')
      for (let wait = 0; wait < 50 && logged.length === 0; wait++)
        await new Promise(resolve => setTimeout(resolve, 10))
      expect(logged).deep.equals([
        'sponsor reels: game gam_hook half-innings not noted: no database'
      ])
    })
  })

  describe('tracks and credits', function () {
    it('places two tracks in an interleague game, each from its own league’s reels and credits', async function () {
      const american = await league()
      const national = await league()
      const al = await reel(american, 1)
      const nl = await reel(national, 1)
      const T = nextDay()
      const gameId = await game(
        await team(national, 9),
        await team(american, 9),
        T - 10 * MIN
      )
      await video(gameId)
      await half(gameId, 0, 1, 'top')
      await noteHalfInnings(f.h.db, gameId, new Date(T))
      await placeDueReels(f.h.db, new Date(T + 9 * SEC))
      expect(
        (await placements(gameId)).map(row => [row.league_id, row.reel_id])
      ).deep.equals(
        [
          [american, al.id],
          [national, nl.id]
        ].sort((a, b) => a[0].localeCompare(b[0]))
      )
      expect([await usedOf(al.id), await usedOf(nl.id)]).deep.equals([1, 1])
    })

    it('goes round the active reels with broadcasts left, stops when the league’s credits are used, and keeps what was placed', async function () {
      const id = await league()
      const first = await reel(id, 1)
      await reel(id, 2, { active: false })
      await reel(id, 3, { allocation: 2, used: 2 })
      const fourth = await reel(id, 4)
      const gameId = await liveGame(id, nextDay())
      const given: Array<string | null> = []
      for (let inning = 1; inning <= 3; inning++) {
        const placed = await placeReel(
          f.h.db,
          gameId,
          id,
          { slot: 'half', inning, half: 'top' },
          new Date(START + inning * MIN)
        )
        expect(placed).a('string')
        given.push((await placements(gameId)).at(-1)?.reel_id ?? null)
      }
      expect(given).deep.equals([first.id, fourth.id, first.id])
      const turn = await f.h.db
        .selectFrom('league_sponsor_credits')
        .select('reel_turn')
        .where('league_id', '=', id)
        .executeTakeFirstOrThrow()
      expect(turn.reel_turn).equals(1)
      // The same slot again is kept as it was, and uses nothing.
      expect(
        await placeReel(
          f.h.db,
          gameId,
          id,
          { slot: 'half', inning: 1, half: 'top' },
          new Date(START)
        )
      ).equals(null)
      expect(await usedOf(first.id)).equals(2)
      // The league's credits: 2 + 1 + 2 used of 5.
      await f.h.db
        .updateTable('league_sponsor_credits')
        .set({ reel_credits: 5 })
        .where('league_id', '=', id)
        .execute()
      expect(
        await placeReel(
          f.h.db,
          gameId,
          id,
          { slot: 'half', inning: 4, half: 'top' },
          new Date(START + 4 * MIN)
        )
      ).equals(null)
      expect(await placements(gameId)).has.length(3)
    })

    it('places nothing when every reel is used up or inactive', async function () {
      const id = await league()
      await reel(id, 1, { allocation: 1, used: 1 })
      await reel(id, 2, { active: false })
      const gameId = await liveGame(id, nextDay())
      expect(
        await placeReel(f.h.db, gameId, id, { slot: 'pregame' }, new Date())
      ).equals(null)
    })

    it('keeps a placement’s media when its reel is deactivated, in the game’s sponsorship', async function () {
      const id = await league()
      const only = await reel(id, 1)
      const startAt = nextDay()
      const gameId = await liveGame(id, startAt)
      await placePregameReels(f.h.db, new Date(startAt - SEC))
      await f.h.db
        .updateTable('sponsor_reels')
        .set({ active: false, deactivated_at: new Date(startAt + MIN) })
        .where('id', '=', only.id)
        .execute()
      expect((await placements(gameId))[0].media_id).equals(only.mediaId)
      const placementId = (
        await f.h.db
          .selectFrom('game_reel_placements')
          .select('id')
          .where('game_id', '=', gameId)
          .executeTakeFirstOrThrow()
      ).id
      expect(await gameSponsorsFor(f.h.db, f.h.space, gameId)).deep.equals({
        leagueId: id,
        logo: null,
        reels: [
          {
            id: placementId,
            reelId: only.id,
            url: mediaUrl(f.h.space, only.key),
            width: 640,
            height: 360,
            startMs: startAt,
            durationMs: 12000
          }
        ],
        overlay: {
          logo: defaultSponsorSettings.logo,
          reel: defaultSponsorSettings.reel
        }
      })
      // A reel row gone keeps its broadcasts, with no reel id.
      await f.h.db
        .updateTable('game_reel_placements')
        .set({ reel_id: null })
        .where('id', '=', placementId)
        .execute()
      expect(
        (await gameSponsorsFor(f.h.db, f.h.space, gameId)).reels[0].reelId
      ).equals('')
    })

    it('answers a game’s reels in start order, only its sponsoring league’s', async function () {
      const american = await league()
      const national = await league()
      await reel(american, 1)
      await reel(national, 1)
      const gameId = await game(
        await team(american, 9),
        await team(national, 9),
        nextDay()
      )
      for (const inning of [2, 1])
        for (const leagueId of [american, national])
          await placeReel(
            f.h.db,
            gameId,
            leagueId,
            { slot: 'half', inning, half: 'top' },
            new Date(START + inning * MIN)
          )
      const read = await gameSponsorsFor(f.h.db, f.h.space, gameId)
      expect(read.leagueId).equals(american)
      expect(read.reels.map(each => each.startMs)).deep.equals([
        START + MIN,
        START + 2 * MIN
      ])
    })
  })
})
