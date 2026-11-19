import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'

import { ChatEngine } from '../../../src/app/chat/engine/engine'
import {
  approveLink,
  pendingLinkCode
} from '../../../src/app/chat/engine/links'
import {
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from '../../../src/app/chat/keyRecord'
import { TeamStationClient } from '../../../src/common/api'
import {
  readSeedTable,
  type SeedTablePerson
} from '../../../src/test/chatSeedTable'
import { testPasswordKdf } from '../../../src/test/passwordFixtures'
import type { E2eContext } from '../../core/spec'

interface Account {
  actor: string
  keyFile: string
}

interface Provider {
  person: SeedTablePerson
  engine: ChatEngine
  approve: (code: string, platform: string) => Promise<void>
}

interface Destination {
  origin: string
  port: number
  close: () => void
}

interface ChatLinkFixture {
  /** The runner interface a physical phone can reach for the test page. */
  destinationHost?: string
  /** The browser selected in the remote Android phone’s Default apps settings. */
  defaultBrowserPackage?: string
  origin: string
  seedFile: string
  sessionsDir?: string
  observer: Account
  sender: Account
  conversationId: string
}

/**
 * Select only synthetic chat-seed accounts and their retained provider keys
 * from the private, seat-specific fixture descriptor. Each surface has its own
 * approved room and actors. New test devices link by their displayed code.
 */
export function fixtureFor(ctx: E2eContext): ChatLinkFixture {
  const file = ctx.secret('chatLinkFixture')
  const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<
    Record<string, ChatLinkFixture>
  >
  const fixture = data[ctx.surface]
  assert(
    fixture?.origin === ctx.stack.origin,
    'Fixture belongs to another seat or surface'
  )
  assert(
    fixture.observer.actor !== fixture.sender.actor,
    'Two synthetic chat members are required'
  )
  return fixture
}

// Authentication sessions are each bound to one chat device. A private
// session directory lets a repeat run reuse its own seat authorizations.
export async function authenticatedActor(
  fixture: ChatLinkFixture,
  account: Account,
  usage: 'provider' | 'browser'
): Promise<{
  person: SeedTablePerson
  client: TeamStationClient
  token: string
}> {
  const person = readSeedTable(readFileSync(fixture.seedFile, 'utf8'))[
    account.actor
  ]
  assert(
    person != null && /@[^@]+\.example\.(com|test)$/.test(person.email),
    'Expected a synthetic chat-seed account'
  )
  const client = new TeamStationClient({
    baseUrl: fixture.origin + '/api/v1',
    passwordKdf: testPasswordKdf
  })
  const file =
    fixture.sessionsDir == null
      ? undefined
      : join(fixture.sessionsDir, person.userId + '-' + usage + '.json')
  if (file != null && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      origin: string
      token: string
    }
    assert.equal(
      saved.origin,
      fixture.origin,
      'Cached session belongs to another seat'
    )
    client.token = saved.token
    const who = await client.whoAmI()
    if (who != null) {
      assert.equal(who.id, person.userId)
      return { person, client, token: saved.token }
    }
    client.token = undefined
  }
  const { token } = await client.signInWithPassword(
    person.email,
    person.password
  )
  if (file != null) {
    const temporary = file + '.' + randomUUID()
    writeFileSync(
      temporary,
      JSON.stringify({ origin: fixture.origin, token }),
      { mode: 0o600, flag: 'wx' }
    )
    renameSync(temporary, file)
  }
  return { person, client, token }
}

export async function providerFor(
  fixture: ChatLinkFixture,
  account: Account
): Promise<Provider> {
  const { person, client } = await authenticatedActor(
    fixture,
    account,
    'provider'
  )
  const store: ChatKeyStore = {
    exists: async () => existsSync(account.keyFile),
    load: async () =>
      existsSync(account.keyFile)
        ? recordFromJson(readFileSync(account.keyFile, 'utf8'))
        : undefined,
    save: async record => {
      const file = account.keyFile + '.' + randomUUID()
      writeFileSync(file, recordToJson(record), { mode: 0o600, flag: 'wx' })
      renameSync(file, account.keyFile)
    },
    wipe: async () => {
      throw new Error('Expected the synthetic fixture’s own key record')
    }
  }
  const setup = {
    client,
    store,
    userId: person.userId,
    device: { name: 'Chat link test provider', platform: 'web' as const }
  }
  const engine = new ChatEngine(setup)
  try {
    assert.equal(
      await engine.start(),
      'ready',
      'Use the retained provider keys or a fresh synthetic account'
    )
    assert(
      engine.conversations().some(room => room.id === fixture.conversationId),
      'Actor must belong to the synthetic room'
    )
    await engine.open(fixture.conversationId)
    return {
      person,
      engine,
      approve: async (code: string, platform: string) => {
        const requests = (await client.chatLinks()).filter(
          link =>
            link.newDevice.platform === platform &&
            pendingLinkCode(link) === code
        )
        assert.equal(
          requests.length,
          1,
          'Expected only the request shown on the test surface'
        )
        const record = await store.load(person.userId)
        assert(record?.userId === person.userId)
        await approveLink(setup, record, requests[0])
      }
    }
  } catch (error) {
    engine.stop()
    throw error
  }
}

/** The browser itself renders its full path, including its client-only fragment. */
export async function destinationPage(
  host = '127.0.0.1'
): Promise<Destination> {
  assert(
    isIPv4(host) && host !== '0.0.0.0',
    'Bind the fixture to one local IPv4 address'
  )
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    })
    response.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><title>Chat link destination</title><h1>Opened chat link</h1><p id="address"></p><script>document.querySelector("p").textContent = location.pathname + location.search + location.hash</script>'
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  assert(address != null && typeof address !== 'string')
  return {
    origin: 'http://' + host + ':' + address.port,
    port: address.port,
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  }
}
