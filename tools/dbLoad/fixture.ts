import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'

import { type Kysely, sql } from 'kysely'

import { signEpoch, signPuk } from '../../src/common/chatCrypto/chain'
import { epochAad, hpkeSeal, pukAad } from '../../src/common/chatCrypto/hpke'
import {
  newDeviceKeys,
  newEpochKey,
  newIdentityKey,
  newPukKey
} from '../../src/common/chatCrypto/keys'
import {
  newIdentityId,
  newMessageId
} from '../../src/common/chatCrypto/messageIds'
import { sealMessage } from '../../src/common/chatCrypto/seal'
import { asPostEventsBody } from '../../src/common/gumboPlay'
import { makeId } from '../../src/common/ids'
import { closeInto } from '../../src/server/admin/people'
import { mergeTeams } from '../../src/server/admin/mergeTeams'
import { addEmail } from '../../src/server/auth/emails'
import {
  createSession,
  revokeSession,
  USER_API_KEY_PREFIX
} from '../../src/server/auth/sessions'
import { hashToken, makeToken } from '../../src/server/auth/tokens'
import { createDm } from '../../src/server/chat/dms'
import { createEpoch } from '../../src/server/chat/epochs'
import { enrol, registerDevice } from '../../src/server/chat/keys'
import { postMessage } from '../../src/server/chat/messages'
import { reconcileScope } from '../../src/server/chat/reconciler'
import { atomic } from '../../src/server/db/atomic'
import type { Database } from '../../src/server/db/database'
import { postGamePlays } from '../../src/server/events/postPlays'
import { addToScope } from '../../src/server/invites/people'
import { sealSecret } from '../../src/server/live/secrets'
import { linkGuardian } from '../../src/server/people/guardians'
import { drain } from '../../src/server/statsBuilder/builder'
import { requestGameStats } from '../../src/server/statsBuilder/request'
import { ensureGumboId, insertUser } from '../../src/server/users/insertUser'
import { type Amounts, amountsFor } from './amounts'
import { type LoadDatabase, requireLoadDatabase } from './database'
import {
  asOlderRecord,
  type GameSides,
  POSITIONS,
  randomFrom,
  type RosterPlayer,
  type ScriptedGame,
  scriptedGame
} from './scoredGames'

/**
 * Seeds a generated population through the application's own write functions:
 * `insertUser`, `createSession`, `closeInto`, `mergeTeams`, `linkGuardian`,
 * `postGamePlays`, `createDm`, `postMessage`. Only history is cloned, in SQL,
 * from games written through those paths, because a large table is all it is
 * there for.
 *
 * Every row it makes that matters is tagged in `external_ids` under the run,
 * by a label that says what it is, so a run's rows can be found, compared and
 * removed however random their ids are.
 */

/** What the seed's randomness starts from, so two seeds build the same shapes. */
const FIXTURE_SEED = 0x7e57ab1e

const USER_AGENT = 'dbload'

/** How many writes run side by side, which is within the fixture's pool. */
const CONCURRENCY = 4

/** The kinds of consumable shape, each named for the event that uses it up. */
export const CONSUMABLES = [
  'teamMerge',
  'personMerge',
  'signOut',
  'statsRebuild',
  'chatAdd'
] as const
export type Consumable = (typeof CONSUMABLES)[number]

export type AccountKind =
  'viewer' | 'worstCase' | 'scorekeeper' | 'videographer' | 'person'

/** One person with a token, as `tokens.json` holds them. */
export interface SeededAccount {
  label: string
  kind: AccountKind
  userId: string
  token: string
  /** The team they joined, and the live game of that team if there is one. */
  teamId: string | null
  gameIndex: number | null
}

export interface SeededGame {
  id: string
  sides: GameSides
  seasonId: string
  /** The account that scores it. */
  scorekeeper: string
}

/** What the rig needs of a seeded run: `tokens.json`, at mode 0600. */
export interface TokensFile {
  runId: string
  scale: string
  accounts: SeededAccount[]
  games: SeededGame[]
}

export interface SeedOptions {
  /** Letters and digits. */
  runId: string
  scale: string
  /** `--accounts`, and changes to the scale's table for a smaller seed. */
  overrides?: Partial<Amounts>
  /** `--streams`: enough videographers for this many at four cameras each. */
  streams?: number
  /** Where the tokens go. They are written even when a seed fails partway. */
  tokensPath?: string
  log?: (message: string) => void
  now?: Date
}

/** The `external_ids.system` a run's rows are tagged under. */
export function systemOf(runId: string): string {
  if (!/^[a-zA-Z0-9]{1,26}$/.test(runId))
    throw new Error(`A run id is 1 to 26 letters and digits, not ${runId}`)
  return `dbload${runId}`
}

export function newRunId(now = Date.now()): string {
  return now.toString(36)
}

export function readTokens(path: string): TokensFile {
  const tokens = JSON.parse(readFileSync(path, 'utf8')) as TokensFile
  if (!Array.isArray(tokens.accounts) || !Array.isArray(tokens.games))
    throw new Error(`${path} is not a tokens file`)
  return tokens
}

export function writeTokens(path: string, tokens: TokensFile): void {
  writeFileSync(path, JSON.stringify(tokens), { mode: 0o600 })
  // The mode above only applies to a file that did not exist.
  chmodSync(path, 0o600)
}

/** Runs `work` over the items, a few at a time. */
export async function inTurn<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
  return results
}

/** A membership row, written as an invitation accepted writes it. */
async function joinScope(
  db: Kysely<Database>,
  scopeType: 'team' | 'season' | 'league',
  scopeId: string,
  userId: string
): Promise<void> {
  await atomic(db, async trx => {
    await addToScope(trx, scopeType, scopeId, userId)
  })
}

const pad = (value: number): string => String(value).padStart(5, '0')

/** A chat identity, whose secret keys the server never holds. */
interface ChatKeys {
  userId: string
  sessionId: string
  identityId: string
  identitySecret: Uint8Array
  pukPublic: Uint8Array
}

class Seeder {
  readonly accounts: SeededAccount[] = []
  readonly games: SeededGame[] = []
  readonly system: string
  private tags: Array<{
    id: string
    entity_type: string
    entity_id: string
    system: string
    kind: string
    external_id: string
  }> = []

  private readonly chatKeys = new Map<string, ChatKeys>()
  private readonly sessions = new Map<string, string>()
  readonly now: Date

  constructor(
    readonly db: LoadDatabase,
    readonly runId: string,
    readonly scale: string,
    readonly amounts: Amounts,
    readonly videographers: number,
    now: Date | undefined,
    readonly log: (message: string) => void
  ) {
    this.system = systemOf(runId)
    this.now = now ?? new Date()
  }

  random(label: string): () => number {
    let hash = FIXTURE_SEED
    for (const char of label)
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    return randomFrom(hash)
  }

  /** Remembers what `label` is, so cleanup and read-back can find it. */
  async tag(kind: string, label: string, id: string): Promise<void> {
    this.tags.push({
      id: makeId('externalId'),
      entity_type: kind,
      entity_id: id,
      system: this.system,
      kind,
      external_id: label
    })
    if (this.tags.length >= 200) await this.flushTags()
  }

  async flushTags(): Promise<void> {
    const tags = this.tags
    this.tags = []
    if (tags.length > 0)
      await this.db.insertInto('external_ids').values(tags).execute()
  }

  /** A person with no way to sign in: a player, or a row about to be merged. */
  async person(
    label: string,
    values: {
      first?: string
      account?: boolean
      admin?: boolean
    } = {}
  ): Promise<string> {
    const last = label.replace(/[^a-zA-Z0-9]+/g, ' ')
    const first = values.first ?? 'Load'
    const displayName = `${first} ${last}`.slice(0, 120)
    const email = `${label.toLowerCase()}.${this.runId.toLowerCase()}@example.test`
    const userId = await this.db.transaction().execute(async trx => {
      const id = await insertUser(trx, {
        display_name: displayName,
        first_name: first,
        last_name: last,
        is_admin: values.admin === true,
        // Adults, which is what a direct message between two of them needs.
        birth_year: 1985,
        birth_month: 6,
        login_enabled: values.account === true
      })
      if (values.account === true)
        await addEmail(trx, id, email, {
          isPrimary: true,
          source: 'manual',
          verifiedAt: this.now
        })
      return id
    })
    await this.tag('user', label, userId)
    return userId
  }

  /** A signed-in account, and its entry in `tokens.json`. */
  async account(
    label: string,
    kind: AccountKind,
    options: {
      teamId?: string | null
      gameIndex?: number | null
      admin?: boolean
    } = {}
  ): Promise<SeededAccount> {
    const userId = await this.person(label, {
      account: true,
      admin: options.admin,
      first: kind === 'viewer' ? 'Viewer' : 'Load'
    })
    return await this.signIn(label, kind, userId, options)
  }

  async signIn(
    label: string,
    kind: AccountKind,
    userId: string,
    options: { teamId?: string | null; gameIndex?: number | null } = {}
  ): Promise<SeededAccount> {
    const session = await createSession(this.db, userId, USER_AGENT)
    this.sessions.set(userId, session.sessionId)
    if (options.teamId != null)
      await joinScope(this.db, 'team', options.teamId, userId)
    const account: SeededAccount = {
      label,
      kind,
      userId,
      token: session.token,
      teamId: options.teamId ?? null,
      gameIndex: options.gameIndex ?? null
    }
    this.accounts.push(account)
    return account
  }

  async league(label: string): Promise<string> {
    const id = makeId('league')
    await this.db
      .insertInto('leagues')
      .values({ id, name: `Load ${label}`, short_name: 'LOAD' })
      .execute()
    await this.tag('league', label, id)
    return id
  }

  async season(label: string, leagueId: string): Promise<string> {
    const id = makeId('season')
    await this.db
      .insertInto('seasons')
      .values({
        id,
        league_id: leagueId,
        name: `Load ${label}`,
        year: 2026,
        term: 'Spring',
        starts_on: '2026-03-01',
        ends_on: '2026-05-31'
      })
      .execute()
    await this.tag('season', label, id)
    return id
  }

  async team(
    label: string,
    seasonId?: string,
    kind: 'full' | 'external' = 'full'
  ): Promise<string> {
    const id = makeId('team')
    await this.db
      .insertInto('teams')
      .values({ id, name: `Load ${label}`, kind })
      .execute()
    if (seasonId != null)
      await this.db
        .insertInto('season_teams')
        .values({ season_id: seasonId, team_id: id })
        .execute()
    await this.tag('team', label, id)
    return id
  }

  /** A team's twelve players: nine who start, by position, and three more. */
  async roster(label: string, teamId: string): Promise<RosterPlayer[]> {
    const players: RosterPlayer[] = []
    for (let i = 0; i < 12; i++) {
      const position = POSITIONS[i]
      const userId = await this.person(`${label}.player${pad(i)}`)
      await this.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teamId,
          role: 'member',
          is_player: true,
          jersey: String(i + 1),
          positions: position == null ? [] : [position]
        })
        .execute()
      const gumboId = await ensureGumboId(this.db, userId)
      players.push({
        gumboId,
        first: 'Load',
        last: `${label} ${i}`,
        ...(position == null ? {} : { position })
      })
    }
    return players
  }

  async game(
    label: string,
    home: string,
    away: string,
    seasonId: string | null,
    status: 'scheduled' | 'inProgress' | 'final',
    startAt: Date
  ): Promise<string> {
    const id = makeId('game')
    await this.db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        season_id: seasonId,
        start_at: startAt,
        venue: 'Load Field',
        status
      })
      .execute()
    await this.tag('game', label, id)
    return id
  }

  /** A team role, through the row the role screens write. */
  async grant(
    userId: string,
    scopeType: 'team' | 'season' | 'league',
    scopeId: string,
    role: 'admin' | 'coach' | 'scorekeeper' | 'videographer'
  ): Promise<void> {
    await this.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userId,
        scope_type: scopeType,
        scope_id: scopeId,
        role
      })
      .execute()
  }

  /** `depth` merges in a row: each row closed into the next. The last is open. */
  async chain(
    label: string,
    depth: number,
    teamId?: string
  ): Promise<string[]> {
    const rows: string[] = []
    for (let i = 0; i <= depth; i++) {
      const row = await this.person(`${label}.row${pad(i)}`)
      if (teamId != null)
        await this.db
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            user_id: row,
            team_id: teamId,
            role: 'member',
            is_player: true
          })
          .onConflict(oc => oc.columns(['user_id', 'team_id']).doNothing())
          .execute()
      rows.push(row)
    }
    for (let i = 0; i < depth; i++) {
      const merge = await closeInto(this.db, rows[i], rows[i + 1])
      if (!merge.closed) throw new Error(`${label}: row ${i} did not close`)
    }
    return rows
  }

  /** Posts a scripted game as the scoring screen does, naming nobody. */
  async postGame(gameId: string, game: ScriptedGame): Promise<void> {
    await postGamePlays(
      this.db,
      gameId,
      asPostEventsBody({
        mode: 'live',
        source: { system: 'teamstation' },
        plays: game.plays,
        currentPlay: game.currentPlay
      })
    )
  }

  /**
   * Copies of a written game, under the same teams at earlier dates: only the
   * ids and dates differ, so its plays go through the same triggers again.
   */
  async cloneGames(
    source: string,
    label: string,
    count: number,
    newestDaysAgo: number
  ): Promise<string[]> {
    if (count <= 0) return []
    const ids = Array.from({ length: count }, () => makeId('game'))
    const dates = ids.map(
      (_, i) => new Date(this.now.getTime() - (newestDaysAgo + i) * 86_400_000)
    )
    const columns = await columnsOf(this.db, 'games', ['id', 'start_at'])
    const list = sql.join(columns.map(column => sql.ref(column)))
    const fromSource = sql.join(columns.map(column => sql.ref(`g.${column}`)))
    await sql`
      insert into games (id, start_at, ${list})
      select copy.id, copy.start_at, ${fromSource}
      from games g,
        unnest(${ids}::text[], ${dates.map(date => date.toISOString())}::timestamptz[])
          as copy(id, start_at)
      where g.id = ${source}
    `.execute(this.db)
    const eventColumns = await columnsOf(this.db, 'events', ['id', 'gameId'])
    const eventList = sql.join(eventColumns.map(column => sql.ref(column)))
    const fromEvent = sql.join(
      eventColumns.map(column => sql.ref(`e.${column}`))
    )
    await sql`
      insert into events (id, "gameId", ${eventList})
      select 'evt_' || md5(copy.id || e.id), copy.id, ${fromEvent}
      from events e, unnest(${ids}::text[]) as copy(id)
      where e."gameId" = ${source}
    `.execute(this.db)
    await inTurn(ids, CONCURRENCY, async (id, i) => {
      await this.tag('game', `${label}.${pad(i)}`, id)
    })
    return ids
  }

  async enrolInChat(userId: string): Promise<ChatKeys> {
    const held = this.chatKeys.get(userId)
    if (held != null) return held
    const sessionId = this.sessions.get(userId)
    if (sessionId == null)
      throw new Error(`${userId} has no session to chat in`)
    const caller = { userId, sessionId }
    const device = newDeviceKeys()
    const registered = await registerDevice(
      this.db,
      caller,
      {
        name: 'dbload',
        platform: 'web',
        boxPublicKey: device.box.publicKey,
        signPublicKey: device.sign.publicKey
      },
      this.now
    )
    const identityId = newIdentityId()
    const identity = newIdentityKey()
    const puk = newPukKey()
    await enrol(
      this.db,
      caller,
      {
        identityId,
        identityPublicKey: identity.publicKey,
        pukPublicKey: puk.publicKey,
        pukSignature: signPuk(
          { userId, generation: 1, publicKey: puk.publicKey },
          identity.secretKey
        ),
        box: hpkeSeal(
          'puk',
          device.box.publicKey,
          pukAad({
            userId,
            identityId,
            generation: 1,
            deviceId: registered.id
          }),
          puk.secretKey
        )
      },
      this.now
    )
    const keys: ChatKeys = {
      userId,
      sessionId,
      identityId,
      identitySecret: identity.secretKey,
      pukPublic: puk.publicKey
    }
    this.chatKeys.set(userId, keys)
    return keys
  }

  /**
   * History: `count` signed messages from one member, under an epoch boxed to
   * every member who holds an identity, as a device writes them.
   */
  async speak(
    conversationId: string,
    speakerId: string,
    count: number
  ): Promise<void> {
    const speaker = await this.enrolInChat(speakerId)
    const members = await this.db
      .selectFrom('chat_members')
      .select('user_id')
      .where('conversation_id', '=', conversationId)
      .where('left_at', 'is', null)
      .execute()
    const epochKey = newEpochKey()
    const boxes = members.flatMap(member => {
      const keys = this.chatKeys.get(member.user_id)
      if (keys == null) return []
      return [
        {
          userId: keys.userId,
          pukGeneration: 1,
          box: hpkeSeal(
            'epoch',
            keys.pukPublic,
            epochAad({
              conversationId,
              epoch: 1,
              recipientUserId: keys.userId,
              identityId: keys.identityId,
              generation: 1
            }),
            epochKey
          )
        }
      ]
    })
    const caller = { userId: speaker.userId, sessionId: speaker.sessionId }
    await createEpoch(
      this.db,
      caller,
      conversationId,
      {
        epoch: 1,
        previousKeyBox: null,
        signature: signEpoch(
          { conversationId, epoch: 1, previousKeyBox: null },
          speaker.identitySecret
        ),
        boxes
      },
      this.now
    )
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ text: 'Generated load test message' })
    )
    for (let i = 0; i < count; i++) {
      const id = newMessageId()
      const sealed = sealMessage({
        conversationId,
        epoch: 1,
        messageId: id,
        senderUserId: speaker.userId,
        kind: 'post',
        epochKey,
        plaintext,
        identitySecretKey: speaker.identitySecret
      })
      await postMessage(
        this.db,
        caller,
        conversationId,
        {
          id,
          epoch: 1,
          kind: 'post',
          senderIdentityId: speaker.identityId,
          targetIds: null,
          attachmentIds: [],
          ...sealed
        },
        this.now
      )
    }
  }

  async copy(kind: Consumable, index: number): Promise<void> {
    await this.tag('copy', `${kind}.${index}`, String(index))
  }

  tokens(): TokensFile {
    return {
      runId: this.runId,
      scale: this.scale,
      accounts: this.accounts,
      games: this.games
    }
  }
}

async function columnsOf(
  db: Kysely<Database>,
  table: string,
  leaving: string[]
): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select column_name as name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
      and is_generated = 'NEVER'
    order by ordinal_position
  `.execute(db)
  return rows.map(row => row.name).filter(name => !leaving.includes(name))
}

interface Groups {
  seasons: string[]
  teams: string[]
  sides: GameSides[]
}

/** Leagues, seasons, teams with rosters, and the live games between them. */
async function seedGroups(seeder: Seeder): Promise<Groups> {
  const { amounts } = seeder
  const leagues: string[] = []
  for (let i = 0; i < amounts.leagues; i++)
    leagues.push(await seeder.league(`league${pad(i)}`))
  const seasons: string[] = []
  for (let i = 0; i < amounts.seasons; i++)
    seasons.push(
      await seeder.season(`season${pad(i)}`, leagues[i % leagues.length])
    )
  // Pairs stay together, so a pair's game is within one season.
  const teamIndexes = Array.from({ length: amounts.teams }, (_, i) => i)
  const players = new Map<number, RosterPlayer[]>()
  const teams = await inTurn(teamIndexes, CONCURRENCY, async i => {
    const label = `team${pad(i)}`
    const id = await seeder.team(
      label,
      seasons[Math.floor(i / 2) % seasons.length]
    )
    players.set(i, await seeder.roster(label, id))
    return id
  })
  const sides: GameSides[] = []
  for (let i = 0; i + 1 < teams.length; i += 2)
    sides.push({
      away: {
        id: teams[i + 1],
        name: `Load team${pad(i + 1)}`,
        players: players.get(i + 1)!
      },
      home: {
        id: teams[i],
        name: `Load team${pad(i)}`,
        players: players.get(i)!
      }
    })
  return { seasons, teams, sides }
}

/**
 * The live games, each with a scorekeeper. The first is the crowded game. The
 * last, which few watch, is the long one: a game every play record version
 * replays in, far into extra innings, with relievers and corrections on record.
 */
async function seedLiveGames(seeder: Seeder, groups: Groups): Promise<void> {
  const { amounts } = seeder
  if (groups.sides.length < amounts.liveGames)
    throw new Error(
      `${amounts.teams} teams cannot play ${amounts.liveGames} games at once`
    )
  for (let i = 0; i < amounts.liveGames; i++) {
    const sides = groups.sides[i]
    const seasonId = groups.seasons[i % groups.seasons.length]
    const id = await seeder.game(
      `live${pad(i)}`,
      sides.home.id,
      sides.away.id,
      seasonId,
      'inProgress',
      seeder.now
    )
    const scorekeeper = await seeder.account(
      `scorekeeper${pad(i)}`,
      'scorekeeper',
      {
        teamId: sides.home.id,
        gameIndex: i
      }
    )
    await seeder.grant(scorekeeper.userId, 'team', sides.home.id, 'scorekeeper')
    seeder.games.push({ id, sides, seasonId, scorekeeper: scorekeeper.label })
    if (i === amounts.liveGames - 1) {
      const written = await scriptedGame(id, sides, {
        innings: amounts.longGameInnings,
        final: false,
        random: seeder.random('longGame'),
        reliefEvery: 6,
        correctEvery: 25
      })
      await seeder.postGame(id, written)
      // Every write stores a record in today's version, so the two older ones
      // go in as the builds that wrote them left them, for a replay to read.
      for (const version of [1, 2] as const) {
        const older = asOlderRecord(written.plays[version - 1], sides, version)
        await sql`
          update events set gumbo = ${JSON.stringify(older)}::jsonb
          where "gameId" = ${id} and "atBatIndex" = ${version - 1}
        `.execute(seeder.db)
      }
    }
  }
}

async function seedVideographers(seeder: Seeder): Promise<void> {
  const labels = Array.from(
    { length: seeder.videographers },
    (_, i) => `videographer${pad(i)}`
  )
  await inTurn(labels, CONCURRENCY, async (label, i) => {
    const gameIndex = i % seeder.games.length
    const teamId = seeder.games[gameIndex].sides.home.id
    const account = await seeder.account(label, 'videographer', {
      teamId,
      gameIndex
    })
    await seeder.grant(account.userId, 'team', teamId, 'videographer')
  })
}

/**
 * Who watches which game: the crowded game gets its own number, and the others
 * fall away as one over their place, so some games have hundreds and most few.
 */
export function gameOfViewer(
  index: number,
  accounts: number,
  crowded: number,
  games: number
): number {
  if (index < crowded || games <= 1) return 0
  const weights = Array.from({ length: games - 1 }, (_, i) => 1 / (i + 1))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let at = ((index - crowded) / Math.max(1, accounts - crowded)) * total
  for (const [i, weight] of weights.entries()) {
    at -= weight
    if (at < 0) return i + 1
  }
  return games - 1
}

async function seedViewers(seeder: Seeder): Promise<void> {
  const { amounts } = seeder
  const indexes = Array.from({ length: amounts.accounts }, (_, i) => i)
  await inTurn(indexes, CONCURRENCY, async i => {
    const gameIndex = gameOfViewer(
      i,
      amounts.accounts,
      amounts.crowdedViewers,
      seeder.games.length
    )
    await seeder.account(`viewer${pad(i)}`, 'viewer', {
      teamId: seeder.games[gameIndex].sides.home.id,
      gameIndex
    })
  })
}

/** Every kind of person the permission checks have to answer for. */
async function seedKinds(seeder: Seeder, groups: Groups): Promise<void> {
  const { db } = seeder
  const teamId = groups.teams[0]
  const seasonId = groups.seasons[0]
  const league = await db
    .selectFrom('seasons')
    .select('league_id')
    .where('id', '=', seasonId)
    .executeTakeFirstOrThrow()
  const leagueId = league.league_id as string

  await seeder.account('person.admin', 'person', { admin: true })
  await seeder.account('person.stranger', 'person')
  const coach = await seeder.account('person.coach', 'person')
  await seeder.grant(coach.userId, 'team', teamId, 'coach')
  const scorer = await seeder.account('person.scorekeeper', 'person')
  await seeder.grant(scorer.userId, 'team', teamId, 'scorekeeper')
  await seeder.account('person.teamMember', 'person', { teamId })
  const seasonMember = await seeder.account('person.seasonMember', 'person')
  await joinScope(db, 'season', seasonId, seasonMember.userId)
  const leagueMember = await seeder.account('person.leagueMember', 'person')
  await joinScope(db, 'league', leagueId, leagueMember.userId)
  const seasonRole = await seeder.account('person.seasonRole', 'person')
  await seeder.grant(seasonRole.userId, 'season', seasonId, 'coach')
  const leagueRole = await seeder.account('person.leagueRole', 'person')
  await seeder.grant(leagueRole.userId, 'league', leagueId, 'coach')

  const guardian = await seeder.account('person.guardian', 'person')
  const [child] = await seeder.chain('person.child', 0, teamId)
  await atomic(db, async trx => {
    await linkGuardian(trx, child, guardian.userId, teamId, null)
  })

  const merged = await seeder.account('person.merged', 'person')
  const kept = await seeder.account('person.mergedKept', 'person')
  await closeInto(db, merged.userId, kept.userId)

  const disabled = await seeder.account('person.disabled', 'person')
  await db
    .updateTable('users')
    .set({ disabled_at: seeder.now })
    .where('id', '=', disabled.userId)
    .execute()

  const revoked = await seeder.account('person.revokedSession', 'person')
  await revokeSession(db, revoked.token)

  const expiredId = await seeder.person('person.expiredSession', {
    account: true
  })
  const expired = await createSession(db, expiredId, USER_AGENT, { days: -1 })
  seeder.accounts.push({
    label: 'person.expiredSession',
    kind: 'person',
    userId: expiredId,
    token: expired.token,
    teamId: null,
    gameIndex: null
  })

  const tokenHolder = await seeder.person('person.apiToken', { account: true })
  const apiToken = makeToken()
  await db
    .insertInto('api_tokens')
    .values({
      id: makeId('apiToken'),
      user_id: tokenHolder,
      label: 'dbload',
      token_hash: hashToken(apiToken),
      created_at: seeder.now
    })
    .execute()
  seeder.accounts.push({
    label: 'person.apiToken',
    kind: 'person',
    userId: tokenHolder,
    token: apiToken,
    teamId: null,
    gameIndex: null
  })

  const keyHolder = await seeder.person('person.userKey', { account: true })
  const userKey = `${USER_API_KEY_PREFIX}${makeToken()}`
  await db
    .insertInto('user_api_keys')
    .values({
      id: makeId('userApiKey'),
      user_id: keyHolder,
      name: 'dbload',
      token_hash: hashToken(userKey),
      secret_sealed: sealSecret(randomBytes(32).toString('hex'), userKey),
      permissions: ['games:read']
    })
    .execute()
  seeder.accounts.push({
    label: 'person.userKey',
    kind: 'person',
    userId: keyHolder,
    token: userKey,
    teamId: null,
    gameIndex: null
  })
}

/** The worst-case people, signed in as the survivors of their merges. */
async function seedWorstPeople(seeder: Seeder, groups: Groups): Promise<void> {
  const { amounts, db } = seeder

  const mergedInto = await seeder.person('worst.mergedMany', { account: true })
  for (let i = 0; i < amounts.mergedRows; i++) {
    const row = await seeder.person(`worst.mergedMany.row${pad(i)}`)
    await closeInto(db, row, mergedInto)
  }
  await seeder.signIn('worst.mergedMany', 'worstCase', mergedInto)

  const chain = await seeder.chain('worst.chain', amounts.chainDepth)
  await seeder.signIn('worst.chain', 'worstCase', chain[chain.length - 1])

  const guardian = await seeder.account('worst.guardian', 'worstCase')
  const guardedTeam = await seeder.team('worst.guardedTeam', groups.seasons[0])
  for (let i = 0; i < amounts.guardianChildren; i++) {
    const rows = await seeder.chain(
      `worst.child${pad(i)}`,
      amounts.guardianChildDepth,
      guardedTeam
    )
    await atomic(db, async trx => {
      await linkGuardian(
        trx,
        rows[rows.length - 1],
        guardian.userId,
        guardedTeam,
        null
      )
    })
  }

  const rolePerson = await seeder.account('worst.manyRoles', 'worstCase')
  for (let i = 0; i < amounts.roleLeagues; i++) {
    const league = await seeder.league(`worst.roleLeague${pad(i)}`)
    await seeder.grant(rolePerson.userId, 'league', league, 'coach')
    if (i === 0) {
      for (let s = 0; s < amounts.roleSeasons; s++) {
        const season = await seeder.season(`worst.roleSeason${pad(s)}`, league)
        await seeder.grant(rolePerson.userId, 'season', season, 'coach')
      }
    }
  }
  for (let i = 0; i < amounts.roleTeams; i++) {
    const team = await seeder.team(`worst.roleTeam${pad(i)}`)
    await seeder.grant(rolePerson.userId, 'team', team, 'coach')
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: rolePerson.userId,
        team_id: team,
        role: 'manager'
      })
      .execute()
  }

  const largeLeague = await seeder.league('worst.largeLeague')
  const largeSeasons: string[] = []
  for (let i = 0; i < amounts.largeLeagueSeasons; i++)
    largeSeasons.push(
      await seeder.season(`worst.largeSeason${pad(i)}`, largeLeague)
    )
  const teamIndexes = Array.from(
    { length: amounts.largeLeagueTeams },
    (_, i) => i
  )
  await inTurn(teamIndexes, CONCURRENCY, async i => {
    await seeder.team(
      `worst.largeTeam${pad(i)}`,
      largeSeasons[i % largeSeasons.length]
    )
  })
  const leagueMember = await seeder.account('worst.largeMember', 'worstCase')
  await joinScope(db, 'league', largeLeague, leagueMember.userId)

  const sessions = await seeder.account('worst.manySessions', 'worstCase')
  for (let i = 1; i < amounts.manySessions; i++)
    await createSession(db, sessions.userId, USER_AGENT)
}

/** Teams typed in again and again, then merged, and a chain of those merges. */
async function seedWorstTeams(seeder: Seeder, groups: Groups): Promise<void> {
  const { amounts, db } = seeder
  const season = groups.seasons[0]
  const kept = await seeder.team('worst.teamKept', season)
  const opponent = await seeder.team('worst.teamOpponent', season)
  for (let i = 0; i < amounts.duplicateTeams; i++) {
    const copy = await seeder.team(
      `worst.teamCopy${pad(i)}`,
      season,
      'external'
    )
    await seeder.game(
      `worst.teamCopy${pad(i)}.game`,
      copy,
      opponent,
      season,
      'scheduled',
      new Date(seeder.now.getTime() + (i + 1) * 3_600_000)
    )
    await mergeTeams(db, { fromTeamId: copy, intoTeamId: kept, apply: true })
  }
  const chain: string[] = []
  for (let i = 0; i <= amounts.teamChainDepth; i++)
    chain.push(await seeder.team(`worst.teamChain${pad(i)}`, season))
  for (let i = 0; i < amounts.teamChainDepth; i++)
    await mergeTeams(db, {
      fromTeamId: chain[i],
      intoTeamId: chain[i + 1],
      apply: true
    })
}

/** One finished game through the real paths, ready to be cloned. */
async function writtenGame(
  seeder: Seeder,
  label: string,
  sides: GameSides,
  seasonId: string | null,
  daysAgo: number,
  innings = 9
): Promise<string> {
  const id = await seeder.game(
    label,
    sides.home.id,
    sides.away.id,
    seasonId,
    'scheduled',
    new Date(seeder.now.getTime() - daysAgo * 86_400_000)
  )
  await seeder.postGame(
    id,
    await scriptedGame(id, sides, {
      innings,
      final: true,
      random: seeder.random(label)
    })
  )
  return id
}

/**
 * Finished games, whose stats the builder writes as it would have, then the
 * history that only has to be there. The live teams never played these: a game
 * is cloned under the teams of a pair the live games do not use, if any.
 */
async function seedFinished(seeder: Seeder, groups: Groups): Promise<void> {
  const { amounts, db } = seeder
  const season = groups.seasons[0]
  const home = await seeder.team('finished.home', season)
  const away = await seeder.team('finished.away', season)
  const sides: GameSides = {
    home: {
      id: home,
      name: 'Load finished.home',
      players: await seeder.roster('finished.home', home)
    },
    away: {
      id: away,
      name: 'Load finished.away',
      players: await seeder.roster('finished.away', away)
    }
  }
  const written: string[] = []
  for (let i = 0; i < amounts.writtenFinishedGames; i++)
    written.push(
      await writtenGame(seeder, `finished${pad(i)}`, sides, season, i + 1)
    )
  const clones = Math.max(0, amounts.finishedGames - written.length)
  const finished = [...written]
  for (const [i, source] of written.entries()) {
    const share =
      Math.floor(clones / written.length) +
      (i < clones % written.length ? 1 : 0)
    finished.push(
      ...(await seeder.cloneGames(
        source,
        `finished${pad(i)}.copy`,
        share,
        written.length + 1 + i * 1000
      ))
    )
  }
  await inTurn(finished, CONCURRENCY, async id => {
    await requestGameStats(db, id)
  })
  await drain(db, () => new Date())
  if (amounts.historyGames > 0) {
    const short = await writtenGame(
      seeder,
      'history.source',
      sides,
      season,
      9_000,
      amounts.historyInnings
    )
    await seeder.cloneGames(short, 'history', amounts.historyGames, 10_000)
  }
}

/** The fresh copies of each shape an event uses up, one for each use. */
async function seedConsumables(seeder: Seeder, groups: Groups): Promise<void> {
  const { amounts, db } = seeder
  const season = groups.seasons[0]
  for (let c = 0; c < amounts.consumableCopies; c++) {
    const home = await seeder.team(`teamMerge.${c}.from`, season)
    const away = await seeder.team(`teamMerge.${c}.opponent`, season)
    await seeder.team(`teamMerge.${c}.into`, season)
    const sides: GameSides = {
      home: {
        id: home,
        name: `Load teamMerge ${c} from`,
        players: await seeder.roster(`teamMerge.${c}.from`, home)
      },
      away: {
        id: away,
        name: `Load teamMerge ${c} opponent`,
        players: await seeder.roster(`teamMerge.${c}.opponent`, away)
      }
    }
    const source = await writtenGame(
      seeder,
      `teamMerge.${c}.game`,
      sides,
      season,
      1
    )
    await seeder.cloneGames(
      source,
      `teamMerge.${c}.copy`,
      amounts.longTeamGames - 1,
      2 + c * 1000
    )
    await seeder.copy('teamMerge', c)

    await seeder.chain(`personMerge.${c}.chain`, amounts.chainDepth)
    await seeder.person(`personMerge.${c}.keep`)
    await seeder.copy('personMerge', c)

    const signingOut = await seeder.person(`signOut.${c}.person`, {
      account: true
    })
    for (let i = 0; i < amounts.manySessions; i++)
      await createSession(db, signingOut, USER_AGENT)
    await seeder.copy('signOut', c)

    await seeder.copy('statsRebuild', c)

    for (let i = 0; i < amounts.chatAddPeople; i++)
      await seeder.person(`chatAdd.${c}.person${pad(i)}`, { account: true })
    await seeder.copy('chatAdd', c)
  }
}

/** The team chats, the large chat, the person in many chats, and the DMs. */
async function seedChats(seeder: Seeder, groups: Groups): Promise<void> {
  const { amounts, db } = seeder
  const viewers = seeder.accounts.filter(account => account.kind === 'viewer')

  const largeTeam = await seeder.team('chat.largeTeam', groups.seasons[0])
  const largeMembers = viewers.slice(0, amounts.largeChatMembers)
  await inTurn(largeMembers, CONCURRENCY, async member => {
    await joinScope(db, 'team', largeTeam, member.userId)
  })
  const large = await reconcileScope(db, 'teamMembers', largeTeam, seeder.now)
  if (large.conversationId == null) throw new Error('The large chat has no one')
  await seeder.tag('conversation', 'chat.large', large.conversationId)
  if (largeMembers.length > 0)
    await seeder.speak(
      large.conversationId,
      largeMembers[0].userId,
      amounts.largeChatMessages
    )

  const inMany = await seeder.account('worst.manyChats', 'worstCase')
  for (let i = 0; i < amounts.manyChats; i++) {
    const team = await seeder.team(`chat.manyTeam${pad(i)}`, groups.seasons[0])
    await joinScope(db, 'team', team, inMany.userId)
    const chat = await reconcileScope(db, 'teamMembers', team, seeder.now)
    if (chat.conversationId != null)
      await seeder.tag(
        'conversation',
        `chat.many${pad(i)}`,
        chat.conversationId
      )
  }

  // Each team's chat, with a little history from a viewer on it.
  for (const [i, teamId] of groups.teams.entries()) {
    const chat = await reconcileScope(db, 'teamMembers', teamId, seeder.now)
    if (chat.conversationId == null) continue
    await seeder.tag('conversation', `chat.team${pad(i)}`, chat.conversationId)
    const speaker = viewers.find(viewer => viewer.teamId === teamId)
    if (speaker != null)
      await seeder.speak(chat.conversationId, speaker.userId, 3)
  }

  // Direct messages between neighbours on one team, who share its chat.
  const byTeam = new Map<string, SeededAccount[]>()
  for (const viewer of viewers) {
    const on = byTeam.get(viewer.teamId ?? '') ?? []
    on.push(viewer)
    byTeam.set(viewer.teamId ?? '', on)
  }
  const pairs: Array<[SeededAccount, SeededAccount]> = []
  const wanted = Math.floor((amounts.accounts * amounts.dmShare) / 2)
  for (const members of byTeam.values())
    for (let i = 0; i + 1 < members.length && pairs.length < wanted; i += 2)
      pairs.push([members[i], members[i + 1]])
  for (const [i, [a, b]] of pairs.entries()) {
    const dm = await createDm(db, a.userId, [b.userId], seeder.now)
    await seeder.tag('conversation', `chat.dm${pad(i)}`, dm.conversationId)
    await seeder.speak(dm.conversationId, a.userId, amounts.messagesPerDm)
  }
}

/**
 * Puts worst-case people where they can watch something: the first few on the
 * crowded game's team, and the rest on the long game's.
 */
async function placeWorstPeople(seeder: Seeder): Promise<void> {
  const worst = seeder.accounts
    .filter(account => account.kind === 'worstCase')
    .sort((a, b) => (a.label < b.label ? -1 : 1))
  for (const [i, account] of worst.entries()) {
    const gameIndex =
      i < seeder.amounts.crowdedWorstCaseViewers ? 0 : seeder.games.length - 1
    const teamId = seeder.games[gameIndex].sides.home.id
    await joinScope(seeder.db, 'team', teamId, account.userId)
    account.teamId = teamId
    account.gameIndex = gameIndex
  }
}

/**
 * Viewers in order with every twentieth place a worst-case account, while they
 * last, so any number of the first accounts is 5% worst-case people. The rest
 * of the accounts follow, as the rig reads them by kind.
 */
export function interleaved(accounts: SeededAccount[]): SeededAccount[] {
  // They were made side by side, in whatever order those writes finished.
  const inOrder = [...accounts].sort((a, b) => (a.label < b.label ? -1 : 1))
  const viewers = inOrder.filter(account => account.kind === 'viewer')
  const worst = inOrder.filter(account => account.kind === 'worstCase')
  const rest = inOrder.filter(
    account => account.kind !== 'viewer' && account.kind !== 'worstCase'
  )
  const mixed: SeededAccount[] = []
  while (viewers.length > 0 || worst.length > 0) {
    if (worst.length > 0 && (mixed.length % 20 === 19 || viewers.length === 0))
      mixed.push(worst.shift()!)
    else mixed.push(viewers.shift()!)
  }
  return [...mixed, ...rest]
}

/** Seeds a run. Refuses a database that is not marked as generated. */
export async function seedFixture(
  db: LoadDatabase,
  options: SeedOptions
): Promise<TokensFile> {
  await requireLoadDatabase(
    async text =>
      await sql
        .raw<{
          comment: string | null
          name: string
        }>(text)
        .execute(db)
  )
  const amounts = amountsFor(options.scale, options.overrides)
  const videographers = Math.max(
    amounts.videographers,
    Math.ceil((options.streams ?? 0) / 4)
  )
  const log = options.log ?? (() => undefined)
  const seeder = new Seeder(
    db,
    options.runId,
    options.scale,
    amounts,
    videographers,
    options.now,
    log
  )
  const step = async (
    name: string,
    work: () => Promise<void>
  ): Promise<void> => {
    const started = Date.now()
    await work()
    await seeder.flushTags()
    log(`seeded ${name} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
  try {
    const groups = await seedGroups(seeder)
    await seeder.flushTags()
    await step('live games', async () => {
      await seedLiveGames(seeder, groups)
    })
    await step('videographers', async () => {
      await seedVideographers(seeder)
    })
    await step('viewers', async () => {
      await seedViewers(seeder)
    })
    await step('kinds of person', async () => {
      await seedKinds(seeder, groups)
    })
    await step('worst-case people', async () => {
      await seedWorstPeople(seeder, groups)
    })
    await step('worst-case teams', async () => {
      await seedWorstTeams(seeder, groups)
    })
    await step('finished games and history', async () => {
      await seedFinished(seeder, groups)
    })
    await step('consumable shapes', async () => {
      await seedConsumables(seeder, groups)
    })
    await step('chats', async () => {
      await seedChats(seeder, groups)
      await placeWorstPeople(seeder)
    })
    seeder.accounts.splice(
      0,
      seeder.accounts.length,
      ...interleaved(seeder.accounts)
    )
    return seeder.tokens()
  } finally {
    await seeder.flushTags()
    if (options.tokensPath != null)
      writeTokens(options.tokensPath, seeder.tokens())
  }
}

/** The ids a run tagged under `kind`, by label. */
export async function taggedIn(
  db: Kysely<Database>,
  runId: string,
  kind: string
): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('external_ids')
    .select(['external_id', 'entity_id'])
    .where('system', '=', systemOf(runId))
    .where('kind', '=', kind)
    .execute()
  return new Map(rows.map(row => [row.external_id, row.entity_id]))
}

/** The foreign keys that would refuse a delete of the rows they point at. */
async function blockers(
  db: Kysely<Database>,
  table: string
): Promise<
  Array<{
    child: string
    column: string
    references: string
    selfReference: boolean
  }>
> {
  const { rows } = await sql<{
    child: string
    column: string
    references: string
  }>`
    select child.relname as child, fk.attname as column, pk.attname as references
    from pg_constraint c
    join pg_class child on child.oid = c.conrelid
    join pg_class parent on parent.oid = c.confrelid
    join pg_attribute fk on fk.attrelid = c.conrelid and fk.attnum = c.conkey[1]
    join pg_attribute pk on pk.attrelid = c.confrelid and pk.attnum = c.confkey[1]
    where c.contype = 'f' and c.confdeltype in ('a', 'r')
      and cardinality(c.conkey) = 1 and parent.relname = ${table}
  `.execute(db)
  return rows.map(row => ({ ...row, selfReference: row.child === table }))
}

/**
 * Deletes rows, first deleting what would refuse it: whatever else a server
 * wrote about these rows during the run, so the delete does not depend on
 * knowing every table. Nothing else can point at a row only this run made.
 */
async function deleteRows(
  db: Kysely<Database>,
  table: string,
  column: string,
  values: readonly string[]
): Promise<void> {
  if (values.length === 0) return
  for (const blocker of await blockers(db, table)) {
    if (blocker.selfReference) continue
    const { rows } = await sql<{ value: string }>`
      select ${sql.ref(blocker.child)}.${sql.ref(blocker.column)}::text as value
      from ${sql.table(blocker.child)}
      where ${sql.ref(blocker.column)}::text = any(${values.map(String)}::text[])
      limit 1
    `.execute(db)
    if (rows.length > 0)
      await deleteDependents(db, blocker.child, blocker.column, values)
  }
  await sql`
    delete from ${sql.table(table)}
    where ${sql.ref(column)}::text = any(${values.map(String)}::text[])
  `.execute(db)
}

async function deleteDependents(
  db: Kysely<Database>,
  table: string,
  column: string,
  values: readonly string[]
): Promise<void> {
  for (const blocker of await blockers(db, table)) {
    if (blocker.selfReference) continue
    const { rows } = await sql<{ value: string }>`
      select ${sql.ref(blocker.references)}::text as value
      from ${sql.table(table)}
      where ${sql.ref(column)}::text = any(${values.map(String)}::text[])
    `.execute(db)
    await deleteRows(
      db,
      blocker.child,
      blocker.column,
      rows.map(row => row.value)
    )
  }
  await sql`
    delete from ${sql.table(table)}
    where ${sql.ref(column)}::text = any(${values.map(String)}::text[])
  `.execute(db)
}

/**
 * Removes exactly the rows of one run: its conversations, the games of its
 * teams, its teams, seasons and leagues, its people, and its tags. Cascades
 * take what hangs off them.
 */
export async function cleanupRun(
  db: LoadDatabase,
  runId: string
): Promise<{ removed: Record<string, number> }> {
  await requireLoadDatabase(
    async text =>
      await sql
        .raw<{
          comment: string | null
          name: string
        }>(text)
        .execute(db)
  )
  const ids = async (kind: string): Promise<string[]> => [
    ...(await taggedIn(db, runId, kind)).values()
  ]
  const conversations = await ids('conversation')
  const users = await ids('user')
  const teams = await ids('team')
  const seasons = await ids('season')
  const leagues = await ids('league')
  const runTeams = sql.join(teams.length > 0 ? teams : [''])
  const games = await sql<{ id: string }>`
    select id from games
    where home_team_id in (${runTeams}) or away_team_id in (${runTeams})
  `.execute(db)
  const gameIds = [
    ...new Set([...(await ids('game')), ...games.rows.map(row => row.id)])
  ]

  // The chats of the run's teams and people, tagged or made by a reconcile since.
  const held = await sql<{ id: string }>`
    select id from chat_conversations
    where scope_id in (${sql.join([...teams, ...seasons, ...leagues, ''])})
  `.execute(db)
  const allConversations = [
    ...new Set([...conversations, ...held.rows.map(row => row.id)])
  ]
  await deleteRows(db, 'chat_conversations', 'id', allConversations)
  if (users.length > 0)
    await sql`
      delete from chat_conversations where created_by = any(${users}::text[])
    `.execute(db)
  await deleteRows(db, 'chat_identities', 'user_id', users)
  if (gameIds.length > 0)
    await db.deleteFrom('videos').where('game_id', 'in', gameIds).execute()
  await deleteRows(db, 'games', 'id', gameIds)
  await deleteRows(db, 'teams', 'id', teams)
  await deleteRows(db, 'seasons', 'id', seasons)
  await deleteRows(db, 'leagues', 'id', leagues)
  await deleteRows(db, 'users', 'id', users)
  await db
    .deleteFrom('external_ids')
    .where('system', '=', systemOf(runId))
    .execute()
  return {
    removed: {
      users: users.length,
      teams: teams.length,
      seasons: seasons.length,
      leagues: leagues.length,
      games: gameIds.length,
      conversations: allConversations.length
    }
  }
}

/** The depth of the chain of merges above a row. */
async function depthOf(
  db: Kysely<Database>,
  table: 'users' | 'teams',
  id: string
): Promise<number> {
  let depth = 0
  let at: string | null = id
  while (at != null) {
    const row: { merged_into: string | null } | undefined = await db
      .selectFrom(table)
      .select('merged_into')
      .where('id', '=', at)
      .executeTakeFirst()
    at = row?.merged_into ?? null
    if (at != null) depth += 1
  }
  return depth
}

export interface Shapes {
  mergedRows: number
  chainDepth: number
  guardianChildren: number
  guardianChildDepths: number[]
  roleTeams: number
  roleSeasons: number
  roleLeagues: number
  largeLeagueSeasons: number
  largeLeagueTeams: number
  duplicateTeams: number
  teamChainDepth: number
  longTeamGames: number[]
  longGame: {
    plays: number
    innings: number
    recordVersions: number[]
    lineupChanges: number
  }
  crowdedViewers: number
  largeChatMembers: number
  largeChatMessages: number
  manyChats: number
  manySessions: number
  finishedGames: number
  statsBuilt: number
  historyGames: number
  kinds: string[]
  copies: Record<string, number>
}

/**
 * What a run's data reads back as, through the rows rather than what the seed
 * meant to write, in terms of labels and counts, so that two seeds compare.
 */
export async function describeShapes(
  db: Kysely<Database>,
  runId: string,
  tokens: TokensFile
): Promise<Shapes> {
  const users = await taggedIn(db, runId, 'user')
  const teams = await taggedIn(db, runId, 'team')
  const games = await taggedIn(db, runId, 'game')
  const leagues = await taggedIn(db, runId, 'league')
  const seasons = await taggedIn(db, runId, 'season')
  const copies = await taggedIn(db, runId, 'copy')
  const labelled = (labels: Map<string, string>, prefix: string): string[] =>
    [...labels.entries()]
      .filter(([label]) => label.startsWith(prefix))
      .map(([, id]) => id)
  const count = async (query: {
    executeTakeFirstOrThrow: () => Promise<{ n: unknown }>
  }): Promise<number> => Number((await query.executeTakeFirstOrThrow()).n)

  const mergedInto = users.get('worst.mergedMany') ?? ''
  const mergedRows = await count(
    db
      .selectFrom('users')
      .select(eb => eb.fn.countAll().as('n'))
      .where('merged_into', '=', mergedInto)
  )

  const guardian = users.get('worst.guardian') ?? ''
  const guarded = await db
    .selectFrom('user_links')
    .select('related_user_id')
    .where('user_id', '=', guardian)
    .where('kind', '=', 'guardian')
    .execute()
  const childLabels = [...users.keys()].filter(label =>
    /^worst\.child\d+\.row00000$/.test(label)
  )
  const guardianChildDepths = await Promise.all(
    childLabels.sort().map(async label => {
      return await depthOf(db, 'users', users.get(label)!)
    })
  )

  const rolePerson = users.get('worst.manyRoles') ?? ''
  const roleRows = await db
    .selectFrom('scope_roles')
    .select('scope_type')
    .where('user_id', '=', rolePerson)
    .execute()
  const roleCount = (kind: string): number =>
    roleRows.filter(row => row.scope_type === kind).length

  const largeSeasons = labelled(seasons, 'worst.largeSeason')
  const largeLeagueTeams =
    largeSeasons.length === 0
      ? 0
      : await count(
          db
            .selectFrom('season_teams')
            .select(eb => eb.fn.countAll().as('n'))
            .where('season_id', 'in', largeSeasons)
        )

  const kept = teams.get('worst.teamKept') ?? ''
  const duplicateTeams = await count(
    db
      .selectFrom('teams')
      .select(eb => eb.fn.countAll().as('n'))
      .where('merged_into', '=', kept)
  )

  const copyKeys = [...copies.keys()].filter(key =>
    key.startsWith('teamMerge.')
  )
  const longTeamGames = await Promise.all(
    copyKeys.sort().map(async key => {
      const teamId = teams.get(`${key}.from`) ?? ''
      return await count(
        db
          .selectFrom('games')
          .select(eb => eb.fn.countAll().as('n'))
          .where(eb =>
            eb.or([
              eb('home_team_id', '=', teamId),
              eb('away_team_id', '=', teamId)
            ])
          )
      )
    })
  )

  const longId = tokens.games[tokens.games.length - 1]?.id ?? ''
  const longPlays = await db
    .selectFrom('events')
    .select(['gumbo', 'inning'])
    .where('gameId', '=', longId)
    .execute()
  const recordVersions = new Set<number>()
  let lineupChanges = 0
  for (const play of longPlays) {
    const record = (
      play.gumbo as unknown as {
        teamStation?: { version?: number; actions?: Array<{ type?: string }> }
      }
    ).teamStation
    if (record?.version != null) recordVersions.add(record.version)
    lineupChanges +=
      record?.actions?.filter(action => action.type === 'lineup').length ?? 0
  }

  const crowdedTeam = tokens.games[0]?.sides.home.id ?? ''
  const crowdedViewers = await count(
    db
      .selectFrom('memberships')
      .select(eb => eb.fn.countAll().as('n'))
      .where('team_id', '=', crowdedTeam)
      .where('is_player', '=', false)
  )

  const conversations = await taggedIn(db, runId, 'conversation')
  const large = conversations.get('chat.large') ?? ''
  const largeChatMembers = await count(
    db
      .selectFrom('chat_members')
      .select(eb => eb.fn.countAll().as('n'))
      .where('conversation_id', '=', large)
      .where('left_at', 'is', null)
  )
  const largeChatMessages = await count(
    db
      .selectFrom('chat_messages')
      .select(eb => eb.fn.countAll().as('n'))
      .where('conversation_id', '=', large)
  )
  const inMany = users.get('worst.manyChats') ?? ''
  const manyChats = await count(
    db
      .selectFrom('chat_members')
      .select(eb => eb.fn.countAll().as('n'))
      .where('user_id', '=', inMany)
      .where('left_at', 'is', null)
  )
  const manySessions = await count(
    db
      .selectFrom('auth_sessions')
      .select(eb => eb.fn.countAll().as('n'))
      .where('user_id', '=', users.get('worst.manySessions') ?? '')
      .where('revoked_at', 'is', null)
  )

  const finishedIds = labelled(games, 'finished')
  const statsBuilt =
    finishedIds.length === 0
      ? 0
      : await count(
          db
            .selectFrom('game_stats_state')
            .select(eb => eb.fn.countAll().as('n'))
            .where('game_id', 'in', finishedIds)
            .where('status', '=', 'built')
        )

  const copyCounts: Record<string, number> = {}
  for (const key of copies.keys()) {
    const [kind] = key.split('.')
    copyCounts[kind] = (copyCounts[kind] ?? 0) + 1
  }

  return {
    mergedRows,
    chainDepth: await depthOf(
      db,
      'users',
      users.get('worst.chain.row00000') ?? ''
    ),
    guardianChildren: guarded.length,
    guardianChildDepths,
    roleTeams: roleCount('team'),
    roleSeasons: roleCount('season'),
    roleLeagues: roleCount('league'),
    largeLeagueSeasons: largeSeasons.length,
    largeLeagueTeams,
    duplicateTeams,
    teamChainDepth: await depthOf(
      db,
      'teams',
      teams.get('worst.teamChain00000') ?? ''
    ),
    longTeamGames,
    longGame: {
      plays: longPlays.length,
      innings: Math.max(0, ...longPlays.map(play => play.inning ?? 0)),
      recordVersions: [...recordVersions].sort(),
      lineupChanges
    },
    crowdedViewers,
    largeChatMembers,
    largeChatMessages,
    manyChats,
    manySessions,
    finishedGames: finishedIds.length,
    statsBuilt,
    historyGames: labelled(games, 'history.').length - 1,
    kinds: [...users.keys()]
      .filter(label => label.startsWith('person.'))
      .filter(label => !label.includes('.row'))
      .sort(),
    copies: copyCounts
  }
}

/** Fails unless every shape reads back in the amounts the table says. */
export function verifyShapes(shapes: Shapes, amounts: Amounts): void {
  const wrong: string[] = []
  const expect = (name: string, actual: unknown, wanted: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted))
      wrong.push(
        `${name}: ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`
      )
  }
  expect('merged rows', shapes.mergedRows, amounts.mergedRows)
  expect('chain depth', shapes.chainDepth, amounts.chainDepth)
  expect('guarded children', shapes.guardianChildren, amounts.guardianChildren)
  expect(
    'guarded children depths',
    shapes.guardianChildDepths,
    Array.from(
      { length: amounts.guardianChildren },
      () => amounts.guardianChildDepth
    )
  )
  expect('role teams', shapes.roleTeams, amounts.roleTeams)
  expect('role seasons', shapes.roleSeasons, amounts.roleSeasons)
  expect('role leagues', shapes.roleLeagues, amounts.roleLeagues)
  expect(
    'large league seasons',
    shapes.largeLeagueSeasons,
    amounts.largeLeagueSeasons
  )
  expect(
    'large league teams',
    shapes.largeLeagueTeams,
    amounts.largeLeagueTeams
  )
  expect('duplicate teams', shapes.duplicateTeams, amounts.duplicateTeams)
  expect('team chain depth', shapes.teamChainDepth, amounts.teamChainDepth)
  expect(
    'teams with years of games',
    shapes.longTeamGames,
    Array.from(
      { length: amounts.consumableCopies },
      () => amounts.longTeamGames
    )
  )
  expect('long game innings', shapes.longGame.innings, amounts.longGameInnings)
  expect('record versions', shapes.longGame.recordVersions, [1, 2, 3])
  expect(
    'large chat members',
    shapes.largeChatMembers,
    amounts.largeChatMembers
  )
  expect(
    'large chat messages',
    shapes.largeChatMessages,
    amounts.largeChatMessages
  )
  expect('many chats', shapes.manyChats, amounts.manyChats)
  expect('many sessions', shapes.manySessions, amounts.manySessions)
  expect('history', shapes.historyGames, amounts.historyGames)
  if (shapes.crowdedViewers < amounts.crowdedViewers)
    wrong.push(`crowded game: ${shapes.crowdedViewers} viewers`)
  if (wrong.length > 0) throw new Error(`Shapes differ: ${wrong.join('; ')}`)
}

/**
 * Which accounts this process connects: its slice of the first `users` of those
 * who watch one of the first `games`, since a viewer may only see their own.
 */
export function accountsForShard(
  tokens: TokensFile,
  users: number,
  shard: { index: number; count: number } = { index: 0, count: 1 },
  games = tokens.games.length
): SeededAccount[] {
  const connectable = tokens.accounts.filter(
    account =>
      (account.kind === 'viewer' || account.kind === 'worstCase') &&
      (account.gameIndex ?? 0) < games
  )
  if (users > connectable.length)
    throw new Error(
      `--users ${users} is above the ${connectable.length} accounts seeded for ${games} game(s) of run ${tokens.runId}`
    )
  return connectable
    .slice(0, users)
    .filter((_, i) => i % shard.count === shard.index)
}

export function parseShard(text: string): { index: number; count: number } {
  const match = /^(\d+)\/(\d+)$/.exec(text)
  const index = Number(match?.[1])
  const count = Number(match?.[2])
  if (match == null || count < 1 || index >= count)
    throw new Error(`--shard takes i/n with i below n, not ${text}`)
  return { index, count }
}
