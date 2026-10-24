/** Private descriptors supply identities, origins and existing keys; none live here. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { argon2id, hash } from 'argon2'
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asUnknown,
  asValue
} from 'cleaners'

import { ChatEngine } from '../app/chat/engine/engine'
import {
  approveLink,
  ensureEnrolled,
  rotatePuk
} from '../app/chat/engine/links'
import {
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from '../app/chat/keyRecord'
import { TeamStationClient } from '../common/api'
import { asUserId } from '../common/userId'

export const CHAT2_SURFACES = [
  'web-wide',
  'web-narrow',
  'web-touch',
  'web-320',
  'ios',
  'android'
] as const
export type Chat2Surface = (typeof CHAT2_SURFACES)[number]
export const CHAT2_SCENARIOS = [
  'E1',
  'E2',
  'E3',
  'E4',
  'E5',
  'E6',
  'E7',
  'E9',
  'E10',
  'E11',
  'E8'
] as const
export type Chat2Scenario = (typeof CHAT2_SCENARIOS)[number]

export class Chat2Blocked extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Chat2Blocked'
  }
}

export function need<T>(value: T | undefined, description: string): T {
  if (value == null) throw new Chat2Blocked(description)
  return value
}

const asActor = asObject({
  userId: asUserId,
  email: asString,
  password: asString,
  accountLabel: asString,
  provider: asOptional(asObject({ keyFile: asString, sessionFile: asString }))
})
const asConversation = asObject({
  id: asString,
  title: asString,
  identityLabel: asOptional(asString)
})
const asMessage = asObject({
  id: asString,
  seq: asNumber,
  body: asString,
  authorId: asUserId
})
export const asIdentityCompatibility = asObject({
  legacy: asObject(
    asObject({
      actor: asString,
      deviceId: asString,
      identityId: asString,
      identityPublicKey: asString,
      pukGeneration: asNumber,
      pukPublicKey: asString,
      safetyNumber: asString,
      text: asMessage,
      reply: asMessage,
      file: asMessage,
      textMentions: asArray(asUserId),
      replyMentions: asArray(asUserId)
    })
  ),
  fullWidthActors: asArray(asString),
  i2Target: asOptional(asValue('retained-linked', 'new-empty'))
})
const asDevice = asObject({
  id: asString,
  name: asString,
  owned: asValue(true),
  driver: asOptional(asString, 'devicelab')
})
const asBinding = asObject({
  source: asString,
  receipt: asString,
  artifact: asString,
  sha256: asString,
  apiUrl: asString,
  mediaOrigin: asString,
  bundle: asOptional(asObject({ path: asString, sha256: asString }))
})
const asAttention = asObject({
  viewer: asString,
  sender: asString,
  readCursor: asNumber,
  ownOriginal: asMessage,
  firstUnreadReply: asMessage,
  readerAnchor: asMessage,
  neutralTail: asMessage,
  expectedCount: asNumber,
  hiddenFile: asOptional(
    asObject({
      message: asMessage,
      attachmentId: asString,
      objectPath: asString
    })
  ),
  targetIds: asArray(asString),
  operationsOnlyBefore: asOptional(asNumber, 0),
  emptyBefore: asOptional(asNumber, 0)
})

const asFixture = asObject({
  schema: asValue(1),
  synthetic: asValue(true),
  disposable: asValue(true),
  localOnly: asValue(true),
  ownershipId: asString,
  appId: asValue('app.teamstation.app'),
  scheme: asOptional(asString, 'teamstation'),
  apiUrl: asString,
  webUrl: asString,
  allowedOrigins: asArray(asString),
  actors: asObject(asActor),
  viewers: asObject(asString),
  scenarioViewers: asOptional(asObject(asString), {}),
  switchActor: asOptional(asString),
  afterArchive: asOptional(asString),
  peer: asString,
  sameUserPeer: asOptional(asString),
  scenarioPeers: asOptional(asObject(asString), {}),
  identityCompatibility: asOptional(asIdentityCompatibility),
  lockedViewer: asOptional(asString),
  readOnlyViewer: asOptional(asString),
  lockedCases: asOptional(
    asObject(
      asObject({
        viewer: asString,
        conversation: asConversation,
        message: asMessage,
        generation: asString
      })
    ),
    {}
  ),
  formerActor: asOptional(asString),
  controls: asOptional(asObject(asString), {}),
  authorization: asOptional(
    asObject({
      playerIds: asArray(asUserId),
      acceptedAdult: asUserId,
      // The actor who asks: one the probe players are candidates for.
      asker: asOptional(asString)
    })
  ),
  avatarProbe: asOptional(
    asObject({
      viewer: asString,
      photoConversation: asConversation,
      initialsConversation: asConversation,
      brokenConversation: asConversation,
      initials: asString,
      brokenInitials: asString
    })
  ),
  variants: asOptional(
    asObject(
      asObject({
        applicability: asValue('applicable', 'not-applicable'),
        reason: asOptional(asString),
        set: asArray(
          asObject({
            command: asString,
            args: asObject(asUnknown)
          })
        ),
        verify: asArray(
          asObject({
            text: asOptional(asString),
            id: asOptional(asString),
            checked: asOptional(asBoolean),
            selected: asOptional(asBoolean),
            rawValue: asOptional(
              asObject({
                identifier: asString,
                type: asString,
                label: asString,
                value: asString
              })
            )
          })
        ),
        restore: asArray(
          asObject({
            command: asString,
            args: asObject(asUnknown)
          })
        ),
        restoreVerify: asArray(
          asObject({
            text: asOptional(asString),
            id: asOptional(asString),
            checked: asOptional(asBoolean),
            selected: asOptional(asBoolean),
            rawValue: asOptional(
              asObject({
                identifier: asString,
                type: asString,
                label: asString,
                value: asString
              })
            )
          })
        )
      })
    )
  ),
  conversations: asObject({
    group: asConversation,
    dm: asOptional(asConversation),
    empty: asOptional(asConversation),
    locked: asOptional(asConversation),
    readOnly: asOptional(asConversation),
    attention: asOptional(asConversation),
    attentionStress: asOptional(asConversation),
    switch: asOptional(asConversation),
    former: asOptional(asConversation),
    attentionEmpty: asOptional(asConversation)
  }),
  messages: asObject({
    target: asMessage,
    long: asMessage,
    incoming: asOptional(asMessage),
    outgoing: asOptional(asMessage),
    file: asOptional(asMessage),
    oldest: asOptional(asMessage)
  }),
  members: asOptional(
    asArray(
      asObject({
        userId: asUserId,
        name: asString,
        role: asString,
        search: asString
      })
    ),
    []
  ),
  files: asOptional(
    asObject({
      synthetic: asValue(true),
      photo: asString,
      label: asString,
      sha256: asString,
      oversize: asOptional(asString),
      nativePicker: asOptional(
        asObject(
          asArray(
            asObject({
              text: asOptional(asString),
              id: asOptional(asString),
              index: asOptional(asNumber)
            })
          )
        )
      )
    })
  ),
  attention: asOptional(asAttention),
  historyStress: asOptional(asAttention),
  devices: asObject({ ios: asDevice, android: asDevice }),
  bindings: asObject(asBinding),
  browser: asOptional(
    asObject({
      executable: asString,
      profileRoot: asString
    })
  ),
  control: asOptional(
    asObject({
      executable: asString,
      args: asArray(asString),
      sha256: asString,
      script: asString,
      dependencies: asArray(asObject({ path: asString, sha256: asString }))
    })
  ),
  cleanupServices: asBoolean,
  matrix: asOptional(
    asArray(
      asObject({
        surface: asString,
        scenario: asString,
        variant: asString,
        receipt: asString,
        cleanupReview: asOptional(asString),
        visualReview: asOptional(asString)
      })
    ),
    []
  )
})
export type Chat2Fixture = ReturnType<typeof asFixture>
export type Chat2Actor = Chat2Fixture['actors'][string]
export type Chat2Message = Chat2Fixture['messages']['target']

export const NEUTRAL_CHAT2_TEXT = {
  target: 'Bring a water bottle to the next practice.',
  draft: 'Review the next practice plan before sending.',
  reply: 'The earlier practice note is confirmed.',
  long: 'Check the space and equipment before each turn. '.repeat(32),
  group: 'Comets',
  league: 'Stratus League'
} as const

export function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Normal sign-out is allowed only after every matched AFTER frame is archived.
 * A capture of `recapturing` replaces that surface's own frames, so those must
 * still be archived and intact but may come from an earlier source.
 */
export function requireAfterArchive(
  fixture: Chat2Fixture,
  recapturing?: string
): void {
  const path = need(
    fixture.afterArchive,
    'Archive all53 matched AFTER frames before account-switch scenarios'
  )
  privateFile(path)
  const archive = JSON.parse(readFileSync(path, 'utf8')) as {
    entries: Array<{
      file: string
      path?: string
      source: string
      sha256: string
    }>
  }
  const kinds = [
    'chat-list',
    'conversation',
    'floating-pins',
    'message-actions',
    'reply-keyboard',
    'info',
    'info-members',
    'mentions',
    'mention-composer',
    'attention'
  ]
  const expected = CHAT2_SURFACES.filter(s => s !== 'web-320').flatMap(s =>
    kinds.map(k => s + '-' + k + '-after.png')
  )
  expected.push(
    'ios-keyboard-pins-after.png',
    'android-keyboard-pins-after.png',
    'web-320-composer-after.png'
  )
  // Surfaces the owner took out of scope keep their last archived frames:
  // CHAT2_OUT_OF_SCOPE_SURFACES=android while QA runs on the iPhone simulator
  // only. Every frame must still be archived.
  const outOfScope = (process.env.CHAT2_OUT_OF_SCOPE_SURFACES ?? '')
    .split(',')
    .filter(surface => (CHAT2_SURFACES as readonly string[]).includes(surface))
  for (const file of expected) {
    const row = need(
      archive.entries.find(e => e.file === file),
      'Matched AFTER archive is incomplete'
    )
    assert(
      row.source === process.env.CHAT2_SOURCE ||
        (recapturing != null && file.startsWith(recapturing + '-')) ||
        outOfScope.some(surface => file.startsWith(surface + '-')),
      'Archived AFTER source differs'
    )
    const image =
      row.path ??
      join(
        resolve(
          need(process.env.CHAT2_ARTIFACTS, 'Private artifact root required')
        ),
        file
      )
    assert(digest(image) === row.sha256, 'Archived AFTER image changed')
    assert(
      readFileSync(image)
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'Archived AFTER must be actual PNG'
    )
  }
}

function privateFile(path: string): void {
  assert(isAbsolute(path), 'Fixture paths must be explicitly absolute')
  const mode = statSync(path).mode & 0o777
  assert(
    (mode & 0o077) === 0,
    'Private fixture file must not be group/world readable'
  )
}

/** Permit only explicit local origins, including an owned simulator's LAN API. */
export function localOrigin(value: string): string {
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const octets = host.split('.').map(Number)
  const ipv4 =
    octets.length === 4 &&
    octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
  const privateHost =
    host === 'localhost' ||
    host === '::1' ||
    (ipv4 &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)))
  assert(
    url.protocol === 'http:' && privateHost,
    'Only a task-owned local HTTP runtime is allowed'
  )
  assert(
    url.username === '' && url.password === '',
    'Credentials do not belong in origins'
  )
  return url.origin
}

export function outsideCheckout(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path))
  assert(
    rel === '..' || rel.startsWith('../') || isAbsolute(rel),
    'Private artifacts must remain outside the checkout'
  )
}

export function loadChat2Fixture(path: string): Chat2Fixture {
  privateFile(path)
  let fixture: Chat2Fixture
  try {
    fixture = asFixture(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    throw new Error(
      'Invalid private disposable chat2 descriptor; no input values logged'
    )
  }
  assert(
    /^[a-z0-9][a-z0-9-]{5,80}$/.test(fixture.ownershipId),
    'Explicit synthetic resource ownership is required'
  )
  const allowed = new Set(fixture.allowedOrigins.map(localOrigin))
  assert(
    allowed.has(localOrigin(fixture.apiUrl)) &&
      allowed.has(localOrigin(fixture.webUrl)),
    'Runtime origins must be explicitly owned'
  )
  for (const actor of Object.values(fixture.actors)) {
    assert(
      asUserId(actor.userId) === actor.userId,
      'Synthetic user ID required'
    )
    assert(
      /^[^@\s]+@(?:[a-z0-9-]+\.)*example\.(?:test|com)$/i.test(actor.email),
      'Only reserved synthetic email domains are allowed'
    )
    assert(
      actor.password.length > 0,
      'Private synthetic credential is required'
    )
    if (actor.provider != null) {
      privateFile(actor.provider.keyFile)
      privateFile(actor.provider.sessionFile)
      const record = recordFromJson(
        readFileSync(actor.provider.keyFile, 'utf8')
      )
      assert(
        record.userId === actor.userId && record.identity != null,
        'Existing provider must belong to this exact synthetic user'
      )
    }
  }
  for (const key of [...Object.values(fixture.viewers), fixture.peer]) {
    assert(fixture.actors[key] != null, 'Fixture actor reference is missing')
  }
  for (const value of Object.values(fixture.conversations)) {
    if (value != null)
      assert(
        /^cnv_[\w-]+$/.test(value.id),
        'Synthetic conversation ID required'
      )
  }
  if (fixture.files != null) {
    assert(
      !fixture.files.photo.split(/[\\/]/).includes('references'),
      'Reference media must never be fixture uploads'
    )
    assert(
      digest(fixture.files.photo) === fixture.files.sha256,
      'Synthetic upload bytes changed'
    )
  }
  return fixture
}

/** The chat2 harness's own files, named because they are its core. */
const CHAT2_HARNESS_FILES: ReadonlySet<string> = new Set([
  'src/app/chat/chat2.e2e.ts',
  'src/test/chat2Maestro.e2e.ts',
  'src/test/chat2Fixture.e2e.ts',
  'src/app/chat/chat2Actions.test.ts',
  'src/test/chat2FixtureIdentity.test.ts',
  'src/app/chat/engine/dmTitle.test.ts'
])

/**
 * Files under `src/test/` that an application build does take in, so a
 * change to them is an application change. `src/app/dev/
 * chatIdentityStoreProbeRun.ts` imports `legacyChatKeyRecord.json`; the
 * native bundle holds it always (`chatBench.native.ts` imports the bench
 * screen statically) and a served web bundle in development.
 */
export const CHAT2_APPLICATION_TEST_FILES: ReadonlySet<string> = new Set([
  'src/test/legacyChatKeyRecord.json'
])

/**
 * Whether a path can change without changing what an application build is
 * made of: a unit or end-to-end test (`*.test.ts(x)`, `*.e2e.ts(x)`),
 * anything else under `src/test/`, or an end-to-end script in `scripts/`.
 * None of these is reachable from the web entries (`src/build.mjs`), the
 * native entry (`index.js`, through Metro) or the server's (`npm start`,
 * `src/server/index.ts`) — except `CHAT2_APPLICATION_TEST_FILES`, which are.
 */
export function isChat2HarnessPath(path: string): boolean {
  if (CHAT2_APPLICATION_TEST_FILES.has(path)) return false
  return (
    CHAT2_HARNESS_FILES.has(path) ||
    /\.(test|e2e)\.tsx?$/.test(path) ||
    path.startsWith('src/test/') ||
    /^scripts\/[^/]+\.e2e\./.test(path)
  )
}

/** A changed harness may reuse an application build only across test files. */
export function verifyChat2HarnessSource(
  root: string,
  applicationSource: string,
  harnessSource = process.env.CHAT2_HARNESS_SOURCE ?? applicationSource
): {
  applicationSource: string
  harnessSource: string
  harnessDiffSha256: string
  changedTestFiles: Array<{ path: string; sha256: string }>
} {
  assert(
    /^[a-f0-9]{40}$/.test(applicationSource),
    'Full application source SHA required'
  )
  assert(
    /^[a-f0-9]{40}$/.test(harnessSource),
    'Full harness source SHA required'
  )
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  assert(
    git(['rev-parse', 'HEAD']).trim() === harnessSource,
    'Checkout and requested harness source differ'
  )
  assert(
    git(['status', '--porcelain', '--untracked-files=no']).trim() === '',
    'Build/UI proofs require frozen tracked source'
  )
  const ancestry = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', applicationSource, harnessSource],
    { cwd: root }
  )
  assert(ancestry.status === 0, 'Application source must be a harness ancestor')
  const paths = git([
    'diff',
    '--name-only',
    '-z',
    applicationSource,
    harnessSource,
    '--'
  ])
    .split('\0')
    .filter(Boolean)
  assert(
    paths.every(isChat2HarnessPath),
    'Application changes require a new build and capture archive'
  )
  const diff = git([
    'diff',
    '--no-ext-diff',
    '--binary',
    '--full-index',
    applicationSource,
    harnessSource,
    '--'
  ])
  const changedTestFiles = paths.map(path => {
    const committed = git(['show', harnessSource + ':' + path])
    const sha256 = digest(join(root, path))
    assert(
      createHash('sha256').update(committed).digest('hex') === sha256,
      'Harness file differs from its committed bytes'
    )
    return { path, sha256 }
  })
  return {
    applicationSource,
    harnessSource,
    harnessDiffSha256: createHash('sha256').update(diff).digest('hex'),
    changedTestFiles
  }
}

export function sourceBinding(
  root: string,
  fixture: Chat2Fixture,
  surface: Chat2Surface
): {
  source: string
  applicationSource: string
  harnessSource: string
  harnessDiffSha256: string
  changedTestFiles: Array<{ path: string; sha256: string }>
  binding: ReturnType<typeof asBinding>
  bindingReceiptSha256: string
} {
  const source = need(
    process.env.CHAT2_SOURCE,
    'CHAT2_SOURCE must pin the final full source SHA'
  )
  const harness = verifyChat2HarnessSource(root, source)
  const binding = need(
    fixture.bindings[surface],
    'Exact surface build binding required'
  )
  assert(
    binding.source === source && existsSync(binding.receipt),
    'Build must bind this exact frozen source'
  )
  assert(
    digest(binding.artifact) === binding.sha256,
    'Build artifact changed after binding'
  )
  if (binding.bundle != null)
    assert(
      digest(binding.bundle.path) === binding.bundle.sha256,
      'Native JS bundle changed after binding'
    )
  const receipt = JSON.parse(readFileSync(binding.receipt, 'utf8')) as Record<
    string,
    unknown
  >
  assert(receipt.source === source, 'Build receipt source differs')
  const allowed = new Set(fixture.allowedOrigins.map(localOrigin))
  assert(
    allowed.has(localOrigin(binding.apiUrl)) &&
      allowed.has(localOrigin(binding.mediaOrigin)),
    'Build runtime origins are not explicitly owned'
  )
  assert(
    receipt.apiUrl === binding.apiUrl &&
      receipt.mediaOrigin === binding.mediaOrigin,
    'Build/source/API/media binding differs'
  )
  return {
    source,
    ...harness,
    binding,
    bindingReceiptSha256: digest(binding.receipt)
  }
}

export function redact(fixture: Chat2Fixture, value: string): string {
  let text = value
  for (const actor of Object.values(fixture.actors)) {
    for (const secret of [actor.password, actor.email])
      text = text.split(secret).join('[private]')
  }
  return text
}

export function privateJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export async function fixtureClient(
  fixture: Chat2Fixture,
  key: string,
  signal?: AbortSignal
): Promise<TeamStationClient> {
  const actor = need(fixture.actors[key], 'Synthetic API actor missing')
  let token: string | undefined
  if (actor.provider != null) {
    token = (
      JSON.parse(readFileSync(actor.provider.sessionFile, 'utf8')) as {
        token?: string
      }
    ).token
  }
  const client = new TeamStationClient({
    baseUrl: fixture.apiUrl,
    token,
    ...(signal == null
      ? {}
      : {
          fetch: async (
            input: Parameters<typeof fetch>[0] | URL,
            init?: Parameters<typeof fetch>[1]
          ) => {
            signal.throwIfAborted()
            return await fetch(input, {
              ...init,
              signal:
                init?.signal == null
                  ? signal
                  : AbortSignal.any([signal, init.signal])
            })
          }
        }),
    passwordKdf: async (password, costs) =>
      (
        await hash(password, {
          type: argon2id,
          salt: Buffer.from(costs.salt, 'hex'),
          memoryCost: costs.memoryKiB,
          timeCost: costs.iterations,
          parallelism: costs.parallelism,
          hashLength: costs.hashLength,
          raw: true
        })
      ).toString('hex')
  })
  if (token == null)
    await client.signInWithPassword(actor.email, actor.password)
  assert(
    (await client.whoAmI())?.id === actor.userId,
    'API session belongs to another actor'
  )
  return client
}

/** Existing provider only. Wipe/identity replacement is always refused. */
export async function fixturePeer(
  fixture: Chat2Fixture,
  key: string,
  signal?: AbortSignal
): Promise<{
  client: TeamStationClient
  engine: ChatEngine
  approvePending: () => Promise<void>
  rotateUserKey: () => Promise<number>
  close: () => void
}> {
  const actor = need(fixture.actors[key], 'Synthetic peer missing')
  const provider = need(
    actor.provider,
    'Peer requires its own existing protocol provider'
  )
  const initial = recordFromJson(readFileSync(provider.keyFile, 'utf8'))
  const store: ChatKeyStore = {
    load: async () => recordFromJson(readFileSync(provider.keyFile, 'utf8')),
    exists: async () => true,
    save: async record => {
      assert(
        record.userId === actor.userId &&
          record.identity?.id === initial.identity?.id &&
          record.deviceId === initial.deviceId,
        'Refuse provider identity/device replacement'
      )
      writeFileSync(provider.keyFile, recordToJson(record), { mode: 0o600 })
    },
    wipe: async () => {
      throw new Error('Fixture provider/key resets are prohibited')
    }
  }
  const client = await fixtureClient(fixture, key, signal)
  const setup = {
    client,
    store,
    userId: actor.userId,
    device: { name: 'Synthetic protocol peer', platform: 'web' as const }
  }
  const enrolled = await ensureEnrolled(setup)
  signal?.throwIfAborted()
  if (enrolled.state !== 'ready')
    throw new Chat2Blocked(
      'Existing synthetic peer is not ready; preserve its keys'
    )
  let engine = new ChatEngine(setup)
  assert(
    (await engine.start()) === 'ready',
    'Existing protocol peer must be ready'
  )
  return {
    client,
    get engine() {
      return engine
    },
    rotateUserKey: async () => {
      engine.stop()
      const current = need(
        await store.load(),
        'Existing provider record required'
      )
      const rotated = await rotatePuk(setup, current)
      engine = new ChatEngine(setup)
      assert(
        (await engine.start()) === 'ready',
        'Rotated provider must be ready'
      )
      return need(rotated.puks.at(-1), 'Rotated generation required').generation
    },
    approvePending: async () => {
      for (const link of await client.chatLinks()) {
        signal?.throwIfAborted()
        await approveLink(setup, enrolled.record, link)
      }
    },
    close: () => {
      engine.stop()
    }
  }
}

export type Chat2ControlAction =
  | 'prepare'
  | 'snapshot'
  | 'prepare-probes'
  | 'prepare-loop'
  | 'post-loop'
  | 'stress-padding'
  | 'claim-locked'
  | 'restore-attention'
  | 'fault'
  | 'clear-fault'
  | 'set-lao'
  | 'cleanup'

/** Optional private fixture/proxy process; never a second UI driver. */
export function fixtureControl(
  fixture: Chat2Fixture,
  action: Chat2ControlAction,
  detail: Record<string, unknown> = {}
): Record<string, unknown> {
  const control = need(
    fixture.control,
    'This scenario requires the private fixture control/proxy adapter'
  )
  assert(
    digest(control.script) === control.sha256,
    'Private fixture-control implementation changed'
  )
  assert(
    control.dependencies.length > 0,
    'Hash-bound fixture-control dependency graph required'
  )
  for (const file of control.dependencies)
    assert(
      digest(file.path) === file.sha256,
      'Private fixture-control dependency changed'
    )
  assert(
    control.args.includes(control.script),
    'Explicit fixture-control script argument required'
  )
  const result = spawnSync(control.executable, control.args, {
    input: JSON.stringify({
      action,
      ownershipId: fixture.ownershipId,
      ...detail
    }),
    encoding: 'utf8',
    timeout: 60000,
    // A snapshot carries every recorded history page's metadata; a long
    // stress history passes 1 MiB.
    maxBuffer: 32 * 1024 * 1024
  })
  // A refused action answers on stdout ({ok: false, error}) and exits 2.
  if (result.status !== 0)
    throw new Chat2Blocked(
      'Private fixture control failed: ' +
        (result.error == null ? '' : result.error.message + ': ') +
        redact(
          fixture,
          result.stderr === '' ? result.stdout : result.stderr
        ).slice(-600)
    )
  const proof = JSON.parse(result.stdout) as Record<string, unknown>
  assert(
    proof.ownershipId === fixture.ownershipId &&
      proof.uiActions === false &&
      proof.ok === true,
    'Fixture control must prove exact resource ownership and no UI actions'
  )
  return proof
}
