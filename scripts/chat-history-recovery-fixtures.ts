/** Disposable fixture preparation; private settings and outputs never enter git. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { Agent, fetch as undiciFetch } from 'undici'

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
  RECOVERY_BROWSER_FOLLOWUP_SCENARIOS,
  recoveryFixtureEnvironment,
  type RecoveryFixtureOwner,
  requireFixtureFields,
  validateRecoveryOwner
} from '../src/test/chatRecoveryFixtureContract'
import { readSeedTable } from '../src/test/chatSeedTable'

/**
 * The fixture clients' requests, each on its own connection. A producer can
 * hold the browser for minutes, the API then resets the idle pooled socket,
 * and fetch never retries a POST that meets it.
 */
const freshConnections = new Agent({ pipelining: 0 })
const fixtureFetch = (async (input: string, init?: object) =>
  await undiciFetch(input, {
    ...init,
    dispatcher: freshConnections
  })) as unknown as typeof fetch

function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx'
  })
}

interface FixtureProvider {
  client: TeamStationClient
  engine: ChatEngine
  keyFile: string
  sessionFile: string
}

/**
 * A signed-in synthetic person with a started chat engine whose keys stay in
 * the fixture directory. It never replaces an identity.
 */
async function fixtureProvider(
  apiUrl: string,
  actor: { email: string; password: string; userId: string },
  out: string,
  key: string
): Promise<FixtureProvider> {
  assert(actor.email.endsWith('@chat.example.com'))
  const client = new TeamStationClient({
    baseUrl: apiUrl,
    fetch: fixtureFetch,
    passwordKdf: async (password, parameters) =>
      await nativeArgon(passwordBytes(password), parameters)
  })
  const session = await client.signInWithPassword(actor.email, actor.password)
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
  assert.equal(await engine.start(), 'ready')
  return { client, engine, keyFile, sessionFile }
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
  const browserFollowup =
    (values.runner === 'web' &&
      RECOVERY_BROWSER_FOLLOWUP_SCENARIOS.some(
        name => name === values.scenario
      )) ||
    (values.runner === 'entity' && values.scenario === 'after')
  assert(
    (values.runner === 'native' &&
      ['bands', 'core', 'default', 'intact'].includes(values.scenario)) ||
      (values.runner === 'reply' &&
        values.surface === 'web' &&
        ['shared', 'small', 'paging', 'incoming', 'incoming-send'].includes(
          values.scenario
        )) ||
      (values.runner === 'entity' &&
        values.surface === 'web' &&
        browserFollowup) ||
      (values.runner === 'web' &&
        values.surface === 'web' &&
        (browserFollowup ||
          [
            'E3',
            'E4',
            'E5',
            'E6',
            'E7',
            'E8',
            'E9',
            'E10',
            'E11',
            'E12',
            'E13'
          ].includes(values.scenario))),
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
    ffmpegPath: string
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
  if (values.runner === 'native' && values.scenario === 'intact') {
    assert(values.surface === 'ios' || values.surface === 'android')
    const webFile = process.env.CHAT_RECOVERY_INTACT_WEB_FIXTURE
    assert(
      webFile != null &&
        resolve(webFile).startsWith(resolve(owner.artifacts) + '/')
    )
    const web = JSON.parse(readFileSync(webFile, 'utf8')) as {
      disposable: true
      source: string
      apiUrl: string
      artifacts: string
      seedFile: string
    }
    assert.equal(web.disposable, true)
    assert.equal(web.source, owner.source)
    assert.equal(web.apiUrl, owner.apiUrl)
    assert(resolve(web.artifacts).startsWith(resolve(owner.artifacts) + '/'))
    assert(resolve(web.seedFile).startsWith(resolve(web.artifacts) + '/'))
    const receipt = JSON.parse(
      readFileSync(join(web.artifacts, 'intact-upgrade-results.json'), 'utf8')
    ) as {
      current: { source: string }
      conversationId: string
      actorKey: string
      posts: Array<{ id: string; body: string }>
      attachment: { messageId: string; fileName: string }
      safetyWordsUnchanged: boolean
      encryptedMessagesUnchanged: boolean
      imageDecodedOnBothVersionsAndRestart: boolean
      freshBoundaries: number
    }
    assert.equal(receipt.current.source, owner.source)
    assert(
      receipt.safetyWordsUnchanged &&
        receipt.encryptedMessagesUnchanged &&
        receipt.imageDecodedOnBothVersionsAndRestart
    )
    assert.equal(receipt.freshBoundaries, 0)
    assert.equal(receipt.posts.length, 4)
    const people = readSeedTable(readFileSync(web.seedFile, 'utf8'))
    const actor = people[receipt.actorKey]
    assert(actor?.email.endsWith('@chat.example.com'))
    const api = new TeamStationClient({
      baseUrl: owner.apiUrl,
      fetch: fixtureFetch,
      passwordKdf: async (password, parameters) =>
        await nativeArgon(passwordBytes(password), parameters)
    })
    await api.signInWithPassword(actor.email, actor.password)
    const conversation = (await api.chatConversations()).find(
      row => row.id === receipt.conversationId
    )
    assert(conversation != null)
    const messages = await api.chatMessages(conversation.id)
    assert.deepEqual(
      messages.filter(row => row.kind === 'post').map(row => row.id),
      receipt.posts.map(row => row.id)
    )
    const epochs = await api.chatEpochs(conversation.id, 0)
    assert.equal(epochs.epochs.length, 1)
    assert.equal(epochs.epochs[0].chainBreak, false)
    const label = dmTitle(actor.userId, undefined, conversation.people ?? [])
    const fixture = {
      synthetic: true,
      disposable: true,
      appId: 'app.teamstation.app',
      scheme: 'teamstation',
      apiUrl: owner.apiUrl,
      conversationId: conversation.id,
      conversationLabel: label,
      scopeName: label,
      scopePill: 'Direct message',
      targetText: receipt.posts[0].body,
      replyText: receipt.posts[1].body,
      originalMessageIds: receipt.posts.map(row => row.id),
      draft: 'Retained history draft',
      probePost: 'Retained history probe',
      orientationPolicy: 'portrait-only',
      actor,
      peers: (conversation.people ?? [])
        .filter(person => person.userId !== actor.userId)
        .map(person => ({ userId: person.userId }))
    }
    requireFixtureFields(fixture, [
      'actor.userId',
      'actor.email',
      'actor.password',
      'conversationId',
      'targetText',
      'replyText',
      'originalMessageIds'
    ])
    privateJson(join(out, 'fixture.json'), fixture)
    privateJson(join(out, 'intact.json'), {
      synthetic: true,
      actorUserId: actor.userId,
      conversationId: conversation.id,
      posts: receipt.posts,
      attachment: receipt.attachment
    })
    const link = join(out, 'link-request.json')
    const env = {
      TS_CHAT_WEB_URL: owner.webUrl,
      TS_CHAT_API_URL: owner.apiUrl,
      CHAT_UI_SEED_FILE: web.seedFile,
      CHAT_UI_ARTIFACTS: out,
      CHAT_UI_NATIVE_FIXTURE_FILE: join(out, 'fixture.json'),
      CHAT_UI_NATIVE_RESULTS: join(out, 'results'),
      CHAT_UI_NATIVE_LINK_REQUEST: link,
      CHAT_UI_LOCKED_LINK_REQUEST: link,
      CHAT_UI_NATIVE_STAGE: 'M4',
      CHAT_UI_NATIVE_DISPOSABLE: '1',
      CHAT_PLATFORM: values.surface,
      CHAT_UI_LOCKED_ACTOR: receipt.actorKey,
      CHAT_UI_LOCKED_CONVERSATION: conversation.id,
      CHAT_UI_LOCKED_ORIGINAL: receipt.posts[0].id,
      CHAT_UI_LOCKED_ORIGINAL_BODY: receipt.posts[0].body,
      CHAT_UI_PROFILE_DIR: join(web.artifacts, 'profiles', 'holder'),
      CHAT_RECOVERY_INTACT_FIXTURE: join(out, 'intact.json'),
      CHAT_RECOVERY_INTACT_RECORD: join(out, 'baseline.json'),
      CHAT_RECOVERY_FIXTURE_SOURCE: owner.source
    }
    const path = join(out, 'env.sh')
    writeFileSync(path, recoveryFixtureEnvironment(env), {
      mode: 0o600,
      flag: 'wx'
    })
    return path
  }
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
  if (values.runner === 'reply' || browserFollowup) {
    // Only inspect membership here. The browser enrolls its own identity and
    // creates every encrypted fixture message through the normal composer.
    const actor = people.Hc
    assert(actor.email.endsWith('@chat.example.com'))
    const client = new TeamStationClient({
      baseUrl: owner.apiUrl,
      fetch: fixtureFetch,
      passwordKdf: async (password, parameters) =>
        await nativeArgon(passwordBytes(password), parameters)
    })
    await client.signInWithPassword(actor.email, actor.password)
    let protectedRoom = (await client.chatConversations()).find(
      room => room.title === 'Hawks Members'
    )
    const deadline = Date.now() + 30000
    while (protectedRoom == null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200))
      protectedRoom = (await client.chatConversations()).find(
        room => room.title === 'Hawks Members'
      )
    }
    assert(protectedRoom != null, 'Protected seeded membership is required')
    const candidates = await client.dmCandidates()
    const peers = ['Ha', 'Hs'].map(key => {
      const person = candidates.find(row => row.userId === people[key].userId)
      assert(person != null, 'History peers must be eligible adult candidates')
      return person.shortName
    })
    const shared = join(out, 'shared-fixture.json')
    const profile = join(out, 'profiles', 'actor')
    const peerProfile = join(out, 'profiles', 'peer')
    const setup = join(out, 'reply-setup.json')
    const incoming = join(out, 'incoming-fixture.json')
    privateJson(setup, {
      synthetic: true,
      source: owner.source,
      origin: owner.webUrl,
      apiUrl: owner.apiUrl,
      seedFile: join(out, 'seed.txt'),
      artifacts: out,
      protectedConversation: protectedRoom.id,
      profiles: {
        Hc: profile,
        Hs: peerProfile,
        Ha: join(out, 'profiles', 'other-peer')
      },
      incoming,
      small: join(out, 'small-fixture.json')
    })
    const path = join(out, 'env.sh')
    const environment: Record<string, string> = {
      TS_CHAT_WEB_URL: owner.webUrl,
      TS_CHAT_API_URL: owner.apiUrl,
      CHAT_UI_SEED_FILE: join(out, 'seed.txt'),
      CHAT_UI_ARTIFACTS: join(out, 'producer-results'),
      CHAT_UI_PROFILE_DIR: profile,
      CHAT_UI_CONVERSATION: protectedRoom.id,
      CHAT_UI_FIXTURE_PEOPLE: JSON.stringify(peers),
      CHAT_UI_HISTORY_FIXTURE_FILE: shared,
      CHAT_UI_REPLY_SEED_FILE: join(out, 'seed.txt'),
      CHAT_UI_REPLY_ACTOR: values.scenario === 'incoming-send' ? 'Hs' : 'Hc',
      CHAT_UI_REPLY_PEER: 'Hs',
      CHAT_UI_REPLY_PROFILE_DIR:
        values.scenario === 'incoming-send' ? peerProfile : profile,
      CHAT_UI_REPLY_WEB_DEVICE: 'recovery-reply',
      CHAT_UI_REPLY_ARTIFACTS: join(out, values.scenario + '-results'),
      CHAT_UI_REPLY_SHARED_FIXTURE: shared,
      CHAT_UI_REPLY_SMALL_FIXTURE: join(out, 'small-fixture.json'),
      CHAT_UI_REPLY_INCOMING_FIXTURE: incoming,
      CHAT_UI_REPLY_CREATE_OUTGOING: 'true',
      CHAT_UI_REPLY_PROTECTED_CONVERSATION: protectedRoom.id,
      CHAT_UI_REPLY_MODE: values.scenario,
      CHAT_RECOVERY_REPLY_SETUP: setup,
      CHAT_RECOVERY_FIXTURE_SOURCE: owner.source,
      MAESTRO_D: 'recovery-reply-' + Date.now()
    }
    if (browserFollowup) {
      const produce = (file: string, mode: string): void => {
        let output = `$ node -r sucrase/register ${file} ${mode}\n`
        try {
          output += execFileSync(
            process.execPath,
            ['-r', 'sucrase/register', file, mode],
            {
              env: { ...process.env, ...environment },
              encoding: 'utf8',
              maxBuffer: 16 * 1024 * 1024,
              stdio: ['ignore', 'pipe', 'pipe']
            }
          )
        } catch (error) {
          const failed = error as { stdout?: string; stderr?: string }
          output += (failed.stdout ?? '') + (failed.stderr ?? '')
          throw error
        } finally {
          writeFileSync(join(out, mode + '-producer.log'), output, {
            flag: 'wx',
            mode: 0o600
          })
        }
      }
      const relayed = ['pendingSend', 'review2Browser'].includes(
        values.scenario
      )
      let relay: { endpoint: string; token: string; audit: string } | undefined
      if (relayed) {
        // The browser reaches the API through the owned relay, whose gates
        // hold only a named person's sends in the test conversation.
        const relayFile = process.env.CHAT_RECOVERY_RELAY
        assert(
          relayFile != null &&
            resolve(relayFile).startsWith(resolve(owner.artifacts) + '/'),
          'CHAT_RECOVERY_RELAY must name the owned relay settings'
        )
        const ready = JSON.parse(readFileSync(relayFile, 'utf8')) as {
          disposable: true
          source: string
          upstream: string
          endpoint: string
          token: string
          audit: string
        }
        assert.equal(ready.disposable, true)
        assert.equal(ready.source, owner.source)
        assert.equal(ready.upstream, owner.apiUrl)
        const page = await (await fetch(owner.webUrl)).text()
        assert(
          page.includes(new URL(ready.endpoint).origin),
          'The served web build must talk to the owned relay'
        )
        relay = ready
      }
      const helper = 'src/app/chat/chatHistoryRecoveryReplyFixture.e2e.ts'
      produce(helper, 'enroll')
      produce(helper, 'followup')
      if (values.runner === 'entity') produce(helper, 'entity')
      const group = JSON.parse(
        readFileSync(join(out, 'followup-fixture.json'), 'utf8')
      )
      assert.equal(group.source, owner.source)
      assert.equal(group.conversationId, protectedRoom.id)
      requireFixtureFields(group, ['originalId', 'originalBody'])
      environment.CHAT_UI_MESSAGE = group.originalId
      environment.CHAT_UI_TARGET_TEXT = group.originalBody
      environment.CHAT_UI_PEER_PROFILE_DIR = peerProfile
      environment.CHAT_UI_PROFILE_DIR = ['S6', 'reader'].includes(
        values.scenario
      )
        ? peerProfile
        : profile
      environment.CHAT_UI_ARTIFACTS = join(out, 'results')
      mkdirSync(environment.CHAT_UI_ARTIFACTS, { mode: 0o700 })
      if (values.scenario === 'reviewNavigation') {
        const rooms = new Set<string>()
        for (let index = 0; index < 20; index++) {
          const room = await client.createDm([
            people.Ha.userId,
            people.Hs.userId
          ])
          assert.notEqual(room.id, protectedRoom.id)
          assert(!rooms.has(room.id), 'Distinct list rows are required')
          rooms.add(room.id)
        }
        privateJson(join(out, 'list-padding.json'), { ids: [...rooms] })
      }
      if (['S4full', 'currentHistoryReply'].includes(values.scenario)) {
        produce('src/app/chat/chatUiFollowup.e2e.ts', 'historyFixture')
        const history = JSON.parse(readFileSync(shared, 'utf8'))
        requireFixtureFields(history, [
          'conversationId',
          'originalId',
          'replyId'
        ])
        assert.notEqual(history.conversationId, protectedRoom.id)
        environment.CHAT_UI_TEST_CONVERSATION = history.conversationId
      } else {
        produce(helper, 'paging-target')
        const small = JSON.parse(
          readFileSync(join(out, 'small-fixture.json'), 'utf8')
        )
        requireFixtureFields(small, ['conversationId', 'originalId'])
        assert.notEqual(small.conversationId, protectedRoom.id)
        environment.CHAT_UI_TEST_CONVERSATION = small.conversationId
      }
      if (relay != null) {
        const control = join(out, 'control.json')
        privateJson(control, {
          disposable: true,
          endpoint: relay.endpoint,
          token: relay.token,
          actors: Object.fromEntries(
            ['Hc', 'Hs'].map(key => [
              key,
              {
                userId: people[key].userId,
                conversationId: environment.CHAT_UI_TEST_CONVERSATION
              }
            ])
          )
        })
        environment.CHAT_RECOVERY_CONTROL_FILE = control
        environment.CHAT_UI_PENDING_CONTROL = resolve(
          'scripts/chat-history-recovery-control.cjs'
        )
        environment.CHAT_UI_PENDING_AUDIT = relay.audit
      }
      if (values.scenario === 'reader') {
        // A season admin's announcement, which the reader may read but not
        // answer. The admin is a fresh provider; the reader enrolled above.
        const admin = await fixtureProvider(owner.apiUrl, people.S, out, 'S')
        try {
          const announcements = (await admin.client.chatConversations()).find(
            row => row.kind === 'seasonAnnouncements'
          )
          assert(announcements != null, 'Season announcements are required')
          await admin.engine.open(announcements.id)
          const post = await admin.engine.sendText(
            announcements.id,
            'Practice notes: the field opens at five.'
          )
          assert(post != null)
          privateJson(join(out, 'reader-fixture.json'), {
            conversationId: announcements.id,
            messageId: post.id
          })
        } finally {
          admin.engine.stop()
          await admin.engine.idle()
        }
      }
      if (values.runner === 'entity') {
        const entity = JSON.parse(
          readFileSync(join(out, 'entity-fixture.json'), 'utf8')
        )
        assert.equal(entity.source, owner.source)
        assert.equal(entity.conversationId, protectedRoom.id)
        requireFixtureFields(entity, ['postId', 'teams.hawks', 'seasonId'])
        environment.TS_CHAT_FIXTURE = join(out, 'entity-fixture.json')
        environment.TS_CHAT_ARTIFACTS = environment.CHAT_UI_ARTIFACTS
        environment.TS_CHAT_WEB = owner.webUrl
        environment.TS_CHAT_API = owner.apiUrl
      }
      if (values.scenario === 'chat117Words') {
        const small = JSON.parse(
          readFileSync(join(out, 'small-fixture.json'), 'utf8')
        )
        requireFixtureFields(small, ['peerLabel'])
        environment.CHAT117_CONVERSATION = environment.CHAT_UI_TEST_CONVERSATION
        environment.CHAT117_PEER = small.peerLabel
        environment.CHAT117_ARTIFACTS = environment.CHAT_UI_ARTIFACTS
      }
      if (values.scenario === 'boundedMedia') {
        // A synthetic clip sent through the actual Attach and Send.
        const clip = join(out, 'practice-clip.mp4')
        execFileSync(
          settings.ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=320x240:rate=10',
            '-t',
            '2',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            '-an',
            clip
          ],
          { stdio: 'ignore' }
        )
        environment.CHAT_UI_VIDEO_FILE = clip
        environment.CHAT_UI_HISTORY_FIXTURE_FILE = join(
          out,
          'small-fixture.json'
        )
        environment.CHAT_UI_VIDEO_FIXTURE_RESULT = join(
          out,
          'video-fixture.json'
        )
        produce('src/app/chat/chatUiFollowup.e2e.ts', 'videoFixture')
        const video = JSON.parse(
          readFileSync(environment.CHAT_UI_VIDEO_FIXTURE_RESULT, 'utf8')
        )
        requireFixtureFields(video, [
          'conversationId',
          'videoMessageId',
          'fileName'
        ])
        assert.equal(
          video.conversationId,
          environment.CHAT_UI_TEST_CONVERSATION
        )
        environment.CHAT_UI_VIDEO_FIXTURE_FILE =
          environment.CHAT_UI_VIDEO_FIXTURE_RESULT
      }
      const picker = join(out, 'picker-notes.txt')
      writeFileSync(picker, 'Owned synthetic practice notes', {
        flag: 'wx',
        mode: 0o600
      })
      environment.CHAT_UI_PICK_FILE = picker
      requireFixtureFields(environment, [
        'CHAT_UI_MESSAGE',
        'CHAT_UI_TARGET_TEXT',
        'CHAT_UI_TEST_CONVERSATION',
        'CHAT_UI_PEER_PROFILE_DIR'
      ])
    }
    writeFileSync(path, recoveryFixtureEnvironment(environment), {
      mode: 0o600,
      flag: 'wx'
    })
    return path
  }
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
  const providers: Record<string, FixtureProvider> = {}
  try {
    for (const key of ['Ha', 'Hc', 'Hs', 'A', 'B'])
      providers[key] = await fixtureProvider(
        owner.apiUrl,
        people[key],
        out,
        key
      )
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
