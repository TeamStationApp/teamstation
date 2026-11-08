/**
 * Runs the owned chat2 fixture proxy until `cleanup` or a signal, for one
 * disposable fixture. Its private settings name the owned API, media and
 * database, the read cursors to restore, the E10 loop and the locked-probe
 * claims; its `ready.json` is what `chat2FixtureControl.e2e.ts` reads.
 *
 *   node -r sucrase/register src/test/chat2FixtureProxyServe.e2e.ts \
 *     <settings.json> <ready.json>
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { sql } from 'kysely'

import { ChatEngine } from '../app/chat/engine/engine'
import {
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from '../app/chat/keyRecord'
import { TeamStationClient } from '../common/api'
import { passwordBytes } from '../common/passwordProtocol'
import { nativeArgon } from '../server/auth/passwords'
import { DmFacts } from '../server/chat/dms'
import { makeDatabase } from '../server/db/database'
import { chat2FixtureProxy, readJson, writePrivate } from './chat2FixtureProxy'

interface Message {
  id: string
  seq: number
  body: string
  authorId: string
}

export interface Chat2ProxySettings {
  disposable: true
  ownershipId: string
  applicationSource: string
  apiUpstream: string
  mediaUpstream: string
  databaseUrl: string
  /** `<viewerId>:<conversationId>` → the cursor `restore-attention` sets. */
  readCursors: Record<string, number>
  claimsFile: string
  apiPort?: number
  mediaPort?: number
  /** By viewer id: the E10 loop `prepare-loop` and `post-loop` serve. */
  loops: Record<
    string,
    {
      viewerId: string
      viewerName: string
      conversationId: string
      readerAnchor: Message
      ownOriginal: Message
      peer: {
        userId: string
        email: string
        password: string
        keyFile: string
      }
    }
  >
}

async function main(): Promise<void> {
  const [settingsFile, readyFile] = process.argv.slice(2)
  assert(isAbsolute(settingsFile ?? '') && isAbsolute(readyFile ?? ''))
  const settings = readJson<Chat2ProxySettings>(settingsFile)
  assert.equal(settings.disposable, true)
  const database = new URL(settings.databaseUrl)
  assert(['localhost', '127.0.0.1'].includes(database.hostname))
  assert.equal(database.port, '5433', 'Only the local test cluster')
  const db = makeDatabase(settings.databaseUrl)
  const token = randomBytes(32).toString('hex')
  let stop: () => void = () => undefined
  const stopped = new Promise<void>(resolve => {
    stop = resolve
  })
  const proxy = await chat2FixtureProxy({
    ownershipId: settings.ownershipId,
    applicationSource: settings.applicationSource,
    apiUpstream: settings.apiUpstream,
    mediaUpstream: settings.mediaUpstream,
    controlToken: token,
    ...(settings.apiPort == null ? {} : { apiPort: settings.apiPort }),
    ...(settings.mediaPort == null ? {} : { mediaPort: settings.mediaPort }),
    onCleanup: () => {
      stop()
    },
    actions: {
      restoreAttention: async (viewerId, conversationId) => {
        const cursor = settings.readCursors[viewerId + ':' + conversationId]
        assert(Number.isInteger(cursor), 'No recorded cursor for that chat')
        // The API never moves a cursor back; the recorded one is restored.
        await sql`insert into chat_read_cursors (conversation_id, user_id, seq)
          values (${conversationId}, ${viewerId}, ${cursor})
          on conflict (conversation_id, user_id)
          do update set seq = excluded.seq, at = now()`.execute(db)
        return cursor
      },
      setLao: async (playerId, on) => {
        const facts = new DmFacts(db, new Date())
        const seasons = await facts.seasonsOf(await facts.playerTeams(playerId))
        assert(seasons.length > 0, 'The player is on no season')
        const leagues = await db
          .selectFrom('seasons')
          .select(['league_id'])
          .where('id', 'in', seasons)
          .execute()
        const ids = [
          ...new Set(
            leagues.flatMap(row =>
              row.league_id == null ? [] : [row.league_id]
            )
          )
        ]
        await db
          .updateTable('leagues')
          .set({ safesport_lao: on })
          .where('id', 'in', ids)
          .execute()
        return ids
      },
      claimLocked: async detail => {
        const claims = existsSync(settings.claimsFile)
          ? readJson<Record<string, unknown>>(settings.claimsFile)
          : {}
        const key = String(detail.surface) + ':' + String(detail.generation)
        assert(claims[key] == null, 'This locked probe was already used')
        claims[key] = {
          viewerId: detail.viewerId,
          conversationId: detail.conversationId,
          run: detail.run,
          at: new Date().toISOString()
        }
        writeFileSync(settings.claimsFile, JSON.stringify(claims, null, 2), {
          mode: 0o600
        })
      },
      prepareLoop: async viewerId => {
        const loop = settings.loops[viewerId]
        assert(loop != null, 'No loop fixture for this viewer')
        return {
          conversationId: loop.conversationId,
          readerAnchor: loop.readerAnchor,
          ownOriginal: loop.ownOriginal
        }
      },
      postLoop: async viewerId => {
        const loop = settings.loops[viewerId]
        assert(loop != null, 'No loop fixture for this viewer')
        const client = new TeamStationClient({
          baseUrl: new URL('/api/v1', settings.apiUpstream).href,
          passwordKdf: async (password, parameters) =>
            await nativeArgon(passwordBytes(password), parameters)
        })
        await client.signInWithPassword(loop.peer.email, loop.peer.password)
        const store: ChatKeyStore = {
          exists: async () => existsSync(loop.peer.keyFile),
          load: async () =>
            recordFromJson(readFileSync(loop.peer.keyFile, 'utf8')),
          save: async record => {
            writeFileSync(loop.peer.keyFile, recordToJson(record), {
              mode: 0o600
            })
          },
          wipe: async () => {
            throw new Error('The loop peer keeps its identity')
          }
        }
        const engine = new ChatEngine({
          client,
          store,
          userId: loop.peer.userId,
          device: { name: 'Synthetic fixture provider', platform: 'web' }
        })
        try {
          assert.equal(await engine.start(), 'ready')
          await engine.open(loop.conversationId)
          const spacer = 'Spacing row for the reading loop.\n'.repeat(6).trim()
          const targets: Message[] = []
          const shapes = [
            {
              body: `@${loop.viewerName} the loop plan needs you.`,
              mention: true
            },
            { body: 'Replying to your loop note.', quote: true },
            {
              body: `@${loop.viewerName} replying to your loop note.`,
              mention: true,
              quote: true
            }
          ]
          for (const shape of shapes) {
            const sent = await engine.sendText(
              loop.conversationId,
              shape.body,
              {
                ...(shape.mention === true ? { mentions: [viewerId] } : {}),
                ...(shape.quote === true
                  ? { quoteId: loop.ownOriginal.id }
                  : {})
              }
            )
            assert(sent?.seq != null)
            targets.push({
              id: sent.id,
              seq: sent.seq,
              body: shape.body,
              authorId: loop.peer.userId
            })
            // Taller than the widest reading band, so one view never holds
            // two targets: each jump uncovers exactly one.
            for (let index = 0; index < 6; index++)
              assert(
                (await engine.sendText(loop.conversationId, spacer)) != null
              )
          }
          return { targets, expectedCount: 3 }
        } finally {
          engine.stop()
          await engine.idle()
        }
      }
    }
  })
  writePrivate(readyFile, {
    disposable: true,
    ownershipId: settings.ownershipId,
    control: proxy.apiOrigin + '/__chat2_fixture',
    token,
    apiOrigin: proxy.apiOrigin,
    mediaOrigin: proxy.mediaOrigin,
    pid: process.pid
  })
  console.log('READY owned chat2 fixture proxy')
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  await stopped
  await proxy.close()
  await db.destroy()
  console.log('PASS chat2 fixture proxy stopped and its listeners released')
}

main().catch(() => {
  console.error('chat2 fixture proxy failed; inspect the private settings')
  process.exitCode = 1
})
