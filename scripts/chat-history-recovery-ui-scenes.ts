/**
 * Scenes whose people enroll through the actual browser UI: the phone
 * scenarios' retained browsers, and the locked-history chain's.
 *
 * The locked-history chain's scene: season admin S and retaining league admin
 * L, both enrolled through the actual browser UI, in a chat both may post in,
 * with S's original sent through the normal composer. It writes the private
 * environment every step of the chain reads; the chain itself
 * (`run-native-locked.sh`) resets S, links a native device to the reset
 * identity and never approves old history.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TeamStationClient } from '../src/common/api'
import {
  recoveryFixtureEnvironment,
  type RecoveryFixtureOwner,
  requireFixtureFields
} from '../src/test/chatRecoveryFixtureContract'
import type { SeedTablePerson } from '../src/test/chatSeedTable'

function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx'
  })
}

/** Writes the helper's private setup and runs its modes for one scene. */
function helperScene(
  owner: RecoveryFixtureOwner,
  out: string,
  conversationId: string,
  profiles: Record<string, string>
): {
  setup: string
  produce: (mode: string, env?: Record<string, string>) => void
} {
  const setup = join(out, 'reply-setup.json')
  privateJson(setup, {
    synthetic: true,
    source: owner.source,
    origin: owner.webUrl,
    apiUrl: owner.apiUrl,
    seedFile: join(out, 'seed.txt'),
    artifacts: out,
    protectedConversation: conversationId,
    profiles,
    incoming: join(out, 'incoming-fixture.json'),
    small: join(out, 'small-fixture.json')
  })
  const helper = 'src/app/chat/chatHistoryRecoveryReplyFixture.e2e.ts'
  const produce = (mode: string, env: Record<string, string> = {}): void => {
    let output = `$ node -r sucrase/register ${helper} ${mode}\n`
    try {
      output += execFileSync(
        process.execPath,
        ['-r', 'sucrase/register', helper, mode],
        {
          env: {
            ...process.env,
            CHAT_RECOVERY_REPLY_SETUP: setup,
            MAESTRO_D: 'recovery-scene-' + Date.now(),
            ...env
          },
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
  return { setup, produce }
}

/**
 * The phone scenarios' run directory: coach Hc and parent B with retained
 * browser profiles `Hc-1` and `B-1`, enrolled through the UI; parent N is
 * still new to chat for P1.
 */
export async function preparePhonesScene(input: {
  owner: RecoveryFixtureOwner
  out: string
  conversationId: string
  ffmpeg: string
  clip: boolean
}): Promise<string> {
  const { owner, out } = input
  const { produce } = helperScene(owner, out, input.conversationId, {
    'Hc-1': join(out, 'profiles', 'Hc-1'),
    'B-1': join(out, 'profiles', 'B-1')
  })
  produce('enroll', { CHAT_RECOVERY_ENROLL: 'Hc-1,B-1' })
  // P3 plays B's video in the shared chat, as the browser scenarios leave it.
  const clip = join(out, 'clip.mp4')
  if (input.clip) {
    execFileSync(
      input.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x360:rate=24',
        '-t',
        '6',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        clip
      ],
      { stdio: 'ignore' }
    )
    produce('clip', {
      CHAT_RECOVERY_CLIP_ACTOR: 'B-1',
      CHAT_RECOVERY_CLIP_FILE: clip
    })
  }
  const path = join(out, 'env.sh')
  writeFileSync(
    path,
    recoveryFixtureEnvironment({
      TS_CHAT_WEB_URL: owner.webUrl,
      TS_CHAT_API_URL: owner.apiUrl,
      CHAT_ARTIFACTS: out,
      CHAT_P1_PERSON: 'N',
      CHAT_P2_PERSON: 'B',
      CHAT_RECOVERY_FIXTURE_SOURCE: owner.source
    }),
    { mode: 0o600, flag: 'wx' }
  )
  return path
}

export async function prepareLockedScene(input: {
  owner: RecoveryFixtureOwner
  out: string
  people: Record<string, SeedTablePerson>
  signIn: (person: SeedTablePerson) => Promise<TeamStationClient>
}): Promise<string> {
  const { owner, out, people } = input
  const admin = await input.signIn(people.S)
  const peer = await input.signIn(people.L)
  // A chat both S and L may post in, that is no DM. A just-reset fixture can
  // still be creating its entity chats on a busy shared cluster.
  let chat: { id: string; title?: string | null } | undefined
  let other: string | undefined
  const deadline = Date.now() + 90000
  while (chat == null && Date.now() < deadline) {
    const mine = await admin.chatConversations()
    const theirs = await peer.chatConversations()
    chat = mine.find(
      row =>
        row.kind !== 'dm' &&
        row.canPost &&
        theirs.some(their => their.id === row.id && their.canPost)
    )
    other = mine.find(row => row.id !== chat?.id)?.id
    if (chat == null) await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert(chat != null && other != null, 'A shared S and L chat is required')
  const profiles = {
    S: join(out, 'profiles', 'S-original'),
    'S-reset': join(out, 'profiles', 'S-reset'),
    L: join(out, 'profiles', 'L')
  }
  const { setup, produce } = helperScene(owner, out, chat.id, profiles)
  produce('enroll', { CHAT_RECOVERY_ENROLL: 'S,L' })
  produce('locked-original')
  const locked = JSON.parse(
    readFileSync(join(out, 'locked-original.json'), 'utf8')
  ) as { conversationId: string; originalId: string; originalBody: string }
  requireFixtureFields(locked, ['conversationId', 'originalId', 'originalBody'])
  assert.equal(locked.conversationId, chat.id)
  const fixture = {
    synthetic: true,
    disposable: true,
    appId: 'app.teamstation.app',
    scheme: 'teamstation',
    apiUrl: owner.apiUrl,
    conversationId: chat.id,
    conversationLabel: chat.title ?? '',
    scopeName: chat.title ?? '',
    scopePill: '',
    targetText: locked.originalBody,
    replyText: locked.originalBody,
    originalMessageIds: [locked.originalId],
    draft: 'Locked chain draft',
    probePost: 'Locked chain probe',
    orientationPolicy: 'portrait-only',
    actor: people.S,
    peers: [{ userId: people.L.userId }]
  }
  privateJson(join(out, 'fixture.json'), fixture)
  mkdirSync(join(out, 'results'), { mode: 0o700 })
  const path = join(out, 'env.sh')
  writeFileSync(
    path,
    recoveryFixtureEnvironment({
      TS_CHAT_WEB_URL: owner.webUrl,
      TS_CHAT_API_URL: owner.apiUrl,
      CHAT_UI_SEED_FILE: join(out, 'seed.txt'),
      CHAT_UI_ARTIFACTS: join(out, 'results'),
      CHAT_RECOVERY_REPLY_SETUP: setup,
      CHAT_UI_CONVERSATION: other,
      CHAT_UI_LOCKED_ACTOR: 'S',
      CHAT_UI_LOCKED_CONVERSATION: chat.id,
      CHAT_UI_LOCKED_ORIGINAL: locked.originalId,
      CHAT_UI_LOCKED_ORIGINAL_BODY: locked.originalBody,
      CHAT_UI_LOCKED_LINK_REQUEST: join(out, 'link-request.json'),
      CHAT_UI_LOCKED_PROVIDER_BACKUP: join(
        out,
        'profiles',
        'S-original-backup'
      ),
      CHAT_UI_LOCKED_REPLY_RESULT: join(out, 'locked-reply.json'),
      CHAT_RECOVERY_LOCKED_ORIGINAL_PROFILE: profiles.S,
      CHAT_RECOVERY_LOCKED_RESET_PROFILE: profiles['S-reset'],
      CHAT_RECOVERY_LOCKED_PEER_PROFILE: profiles.L,
      CHAT_UI_NATIVE_FIXTURE_FILE: join(out, 'fixture.json'),
      CHAT_UI_NATIVE_ARTIFACTS: join(out, 'results'),
      CHAT_UI_NATIVE_LINK_REQUEST: join(out, 'link-request.json'),
      CHAT_UI_NATIVE_LOCKED_FIXTURE: join(out, 'locked-original.json'),
      CHAT_UI_NATIVE_LOCKED_REPLY: join(out, 'locked-reply.json'),
      CHAT_UI_NATIVE_STAGE: 'M4',
      CHAT_UI_NATIVE_DISPOSABLE: '1',
      // Six native steps observe as S; one session keeps them clear of the
      // sign-in rate limit.
      CHAT_UI_NATIVE_OBSERVER_CACHE: join(out, 'observer-session.json'),
      CHAT_RECOVERY_FIXTURE_SOURCE: owner.source
    }),
    { mode: 0o600, flag: 'wx' }
  )
  return path
}
