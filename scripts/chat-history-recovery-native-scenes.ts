/**
 * The per-branch data the native follow-up runner reads, made through the
 * real authorized API by synthetic provider engines. Every file it writes is
 * private to the owned fixture directory.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { MessageView } from '../src/app/chat/engine/apply'
import type { ChatEngine } from '../src/app/chat/engine/engine'
import type { TeamStationClient } from '../src/common/api'

export interface NativeSceneProvider {
  client: TeamStationClient
  engine: ChatEngine
}

export interface NativeSceneInput {
  /** The runner's branch, as `chatUiFollowupNative.e2e.ts` is given it. */
  branch: string
  platform: 'ios' | 'android'
  out: string
  ffmpeg: string
  people: Record<string, { userId: string }>
  providers: Record<string, NativeSceneProvider>
  /** A season admin, started only for the read-only reader. */
  admin: () => Promise<NativeSceneProvider>
  /** Turns the league's SafeSport LAO rules on, as its admin does. */
  setLao: () => Promise<void>
  /** The shared group and its readable original and reply. */
  group: { id: string; replyId: string; replyBody: string }
  /** The actor's DM with a second person. */
  other: { id: string }
  relay?: { endpoint: string; token: string; audit: string }
}

export interface NativeScene {
  env: Record<string, string>
  fixture: Record<string, unknown>
}

/** The branches a native scene prepares, by runner argument. */
export const NATIVE_SCENE_BRANCHES = [
  'core',
  'bands',
  'fault-pending-send',
  'fault-send',
  'restricted-closed',
  'restricted-readOnly',
  'fault-page',
  'fault-empty',
  'fault-cancel',
  'deep',
  'attachment-short',
  'attachment-quote',
  'retention',
  'top-retention',
  'list-terminal',
  'hold-probe',
  'attachment-probe',
  'quote-hold-probe',
  'owned-delete-live',
  'read-fixture',
  'return-key',
  'reply-send',
  'messages',
  'reply-probe',
  'reply-capture',
  'picker',
  'picker-large',
  'media-bounds'
] as const

/** The runner argument a scene name stands for. */
export function nativeRunnerBranch(branch: string): string {
  return branch.startsWith('restricted-') ? 'restricted' : branch
}

const DEEP = new Set([
  'deep',
  'attachment-probe',
  'quote-hold-probe',
  'attachment-short',
  'attachment-quote',
  'fault-page',
  'fault-empty',
  'fault-cancel',
  'fault-send',
  'owned-delete-live'
])
const PHOTO = new Set(['picker', 'picker-large', 'fault-send'])
const OVERSIZE = new Set(['picker', 'picker-large'])
/** The runner refuses a photo at or over this size. */
const ATTACHMENT_LIMIT = 100 * 1024 * 1024

function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx'
  })
}

export async function prepareNativeScene(
  input: NativeSceneInput
): Promise<NativeScene> {
  const { branch, out, people, providers } = input
  assert(
    NATIVE_SCENE_BRANCHES.some(name => name === branch),
    'Unknown native scene'
  )
  const env: Record<string, string> = {}
  const fixture: Record<string, unknown> = {
    nativeReplyText: 'Native reply for ' + branch
  }
  const opened = new Set<string>()
  const engineOf = async (
    key: string,
    conversationId: string
  ): Promise<ChatEngine> => {
    const engine = providers[key].engine
    if (!opened.has(key + conversationId)) {
      await engine.open(conversationId)
      opened.add(key + conversationId)
    }
    return engine
  }
  const send = async (
    key: string,
    conversationId: string,
    body: string,
    quoteId?: string
  ): Promise<MessageView> => {
    const engine = await engineOf(key, conversationId)
    if (quoteId != null) {
      // A quote names a message the sender has loaded: page back to it.
      let view = await engine.open(conversationId)
      while (
        !view.messages.some(message => message.id === quoteId) &&
        view.hasEarlier
      )
        view = await engine.loadEarlier(conversationId)
    }
    const message = await engine.sendText(
      conversationId,
      body,
      quoteId == null ? {} : { quoteId }
    )
    assert(message != null, 'Synthetic post was not acknowledged')
    return message
  }
  const attach = async (
    key: string,
    conversationId: string,
    file: {
      bytes: Uint8Array
      contentType: string
      fileName: string
      width?: number
      height?: number
    },
    body = '',
    quoteId?: string
  ): Promise<MessageView> => {
    const message = await (
      await engineOf(key, conversationId)
    ).attach(conversationId, [file], body, quoteId == null ? {} : { quoteId })
    assert(message != null, 'Synthetic attachment was not acknowledged')
    return message
  }
  const image = (name: string, width: number, height: number): string => {
    const path = join(out, name)
    execFileSync(
      input.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc=size=${width}x${height}:rate=1`,
        '-frames:v',
        '1',
        path
      ],
      { stdio: 'ignore' }
    )
    return path
  }
  const notes = 'Practice notes: bring water and a glove.\n'
  const noteFile = {
    bytes: new TextEncoder().encode(notes),
    contentType: 'text/plain',
    fileName: 'practice-notes.txt'
  }

  if (PHOTO.has(branch)) {
    fixture.photoPath = image('practice-photo.png', 64, 64)
  }
  if (OVERSIZE.has(branch)) {
    // Random pixels, so the photo library keeps it over the attachment limit.
    const path = join(out, 'oversize-photo.png')
    execFileSync(
      input.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'nullsrc=s=6200x6200,geq=r=random(1)*255:g=random(2)*255:b=random(3)*255',
        '-frames:v',
        '1',
        '-compression_level',
        '0',
        path
      ],
      { stdio: 'ignore' }
    )
    assert(statSync(path).size > ATTACHMENT_LIMIT, 'Oversize photo too small')
    fixture.oversizePhotoPath = path
  }

  let deep: Record<string, unknown> | undefined
  if (DEEP.has(branch)) {
    // An original with its file just below it, more than a page above the
    // current replies to each.
    const room = await providers.Hc.client.createDm([
      people.Ha.userId,
      people.Hs.userId
    ])
    const originalBody = (
      'Original practice plan: ' +
      'warm up, field grounders, run the bases and finish with batting. '.repeat(
        4
      )
    ).trim()
    // ASCII only, so its length is its code points.
    assert(/^[\x20-\x7e]+$/.test(originalBody) && originalBody.length > 200)
    const original = await send('Hs', room.id, originalBody)
    const file = await attach('Hs', room.id, noteFile)
    const fillerCount = 105
    for (let index = 0; index < fillerCount; index++)
      await send(
        index % 2 === 0 ? 'Ha' : 'Hs',
        room.id,
        `Filler ${index + 1} for the long practice thread`
      )
    // Current replies: one to the file, one to the original far above.
    const fileReply = await send(
      'Hc',
      room.id,
      'Thanks for the practice notes file.',
      file.id
    )
    const reply = await send(
      'Ha',
      room.id,
      'Current reply to the original practice plan.',
      original.id
    )
    deep = {
      conversationId: room.id,
      originalId: original.id,
      originalBody,
      attachmentId: file.id,
      attachmentReplyId: fileReply.id,
      attachmentReplyBody: fileReply.body,
      replyId: reply.id,
      replyBody: reply.body,
      fileName: noteFile.fileName,
      fileBytes: notes,
      fillerCount
    }
    privateJson(join(out, 'deep-fixture.json'), deep)
    env.CHAT_UI_NATIVE_DEEP_FIXTURE = join(out, 'deep-fixture.json')
  }

  let faulted: string | undefined
  if (branch === 'fault-pending-send') {
    const context = await send(
      'A',
      input.other.id,
      'Earlier context for the pending send'
    )
    const reply = await send(
      'A',
      input.other.id,
      'Reply above the pending send',
      context.id
    )
    privateJson(join(out, 'pending-fixture.json'), {
      conversationId: input.other.id,
      replyId: reply.id,
      replyBody: reply.body,
      submittedText: 'Native pending submitted text',
      newerText: 'Native newer unsent text'
    })
    env.CHAT_UI_NATIVE_PENDING_FIXTURE = join(out, 'pending-fixture.json')
    faulted = input.other.id
  } else if (branch.startsWith('fault-')) {
    assert(deep != null)
    faulted = deep.conversationId as string
  }
  if (faulted != null) {
    const relay = input.relay
    assert(relay != null, 'A fault scene requires the owned relay')
    privateJson(join(out, 'control.json'), {
      disposable: true,
      endpoint: relay.endpoint,
      token: relay.token,
      actors: {
        [input.platform]: {
          userId: people.Hc.userId,
          conversationId: faulted
        }
      }
    })
    env.CHAT_RECOVERY_CONTROL_FILE = join(out, 'control.json')
    env.CHAT_UI_NATIVE_FAULT_CONTROL = resolve(
      'scripts/chat-history-recovery-control.cjs'
    )
    env.CHAT_UI_NATIVE_FAULT_AUDIT = relay.audit
  }

  // The runner finds and holds the message by its whole text.
  const scoped = (value: {
    conversationId: string
    messageId: string
    bodyStub: string
  }): void => {
    privateJson(join(out, 'scoped-fixture.json'), value)
    env.CHAT_UI_NATIVE_SCOPED_FIXTURE = join(out, 'scoped-fixture.json')
  }
  if (branch === 'restricted-closed') {
    // Under the league's LAO rules, the coach left alone with a minor: the
    // chat closes, readable but not open to posts.
    await input.setLao()
    const room = await providers.Hc.client.createDm([
      people.Hs.userId,
      people.Ha.userId,
      people.P.userId
    ])
    const note = await send('Hs', room.id, 'Closed chat note for the reader')
    await providers.Hs.client.leaveDm(room.id)
    assert((await providers.Ha.client.leaveDm(room.id)).closed)
    const listed = (await providers.Hc.client.chatConversations()).find(
      row => row.id === room.id
    )
    assert(listed?.closed === true && !listed.canPost)
    scoped({
      conversationId: room.id,
      messageId: note.id,
      bodyStub: note.body ?? ''
    })
    env.CHAT_UI_NATIVE_EXPECTED_COMPOSER = 'closed'
  }
  if (branch === 'restricted-readOnly') {
    // A season admin's announcement the coach may read and react to.
    const admin = await input.admin()
    try {
      const announcements = (await admin.client.chatConversations()).find(
        row => row.kind === 'seasonAnnouncements'
      )
      assert(announcements != null, 'Season announcements are required')
      await admin.engine.open(announcements.id)
      const note = await admin.engine.sendText(
        announcements.id,
        'Season notice for readers'
      )
      assert(note != null)
      const listed = (await providers.Hc.client.chatConversations()).find(
        row => row.id === announcements.id
      )
      assert(listed != null && !listed.canPost && !listed.closed)
      scoped({
        conversationId: announcements.id,
        messageId: note.id,
        bodyStub: note.body ?? ''
      })
    } finally {
      admin.engine.stop()
      await admin.engine.idle()
    }
    env.CHAT_UI_NATIVE_EXPECTED_COMPOSER = 'readOnly'
  }
  if (branch === 'read-fixture')
    scoped({
      conversationId: input.group.id,
      messageId: input.group.replyId,
      bodyStub: input.group.replyBody
    })
  if (branch === 'hold-probe') {
    privateJson(join(out, 'hold-fixture.json'), {
      conversationId: input.group.id,
      messageId: input.group.replyId,
      body: input.group.replyBody,
      holdCount: 3
    })
    env.CHAT_UI_NATIVE_HOLD_FIXTURE = join(out, 'hold-fixture.json')
  }
  if (branch === 'owned-delete-live') {
    // A peer's note the actor quotes and pins; the peer deletes it while the
    // native runner watches (`chat-history-recovery-peer.ts`).
    const original = await send(
      'Hs',
      input.group.id,
      'Owned delete original note'
    )
    const selfReply = await send(
      'Hc',
      input.group.id,
      'Self reply to the deletable note',
      original.id
    )
    await providers.Hc.client.pinChatMessage(input.group.id, original.id, true)
    privateJson(join(out, 'owned-fixture.json'), {
      synthetic: true,
      conversationId: input.group.id,
      originalId: original.id,
      originalBody: original.body,
      selfReplyId: selfReply.id,
      selfReplyBody: selfReply.body,
      authorUserId: people.Hs.userId,
      preparePersonalPin: false,
      pinnedBeforeDelete: true
    })
    env.CHAT_UI_NATIVE_OWNED_FIXTURE = join(out, 'owned-fixture.json')
    env.CHAT_UI_NATIVE_READY_SIGNAL = join(out, 'owned-ready.json')
  }
  if (branch === 'retention' || branch === 'top-retention') {
    // The two-person DM with the first peer that the reading checks use.
    await providers.Hc.client.createDm([people.Hs.userId])
  }
  if (branch === 'list-terminal') {
    // Enough rows to scroll, then two whose latest posts put them on top.
    const rooms: string[] = []
    for (let index = 0; index < 20; index++)
      rooms.push(
        (
          await providers.Hc.client.createDm([
            people.Ha.userId,
            people.Hs.userId
          ])
        ).id
      )
    await send('Hc', rooms[0], 'Second newest row')
    await send('Hc', rooms[1], 'Newest row')
    privateJson(join(out, 'list-terminal-fixture.json'), {
      synthetic: true,
      actorUserId: people.Hc.userId,
      zeroRows: [rooms[1], rooms[0]],
      membersConversationId: input.group.id,
      membersHeading: 'Members'
    })
    env.CHAT_UI_NATIVE_LIST_TERMINAL_FIXTURE = join(
      out,
      'list-terminal-fixture.json'
    )
  }
  if (branch === 'media-bounds') {
    const room = await providers.Hc.client.createDm([
      people.Ha.userId,
      people.Hs.userId
    ])
    const photo = image('media-photo.png', 320, 240)
    const picture = await attach('Hs', room.id, {
      bytes: readFileSync(photo),
      contentType: 'image/png',
      fileName: 'media-photo.png',
      width: 320,
      height: 240
    })
    const file = await attach('Hs', room.id, noteFile)
    privateJson(join(out, 'media-bounds-fixture.json'), {
      conversationId: room.id,
      entries: [
        {
          messageId: picture.id,
          fileNamePrefix: 'media-photo',
          contentType: 'image/png',
          width: 320,
          height: 240
        },
        {
          messageId: file.id,
          fileName: noteFile.fileName,
          contentType: noteFile.contentType
        }
      ]
    })
    env.CHAT_UI_NATIVE_MEDIA_BOUNDS_FIXTURE = join(
      out,
      'media-bounds-fixture.json'
    )
  }
  return { env, fixture }
}
