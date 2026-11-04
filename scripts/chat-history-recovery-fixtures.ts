/** Disposable fixture preparation; private settings and outputs never enter git. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { ChatEngine, dmTitle } from '../src/app/chat/engine/engine'
import {
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from '../src/app/chat/keyRecord'
import { TeamStationClient } from '../src/common/api'
import { passwordBytes } from '../src/common/passwordProtocol'
import { nativeArgon } from '../src/server/auth/passwords'
import {
  recoveryFixtureEnvironment,
  type RecoveryFixtureOwner,
  requireFixtureFields,
  validateRecoveryOwner
} from '../src/test/chatRecoveryFixtureContract'
import { readSeedTable } from '../src/test/chatSeedTable'

function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx'
  })
}

export async function prepareRecoveryFixture(args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    options: {
      runner: { type: 'string' },
      scenario: { type: 'string' },
      surface: { type: 'string' },
      out: { type: 'string' }
    }
  })
  assert(
    values.runner != null &&
      ['native', 'web', 'reply', 'entity', 'chat2'].includes(values.runner)
  )
  assert(values.scenario != null && /^[a-zA-Z0-9_-]+$/.test(values.scenario))
  assert(
    values.surface != null && ['web', 'ios', 'android'].includes(values.surface)
  )
  assert(values.out != null)
  assert(
    (values.runner === 'native' &&
      ['bands', 'core', 'default'].includes(values.scenario)) ||
      (values.runner === 'web' &&
        values.surface === 'web' &&
        ['E3', 'E4', 'E5', 'E6', 'E7'].includes(values.scenario)),
    'This scenario requires its specialized fixture producer'
  )
  const ownerFile = process.env.CHAT_RECOVERY_OWNER_FILE
  assert(
    ownerFile != null,
    'CHAT_RECOVERY_OWNER_FILE must name the private disposable server settings'
  )
  const owner = JSON.parse(
    readFileSync(ownerFile, 'utf8')
  ) as RecoveryFixtureOwner
  const git = (...args: string[]): string =>
    execFileSync('git', args, { encoding: 'utf8' }).trim()
  const settings = JSON.parse(readFileSync('serverConfig.json', 'utf8')) as {
    databaseUrl: string
    listenPort: number
  }
  validateRecoveryOwner(owner, {
    source: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    databaseUrl: settings.databaseUrl
  })
  assert.equal(
    Number(new URL(owner.apiUrl).port),
    settings.listenPort,
    'Fixture API must be the owned configured server'
  )
  assert.equal(
    git('status', '--porcelain'),
    '',
    'Commit the fixture source before preparation'
  )
  const out = resolve(values.out)
  assert(
    out.startsWith(resolve(owner.artifacts) + '/'),
    'Fixture output must be inside the owned artifact directory'
  )
  assert(!existsSync(out), 'Every scenario needs a new fixture directory')
  mkdirSync(out, { recursive: true, mode: 0o700 })
  privateJson(join(out, 'owner.json'), owner)
  const reset = execFileSync('/bin/bash', ['scripts/chat-e2e-reset.sh', out], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  writeFileSync(
    join(out, 'prepare.log'),
    '$ scripts/chat-e2e-reset.sh <owned fixture directory>\n' + reset,
    { mode: 0o600 }
  )
  const people = readSeedTable(readFileSync(join(out, 'seed.txt'), 'utf8'))
  if (values.runner === 'web') {
    // These scenarios must first enroll through the actual browser UI.
    // A provider engine here would pre-enroll them and change the scenario.
    const fixture = {
      disposable: true,
      source: owner.source,
      origin: owner.webUrl,
      apiUrl: owner.apiUrl,
      seedFile: join(out, 'seed.txt'),
      artifacts: out
    }
    requireFixtureFields(fixture, [
      'source',
      'origin',
      'apiUrl',
      'seedFile',
      'artifacts'
    ])
    privateJson(join(out, 'fixture.json'), fixture)
    const path = join(out, 'env.sh')
    writeFileSync(
      path,
      recoveryFixtureEnvironment({
        CHAT_RECOVERY_FIXTURE: join(out, 'fixture.json'),
        CHAT_RECOVERY_SURFACE: 'web',
        CHAT_RECOVERY_DEVICE: 'recovery-' + values.scenario,
        CHAT_RECOVERY_FIXTURE_SOURCE: owner.source,
        MAESTRO_D: 'recovery-' + values.scenario + '-' + Date.now()
      }),
      { mode: 0o600, flag: 'wx' }
    )
    return path
  }
  const providers: Record<
    string,
    {
      client: TeamStationClient
      engine: ChatEngine
      keyFile: string
      sessionFile: string
    }
  > = {}
  try {
    for (const key of ['Ha', 'Hc', 'Hs', 'A', 'B']) {
      const actor = people[key]
      assert(actor.email.endsWith('@chat.example.com'))
      const client = new TeamStationClient({
        baseUrl: owner.apiUrl,
        passwordKdf: async (password, parameters) =>
          await nativeArgon(passwordBytes(password), parameters)
      })
      const session = await client.signInWithPassword(
        actor.email,
        actor.password
      )
      assert.equal(
        (await client.whoAmI())?.id,
        actor.userId,
        'API and fixture database disagree'
      )
      const keyFile = join(out, key + '-keys.json')
      const sessionFile = join(out, key + '-session.json')
      privateJson(sessionFile, session)
      const store: ChatKeyStore = {
        exists: async () => existsSync(keyFile),
        load: async () =>
          existsSync(keyFile)
            ? recordFromJson(readFileSync(keyFile, 'utf8'))
            : undefined,
        save: async record => {
          writeFileSync(keyFile, recordToJson(record), { mode: 0o600 })
        },
        wipe: async () => {
          throw new Error('Fixture provider identity replacement is prohibited')
        }
      }
      const engine = new ChatEngine({
        client,
        store,
        userId: actor.userId,
        device: { name: 'Synthetic fixture provider', platform: 'web' }
      })
      providers[key] = { client, engine, keyFile, sessionFile }
      assert.equal(await engine.start(), 'ready')
    }
    const actor = providers.Hc
    let conversation = (await actor.client.chatConversations()).find(
      row => row.title === 'Hawks Members'
    )
    const deadline = Date.now() + 30000
    while (conversation == null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200))
      conversation = (await actor.client.chatConversations()).find(
        row => row.title === 'Hawks Members'
      )
    }
    assert(conversation != null, 'Seeded chat membership did not reconcile')
    const original = await actor.engine.sendText(
      conversation.id,
      'Original message for ' + values.scenario
    )
    assert(original != null)
    await providers.Hs.engine.open(conversation.id)
    const reply = await providers.Hs.engine.sendText(
      conversation.id,
      'Reply for ' + values.scenario,
      { quoteId: original.id }
    )
    assert(reply != null)
    const dm = await actor.client.createDm([people.A.userId])
    const other = await actor.engine.sendText(
      dm.id,
      'Independent chat for ' + values.scenario
    )
    assert(other != null)
    const fixture = {
      synthetic: true,
      disposable: true,
      appId: 'app.teamstation.app',
      scheme: 'teamstation',
      apiUrl: owner.apiUrl,
      conversationId: conversation.id,
      conversationLabel: 'Hawks Members',
      scopeName: 'Hawks',
      scopePill: 'Team Members',
      targetText: original.body,
      replyText: reply.body,
      originalMessageIds: [original.id, reply.id],
      draft: 'Retained draft for ' + values.scenario,
      probePost: 'Acknowledged post for ' + values.scenario,
      orientationPolicy: 'portrait-only',
      actor: people.Hc,
      peers: [people.Hs, people.A].map(person => ({ userId: person.userId })),
      reader: {
        conversationId: dm.id,
        conversationLabel: dmTitle(
          people.Hc.userId,
          undefined,
          dm.people ?? []
        ),
        messageId: other.id,
        body: other.body
      },
      initialPreferences: { pinned: false, muted: false },
      initialMessagePinned: false
    }
    requireFixtureFields(fixture, [
      'actor.userId',
      'actor.email',
      'actor.password',
      'conversationId',
      'targetText',
      'replyText',
      'originalMessageIds',
      'reader.conversationId',
      'reader.messageId'
    ])
    const messages = await actor.client.chatMessages(conversation.id)
    assert(
      messages.some(message => message.id === original.id) &&
        messages.some(message => message.id === reply.id),
      'Prepared encrypted messages must exist through the actual authorized API'
    )
    privateJson(join(out, 'fixture.json'), fixture)
    privateJson(
      join(out, 'providers.json'),
      Object.fromEntries(
        Object.entries(providers).map(([key, provider]) => [
          key,
          {
            ...people[key],
            keyFile: provider.keyFile,
            sessionFile: provider.sessionFile
          }
        ])
      )
    )
    privateJson(join(out, 'scene.json'), {
      source: owner.source,
      runner: values.runner,
      scenario: values.scenario,
      surface: values.surface,
      conversationId: conversation.id,
      originalId: original.id,
      originalBody: original.body,
      replyId: reply.id,
      replyBody: reply.body,
      otherConversationId: dm.id
    })
    const env = {
      TS_CHAT_WEB_URL: owner.webUrl,
      TS_CHAT_API_URL: owner.apiUrl,
      CHAT_UI_SEED_FILE: join(out, 'seed.txt'),
      CHAT_UI_ARTIFACTS: out,
      CHAT_UI_NATIVE_FIXTURE_FILE: join(out, 'fixture.json'),
      CHAT_UI_NATIVE_ARTIFACTS: out,
      CHAT_UI_NATIVE_RESULTS: join(out, 'results'),
      CHAT_UI_NATIVE_LINK_REQUEST: join(out, 'link-request.json'),
      CHAT_UI_NATIVE_STAGE: 'M4',
      CHAT_UI_NATIVE_DISPOSABLE: '1',
      CHAT_PLATFORM: values.surface,
      CHAT_UI_PROFILE_DIR: join(out, 'profiles', 'Hc'),
      CHAT_UI_PEER_PROFILE_DIR: join(out, 'profiles', 'Hs'),
      CHAT_UI_CONVERSATION: conversation.id,
      CHAT_UI_MESSAGE: original.id,
      CHAT_UI_TARGET_TEXT: original.body ?? '',
      CHAT_RECOVERY_FIXTURE_SOURCE: owner.source
    }
    const path = join(out, 'env.sh')
    writeFileSync(path, recoveryFixtureEnvironment(env), {
      mode: 0o600,
      flag: 'wx'
    })
    return path
  } finally {
    for (const provider of Object.values(providers)) provider.engine.stop()
    await Promise.all(
      Object.values(providers).map(async provider => {
        await provider.engine.idle()
      })
    )
  }
}

if (
  process.argv[1] != null &&
  resolve(process.argv[1]) === resolve(__filename)
) {
  prepareRecoveryFixture(process.argv.slice(2))
    .then(path => {
      console.log(path)
    })
    .catch(() => {
      // Authentication and database exceptions may carry fixture credentials.
      console.error(
        'Fixture preparation failed; no runner should start. Inspect the private preparation log.'
      )
      process.exitCode = 1
    })
}
