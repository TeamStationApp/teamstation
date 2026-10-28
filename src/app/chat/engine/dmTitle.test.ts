import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type ChatConversation,
  type ChatDmPerson,
  type ChatMember,
  type ChatMessage,
  TeamStationClient
} from '../../../common/api'
import type { ChatContent } from '../../../common/chatContent'
import { signEpoch, signPuk } from '../../../common/chatCrypto/chain'
import {
  newDeviceKeys,
  newIdentityKey,
  newPukKey
} from '../../../common/chatCrypto/keys'
import {
  newIdentityId,
  newMessageId
} from '../../../common/chatCrypto/messageIds'
import { sealMessage } from '../../../common/chatCrypto/seal'
import { userIdOfGumbo, userIdOfValue } from '../../../common/userId'
import { lstrings } from '../../locales/strings'
import { b64, type ChatKeyStore, newRecord, withEpochKey } from '../keyRecord'
import { ChatEngine, dmTitle } from './engine'

/** U12: a DM's name, from the people in it with you. */
describe('a DM’s name', function () {
  const me = userIdOfGumbo(1)

  const member = (userId: string, shortName: string): ChatMember => ({
    userId,
    shortName,
    avatarUrl: null,
    label: 'Member',
    isModerator: false,
    isApprover: true,
    eligible: true,
    hasIdentity: true,
    identityKey: null,
    generation: 1
  })

  const person = (
    userId: string,
    shortName: string,
    left = false
  ): ChatDmPerson => ({ userId, shortName, left, avatarUrl: null })

  it('names the others who are in it now', function () {
    const people = [
      person(userIdOfGumbo(2), 'Eli C'),
      person(userIdOfGumbo(3), 'Blair B')
    ]
    expect(dmTitle(me, undefined, people)).equals('Eli C, Blair B')
    expect(
      dmTitle(
        me,
        [member(me, 'Dana D'), member(userIdOfGumbo(2), 'Eli C')],
        people
      )
    ).equals('Eli C')
  })

  it('names only those still there when some have left', function () {
    const people = [
      person(userIdOfGumbo(2), 'Eli C', true),
      person(userIdOfGumbo(3), 'Blair B')
    ]
    expect(dmTitle(me, undefined, people)).equals('Blair B')
    expect(
      dmTitle(
        me,
        [member(me, 'Dana D'), member(userIdOfGumbo(3), 'Blair B')],
        people
      )
    ).equals('Blair B')
  })

  it('names the people who left, marked, once they all have', function () {
    expect(
      dmTitle(me, undefined, [person(userIdOfGumbo(2), 'Eli C', true)])
    ).equals('Eli C (left)')
    expect(
      dmTitle(
        me,
        [member(me, 'Dana D')],
        [
          person(userIdOfGumbo(3), 'Blair B', true),
          person(userIdOfGumbo(2), 'Eli C', true)
        ]
      )
    ).equals('Blair B (left), Eli C (left)')
  })

  it('trusts the members it has read over a list that has not caught up', function () {
    // The list still says Eli C is in it; the members say otherwise.
    expect(
      dmTitle(me, [member(me, 'Dana D')], [person(userIdOfGumbo(2), 'Eli C')])
    ).equals('Eli C (left)')
    // Somebody added since the list was read is named all the same.
    expect(
      dmTitle(me, [member(me, 'Dana D'), member(userIdOfGumbo(4), 'Kim K')], [])
    ).equals('Kim K')
  })

  it('is "Just you" when nobody else was ever in it', function () {
    expect(dmTitle(me, undefined, [])).equals('Just you')
    expect(dmTitle(me, [member(me, 'Dana D')], [])).equals('Just you')
  })
})

/** Public list reads must respect current membership and authenticated local content. */
describe('public chat engine list summaries', () => {
  const me = userIdOfGumbo(1)
  const currentId = userIdOfValue((1n << 127n) + 5n)
  const formerId = userIdOfGumbo(3)
  const conversationId = 'cnv_summary'
  const createdAt = '2027-04-10T12:00:00Z'
  const currentPhoto = 'https://images.example.test/current.png'
  const oldPhoto = 'https://images.example.test/former.png'
  const member = (userId: string, shortName: string): ChatMember => ({
    userId,
    shortName,
    avatarUrl: userId === currentId ? currentPhoto : null,
    label: 'Member',
    isModerator: false,
    isApprover: true,
    eligible: true,
    hasIdentity: true,
    identityKey: null,
    generation: 1
  })
  function summary(): ChatConversation {
    return {
      id: conversationId,
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
      memberCount: 2,
      people: [
        {
          userId: currentId,
          shortName: 'Aaron J',
          left: false,
          avatarUrl: currentPhoto
        },
        {
          userId: formerId,
          shortName: 'Mookie B',
          left: false,
          avatarUrl: oldPhoto
        }
      ]
    }
  }
  function client(): TeamStationClient {
    return new TeamStationClient({
      baseUrl: 'https://api.example.test/api/v1',
      fetch: async () => {
        throw new Error('Unexpected network request')
      }
    })
  }
  function engine(
    api: TeamStationClient,
    store: ChatKeyStore = {
      load: async () => undefined,
      exists: async () => false,
      save: async () => {
        throw new Error('List refresh must not change keys')
      },
      wipe: async () => {
        throw new Error('List refresh must not reset keys')
      }
    }
  ): ChatEngine {
    return new ChatEngine({
      client: api,
      store,
      userId: me,
      device: { name: 'Unit browser', platform: 'web' }
    })
  }

  it('uses listed DM people while members are pending, then strips the departed photo and keeps the full-width current member', async () => {
    const listed = summary()
    listed.people[0].avatarUrl = 'https://images.example.test/listed.png'
    const api = client()
    let requested!: () => void
    let complete!: (members: ChatMember[]) => void
    const called = new Promise<void>(resolve => {
      requested = resolve
    })
    api.chatConversations = async () => [listed]
    api.chatMembers = async () => {
      requested()
      return await new Promise<ChatMember[]>(resolve => {
        complete = resolve
      })
    }
    const chat = engine(api)
    const refresh = chat.refresh()
    try {
      await called
      expect(chat.conversations()[0].people).deep.equals(listed.people)
      complete([member(me, 'Juan S'), member(currentId, 'Aaron J')])
      const [item] = await refresh
      expect(item.title).equals('Aaron J')
      expect(item.people).deep.equals([
        {
          userId: currentId,
          shortName: 'Aaron J',
          left: false,
          avatarUrl: currentPhoto
        },
        { userId: formerId, shortName: 'Mookie B', left: true, avatarUrl: null }
      ])
      expect(item.preview).equals('')
      expect(listed.people[1].avatarUrl).equals(oldPhoto)
    } finally {
      complete([member(me, 'Juan S'), member(currentId, 'Aaron J')])
      await refresh
      chat.stop()
    }
  })

  it('removes former-member photos and marks the names after the current member leaves', async () => {
    const api = client()
    let listed = summary()
    let members = [member(me, 'Juan S'), member(currentId, 'Aaron J')]
    api.chatConversations = async () => [listed]
    api.chatMembers = async () => members
    const chat = engine(api)
    try {
      await chat.refresh()
      listed = { ...listed, memberCount: 1 }
      members = [member(me, 'Juan S')]
      const [item] = await chat.refresh()
      expect(item.title).equals('Aaron J (left), Mookie B (left)')
      expect(item.people).deep.equals(
        listed.people.map(person => ({
          ...person,
          left: true,
          avatarUrl: null
        }))
      )
    } finally {
      chat.stop()
    }
  })

  it('reads the members again when one person left and another joined between list reads', async () => {
    const api = client()
    const joinedId = userIdOfGumbo(4)
    const first = summary()
    let listed: ChatConversation = { ...first, people: [first.people[0]] }
    let members = [member(me, 'Juan S'), member(currentId, 'Aaron J')]
    let reads = 0
    api.chatConversations = async () => [listed]
    api.chatMembers = async () => {
      reads += 1
      return members
    }
    const chat = engine(api)
    try {
      await chat.refresh()
      listed = {
        ...listed,
        people: [
          { ...listed.people[0], left: true },
          { userId: joinedId, shortName: 'Kim K', left: false, avatarUrl: null }
        ]
      }
      members = [member(me, 'Juan S'), member(joinedId, 'Kim K')]
      const [item] = await chat.refresh()
      expect(reads).equals(2)
      expect(item.title).equals('Kim K')
      expect(item.people).deep.equals([
        { userId: joinedId, shortName: 'Kim K', left: false, avatarUrl: null },
        { userId: currentId, shortName: 'Aaron J', left: true, avatarUrl: null }
      ])
      // A list that agrees with the members read reads them no more.
      await chat.refresh()
      expect(reads).equals(2)
    } finally {
      chat.stop()
    }
  })

  it('keeps an empty scope chat preview blank and omits unrelated DM people', async () => {
    const api = client()
    api.chatConversations = async () => [
      { ...summary(), kind: 'teamMembers', title: 'Training group' }
    ]
    api.chatMembers = async () => {
      throw new Error('Scope list must not load DM members')
    }
    const chat = engine(api)
    try {
      const [item] = await chat.refresh()
      expect(item.people).deep.equals([])
      expect(item.preview).equals('')
      expect(item.lastPostSeq).equals(0)
      expect(item.lastPostId).equals(null)
    } finally {
      chat.stop()
    }
  })

  function previewFixture(invalid = false): {
    chat: ChatEngine
    latest: ChatMessage
    expected: string
    readCalls: () => number
  } {
    const api = client()
    const identity = newIdentityKey()
    const identityId = newIdentityId()
    const puk = newPukKey()
    const epochKey = new Uint8Array(32).fill(7)
    let record = newRecord(me, 'cdv_summary', newDeviceKeys())
    record.identity = { id: identityId, keys: identity }
    record.puks = [{ generation: 1, keys: puk }]
    record = withEpochKey(record, conversationId, 1, epochKey)
    const store: ChatKeyStore = {
      load: async () => record,
      exists: async () => true,
      save: async value => {
        record = value
      },
      wipe: async () => {
        throw new Error('Preview must preserve installed keys')
      }
    }
    const seal = (
      seq: number,
      kind: ChatMessage['kind'],
      content: ChatContent
    ): ChatMessage => {
      const id = newMessageId()
      const encrypted = sealMessage({
        conversationId,
        epoch: 1,
        messageId: id,
        senderUserId: me,
        kind,
        epochKey,
        identitySecretKey: identity.secretKey,
        plaintext: new TextEncoder().encode(JSON.stringify(content))
      })
      return {
        id,
        conversationId,
        seq,
        epoch: 1,
        senderUserId: me,
        senderIdentityId: identityId,
        kind,
        targetIds: null,
        nonce: b64(encrypted.nonce),
        ciphertext: b64(encrypted.ciphertext),
        signature: b64(encrypted.signature),
        attachmentIds: [],
        clearedAt: null,
        createdAt: new Date(Date.parse(createdAt) + seq * 1000).toISOString()
      }
    }
    const older = seal(1, 'post', {
      type: 'text',
      body: 'Earlier practice update.',
      mentions: [],
      attachments: []
    })
    const reaction = seal(3, 'reaction', {
      type: 'reaction',
      targetId: older.id,
      emoji: '👍',
      remove: false
    })
    const expected = 'Latest authenticated practice update.'
    const latest = seal(2, 'post', {
      type: 'text',
      body: expected,
      mentions: [],
      attachments: []
    })
    const edit = seal(4, 'edit', {
      type: 'edit',
      targetId: older.id,
      body: 'An older post edited later.',
      mentions: []
    })
    if (invalid) latest.signature = b64(new Uint8Array(64))
    const messages = [older, latest, reaction, edit]
    api.myChatKeys = async () => ({
      deviceId: record.deviceId,
      linked: true,
      identity: {
        id: identityId,
        publicKey: b64(identity.publicKey),
        createdAt
      },
      generations: [
        {
          generation: 1,
          publicKey: b64(puk.publicKey),
          signature: b64(
            signPuk(
              { userId: me, generation: 1, publicKey: puk.publicKey },
              identity.secretKey
            )
          ),
          previousKeysBox: null,
          box: null
        }
      ],
      pukNeedsRotation: false
    })
    api.chatConversations = async () => [
      {
        ...summary(),
        kind: 'teamMembers',
        title: 'Training group',
        people: [],
        lastSeq: edit.seq,
        lastMessageAt: edit.createdAt,
        lastPostId: latest.id,
        lastPostSeq: latest.seq,
        lastPostAt: latest.createdAt
      }
    ]
    api.chatMembers = async () => [member(me, 'Juan S')]
    api.chatGrants = async () => []
    api.chatLog = async () => []
    api.chatIdentity = async id => {
      expect(id).equals(identityId)
      return {
        id: identityId,
        userId: me,
        publicKey: b64(identity.publicKey),
        createdAt,
        replacedAt: null
      }
    }
    api.chatEpochs = async (_id, after = 0) => ({
      latest: 1,
      needsRotation: false,
      noHolder: false,
      epochs:
        after > 0
          ? []
          : [
              {
                epoch: 1,
                createdByUserId: me,
                identityId,
                previousKeyBox: null,
                chainBreak: false,
                signature: b64(
                  signEpoch(
                    { conversationId, epoch: 1, previousKeyBox: null },
                    identity.secretKey
                  )
                ),
                createdAt
              }
            ],
      boxes: []
    })
    api.chatMessages = async (
      _id,
      query: { after?: number; before?: number; limit?: number } = {}
    ) =>
      messages
        .filter(
          row =>
            row.seq > (query.after ?? 0) && row.seq < (query.before ?? Infinity)
        )
        .slice(0, query.limit ?? 100)
    let reads = 0
    api.markChatRead = async () => {
      reads++
      throw new Error('Preview must not mark the chat read')
    }
    api.chatAttachment = async () => {
      throw new Error('Preview must not fetch attachment bytes')
    }
    return {
      chat: engine(api, store),
      latest,
      expected,
      readCalls: () => reads
    }
  }

  it('previews the latest authenticated post rather than a newer reaction or edit, without marking it read', async () => {
    const f = previewFixture()
    try {
      expect(await f.chat.start()).equals('ready')
      expect(f.chat.conversations()[0].preview).equals(undefined)
      await f.chat.loadPreview(conversationId)
      const [item] = f.chat.conversations()
      expect(item.preview).equals(f.expected)
      expect(item.lastPostId).equals(f.latest.id)
      expect(item.lastPostSeq).equals(2)
      expect(item.lastSeq).equals(4)
      expect(f.readCalls()).equals(0)
    } finally {
      f.chat.stop()
      await f.chat.idle()
    }
  })

  it('does not expose an unauthenticated latest body as preview text', async () => {
    const f = previewFixture(true)
    try {
      expect(await f.chat.start()).equals('ready')
      await f.chat.loadPreview(conversationId)
      expect(f.chat.conversations()[0].preview).equals(
        lstrings.chat_invalid_message
      )
      expect(f.chat.conversations()[0].preview).not.equals(f.expected)
      expect(f.readCalls()).equals(0)
    } finally {
      f.chat.stop()
      await f.chat.idle()
    }
  })
})
