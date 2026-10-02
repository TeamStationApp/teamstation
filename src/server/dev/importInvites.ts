import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Pool } from 'pg'

import { makeDatabase } from '../db/database'
import {
  createInvite,
  findInviteByCode,
  type InviteScopeType
} from '../invites/invites'
import { serverConfig } from '../serverConfig'

/**
 * PeerTube's channel invite codes, brought across as TeamStation invites.
 *
 *   npm run import-invites -- --dry     (writes nothing)
 *   npm run import-invites
 *   npm run import-invites -- --map /path/to/other.json
 *
 * The codes themselves come over **unchanged**, because they are already out
 * there: `app.teamstation.app/i/tforce26` is in mailboxes, in group chats and
 * on a team sheet, and none of those can be edited. TeamStation serves the
 * same `/i/<code>` path, so those links keep working the day it takes the
 * domain over — which only holds if the code behind them is the same string.
 *
 * Use counts come with them, so a link that 28 families have already used does
 * not read as new. The people who used them are already here: the migration
 * brought PeerTube's channel allow-lists across as season members, and this is
 * about the door staying open, not about who came through it.
 *
 * Which channel maps to which team or season is operational fact, not program
 * logic, so it lives in `peertubeInvites.json` beside this file rather than in
 * the source. A channel is named by what it is called, never by its id: the
 * development and production databases number the same team differently.
 *
 * PeerTube is read and never written. The role this reads through has
 * `SELECT` and nothing else.
 */

interface ChannelMapping {
  channel: string
  scopeType?: InviteScopeType
  scopeName?: string
  scopeId?: string
  skip?: boolean
  why?: string
}

interface PeertubeInvite {
  code: string
  channel: string
  maxUses: number | null
  uses: number
  expiresAt: Date | null
  createdAt: Date
}

function readMap(file: string): ChannelMapping[] {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const channels =
    typeof raw === 'object' && raw !== null
      ? (raw as { channels?: unknown }).channels
      : undefined
  if (!Array.isArray(channels)) {
    throw new Error(`${file}: needs a "channels" array`)
  }
  return channels as ChannelMapping[]
}

async function readPeertubeInvites(url: string): Promise<PeertubeInvite[]> {
  const pool = new Pool({ connectionString: url, max: 2 })
  try {
    const { rows } = await pool.query<{
      code: string
      channel: string
      maxUses: number | null
      uses: number
      expiresAt: Date | null
      createdAt: Date
    }>(`
      select
        i."code"        as "code",
        c."name"        as "channel",
        i."maxUses"     as "maxUses",
        i."uses"        as "uses",
        i."expiresAt"   as "expiresAt",
        i."createdAt"   as "createdAt"
      from "videoChannelInvite" i
      join "videoChannel" c on c.id = i."channelId"
      order by i.id
    `)
    return rows
  } finally {
    await pool.end()
  }
}

async function main(): Promise<void> {
  // `--dry`, not `--dry-run`: npm eats the latter before the script sees it.
  const dryRun = process.argv.includes('--dry')
  const mapAt = process.argv.indexOf('--map')
  const mapFile =
    mapAt === -1
      ? path.join(__dirname, 'peertubeInvites.json')
      : (process.argv[mapAt + 1] ?? '')
  if (mapFile === '') throw new Error('--map needs a file')

  if (serverConfig.peertubeDatabaseUrl === '') {
    throw new Error('peertubeDatabaseUrl is not configured')
  }

  const mappings = readMap(mapFile)
  const invites = await readPeertubeInvites(serverConfig.peertubeDatabaseUrl)
  const db = makeDatabase(serverConfig.databaseUrl)

  console.log(
    dryRun
      ? '=== DRY RUN, nothing written ===\n'
      : '=== importing invites ===\n'
  )
  console.log(`${invites.length} invite codes in PeerTube\n`)

  try {
    for (const invite of invites) {
      const mapping = mappings.find(item => item.channel === invite.channel)
      const say = (what: string): void => {
        console.log(`${invite.code.padEnd(26)} ${invite.channel}: ${what}`)
      }

      if (mapping == null) {
        say('no mapping, left behind')
        continue
      }
      if (mapping.skip === true) {
        say(`left behind — ${mapping.why ?? 'asked for'}`)
        continue
      }
      if (mapping.scopeType == null) {
        say('mapping has no scopeType, left behind')
        continue
      }

      const scopeId = await resolveScope(db, mapping)
      if (scopeId == null) {
        say(`no ${mapping.scopeType} called "${mapping.scopeName ?? ''}"`)
        continue
      }

      const held = await findInviteByCode(db, invite.code)
      if (held != null) {
        say(`already here as ${held.id}`)
        continue
      }

      if (dryRun) {
        say(
          `would become a ${mapping.scopeType} invite to ${
            mapping.scopeName ?? scopeId
          }, ${invite.uses} uses`
        )
        continue
      }

      const made = await createInvite(db, {
        scopeType: mapping.scopeType,
        scopeId,
        // Nobody: PeerTube does not record who made an invite.
        createdBy: null,
        code: invite.code,
        label: invite.channel,
        maxUses: invite.maxUses ?? undefined,
        expiresAt: invite.expiresAt ?? undefined,
        uses: invite.uses,
        createdAt: invite.createdAt,
        source: 'peertube'
      })
      say(
        `→ ${made.id}, a ${mapping.scopeType} invite to ${
          mapping.scopeName ?? scopeId
        }, ${made.uses} uses carried over`
      )
    }
  } finally {
    await db.destroy()
  }
}

/** The team, season or league this channel's invite belongs to. */
async function resolveScope(
  db: ReturnType<typeof makeDatabase>,
  mapping: ChannelMapping
): Promise<string | undefined> {
  if (mapping.scopeId != null) return mapping.scopeId
  if (mapping.scopeName == null || mapping.scopeType == null) return undefined

  if (mapping.scopeType === 'team') {
    const row = await db
      .selectFrom('teams')
      .select(['id'])
      .where('name', '=', mapping.scopeName)
      // Never an opponent: an external team has no members to invite.
      .where('kind', '=', 'full')
      .executeTakeFirst()
    return row?.id
  }
  if (mapping.scopeType === 'season') {
    const row = await db
      .selectFrom('seasons')
      .select(['id'])
      .where('name', '=', mapping.scopeName)
      .executeTakeFirst()
    return row?.id
  }
  const row = await db
    .selectFrom('leagues')
    .select(['id'])
    .where('name', '=', mapping.scopeName)
    .executeTakeFirst()
  return row?.id
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
