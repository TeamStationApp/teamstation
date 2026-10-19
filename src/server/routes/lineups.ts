import { isDeepStrictEqual } from 'node:util'

import { Router } from 'express'
import type { Kysely } from 'kysely'

import {
  asSaveLineupsBody,
  asUnrosterBody,
  type DjBatter,
  type DjGame,
  type DjSide,
  type RosterEntry,
  type SaveLineupsBody
} from '../../common/api'
import { asLiteral } from '../../common/asLiteral'
import { atBatFromCurrentPlay } from '../../common/djAtBat'
import {
  badRequest,
  conflict,
  forbidden,
  type HttpError,
  notFound,
  unauthorized
} from '../../common/errors'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { shortNames } from '../../common/names'
import { asNewRosterPlayer } from '../../common/playerSettings'
import type { Problem, ScoringAction } from '../../common/scoring/actions'
import { addPlayer } from '../../common/scoring/lineup'
import {
  type Lineup,
  NO_DEFAULT_LINEUP,
  placeholderSidesOf
} from '../../common/scoring/lineupHistory'
import { awaitingResult } from '../../common/scoring/rules'
import {
  type EventStore,
  ScoringSession,
  type SessionContext,
  type StoredGame
} from '../../common/scoring/session'
import { startingSetup, teamsOf } from '../../common/scoring/startingSetup'
import {
  type GameSetup,
  type GameState,
  type Position,
  POSITIONS,
  setupOf,
  type Side
} from '../../common/scoring/state'
import {
  canKeepSongs,
  canScore,
  canSeeGame,
  canSeeTeam,
  isHeadCoach,
  roleScopes,
  visibleScopes
} from '../access'
import type { Database } from '../db/database'
import { postGamePlays, readPlays } from '../events/postPlays'
import { requireVisibleGame } from '../events/requireVisibleGame'
import {
  defaultOf,
  gameLineups,
  lineupsAnswer,
  storedLineupsDigest,
  type TeamSideLineups
} from '../events/teamLineups'
import { fenceDistanceFor } from '../games/fenceDistance'
import { createGuestPlayer } from '../games/guestPlayers'
import { gameAvailability } from '../games/rosterAvailability'
import { setRostered } from '../games/unroster'
import { cleanBody } from '../jsonBody'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { resolveScoringGame } from '../scoring/openRow'
import { contextOf } from '../scoring/replayContext'
import { teamWalkUpSongs } from './walkUpSongs'

type Trx = Kysely<Database>

export interface LineupRouteOptions {
  /**
   * Called with the game's id once a lineup save has committed, as
   * `eventRoutes`' hook is, so the game's scoreboard follows a coach's change.
   * Fire and forget: whatever it throws is logged and never fails the save.
   */
  onGameWritten?: (gameId: string) => void
  /**
   * Called each time a save has replayed the game, just before it writes:
   * where a test posts a scorer's play, as one arriving mid-save would.
   */
  beforeSave?: (gameId: string) => Promise<void>
  /**
   * Called once a save has committed, before its answer is read: where a test
   * saves another device's change, as one landing in between would.
   */
  afterSave?: (gameId: string) => Promise<void>
}

/** How many times a save replays a game that changed under it. */
const SAVE_ATTEMPTS = 3

/**
 * Lineups, read back out of what TeamStation stores.
 *
 * `GET /teams/:teamId/default-lineup` is the team's default lineup: the
 * starting lineup of the last game scored here that began with a different
 * one, with that game's id and when it was taken, or all three null. It
 * needs somebody who can see the team.
 *
 * `GET /games/:gameId/lineups` is each side's lineups in the game: the one it
 * began with (null until the game has begun), every substitution the stored
 * plays announce, and the lineup as it stands now, including a change not
 * announced yet, with the `digest` the game keeps of them. A game
 * TeamStation did not score, or whose record no longer replays, has only its
 * announced changes. It needs somebody who can see the game; anybody else
 * gets 404.
 *
 * `POST /games/:gameId/lineups` saves one side's players, batting order and
 * defence (`SaveLineupsBody`), as its head coach or a scorekeeper of either
 * team sets them; anybody else who can see the game gets 403. The game is
 * replayed as the scoring screen replays it, the side's lineup is applied as
 * a scorer's roster change, and only what that changes is posted, through
 * `postGamePlays`, as a scorer's save is. The other side is never read from
 * the body, so it cannot change. A change the game refuses is 409 when it
 * cannot be made now (a play to finish, a game over) and 400 when it cannot
 * be made at all. A game that changes while the save replays it is replayed
 * again, up to three times, and then answers 409. A save before the game
 * begins does not start it. A game with no record yet opens as the scoring
 * screen of the one saving opens it: each team's default lineup arranges its
 * side only when he may see that team, else its roster order does. The
 * answer is the lineups as `GET` reads them, with the digest the save itself
 * left, read as it was written (or the one it found, when it changed
 * nothing), so a later save is never taken for this one.
 *
 * `GET /games/:gameId/dj` is what DJ Game lists: each side's batters in
 * order, with their walk-up songs on that team. The order is the game's own
 * lineup as it stands once TeamStation has a record of it (`'lineup'`), the
 * team's default before that (`'default'`), and otherwise the team's players
 * by jersey number, then name (`'roster'`). `canEditWalkUp` says whether the
 * caller keeps that team's songs. Game lineups share game visibility;
 * defaults and rosters require team visibility.
 */
export function lineupRoutes(
  db: Kysely<Database>,
  options: LineupRouteOptions = {}
): Router {
  const router = Router()

  router.put(
    '/games/:gameId/unroster',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const body = cleanBody(asUnrosterBody, req.body)
      res.json(await setRostered(db, actor, gameId, body))
      try {
        options.onGameWritten?.(gameId)
      } catch {
        /* Notification does not fail a committed switch. */
      }
    })
  )

  router.post(
    '/games/:gameId/guest-players',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const side = cleanBody(asLiteral('away', 'home'), req.body?.side)
      const player = cleanBody(asNewRosterPlayer, req.body)
      res
        .status(201)
        .json(await createGuestPlayer(db, actor, gameId, side, player))
    })
  )

  router.get(
    '/teams/:teamId/default-lineup',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (!canSeeTeam(scopes, teamId)) throw notFound()
      const team = await db
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', teamId)
        .executeTakeFirst()
      if (team == null) throw notFound()
      res.json(defaultOf(team.default_lineup) ?? NO_DEFAULT_LINEUP)
    })
  )

  router.get(
    '/games/:gameId/lineups',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const game = await db
        .selectFrom('games')
        .select([
          'home_team_id',
          'away_team_id',
          'season_id',
          'currentPlay',
          'lineups_digest',
          'guests',
          'unrostered'
        ])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (
        !canSeeGame(scopes, {
          homeTeamId: game.home_team_id,
          awayTeamId: game.away_team_id,
          seasonId: game.season_id
        })
      )
        throw notFound()
      res.json(await lineupsAnswer(db, { id: gameId, ...game }))
    })
  )

  router.post(
    '/games/:gameId/lineups',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const body = cleanBody(asSaveLineupsBody, req.body)
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      // The side's head coach, or a scorekeeper of either team. Asked before
      // the game is replayed, so a save with nothing to change is refused
      // too, and again on the locked row the save is written against.
      const mayPost = async (
        reader: Trx,
        game: { home_team_id: string; away_team_id: string }
      ): Promise<void> => {
        const roles = await roleScopes(reader, actor.userId, actor.isAdmin)
        const teamId =
          body.side === 'home' ? game.home_team_id : game.away_team_id
        if (
          !isHeadCoach(roles, teamId) &&
          !canScore(roles, game.home_team_id) &&
          !canScore(roles, game.away_team_id)
        )
          throw forbidden(
            "Only the team's head coach or a scorekeeper may save its lineup"
          )
      }
      const teams = await db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id'])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (teams == null) throw notFound()
      await mayPost(db, teams)
      // A team's default lineup is only for somebody who may see the team.
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      const sees = (teamId: string): boolean => canSeeTeam(scopes, teamId)
      let saved: SideSaved | undefined
      for (let attempt = 0; ; attempt++) {
        if (attempt === SAVE_ATTEMPTS)
          throw conflict('The game changed while saving; try again')
        const outcome = await saveSide(db, gameId, body, mayPost, sees, options)
        if (outcome.outcome === 'moved') continue
        saved = outcome
        break
      }
      if (saved.outcome === 'saved') {
        await options.afterSave?.(gameId)
        try {
          options.onGameWritten?.(gameId)
        } catch (error) {
          console.error(`onGameWritten ${gameId}`, error)
        }
      }
      const game = await db
        .selectFrom('games')
        .select([
          'home_team_id',
          'away_team_id',
          'currentPlay',
          'lineups_digest',
          'guests',
          'unrostered'
        ])
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      res.json({
        ...(await lineupsAnswer(db, { id: gameId, ...game })),
        digest: saved.digest
      })
    })
  )

  router.get(
    '/games/:gameId/dj',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const game = await db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id', 'season_id', 'currentPlay'])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      if (
        !canSeeGame(scopes, {
          homeTeamId: game.home_team_id,
          awayTeamId: game.away_team_id,
          seasonId: game.season_id
        })
      )
        throw notFound()
      const roles = await roleScopes(db, actor.userId, actor.isAdmin)
      const lineups = await gameLineups(db, {
        id: gameId,
        home_team_id: game.home_team_id,
        away_team_id: game.away_team_id,
        currentPlay: game.currentPlay
      })
      const side = async (which: Side): Promise<DjSide> => {
        const read = lineups[which]
        return {
          teamId: read.teamId,
          teamName: read.teamName,
          canEditWalkUp: canKeepSongs(roles, read.teamId),
          ...(await djBatters(db, read, canSeeTeam(scopes, read.teamId)))
        }
      }
      const answer: DjGame = {
        away: await side('away'),
        home: await side('home'),
        atBat: atBatFromCurrentPlay(game.currentPlay)
      }
      res.json(answer)
    })
  )

  return router
}

/** A game that changed between its replay and its save, which tries again. */
class GameMoved extends Error {
  constructor() {
    super('The game changed while saving')
  }
}

/** What a save replayed: the game's lineups digest, at-bat and plays. */
function snapshotOf(
  game: {
    currentPlay: unknown
    lineups_digest: string | null
    guests?: unknown
    unrostered?: unknown
  },
  plays: Array<{ id: string }>
): string {
  return JSON.stringify([
    game.lineups_digest,
    game.currentPlay,
    game.guests,
    game.unrostered,
    plays.map(play => play.id)
  ])
}

/**
 * What a save did, and the lineups digest that goes with it: the one it
 * wrote, or the one it found when there was nothing to write.
 */
type SideSaved =
  { outcome: 'saved' | 'unchanged'; digest: string } | { outcome: 'moved' }

/**
 * Replays the game, applies one side's lineup from `body` to it, and posts
 * what changed. `'moved'` when the game changed between the replay and the
 * save, so nothing was written; `'unchanged'` when there was nothing to save.
 * A game with no record yet opens with the defaults of the teams `sees`.
 */
async function saveSide(
  db: Kysely<Database>,
  gameId: string,
  body: SaveLineupsBody,
  mayPost: (
    trx: Trx,
    game: { home_team_id: string; away_team_id: string }
  ) => Promise<void>,
  sees: (teamId: string) => boolean,
  options: LineupRouteOptions
): Promise<SideSaved> {
  // The plays and the game row as one moment.
  const read = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async trx => {
      const game = await trx
        .selectFrom('games')
        .select([
          'home_team_id',
          'away_team_id',
          'currentPlay',
          'lineups_digest',
          'guests',
          'unrostered'
        ])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      const rows = await readPlays(trx, gameId)
      const stored: StoredGame = await resolveScoringGame(trx, {
        plays: rows.map(row => row.gumbo as GumboPlay),
        currentPlay: game.currentPlay as CurrentPlay | null
      })
      const context =
        (await contextOf(trx, gameId, game, stored)) ??
        (await startingContext(trx, gameId, game, sees))
      const availability = await gameAvailability(trx, { id: gameId, ...game })
      return {
        stored,
        context,
        guests: availability.guests[body.side].filter(
          id =>
            !availability.roster[body.side].some(
              row => row.isPlayer && row.userId === id
            )
        ),
        roster: availability.roster[body.side].filter(
          person =>
            person.isPlayer &&
            !availability.unrostered[body.side].includes(person.userId)
        ),
        snapshot: snapshotOf(game, rows),
        digest: await storedLineupsDigest(trx, { id: gameId, ...game })
      }
    })

  let failure: Error | undefined
  // The digest the save left, read in the transaction that wrote it.
  let wrote: string | undefined
  const store: EventStore = {
    load: async () => read.stored,
    save: async (_gameId, change) => {
      try {
        const posted = await postGamePlays(
          db,
          gameId,
          asPostEventsBody({
            mode: 'live',
            source: { system: 'teamstation' },
            plays: change.plays,
            remove: change.remove,
            currentPlay: change.currentPlay,
            fenceDistanceFt: change.fenceDistanceFt
          }),
          async (trx, game) => {
            await mayPost(trx, game)
            const now = await trx
              .selectFrom('games')
              .select(['currentPlay', 'lineups_digest', 'guests', 'unrostered'])
              .where('id', '=', gameId)
              .executeTakeFirstOrThrow()
            if (snapshotOf(now, await readPlays(trx, gameId)) !== read.snapshot)
              throw new GameMoved()
          }
        )
        // A live post always keeps one.
        wrote = posted.lineupsDigest ?? read.digest
        return {
          plays: posted.plays.map(play => play.gumbo as GumboPlay),
          currentPlay: posted.currentPlay as CurrentPlay | null
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        throw failure
      }
    }
  }
  const session = await ScoringSession.open(store, gameId, read.context, {
    requireCurrentSetup: true,
    // The request saves once, with `flush`; no retry outlives it.
    setTimer: () => null,
    clearTimer: () => undefined
  })
  // A game with no record of its lineups yet takes them as they stand: a
  // coach accepts the lineup it opens on by saving it unchanged.
  const held =
    session.actions.length > 0 ||
    session.state.liveData.plays.allPlays.length > 0
  const actions = sideActions(
    session.state,
    body,
    held,
    read.roster,
    read.guests
  )
  markRosterVisibility(
    actions,
    session.actions,
    body.side,
    held,
    read.context.teams,
    sees
  )
  if (actions.length === 0) return { outcome: 'unchanged', digest: read.digest }
  // The game takes a lineup change with a ball in play; the scorer's screen
  // offers none until the play has its result, and nor does this.
  if (awaitingResult(session.state))
    throw conflict('Finish the current play first')
  for (const action of actions) {
    const problem = session.apply(action).problems[0]
    if (problem != null) throw refusal(problem)
  }
  await options.beforeSave?.(gameId)
  // A refused store is kept in the session's state, so its error is rethrown
  // here, and its 400, 403 or 409 reaches the caller.
  await session.flush()
  if (failure instanceof GameMoved) return { outcome: 'moved' }
  if (failure != null) throw failure
  return wrote == null
    ? { outcome: 'unchanged', digest: read.digest }
    : { outcome: 'saved', digest: wrote }
}

/**
 * The lineups a game with no TeamStation record opens with, as the scoring
 * screen of somebody who `sees` the teams it does opens it: the teams'
 * rosters as they stand, never topped up with made-up players, each arranged
 * as its team's default lineup when he may see that team (as
 * `GET /teams/:teamId/default-lineup` asks), else in roster order.
 */
export async function startingContext(
  db: Trx,
  gameId: string,
  game: { home_team_id: string; away_team_id: string },
  sees: (teamId: string) => boolean
): Promise<SessionContext> {
  const gameRow = await db
    .selectFrom('games')
    .selectAll()
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  const availability = await gameAvailability(db, gameRow)
  const rows = await db
    .selectFrom('teams')
    .select(['id', 'name', 'logo_path', 'default_lineup'])
    .where('id', 'in', [game.home_team_id, game.away_team_id])
    .execute()
  const row = (id: string): (typeof rows)[number] | undefined =>
    rows.find(item => item.id === id)
  const teams = {
    awayTeamId: game.away_team_id,
    awayTeamName: row(game.away_team_id)?.name ?? '',
    awayLogoUrl: row(game.away_team_id)?.logo_path ?? null,
    homeTeamId: game.home_team_id,
    homeTeamName: row(game.home_team_id)?.name ?? '',
    homeLogoUrl: row(game.home_team_id)?.logo_path ?? null
  }
  return {
    gamePk: gameId,
    teams: teamsOf(teams),
    setup: startingSetup(
      {
        ...teams,
        unrostered: availability.unrostered,
        guestPlayers: availability.guestPlayers
      },
      availability.roster.away,
      availability.roster.home,
      {
        away: sees(game.away_team_id)
          ? defaultOf(row(game.away_team_id)?.default_lineup)?.lineup
          : null,
        home: sees(game.home_team_id)
          ? defaultOf(row(game.home_team_id)?.default_lineup)?.lineup
          : null
      },
      false
    ),
    fenceDistanceFt: await fenceDistanceFor(db, gameId)
  }
}

/**
 * Marks the roster action with the side this save sets, and, on a game with
 * no record yet, the sides the saver could not see. He can set only his own
 * side: the other side is never confirmed, so this save does not take that
 * team's lineup or its default. A side he could not see is in roster order
 * in that setup. The first pitch leaves that team's default as it stands. A
 * side an earlier save already left unseen stays unseen: the saver is
 * looking at an order the game does not hold as that team's lineup.
 */
function markRosterVisibility(
  actions: ScoringAction[],
  prior: readonly ScoringAction[],
  saved: Side,
  held: boolean,
  teams: Record<Side, { id: string }>,
  sees: (teamId: string) => boolean
): void {
  const sides: Side[] = ['away', 'home']
  const seen = (side: Side): boolean => sees(teams[side].id)
  const blocked = placeholderSidesOf(prior)
  const unseen = held ? [] : sides.filter(side => !seen(side))
  const confirmed = seen(saved) && !blocked.has(saved) ? [saved] : []
  if (unseen.length === 0 && confirmed.length === 0) return
  for (const action of actions) {
    if (action.type !== 'lineup' || action.kind !== 'roster') continue
    if (unseen.length > 0) action.unseen = unseen
    if (confirmed.length > 0) action.confirmed = confirmed
  }
}

/**
 * The actions that make one side's lineup the one `body` names: a roster
 * change carrying the game's setup with that side's players, order and
 * defence replaced, then a pinch runner per runner. None when the lineup is
 * already that one and the game `held` it.
 *
 * Players retain their persistent identities. A new option must already be
 * a team roster member or a guest created for this side of this game.
 */
function sideActions(
  state: GameState,
  body: SaveLineupsBody,
  held = true,
  roster: readonly RosterEntry[] = [],
  guests: readonly number[] = []
): ScoringAction[] {
  const required = new Set([
    ...roster.map(row => row.userId),
    ...guests.filter(id => !roster.some(row => row.userId === id))
  ])
  const sent = body.players.map(player => player.userId)
  if (
    sent.length !== required.size ||
    sent.some(id => id == null || !required.has(id))
  )
    throw badRequest(
      'The lineup must include every available roster player and game guest'
    )
  const side = body.side
  const setup: GameSetup = setupOf(state)
  const team = setup.sides[side]
  const draft = {
    gameData: { teams: state.gameData.teams, players: setup.players },
    liveData: { boxscore: { teams: setup.sides } },
    meta: { tagOrder: setup.tagOrder }
  }
  const ids: number[] = []
  for (const player of body.players) {
    if (player.userId == null)
      throw badRequest('Create the player before saving the lineup')
    let known = team.players.find(id => id === player.userId)
    if (known == null && guests.includes(player.userId))
      known = addPlayer(
        draft,
        side,
        player.userId,
        player.fullName,
        player.jersey
      )
    if (known == null) {
      const entry = roster.find(person => person.userId === player.userId)
      if (entry == null)
        throw badRequest(`${player.fullName} is not on this team's roster`)
      const id = entry.userId
      if (!setup.tagOrder.includes(id)) setup.tagOrder.push(id)
      const existing = setup.players[id]
      if (existing != null && existing.teamId !== state.gameData.teams[side].id)
        throw badRequest(`${player.fullName} is already on the other team`)
      // Use current roster data, never caller-provided identity/name details.
      setup.players[id] = existing ?? {
        id,
        userId: entry.userId,
        teamId: state.gameData.teams[side].id,
        fullName: entry.shortName,
        jersey: entry.jersey ?? '',
        bats: entry.bats ?? 'right',
        throws: entry.throws ?? null,
        positions: [...entry.positions],
        local: false
      }
      known = id
    }
    const id = known
    if (ids.includes(id))
      throw badRequest(`${player.fullName} is named more than once`)
    ids.push(id)
  }
  team.players = ids
  team.battingOrder = body.battingOrder.map(index => ids[index])
  team.defense = Object.fromEntries(
    POSITIONS.map(position => {
      const index = body.defense[position]
      return [position, index == null ? null : ids[index]]
    })
  ) as Record<Position, number | null>
  const runners = body.runners ?? []
  if (
    held &&
    body.nextBatter == null &&
    runners.length === 0 &&
    isDeepStrictEqual(setup, setupOf(state))
  )
    return []
  return [
    {
      type: 'lineup',
      kind: 'roster',
      setup,
      ...(body.nextBatter == null ? {} : { nextBatter: ids[body.nextBatter] })
    },
    ...runners.map((runner): ScoringAction => ({
      type: 'lineup',
      kind: 'runner',
      side,
      base: runner.base,
      player: ids[runner.player]
    }))
  ]
}

/** The game's refusal as an answer: 409 for not now, 400 for not at all. */
function refusal(problem: Problem): HttpError {
  return problem.code === 'notNow' || problem.code === 'gameOver'
    ? conflict(problem.message)
    : badRequest(problem.message)
}

/**
 * One side's batters for DJ Game, and where they came from, each with his
 * walk-up song on that team. A placeholder has none.
 */
async function djBatters(
  db: Kysely<Database>,
  read: TeamSideLineups,
  maySeeTeam: boolean
): Promise<Pick<DjSide, 'source' | 'batters'>> {
  // Game visibility shares this game’s lineup, never an unrelated team default
  // or roster. Check before querying either fallback or its private songs.
  if (read.current == null && !maySeeTeam)
    return { source: 'roster', batters: [] }
  const songs = await teamWalkUpSongs(db, read.teamId)
  const withSongs = (lineup: Lineup): DjBatter[] =>
    lineup.batters.map(person => ({
      userId: person.userId,
      name: person.name,
      walkUpSong:
        person.userId == null ? null : (songs.get(person.userId) ?? null)
    }))
  if (read.current != null) {
    return { source: 'lineup', batters: withSongs(read.current) }
  }
  const team = await db
    .selectFrom('teams')
    .select('default_lineup')
    .where('id', '=', read.teamId)
    .executeTakeFirst()
  const kept = defaultOf(team?.default_lineup)
  if (kept?.lineup != null) {
    return { source: 'default', batters: withSongs(kept.lineup) }
  }
  const rows = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'memberships.user_id as userId',
      'users.display_name as displayName',
      'users.first_name as firstName',
      'users.last_name as lastName',
      'memberships.jersey as jersey'
    ])
    .where('memberships.team_id', '=', read.teamId)
    .where('memberships.is_player', '=', true)
    .where('users.merged_into', 'is', null)
    .execute()
  const names = shortNames(
    rows.map(row => ({
      id: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      displayName: row.displayName
    }))
  )
  const nameOf = (row: (typeof rows)[number]): string =>
    names.get(row.userId) ?? row.displayName
  const batters = [...rows]
    .sort((a, b) => {
      const byJersey = jerseyNumber(a.jersey) - jerseyNumber(b.jersey)
      return byJersey !== 0 ? byJersey : nameOf(a).localeCompare(nameOf(b))
    })
    .map(row => ({
      userId: row.userId,
      name: nameOf(row),
      walkUpSong: songs.get(row.userId) ?? null
    }))
  return { source: 'roster', batters }
}

/** A jersey as a number to sort by; none, or not a number, sorts last. */
function jerseyNumber(jersey: string | null): number {
  const number = jersey == null ? NaN : Number.parseInt(jersey, 10)
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
