/** Approve only the native UI link emitted by an owned synthetic fixture. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { ChatEngine } from '../src/app/chat/engine/engine'
import { approveLink, pendingLinkCode } from '../src/app/chat/engine/links'
import {
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from '../src/app/chat/keyRecord'
import { TeamStationClient } from '../src/common/api'
import {
  type RecoveryFixtureOwner,
  validateRecoveryOwner
} from '../src/test/chatRecoveryFixtureContract'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string' },
      device: { type: 'string' },
      platform: { type: 'string' }
    }
  })
  assert(values.fixture != null && values.device != null)
  assert(values.platform === 'android' || values.platform === 'ios')
  const directory = resolve(values.fixture)
  const owner = JSON.parse(
    readFileSync(join(directory, 'owner.json'), 'utf8')
  ) as RecoveryFixtureOwner
  const settings = JSON.parse(readFileSync('serverConfig.json', 'utf8')) as {
    databaseUrl: string
    listenPort: number
  }
  const git = (...args: string[]): string =>
    execFileSync('git', args, { encoding: 'utf8' }).trim()
  validateRecoveryOwner(owner, {
    source: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    databaseUrl: settings.databaseUrl
  })
  assert(directory.startsWith(resolve(owner.artifacts) + '/'))
  assert.equal(Number(new URL(owner.apiUrl).port), settings.listenPort)
  const fixture = JSON.parse(
    readFileSync(join(directory, 'fixture.json'), 'utf8')
  ) as {
    synthetic: boolean
    disposable: boolean
    apiUrl: string
    actor: { userId: string }
  }
  assert(fixture.synthetic && fixture.disposable)
  assert.equal(fixture.apiUrl, owner.apiUrl)
  const session = JSON.parse(
    readFileSync(join(directory, 'Hc-session.json'), 'utf8')
  ) as { token: string }
  const client = new TeamStationClient({
    baseUrl: owner.apiUrl,
    token: session.token
  })
  assert.equal((await client.whoAmI())?.id, fixture.actor.userId)
  const keyFile = join(directory, 'Hc-keys.json')
  const store: ChatKeyStore = {
    exists: async () => existsSync(keyFile),
    load: async () => recordFromJson(readFileSync(keyFile, 'utf8')),
    save: async record => {
      writeFileSync(keyFile, recordToJson(record), { mode: 0o600 })
    },
    wipe: async () => {
      throw new Error('Fixture provider reset is prohibited')
    }
  }
  const setup = {
    client,
    store,
    userId: fixture.actor.userId,
    device: { name: 'Synthetic fixture provider', platform: 'web' as const },
    existingOnly: true
  }
  const engine = new ChatEngine(setup)
  try {
    assert.equal(await engine.start(), 'ready')
    const deadline = Date.now() + 180000
    const requestFile = join(directory, 'link-request.json')
    while (!existsSync(requestFile)) {
      assert(
        Date.now() < deadline,
        'Native UI did not publish its link request'
      )
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
      normalUiLinkRequest: boolean
      actorUserId: string
      nativeDeviceId: string
      platform: string
      code: string
    }
    assert.equal(request.normalUiLinkRequest, true)
    assert.equal(request.actorUserId, fixture.actor.userId)
    assert.equal(request.nativeDeviceId, values.device)
    assert.equal(request.platform, values.platform)
    assert(/^\d{6}$/.test(request.code))
    const links = (await client.chatLinks()).filter(
      link =>
        pendingLinkCode(link) === request.code &&
        link.newDevice.platform === request.platform
    )
    assert.equal(
      links.length,
      1,
      'Exactly one matching live device link is required'
    )
    const record = await store.load()
    assert(record?.userId === fixture.actor.userId)
    await approveLink(setup, record, links[0])
    console.log(
      'PASS normal native device link approved by its retained synthetic provider'
    )
  } finally {
    engine.stop()
    await engine.idle()
  }
}

main().catch(() => {
  console.error(
    'Owned native fixture link failed; no history approval was issued'
  )
  process.exitCode = 1
})
