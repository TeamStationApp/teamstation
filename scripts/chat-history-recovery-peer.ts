/**
 * The retained peer's part in the native owned-delete-live scenario: once the
 * native runner signals it is watching, the note's author deletes it with the
 * normal author Delete, so the device sees the real socket, pin and quote
 * updates.
 *
 *   node -r sucrase/register scripts/chat-history-recovery-peer.ts <fixture dir>
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Agent, fetch as undiciFetch } from 'undici'

import { ChatEngine } from '../src/app/chat/engine/engine'
import {
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from '../src/app/chat/keyRecord'
import { TeamStationClient } from '../src/common/api'
import { passwordBytes } from '../src/common/passwordProtocol'
import { nativeArgon } from '../src/server/auth/passwords'
import type { RecoveryFixtureOwner } from '../src/test/chatRecoveryFixtureContract'

async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? '')
  const owner = JSON.parse(
    readFileSync(join(out, 'owner.json'), 'utf8')
  ) as RecoveryFixtureOwner
  assert.equal(owner.disposable, true)
  assert(out.startsWith(resolve(owner.artifacts) + '/'))
  const owned = JSON.parse(
    readFileSync(join(out, 'owned-fixture.json'), 'utf8')
  ) as {
    synthetic: true
    conversationId: string
    originalId: string
    authorUserId: string
  }
  assert.equal(owned.synthetic, true)
  const author = Object.values(
    JSON.parse(readFileSync(join(out, 'providers.json'), 'utf8')) as Record<
      string,
      { userId: string; email: string; password: string; keyFile: string }
    >
  ).find(person => person.userId === owned.authorUserId)
  assert(
    author?.email.endsWith('@chat.example.com') === true,
    'The author must be a synthetic provider'
  )
  const ready = join(out, 'owned-ready.json')
  const until = Date.now() + 15 * 60 * 1000
  while (!existsSync(ready)) {
    assert(Date.now() < until, 'The native runner never signalled')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(
    (JSON.parse(readFileSync(ready, 'utf8')) as { ready?: boolean }).ready,
    true
  )
  const connections = new Agent({ pipelining: 0 })
  const client = new TeamStationClient({
    baseUrl: owner.apiUrl,
    fetch: (async (input: string, init?: object) =>
      await undiciFetch(input, {
        ...init,
        dispatcher: connections
      })) as unknown as typeof fetch,
    passwordKdf: async (password, parameters) =>
      await nativeArgon(passwordBytes(password), parameters)
  })
  await client.signInWithPassword(author.email, author.password)
  const store: ChatKeyStore = {
    exists: async () => existsSync(author.keyFile),
    load: async () => recordFromJson(readFileSync(author.keyFile, 'utf8')),
    save: async record => {
      writeFileSync(author.keyFile, recordToJson(record), { mode: 0o600 })
    },
    wipe: async () => {
      throw new Error('The peer keeps its identity')
    }
  }
  const engine = new ChatEngine({
    client,
    store,
    userId: author.userId,
    device: { name: 'Synthetic fixture provider', platform: 'web' }
  })
  try {
    assert.equal(await engine.start(), 'ready')
    await engine.open(owned.conversationId)
    await engine.deleteMessage(owned.conversationId, owned.originalId)
    writeFileSync(
      join(out, 'owned-deleted.json'),
      JSON.stringify({ deletedAt: new Date().toISOString(), normal: true }),
      { mode: 0o600, flag: 'wx' }
    )
    console.log('PASS retained peer deleted its own note normally')
  } finally {
    engine.stop()
    await engine.idle()
  }
}

main().catch(() => {
  // Authentication errors may carry the synthetic credentials.
  console.error('Peer delete failed; inspect the private fixture')
  process.exitCode = 1
})
