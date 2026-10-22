import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  ChatConversation,
  ChatPerson,
  IncludedAdult
} from '../../common/api'
import type { AttachmentRef } from '../../common/chatContent'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import { AttachmentView } from './AttachmentView'
import {
  bytesUri,
  pickFiles,
  readPicked,
  releaseUri,
  saveFile
} from './chatFiles'
import { ChatGate } from './ChatGate'
import { ChatInfoScreen } from './ChatInfoScreen'
import { ChatLinks } from './ChatLinks'
import { ChatListScreen } from './ChatListScreen'
import {
  chat,
  measureChatTestViewport,
  member,
  message,
  settleChatMessageActions,
  view
} from './chatViews.test.helpers'
import { Composer } from './Composer'
import {
  type ConversationFiles,
  ConversationScreen
} from './ConversationScreen'
import { EMOJI, EMOJI_GROUPS, EmojiPicker, searchEmoji } from './EmojiPicker'
import type { MessageView } from './engine/apply'
import {
  type ConversationListItem,
  type ConversationView,
  dmTitle,
  type GrantApproval
} from './engine/engine'
import type { ChatKeysClient } from './engine/links'
import type { ChatEngineEvent, ChatEngineListener } from './engine/store'
import { NewDmScreen } from './NewDmScreen'
import { SafetyNumberScreen } from './SafetyNumberScreen'
import type { ChatScreenEngine } from './screenEngine'
import { swipeHandlers, SwipeToReply } from './SwipeToReply'

/**
 * U13, the screens: the chat list, a conversation (composer, banners,
 * long-press menu per role, read ticks, attachments), a new DM with the
 * SafeSport sheet, members with approvals, safety numbers, and the web's
 * attachment twin — each against a stand-in engine and client.
 */
let root: Root | undefined
let oldMatchMedia: PropertyDescriptor | undefined
let touchFixture = false
let restoreViewport: (() => void) | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  restoreViewport?.()
  restoreViewport = undefined
  if (touchFixture) {
    if (oldMatchMedia == null)
      delete (globalThis as { matchMedia?: unknown }).matchMedia
    else Object.defineProperty(globalThis, 'matchMedia', oldMatchMedia)
    touchFixture = false
  }
})

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const text = (): string => document.body.textContent ?? ''

async function render(element: React.ReactElement): Promise<void> {
  restoreViewport ??= measureChatTestViewport()
  if (!touchFixture) {
    oldMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addListener: () => {},
        removeListener: () => {}
      })
    })
    touchFixture = true
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(20)
  })
  await settleChatMessageActions()
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await delay(ms)
  })
}

async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await settle(20)
  }
  throw new Error(`Timed out waiting for ${what}: ${text().slice(0, 400)}`)
}

/** The element labelled exactly so (jsdom's selectors trip on emoji). */
function labelled(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[aria-label]')].find(
      node => node.getAttribute('aria-label') === label
    ) ?? null
  )
}

const page = (): Window & typeof globalThis => document.defaultView!

function button(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node =>
      (node.getAttribute('aria-label') ?? '') === label ||
      (node.getAttribute('aria-label') == null &&
        (node.textContent ?? '').endsWith(label))
  )
}

async function press(label: string): Promise<void> {
  const found = button(label) ?? labelled(label) ?? undefined
  expect(
    found,
    `${label} among ${[...document.querySelectorAll('[role="button"]')]
      .map(node => node.getAttribute('aria-label') ?? node.textContent)
      .join(' | ')}`
  ).not.equals(undefined)
  await act(async () => {
    found!.click()
    await delay(20)
  })
  await settleChatMessageActions()
}

/** Types into a field the way React hears it. */
async function typeInto(label: string, value: string): Promise<void> {
  const field = labelled(label) as HTMLInputElement | HTMLTextAreaElement
  expect(field, label).not.equals(null)
  const proto =
    field instanceof page().HTMLTextAreaElement
      ? page().HTMLTextAreaElement.prototype
      : page().HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
    field.dispatchEvent(new (page().Event)('input', { bubbles: true }))
    await delay(20)
  })
}

/**
 * Holds the mouse on the words until the long press fires. Tried again a
 * time or two: a press another test left half done can swallow the first.
 */
async function longPress(words: string): Promise<void> {
  const node = [...document.querySelectorAll<HTMLElement>('div')].find(
    candidate =>
      candidate.textContent === words && candidate.children.length === 0
  )
  expect(node, words).not.equals(undefined)
  const menu = (): boolean =>
    [...document.querySelectorAll('[aria-label]')].some(found =>
      (found.getAttribute('aria-label') ?? '').startsWith('Message from ')
    )
  for (let attempt = 0; attempt < 3 && !menu(); attempt++) {
    await act(async () => {
      for (const type of ['mousedown', 'mouseup']) {
        node!.dispatchEvent(
          new (page().MouseEvent)(type, {
            bubbles: true,
            button: 0,
            buttons: type === 'mousedown' ? 1 : 0
          })
        )
        if (type === 'mousedown') await delay(600)
      }
      await delay(20)
    })
  }
}

/** A safety number: 60 digits. */
const SAFETY = '1234567890'.repeat(6)

/** A key client the gate never reaches, since the engine says ready. */
const unusedClient: ChatKeysClient = Object.create(null)

class FakeEngine implements ChatScreenEngine {
  list: ConversationListItem[] = []
  views = new Map<string, ConversationView>()
  calls: string[] = []
  listeners = new Set<ChatEngineListener>()
  waiting: GrantApproval[] = []
  startAs: 'ready' | 'link' | 'fail' = 'ready'
  /** Opens to refuse before one succeeds. */
  refuseOpens = 0
  failSend = false

  async start(): Promise<'ready' | 'link' | 'reset'> {
    this.calls.push('start')
    if (this.startAs === 'fail') throw new Error('offline')
    return this.startAs
  }

  async refresh(): Promise<ConversationListItem[]> {
    this.calls.push('refresh')
    return this.list
  }

  conversations(): ConversationListItem[] {
    return this.list
  }

  subscribe(listener: ChatEngineListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: ChatEngineEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  async open(id: string): Promise<ConversationView> {
    this.calls.push(`open ${id}`)
    if (this.refuseOpens > 0) {
      this.refuseOpens -= 1
      throw new Error('Not in chat')
    }
    const found = this.views.get(id)
    if (found == null) throw new Error('Not in chat')
    return found
  }

  close(id: string): void {
    this.calls.push(`close ${id}`)
  }

  view(id: string): ConversationView | undefined {
    return this.views.get(id)
  }

  async loadEarlier(id: string): Promise<ConversationView> {
    this.calls.push(`loadEarlier ${id}`)
    return this.views.get(id)!
  }

  private async sent(call: string): Promise<MessageView | undefined> {
    this.calls.push(call)
    if (this.failSend) throw new HttpError('conflict', 'no')
    return undefined
  }

  async sendText(
    id: string,
    body: string,
    options: { quoteId?: string } = {}
  ): Promise<MessageView | undefined> {
    return await this.sent(`send ${id} ${body} ${options.quoteId ?? '-'}`)
  }

  async attach(
    id: string,
    files: Array<{ fileName: string }>,
    body = '',
    options: { quoteId?: string } = {}
  ): Promise<MessageView | undefined> {
    return await this.sent(
      `attach ${id} ${files.map(file => file.fileName).join(',')} ${body} ${options.quoteId ?? '-'}`
    )
  }

  async react(
    id: string,
    target: string,
    emoji: string,
    remove = false
  ): Promise<void> {
    await this.sent(`react ${id} ${target} ${emoji} ${remove}`)
  }

  async edit(id: string, target: string, body: string): Promise<void> {
    await this.sent(`edit ${id} ${target} ${body}`)
  }

  async deleteMessage(id: string, target: string): Promise<void> {
    await this.sent(`delete ${id} ${target}`)
  }

  async moderatorDelete(id: string, target: string): Promise<void> {
    await this.sent(`moderatorDelete ${id} ${target}`)
  }

  async report(
    id: string,
    target: string
  ): Promise<{ id: string; verified: boolean }> {
    await this.sent(`report ${id} ${target}`)
    return { id: 'crp_1', verified: true }
  }

  async markRead(id: string): Promise<void> {
    this.calls.push(`markRead ${id}`)
  }

  typing(id: string): boolean {
    this.calls.push(`typing ${id}`)
    return true
  }

  async openAttachment(ref: AttachmentRef): Promise<Uint8Array> {
    this.calls.push(`openAttachment ${ref.fileName}`)
    if (ref.fileName.includes('broken')) throw new Error('digest')
    return new Uint8Array([1, 2, 3])
  }

  approvals(): GrantApproval[] {
    return this.waiting
  }

  async approve(requestId: number): Promise<void> {
    this.calls.push(`approve ${requestId}`)
    if (requestId === 99) throw new Error('refused')
    this.waiting = this.waiting.filter(
      approval => approval.requestId !== requestId
    )
  }

  async fillGrants(): Promise<number> {
    this.calls.push('fillGrants')
    return 0
  }

  async safetyNumber(userId: string): Promise<string | undefined> {
    if (userId === userIdOfGumbo(404)) throw new Error('offline')
    return userId === userIdOfGumbo(405) ? undefined : SAFETY
  }
}

/** A stand-in for the platform's file twin. */
function fakeFiles(log: string[]): ConversationFiles {
  return {
    PICK_SOURCES: ['photos', 'files'],
    pickFiles: async source => {
      log.push(`pick ${source}`)
      return source === 'photos'
        ? [
            {
              bytes: new Uint8Array(4),
              contentType: 'image/jpeg',
              fileName: 'photo.jpg',
              width: 4,
              height: 3
            }
          ]
        : [
            {
              bytes: new Uint8Array(104857601),
              contentType: 'application/pdf',
              fileName: 'huge.pdf'
            }
          ]
    },
    bytesUri: async (_bytes, _type, name) => {
      log.push(`uri ${name}`)
      return `blob:${name}`
    },
    releaseUri: async uri => {
      log.push(`release ${uri}`)
    },
    saveFile: async (_bytes, _type, name) => {
      log.push(`save ${name}`)
    }
  }
}

const attachment = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: 'cat_1',
  key: 'k',
  digest: 'd',
  size: 48209,
  contentType: 'image/jpeg',
  fileName: 'photo.jpg',
  width: 1280,
  height: 960,
  ...over
})

describe('the chat list', function () {
  it('groups chats, counts unread, badges locked and closed, and opens one', async function () {
    const engine = new FakeEngine()
    engine.list = [
      chat({ id: 'a', unread: 3, lastMessageAt: new Date().toISOString() }),
      chat({ id: 'b', kind: 'teamFans', title: 'Hawks Fans', locked: true }),
      chat({
        id: 'c',
        kind: 'dm',
        title: 'Pat P',
        scope: null,
        scopeName: null,
        closed: true,
        memberCount: 1,
        lastMessageAt: '2027-04-01T10:00:00Z'
      })
    ]
    const opened: string[] = []
    let newMessage = 0
    await render(
      <ChatListScreen
        engine={engine}
        onOpen={item => opened.push(item.id)}
        onNewMessage={() => (newMessage += 1)}
      />
    )
    await until('the list', () => button('Hawks Fans') != null)
    const words = text()
    expect(words).contains('Hawks')
    expect(words).contains('Team Fans')
    expect(words).contains('Team Members')
    expect(words).contains('Chats')
    expect(labelled('3 unread')).not.equals(null)
    expect(words).contains('Locked')
    expect(words).contains('Closed')
    expect(words).not.contains('No messages yet')
    await press('Pat P')
    expect(opened).deep.equals(['c'])
    await press('New message')
    expect(words).not.contains('Follow a team')
    expect(newMessage).equals(1)

    // A new list from the engine redraws it.
    engine.list = [chat({ id: 'a', title: 'Hawks Members', unread: 0 })]
    await act(async () => {
      engine.emit({ type: 'conversations' })
      await delay(10)
    })
    expect(text()).not.contains('Hawks Fans')
  })

  it('names a DM whose others have all left by who was in it', async function () {
    const engine = new FakeEngine()
    const dm = (id: string, title: string): ConversationListItem =>
      chat({
        id,
        kind: 'dm',
        title,
        scope: null,
        scopeName: null,
        memberCount: 1,
        lastMessageAt: new Date().toISOString()
      })
    engine.list = [
      dm(
        'd1',
        dmTitle(userIdOfGumbo(1), undefined, [
          { userId: userIdOfGumbo(2), shortName: 'Eli C', left: true }
        ])
      ),
      dm(
        'd2',
        dmTitle(
          userIdOfGumbo(1),
          [member(userIdOfGumbo(1), 'Dana D')],
          [
            { userId: userIdOfGumbo(3), shortName: 'Blair B', left: true },
            { userId: userIdOfGumbo(4), shortName: 'Hank C', left: true }
          ]
        )
      ),
      dm(
        'd3',
        dmTitle(userIdOfGumbo(1), [member(userIdOfGumbo(1), 'Dana D')], [])
      )
    ]
    const opened: string[] = []
    await render(
      <ChatListScreen
        engine={engine}
        onOpen={item => opened.push(item.id)}
        onNewMessage={() => {}}
      />
    )
    await until('the list', () => text().includes('Eli C (left)'))
    expect(text()).contains('Blair B (left), Hank C (left)')
    expect(text()).contains('Just you')
    await press('Eli C (left)')
    expect(opened).deep.equals(['d1'])
  })

  it('has no New message for someone whose only ties are follows', async function () {
    const engine = new FakeEngine()
    engine.list = [chat({ kind: 'teamFans', title: 'Hawks Fans' })]
    await render(
      <ChatListScreen
        engine={engine}
        onOpen={() => {}}
        onNewMessage={() => {}}
      />
    )
    await until('the list', () => button('Hawks Fans') != null)
    expect(button('New message')).equals(undefined)
    expect(button('Follow a team')).equals(undefined)
  })

  it('says so when there are no chats, or the list will not load', async function () {
    const engine = new FakeEngine()
    await render(
      <ChatListScreen
        engine={engine}
        onOpen={() => {}}
        onNewMessage={() => {}}
      />
    )
    await until('the empty list', () =>
      text().includes('You are in no chats yet.')
    )
    await act(async () => {
      root?.unmount()
    })
    engine.refresh = async () => {
      throw new Error('offline')
    }
    await render(
      <ChatListScreen
        engine={engine}
        onOpen={() => {}}
        onNewMessage={() => {}}
      />
    )
    await until('the failure', () =>
      text().includes('Chat could not be opened.')
    )
  })
})

describe('the chat gate', function () {
  it('shows the screen once the device is ready', async function () {
    const engine = new FakeEngine()
    await render(
      <ChatGate engine={engine} client={unusedClient} userId={userIdOfGumbo(1)}>
        <span>inside</span>
      </ChatGate>
    )
    await until('inside', () => text().includes('inside'))
  })

  it('offers another try when chat will not start', async function () {
    const engine = new FakeEngine()
    engine.startAs = 'fail'
    await render(
      <ChatGate engine={engine} client={unusedClient} userId={userIdOfGumbo(1)}>
        <span>inside</span>
      </ChatGate>
    )
    await until('the failure', () =>
      text().includes('Chat could not be opened.')
    )
    engine.startAs = 'ready'
    await press('Try again')
    await until('inside', () => text().includes('inside'))
    expect(engine.calls.filter(call => call === 'start')).length(2)
  })

  it('links this device first when the person uses chat elsewhere', async function () {
    const engine = new FakeEngine()
    engine.startAs = 'link'
    const client = {
      myChatKeys: async () => {
        throw new Error('offline')
      }
    }
    await render(
      <ChatGate
        engine={engine}
        client={client as never}
        userId={userIdOfGumbo(1)}
        pollMs={50}
      >
        <span>inside</span>
      </ChatGate>
    )
    await until('the link screen', () => !text().includes('Opening chat'))
    expect(text()).not.contains('inside')
  })
})

describe('a conversation', function () {
  this.timeout(10000)

  async function open(
    shown: ConversationView,
    over: Partial<{
      engine: FakeEngine
      log: string[]
      swipe: boolean
      onMembers: () => void
    }> = {}
  ): Promise<{ engine: FakeEngine; log: string[]; titles: string[] }> {
    const engine = over.engine ?? new FakeEngine()
    engine.views.set(shown.conversation.id, shown)
    engine.list = [shown.conversation]
    const log = over.log ?? []
    const titles: string[] = []
    await render(
      <ConversationScreen
        engine={engine}
        userId={userIdOfGumbo(1)}
        conversationId={shown.conversation.id}
        onMembers={over.onMembers ?? (() => {})}
        onTitle={title => titles.push(title)}
        files={fakeFiles(log)}
        paneHeader
        swipe={over.swipe ?? false}
      />
    )
    await until(
      'the chat',
      () =>
        document.querySelector('[data-testid="chat-message-history"]') != null
    )
    return { engine, log, titles }
  }

  it('shows History is locked and holds the composer off', async function () {
    const { titles } = await open(
      view({
        historyLocked: true,
        composer: 'locked',
        messages: [message({ status: 'locked', body: '' })]
      })
    )
    expect(text()).contains(
      'History is locked — it unlocks when another member opens TeamStation'
    )
    expect(text()).contains('Locked message')
    const field = labelled('Message') as HTMLTextAreaElement
    expect(field.readOnly).equals(true)
    expect(field.placeholder).equals('Waiting for history to unlock…')
    expect(titles).deep.equals(['Hawks Members'])
  })

  it('hides the composer from an Announcements reader, who may still react', async function () {
    const { engine } = await open(
      view({
        conversation: chat({
          kind: 'seasonAnnouncements',
          title: 'QPLL Spring 2027 Announcements',
          canPost: false
        }),
        composer: 'readOnly',
        messages: [message({ body: 'Opening day is Saturday' })]
      })
    )
    expect(labelled('Message')).equals(null)
    expect(text()).contains('Only season staff post here. You can react.')
    await longPress('Opening day is Saturday')
    expect(button('Reply')).equals(undefined)
    await press('React with 👍')
    await until('the reaction', () =>
      engine.calls.includes('react cnv_1 msg_1 👍 false')
    )
  })

  it('reads a closed chat with personal copy and pin but no posting actions', async function () {
    await open(
      view({
        conversation: chat({ closed: true }),
        composer: 'closed',
        messages: [message({ body: 'old words' })]
      })
    )
    expect(text()).contains('This chat is closed')
    expect(labelled('Message')).equals(null)
    await longPress('old words')
    expect(button('React with 👍')).equals(undefined)
    expect(button('Reply')).equals(undefined)
    expect(button('Report')).equals(undefined)
    expect(button('Copy')).not.equals(undefined)
    expect(button('Pin')).not.equals(undefined)
    await press('Cancel')
  })

  it('offers the restricted mobile message actions without edit or report', async function () {
    await open(
      view({
        messages: [
          message({ mine: true, body: 'my words' }),
          message({
            id: 'received',
            senderName: 'Casey C',
            body: 'received words'
          })
        ]
      })
    )
    await longPress('my words')
    for (const label of ['Reply', 'Copy', 'Pin', 'Delete'])
      expect(button(label), label).not.equals(undefined)
    for (const label of [
      'Edit',
      'Report',
      'Forward',
      'Select',
      'Speak',
      'Info'
    ])
      expect(button(label), label).equals(undefined)
    await press('Cancel')
    await longPress('received words')
    for (const label of ['Reply', 'Copy', 'Pin'])
      expect(button(label), label).not.equals(undefined)
    expect(button('Delete')).equals(undefined)
    await press('Cancel')
  })

  it('writes with emoji, replies, attaches, and sends', async function () {
    const { engine, log } = await open(
      view({ messages: [message({ body: 'Game day' })] })
    )
    expect(engine.calls).includes('markRead cnv_1')

    // Emoji from the picker go into the words.
    await typeInto('Message', 'Go ')
    expect(engine.calls).includes('typing cnv_1')
    await press('Emoji')
    await until('the picker', () => labelled('grinning face') != null)
    await press('grinning face')
    expect((labelled('Message') as HTMLTextAreaElement).value).equals('Go 😀')
    await press('Emoji')

    // Reply from the long-press menu, with its chip.
    await longPress('Game day')
    await press('Reply')
    expect(text()).contains('Replying to Hank C')
    await press('Cancel reply')
    expect(text()).not.contains('Replying to')
    await longPress('Game day')
    await press('Reply')

    // Attach: two places to pick from, a chip each, one removed.
    await press('Attach')
    await press('Photo library')
    await until('the chip', () => text().includes('photo.jpg'))
    await press('Attach')
    await press('File')
    await until('the size rejection', () =>
      text().includes('huge.pdf is too large')
    )
    expect(log).deep.equals(['pick photos', 'pick files'])
    expect(labelled('Remove huge.pdf')).equals(null)
    await press('Send')
    await until('the send', () =>
      engine.calls.some(call => call.startsWith('attach'))
    )
    expect(engine.calls).includes('attach cnv_1 photo.jpg Go 😀 msg_1')
    await until(
      'the composer to clear',
      () => (labelled('Message') as HTMLTextAreaElement).value === ''
    )
    expect(text()).not.contains('photo.jpg')

    // Plain words.
    await typeInto('Message', 'Again')
    await press('Send')
    await until('the send', () => engine.calls.includes('send cnv_1 Again -'))

    // A refusal says so and keeps the words.
    engine.failSend = true
    await typeInto('Message', 'Once more')
    await press('Send')
    await until('the failure', () =>
      text().includes('That did not send. Try again.')
    )
    expect((labelled('Message') as HTMLTextAreaElement).value).equals(
      'Once more'
    )
  })

  it('confirms deletion for everyone for authors and moderators and retains reactions', async function () {
    const { engine } = await open(
      view({
        conversation: chat({ canModerate: true }),
        messages: [
          message({ id: 'msg_mine', mine: true, body: 'Snack schedule' }),
          message({ id: 'msg_c', senderName: 'Casey C', body: 'first from C' }),
          message({
            id: 'msg_gone',
            status: 'removed',
            removedBy: 'moderator',
            body: ''
          }),
          message({
            id: 'msg_own_gone',
            status: 'removed',
            removedBy: 'author',
            body: ''
          })
        ]
      })
    )
    expect(text()).contains('Removed by a moderator')
    expect(text()).contains('Message deleted')
    await longPress('Snack schedule')
    expect(button('Edit')).equals(undefined)
    await press('Delete')
    expect(text()).contains('This message will be removed for everyone.')
    expect(engine.calls.some(call => call.startsWith('delete'))).equals(false)
    await press('Delete')
    await until('the author delete', () =>
      engine.calls.includes('delete cnv_1 msg_mine')
    )
    await longPress('first from C')
    expect(button('Delete for everyone')).equals(undefined)
    await press('Delete')
    await press('Delete')
    await until('the moderator delete', () =>
      engine.calls.includes('moderatorDelete cnv_1 msg_c')
    )
    await longPress('first from C')
    await press('Cancel')
    await longPress('first from C')
    await press('More emoji')
    await until('the picker', () => labelled('grinning face') != null)
    await press('grinning face')
    await until('the reaction', () =>
      engine.calls.includes('react cnv_1 msg_c 😀 false')
    )
  })

  it('names who read one’s own messages up to 20 members, and counts above', async function () {
    await open(
      view({
        conversation: chat({ memberCount: 12 }),
        members: [
          member(userIdOfGumbo(5), 'Blair B'),
          member(userIdOfGumbo(6), 'Casey C')
        ],
        messages: [
          message({
            id: 'msg_1',
            mine: true,
            body: 'one',
            readBy: [userIdOfGumbo(5), userIdOfGumbo(6)]
          }),
          message({ id: 'msg_2', mine: true, seq: 2, body: 'two' }),
          message({
            id: 'msg_3',
            seq: 3,
            body: 'three',
            readBy: [userIdOfGumbo(5)]
          })
        ]
      })
    )
    expect(text()).contains('✓✓ Read by Blair B, Casey C')
    expect(text()).contains('✓ Sent')
    expect(text().match(/Read by/g)).length(1)
    await act(async () => {
      root?.unmount()
    })
    await open(
      view({
        conversation: chat({ memberCount: 21 }),
        messages: [
          message({
            mine: true,
            body: 'big',
            readBy: [userIdOfGumbo(5), userIdOfGumbo(6), userIdOfGumbo(7)]
          })
        ]
      })
    )
    expect(text()).contains('✓✓ Seen by 3')
  })

  it('shows reactions, quotes, typing, notices and banners', async function () {
    const now = Date.parse('2027-04-01T17:00:00.000Z')
    const onMembers: string[] = []
    const engine = new FakeEngine()
    engine.waiting = [
      {
        requestId: 7,
        conversationId: 'cnv_1',
        conversationTitle: 'Hawks Members',
        userId: userIdOfGumbo(9),
        name: 'Drew D',
        oldSafetyNumber: SAFETY,
        newSafetyNumber: SAFETY
      },
      // The person's own reset is never put to them.
      {
        requestId: 6,
        conversationId: 'cnv_1',
        conversationTitle: 'Hawks Members',
        userId: userIdOfGumbo(1),
        name: 'Ari A',
        oldSafetyNumber: SAFETY,
        newSafetyNumber: SAFETY
      }
    ]
    await open(
      view({
        unverified: true,
        earlierLost: true,
        hasEarlier: true,
        typing: [{ userId: userIdOfGumbo(3), name: 'Blair B' }],
        safetyChanges: [
          { userId: userIdOfGumbo(9), name: 'Drew D', seq: 4, at: now - 1000 }
        ],
        messages: [
          message({ id: 'msg_lost', status: 'lost', body: '' }),
          message({
            id: 'msg_2',
            seq: 2,
            senderName: undefined,
            body: 'from someone gone',
            sentBeforeSafetyNumberChange: true,
            quote: {
              id: 'msg_x',
              authorId: userIdOfGumbo(2),
              authorName: undefined,
              snippet: 'what was said'
            },
            reactions: [
              {
                emoji: '👍',
                userIds: [userIdOfGumbo(1), userIdOfGumbo(3)],
                mine: true
              }
            ],
            edited: true
          }),
          message({ id: 'msg_3', seq: 3, status: 'invalid', body: '' })
        ]
      }),
      { engine, onMembers: () => onMembers.push('members') }
    )
    const words = text()
    expect(words).contains('Membership record could not be verified')
    expect(words).contains('Earlier messages can’t be opened')
    expect(words).contains('This message can’t be opened')
    expect(words).contains('This message could not be verified')
    expect(words).contains('Former member')
    expect(words).contains('what was said')
    expect(words).contains('edited')
    expect(words).contains('sent before Former member’s safety number changed')
    expect(words).contains('Blair B is typing…')
    expect(words).contains('Drew D’s safety number changed')
    expect(words).contains(
      'Drew D reset their chat keys and asks for this chat’s history.'
    )
    expect(words).not.contains('Ari A reset')
    expect(labelled('👍, 2')).not.equals(null)
    await press('👍, 2')
    await until('the reaction taken back', () =>
      engine.calls.includes('react cnv_1 msg_2 👍 true')
    )
    await press('Review')
    await press('Hawks, Team Members')
    expect(onMembers).deep.equals(['members', 'members'])
    await press('Load earlier messages')
    await until('earlier', () => engine.calls.includes('loadEarlier cnv_1'))

    // A new view from the engine, and approvals that went.
    engine.waiting = []
    engine.views.set(
      'cnv_1',
      view({
        typing: [
          { userId: userIdOfGumbo(3), name: 'Blair B' },
          { userId: userIdOfGumbo(4), name: undefined }
        ]
      })
    )
    await act(async () => {
      engine.emit({ type: 'approvals' })
      engine.emit({ type: 'conversation', conversationId: 'cnv_1' })
      await delay(10)
    })
    expect(text()).contains('Blair B, Someone are typing…')
    expect(text()).not.contains('reset their chat keys')
  })

  it('opens a chat the list did not hold yet once it arrives', async function () {
    const engine = new FakeEngine()
    engine.refuseOpens = 1
    const shown = view({ messages: [message({ body: 'hello newcomer' })] })
    engine.views.set('cnv_1', shown)
    await render(
      <ConversationScreen
        engine={engine}
        userId={userIdOfGumbo(1)}
        conversationId="cnv_1"
        onMembers={() => {}}
        files={fakeFiles([])}
        swipe={false}
      />
    )
    await settle(50)
    await act(async () => {
      engine.emit({ type: 'conversations' })
      await delay(30)
    })
    await until('the chat', () => text().includes('hello newcomer'))
    expect(
      engine.calls.filter(call => call === 'open cnv_1').length
    ).greaterThanOrEqual(2)
  })

  it('says so when a chat cannot be opened at all', async function () {
    const engine = new FakeEngine()
    engine.refuseOpens = 100
    await render(
      <ConversationScreen
        engine={engine}
        userId={userIdOfGumbo(1)}
        conversationId="cnv_nope"
        onMembers={() => {}}
        files={fakeFiles([])}
        swipe={false}
      />
    )
    expect(text()).contains('Loading…')
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        engine.emit({ type: 'conversations' })
        await delay(20)
      })
    }
    await until('the failure', () =>
      text().includes('Chat could not be opened.')
    )
  })

  it('heads a DM whose others have all left with who was in it', async function () {
    const { titles } = await open(
      view({
        conversation: chat({
          id: 'cnv_dm',
          kind: 'dm',
          scope: null,
          scopeName: null,
          memberCount: 1,
          title: dmTitle(
            userIdOfGumbo(1),
            [member(userIdOfGumbo(1), 'Trea Turner')],
            [{ userId: userIdOfGumbo(2), shortName: 'Aaron Judge', left: true }]
          )
        }),
        members: [member(userIdOfGumbo(1), 'Trea Turner')]
      })
    )
    expect(titles.at(-1)).equals('Aaron Judge (left)')
    expect(text()).not.contains('1 member')
    expect(labelled('Aaron Judge (left), Direct message')).not.equals(null)
  })

  it('keeps the member count out of the compact conversation identity', async function () {
    await open(view({ conversation: chat({ memberCount: 1 }) }))
    expect(text()).not.contains('1 member')
    expect(text()).not.contains('1 members')
    expect(labelled('Hawks, Team Members')).not.equals(null)
  })

  it('draws pictures from their bytes, opens a video, and saves a file', async function () {
    const { engine, log } = await open(
      view({
        messages: [
          message({
            body: '',
            attachments: [
              attachment(),
              attachment({
                id: 'cat_2',
                contentType: 'video/mp4',
                fileName: 'clip.mp4',
                size: 20526514,
                width: undefined,
                height: undefined
              }),
              attachment({
                id: 'cat_3',
                contentType: 'application/pdf',
                fileName: 'roster.pdf',
                size: 812
              }),
              attachment({
                id: 'cat_4',
                contentType: 'image/png',
                fileName: 'broken.png'
              }),
              attachment({
                id: 'cat_5',
                contentType: 'application/pdf',
                fileName: 'broken.pdf'
              })
            ]
          })
        ]
      })
    )
    await until('the picture', () =>
      [...document.querySelectorAll('img')].some(
        image =>
          image.getAttribute('src')?.startsWith('blob:photo.jpg') === true
      )
    )
    expect(text()).contains('That attachment could not be opened.')
    expect(text()).contains('19.6 MB')
    await press('Open clip.mp4')
    await until('the video', () => document.querySelector('video') != null)
    expect(document.querySelector('video')?.getAttribute('src')).equals(
      'blob:clip.mp4'
    )
    await press('Save roster.pdf')
    await until('the save', () => log.includes('save roster.pdf'))
    await press('Save broken.pdf')
    await until(
      'the failure',
      () => text().split('That attachment could not be opened.').length === 3
    )
    expect(engine.calls).includes('openAttachment clip.mp4')
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(log).includes('release blob:photo.jpg')
  })
})

describe('the composer on its own', function () {
  it('offers the one picker at once where there is only one', async function () {
    const picked: string[] = []
    await render(
      <Composer
        text=""
        onText={() => {}}
        enabled
        sending={false}
        context={undefined}
        onCancelContext={() => {}}
        attachments={[]}
        onRemoveAttachment={() => {}}
        sources={['files']}
        onAttach={source => picked.push(source)}
        onSend={() => {}}
      />
    )
    await press('Attach')
    expect(picked).deep.equals(['files'])
    expect(button('Send')?.getAttribute('aria-disabled')).equals('true')
  })

  it('asks which, and can be put away', async function () {
    await render(
      <Composer
        text="hi"
        onText={() => {}}
        enabled
        sending={false}
        context={undefined}
        onCancelContext={() => {}}
        attachments={[]}
        onRemoveAttachment={() => {}}
        sources={['photos', 'files']}
        onAttach={() => {}}
        onSend={() => {}}
      />
    )
    await press('Attach')
    expect(button('Photo library')).not.equals(undefined)
    await press('Cancel')
    expect(button('Photo library')).equals(undefined)
  })
})

describe('a swipe to reply', function () {
  it('is only a wrapper where there is no swipe', async function () {
    await render(
      <SwipeToReply enabled={false} onReply={() => {}}>
        <span>bubble</span>
      </SwipeToReply>
    )
    expect(text()).equals('bubble')
  })

  it('wraps the bubble in a gesture on a phone', async function () {
    await render(
      <SwipeToReply enabled onReply={() => {}}>
        <span>bubble</span>
      </SwipeToReply>
    )
    expect(text()).equals('bubble')
  })

  it('follows the finger, replies past the threshold, and springs back', function () {
    const moved: number[] = []
    let replies = 0
    const pan = swipeHandlers(
      dx => moved.push(dx),
      () => {
        replies += 1
      }
    )
    pan.onUpdate({ translationX: -30 })
    pan.onUpdate({ translationX: 40 })
    pan.onDeactivate({ translationX: 10, canceled: false })
    expect(replies).equals(0)
    pan.onDeactivate({ translationX: 500, canceled: true })
    expect(replies).equals(0)
    pan.onDeactivate({ translationX: 500, canceled: false })
    expect(replies).equals(1)
    pan.onFinalize()
    expect(moved).deep.equals([0, 40, 0])
  })
})

describe('the emoji picker', function () {
  it('offers every group but the components, and searches by name and tag', async function () {
    expect(EMOJI.length).greaterThan(1800)
    expect(EMOJI_GROUPS.map(group => group.name)).includes('Smileys & emotion')
    expect(EMOJI_GROUPS.some(group => group.id === 2)).equals(false)
    expect(searchEmoji('')).deep.equals([])
    expect(searchEmoji('party').map(emoji => emoji.unicode)).includes('🎉')
    expect(searchEmoji('face', 5)).length(5)

    const picked: string[] = []
    let closed = 0
    await render(
      <EmojiPicker
        onPick={emoji => picked.push(emoji)}
        onClose={() => (closed += 1)}
      />
    )
    await press('grinning face')
    await press('Animals & nature')
    await press('dog face')
    await typeInto('More emoji', 'tada')
    await press('party popper')
    await press('Cancel')
    expect(picked).deep.equals(['😀', '🐶', '🎉'])
    expect(closed).equals(1)
  })
})

describe('starting a direct message', function () {
  this.timeout(10000)

  class FakeDms {
    calls: string[] = []
    adultsFor: string[] | undefined
    refuse: string | undefined
    people: ChatPerson[] = [
      { userId: userIdOfGumbo(7), shortName: 'Pat P', avatarUrl: null },
      { userId: userIdOfGumbo(8), shortName: 'Frankie F', avatarUrl: null }
    ]

    adults: IncludedAdult[] = [
      { userId: userIdOfGumbo(20), shortName: 'Glen G', label: 'Guardian' },
      { userId: userIdOfGumbo(21), shortName: 'Hank C', label: 'Coach · Hawks' }
    ]

    async dmCandidates(query = ''): Promise<ChatPerson[]> {
      this.calls.push(`candidates ${query}`)
      return this.people.filter(person =>
        person.shortName.toLowerCase().includes(query.toLowerCase())
      )
    }

    async includedAdults(
      playerIds: string[],
      query = ''
    ): Promise<IncludedAdult[]> {
      this.calls.push(`adults ${playerIds.join(',')} ${query}`)
      return query === ''
        ? this.adults
        : this.adults.filter(adult => adult.shortName.startsWith(query))
    }

    async createDm(userIds: string[]): Promise<ChatConversation> {
      this.calls.push(`create ${userIds.join(',')}`)
      if (this.refuse != null) {
        throw new HttpError('forbidden', 'no', { reason: this.refuse })
      }
      if (this.adultsFor != null && userIds.length === 1) {
        throw new HttpError('conflict', 'adult', {
          reason: 'adultRequired',
          playerIds: this.adultsFor
        })
      }
      return {
        id: 'cnv_dm',
        kind: 'dm',
        title: null,
        scope: null,
        scopeName: null,
        avatarName: null,
        avatarUrl: null,
        lastSeq: 0,
        lastMessageAt: null,
        lastPostAt: null,
        lastPostId: null,
        lastPostSeq: 0,
        preferences: {
          pinned: false,
          muted: false,
          manualUnread: false,
          manualUnreadRevision: 0
        },
        unread: 0,
        canPost: true,
        canModerate: false,
        locked: false,
        noHolder: false,
        closed: false,
        memberCount: userIds.length + 1,
        people: []
      }
    }
  }

  it('picks from the candidates and starts the conversation', async function () {
    const dms = new FakeDms()
    const engine = new FakeEngine()
    const created: string[] = []
    await render(
      <NewDmScreen
        client={dms}
        engine={engine}
        onCreated={conversation => created.push(conversation.id)}
        pauseMs={0}
      />
    )
    await until('the candidates', () => text().includes('Frankie F'))
    await typeInto('Name', 'Fra')
    await until('the search', () => !text().includes('Pat P'))
    await press('Pick Frankie F')
    await press('Remove Frankie F')
    await press('Pick Frankie F')
    await press('Start conversation')
    await until('the conversation', () => created.length === 1)
    expect(dms.calls).includes(`create ${userIdOfGumbo(8)}`)
    expect(engine.calls).includes('refresh')
    await typeInto('Name', 'zzz')
    await until('nobody', () => text().includes('Nobody matches.'))
  })

  it('opens Include another adult on adultRequired and starts again with them', async function () {
    const dms = new FakeDms()
    dms.adultsFor = [userIdOfGumbo(7)]
    const created: string[] = []
    await render(
      <NewDmScreen
        client={dms}
        engine={new FakeEngine()}
        onCreated={conversation => created.push(conversation.id)}
        pauseMs={0}
      />
    )
    await until('the candidates', () => text().includes('Pat P'))
    await press('Pick Pat P')
    await press('Start conversation')
    await until('the sheet', () => text().includes('Include another adult'))
    await until('the suggestions', () => text().includes('Glen G'))
    expect(text()).contains('Suggested')
    expect(text()).contains('Coach · Hawks')
    expect(dms.calls).includes(`adults ${userIdOfGumbo(7)} `)
    await typeInto('Search for an adult', 'Eddie')
    await until('no match', () => text().includes('Nobody matches that name.'))
    expect(text()).contains('Matches')
    await typeInto('Search for an adult', 'Hank')
    await until('Hank', () => text().includes('Hank C'))
    expect(text()).not.contains('Glen G')
    await press('Include Hank C')
    await press('Do not include Hank C')
    await press('Include Hank C')
    await typeInto('Search for an adult', '')
    await until('the suggestions again', () => text().includes('Glen G'))
    await press('Include Glen G')
    await press('Start with them')
    await until('the conversation', () => created.length === 1)
    expect(dms.calls).includes(
      `create ${[7, 21, 20].map(userIdOfGumbo).join(',')}`
    )
  })

  it('says who cannot be named, holds a DM to twenty, and closes the sheet', async function () {
    const dms = new FakeDms()
    dms.people = Array.from({ length: 22 }, (_, index) => ({
      userId: userIdOfGumbo(100 + index),
      shortName: `Person ${index}`,
      avatarUrl: null
    }))
    await render(
      <NewDmScreen
        client={dms}
        engine={new FakeEngine()}
        onCreated={() => {}}
        pauseMs={0}
      />
    )
    await until('the candidates', () => text().includes('Person 21'))
    for (let index = 0; index < 20; index++) {
      await press(`Pick Person ${index}`)
    }
    expect(text()).contains('A conversation holds at most 20 people.')
    dms.refuse = 'notCandidate'
    await press('Start conversation')
    await until('the refusal', () =>
      text().includes('You cannot start a conversation with Person 0')
    )
    dms.refuse = 'other'
    await press('Start conversation')
    await until('the failure', () =>
      text().includes('The conversation could not be started.')
    )
    dms.refuse = undefined
    dms.adultsFor = [userIdOfGumbo(100)]
  })

  it('cancels the sheet', async function () {
    const dms = new FakeDms()
    dms.adultsFor = [userIdOfGumbo(7)]
    dms.includedAdults = async () => {
      throw new Error('offline')
    }
    await render(
      <NewDmScreen
        client={dms}
        engine={new FakeEngine()}
        onCreated={() => {}}
        pauseMs={0}
      />
    )
    await until('the candidates', () => text().includes('Pat P'))
    await press('Pick Pat P')
    await press('Start conversation')
    await until('the sheet', () => text().includes('Include another adult'))
    await until('the failure', () =>
      text().includes('The conversation could not be started.')
    )
    await press('Cancel')
    await until(
      'the sheet to go',
      () => !text().includes('Include another adult')
    )
  })
})

describe('members, approvals and safety numbers', function () {
  this.timeout(10000)

  it('lists members with labels, approves a reset identity, and shows a safety number', async function () {
    const engine = new FakeEngine()
    engine.views.set(
      'cnv_1',
      view({
        members: [
          member(userIdOfGumbo(1), 'Blair B'),
          member(userIdOfGumbo(2), 'Hank C', {
            label: 'Coach · Guardian',
            isModerator: true
          }),
          member(userIdOfGumbo(9), 'Drew D', { safetyNumberChanged: true })
        ]
      })
    )
    engine.waiting = [
      {
        requestId: 7,
        conversationId: 'cnv_1',
        conversationTitle: 'Hawks Members',
        userId: userIdOfGumbo(9),
        name: 'Drew D',
        oldSafetyNumber: '1'.repeat(60),
        newSafetyNumber: '2'.repeat(60)
      },
      {
        requestId: 8,
        conversationId: 'cnv_other',
        conversationTitle: 'Elsewhere',
        userId: userIdOfGumbo(9),
        name: 'Drew D',
        oldSafetyNumber: undefined,
        newSafetyNumber: '3'.repeat(60)
      },
      // The person's own reset is never put to them.
      {
        requestId: 6,
        conversationId: 'cnv_1',
        conversationTitle: 'Hawks Members',
        userId: userIdOfGumbo(1),
        name: 'Blair B',
        oldSafetyNumber: '4'.repeat(60),
        newSafetyNumber: '5'.repeat(60)
      }
    ]
    await render(
      <ChatInfoScreen
        showMembers
        engine={engine}
        client={{ leaveDm: async () => ({ closed: false }) }}
        conversationId="cnv_1"
        userId={userIdOfGumbo(1)}
        onLeft={() => {}}
      />
    )
    await until(
      'the members',
      () => document.querySelector('[data-testid="chat-info-members"]') != null
    )
    await until('the approval', () => text().includes('reset their chat keys'))
    const words = text()
    expect(words).contains('Coach · Guardian')
    expect(words).contains('Moderator')
    expect(words).contains('Drew D’s safety number changed')
    expect(words).contains('Blair B (You)')
    expect(words).contains('11111 11111')
    expect(words).contains('22222 22222')
    expect(words).not.contains('33333')
    expect(words).not.contains('Blair B reset')
    expect(words).not.contains('44444')
    expect(button('Leave this conversation')).equals(undefined)
    await press('Approve Drew D')
    await until(
      'the approval to go',
      () => !text().includes('reset their chat keys')
    )
    expect(engine.calls).includes('approve 7')

    await press('Safety number with Hank C')
    await until('the digits', () =>
      text().includes('Safety number with Hank C')
    )
    const grid = labelled('Safety number with Hank C')
    expect(grid?.children.length).equals(12)
    expect(
      [...(grid?.children ?? [])].every(cell =>
        /^\d{5}$/.test(cell.textContent ?? '')
      )
    ).equals(true)
    await press('Done')
    await until('the members again', () => text().includes('Coach · Guardian'))
  })

  it('says when an approval fails, and lets a DM member leave', async function () {
    const engine = new FakeEngine()
    engine.views.set(
      'cnv_dm',
      view({
        conversation: chat({
          id: 'cnv_dm',
          kind: 'dm',
          title: 'Pat P',
          scope: null
        })
      })
    )
    engine.waiting = [
      {
        requestId: 99,
        conversationId: 'cnv_dm',
        conversationTitle: 'Pat P',
        userId: userIdOfGumbo(9),
        name: undefined,
        oldSafetyNumber: undefined,
        newSafetyNumber: '2'.repeat(60)
      }
    ]
    let left = 0
    const asked: string[] = []
    await render(
      <ChatInfoScreen
        showMembers
        engine={engine}
        client={{
          leaveDm: async id => {
            asked.push(id)
            return { closed: true }
          }
        }}
        conversationId="cnv_dm"
        userId={userIdOfGumbo(1)}
        onLeft={() => (left += 1)}
      />
    )
    await until('the approval', () => text().includes('Former member reset'))
    expect(text()).contains('—')
    await press('Approve Former member')
    await until('the failure', () =>
      text().includes('That did not work. Try again.')
    )
    await press('Leave this conversation')
    await until('left', () => left === 1)
    expect(asked).deep.equals(['cnv_dm'])
  })

  it('says when the members cannot be read', async function () {
    const engine = new FakeEngine()
    await render(
      <ChatInfoScreen
        showMembers
        engine={engine}
        client={{ leaveDm: async () => ({ closed: false }) }}
        conversationId="cnv_missing"
        userId={userIdOfGumbo(1)}
        onLeft={() => {}}
      />
    )
    await until('the failure', () =>
      text().includes('Chat could not be opened.')
    )
  })

  it('shows 60 digits in 12 groups of five, or says why not', async function () {
    const engine = new FakeEngine()
    let done = 0
    await render(
      <SafetyNumberScreen
        engine={engine}
        userId={userIdOfGumbo(5)}
        name="Blair B"
        onDone={() => (done += 1)}
      />
    )
    await until('the digits', () => text().includes('12345'))
    const grid = labelled('Safety number with Blair B')
    const groups = [...(grid?.children ?? [])].map(cell => cell.textContent)
    expect(groups).length(12)
    expect(groups.join('')).equals(SAFETY)
    expect(text()).contains('Compare these 60 digits with Blair B')
    await press('Done')
    expect(done).equals(1)
    await act(async () => {
      root?.unmount()
    })
    await render(
      <SafetyNumberScreen
        engine={engine}
        userId={userIdOfGumbo(405)}
        name="Riley R"
        onDone={() => {}}
      />
    )
    await until('none', () =>
      text().includes('Riley R has not set up chat yet.')
    )
    await act(async () => {
      root?.unmount()
    })
    await render(
      <SafetyNumberScreen
        engine={engine}
        userId={userIdOfGumbo(404)}
        name="X"
        onDone={() => {}}
      />
    )
    await until('failure', () => text().includes('Chat could not be opened.'))
  })
})

describe('chat links on a team or season page', function () {
  it('opens each chat, and draws nothing without one', async function () {
    const opened: string[] = []
    await render(
      <ChatLinks
        chats={[
          { id: 'a', title: 'Hawks Members' },
          { id: 'b', title: 'Hawks Staff' }
        ]}
        onOpen={link => opened.push(link.id)}
      />
    )
    await press('Open Hawks Staff')
    expect(opened).deep.equals(['b'])
    await act(async () => {
      root?.unmount()
    })
    await render(<ChatLinks chats={[]} onOpen={() => {}} />)
    expect(text()).equals('')
  })
})

describe('attachments in a browser', function () {
  it('reads what the file input was given', async function () {
    const picked = await readPicked(
      [
        new File([new Uint8Array([1, 2, 3])], 'photo.jpg', {
          type: 'image/jpeg'
        }),
        new File([new Uint8Array([4, 5])], 'notes.txt', { type: '' }),
        new File([new Uint8Array([6])], 'clip.mp4', { type: 'video/mp4' })
      ],
      20
    )
    expect(picked.map(file => [file.fileName, file.contentType])).deep.equals([
      ['photo.jpg', 'image/jpeg'],
      ['notes.txt', 'application/octet-stream'],
      ['clip.mp4', 'video/mp4']
    ])
    expect([...picked[0].bytes]).deep.equals([1, 2, 3])
    expect([...picked[1].bytes]).deep.equals([4, 5])
  })

  it('reads a picture’s size where the browser can, and goes on where not', async function () {
    const g = globalThis as { createImageBitmap?: unknown }
    const real = g.createImageBitmap
    const photo = (): File =>
      new File([new Uint8Array([1])], 'p.png', { type: 'image/png' })
    try {
      let closed = 0
      g.createImageBitmap = async () => ({
        width: 640,
        height: 480,
        close: () => {
          closed += 1
        }
      })
      const [sized] = await readPicked([photo()], 20)
      expect([sized.width, sized.height, closed]).deep.equals([640, 480, 1])
      g.createImageBitmap = async () => {
        throw new Error('not a picture')
      }
      const [unread] = await readPicked([photo()], 20)
      expect(unread.width).equals(undefined)
      g.createImageBitmap = undefined
      const [none] = await readPicked([photo()], 20)
      expect(none.width).equals(undefined)
    } finally {
      g.createImageBitmap = real
    }
  })

  it('reads a video’s size and length, and gives up on an error or a wait', async function () {
    // Replaced for the test, through plain records so nothing is unbound.
    const url = URL as unknown as Record<string, unknown>
    const doc = document as unknown as Record<string, unknown>
    const real = {
      createObjectURL: url.createObjectURL,
      revokeObjectURL: url.revokeObjectURL,
      createElement: doc.createElement
    }
    const make = (tag: string): HTMLElement =>
      (real.createElement as (tag: string) => HTMLElement).call(document, tag)
    const DomEvent = (
      document.defaultView as unknown as { Event: typeof Event }
    ).Event
    const revoked: string[] = []
    url.createObjectURL = () => 'blob:clip'
    url.revokeObjectURL = (made: string) => {
      revoked.push(made)
    }
    let next: (video: HTMLVideoElement) => void = () => {}
    doc.createElement = (tag: string) => {
      const made = make(tag)
      if (tag === 'video') {
        setTimeout(() => {
          next(made as HTMLVideoElement)
        }, 1)
      }
      return made
    }
    const clip = (): File =>
      new File([new Uint8Array([1])], 'c.mp4', { type: 'video/mp4' })
    const meta = (
      video: HTMLVideoElement,
      width: number,
      duration: number
    ): void => {
      Object.defineProperty(video, 'videoWidth', { value: width })
      Object.defineProperty(video, 'videoHeight', { value: 360 })
      Object.defineProperty(video, 'duration', { value: duration })
      video.dispatchEvent(new DomEvent('loadedmetadata'))
    }
    try {
      next = video => {
        meta(video, 640, 12.3456)
      }
      const [loaded] = await readPicked([clip()], 1000)
      expect([loaded.width, loaded.height, loaded.durationMs]).deep.equals([
        640, 360, 12346
      ])
      next = video => {
        meta(video, 640, Infinity)
      }
      const [endless] = await readPicked([clip()], 1000)
      expect(endless.durationMs).equals(0)
      next = video => {
        meta(video, 0, 1)
      }
      const [blank] = await readPicked([clip()], 1000)
      expect(blank.width).equals(undefined)
      next = video => {
        video.dispatchEvent(new DomEvent('error'))
      }
      const [broken] = await readPicked([clip()], 1000)
      expect(broken.width).equals(undefined)
      next = () => {}
      const [waited] = await readPicked([clip()], 20)
      expect(waited.width).equals(undefined)
      expect(revoked).deep.equals(Array(5).fill('blob:clip'))
    } finally {
      Object.assign(url, {
        createObjectURL: real.createObjectURL,
        revokeObjectURL: real.revokeObjectURL
      })
      doc.createElement = real.createElement
    }
  })

  it('opens the browser’s picker, and hands back what was chosen', async function () {
    const chosen = pickFiles('files')
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input?.multiple).equals(true)
    Object.defineProperty(input, 'files', {
      value: [
        new File([new Uint8Array([9])], 'a.pdf', { type: 'application/pdf' })
      ]
    })
    input!.dispatchEvent(new (page().Event)('change'))
    const files = await chosen
    expect(files.map(file => file.fileName)).deep.equals(['a.pdf'])
    expect(document.querySelector('input[type="file"]')).equals(null)

    const cancelled = pickFiles('photos')
    document
      .querySelector<HTMLInputElement>('input[type="file"]')!
      .dispatchEvent(new (page().Event)('cancel'))
    expect(await cancelled).deep.equals([])
  })

  it('shows bytes from a Blob URL, lets it go, and saves a download', async function () {
    const made: string[] = []
    const revoked: string[] = []
    const held = {
      create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
      revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    }
    URL.createObjectURL = () => {
      made.push('blob:x')
      return 'blob:x'
    }
    URL.revokeObjectURL = url => {
      revoked.push(url)
    }
    try {
      expect(await bytesUri(new Uint8Array([1]), 'image/png', 'a.png')).equals(
        'blob:x'
      )
      await releaseUri('blob:x')
      await releaseUri('file:///not-mine')
      expect(revoked).deep.equals(['blob:x'])
      let clicked = ''
      const anchor = page().HTMLAnchorElement.prototype
      anchor.click = function (this: HTMLAnchorElement) {
        clicked = `${this.download} ${this.href}`
      }
      try {
        await saveFile(new Uint8Array([1]), 'application/pdf', 'roster.pdf')
      } finally {
        // The element's own click, on HTMLElement's prototype, again.
        Reflect.deleteProperty(anchor, 'click')
      }
      expect(clicked).equals('roster.pdf blob:x')
      expect(document.querySelector('a')).equals(null)
    } finally {
      for (const [name, descriptor] of [
        ['createObjectURL', held.create],
        ['revokeObjectURL', held.revoke]
      ] as const) {
        if (descriptor == null) Reflect.deleteProperty(URL, name)
        else Object.defineProperty(URL, name, descriptor)
      }
    }
  })
})

describe('an attachment on its own', function () {
  it('keeps a picture’s box until its bytes open', async function () {
    const engine = new FakeEngine()
    const log: string[] = []
    let finish: (bytes: Uint8Array) => void = () => {}
    engine.openAttachment = async () =>
      await new Promise<Uint8Array>(resolve => {
        finish = resolve
      })
    await render(
      <AttachmentView
        attachment={attachment()}
        engine={engine}
        files={fakeFiles(log)}
        maxWidth={320}
      />
    )
    const box = labelled('photo.jpg')
    expect(box?.querySelector('img')).equals(null)
    await act(async () => {
      root?.unmount()
      finish(new Uint8Array([1]))
      await delay(20)
    })
    root = undefined
    // Opened after the view went: its URL is let go at once.
    expect(log).deep.equals(['uri photo.jpg', 'release blob:photo.jpg'])
  })
})
