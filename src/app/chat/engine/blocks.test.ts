import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type ChatBlock,
  type ChatConversation,
  type ChatMessage,
  TeamStationClient
} from '../../../common/api'
import { newDeviceKeys } from '../../../common/chatCrypto/keys'
import { sealAttachment } from '../../../common/chatCrypto/stream'
import { userIdOfGumbo } from '../../../common/userId'
import { chat } from '../chatViews.test.helpers'
import { b64, newRecord } from '../keyRecord'
import { foldMessages } from './apply'
import { type EngineContext, KeyHolder } from './context'
import { IdentityCache } from './decrypt'
import { ChatEngine } from './engine'
import type { ChatMemory } from './store'
import { syncList, syncMessages } from './sync'

const me = userIdOfGumbo(1)
const peer = userIdOfGumbo(2)
const alias = userIdOfGumbo(3)
const block: ChatBlock = {
  userId: peer,
  userIds: [peer, alias],
  shortName: 'Fixture Peer',
  avatarUrl: null,
  createdAt: '2027-01-01T00:00:00Z'
}
function fixture(): {
  engine: ChatEngine
  client: TeamStationClient
  memory: ChatMemory
} {
  const client = new TeamStationClient({
    baseUrl: 'https://example.test',
    fetch: async () => {
      throw new Error('Unexpected API call')
    }
  })
  client.chatBlocks = async () => []
  const summary: ChatConversation = {
    ...chat(),
    people: [],
    avatarUrl: null,
    avatarName: null,
    lastPostId: null,
    lastPostAt: null,
    lastPostSeq: 0,
    preferences: {
      pinned: false,
      muted: false,
      manualUnread: false,
      manualUnreadRevision: 0
    }
  }
  client.chatConversations = async () => [summary]
  const engine = new ChatEngine({
    client,
    userId: me,
    device: { name: 'Test', platform: 'web' },
    store: {
      load: async () => undefined,
      save: async () => {},
      exists: async () => false,
      wipe: async () => {}
    }
  })
  return {
    engine,
    client,
    memory: (engine as unknown as { memory: ChatMemory }).memory
  }
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let complete!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    complete = resolve
  })
  return { promise, resolve: complete }
}
function envelope(
  seq: number,
  senderUserId: string,
  kind: ChatMessage['kind'] = 'post',
  targetIds: string[] | null = null
): ChatMessage {
  return {
    id: `msg_${seq}`,
    conversationId: 'cnv_1',
    seq,
    epoch: 0,
    senderUserId,
    senderIdentityId: 'cid_test',
    kind,
    targetIds,
    nonce: '',
    ciphertext: '',
    signature: '',
    attachmentIds: [],
    clearedAt: null,
    createdAt: '2027-01-01T00:00:00Z'
  }
}

describe('client personal blocking', () => {
  it('fails closed before the first list when blocks cannot be read', async () => {
    const f = fixture()
    let listed = false
    f.client.chatBlocks = async () => {
      throw new Error('offline')
    }
    f.client.chatConversations = async () => {
      listed = true
      return []
    }
    try {
      await f.engine.refresh()
      expect.fail('must fail')
    } catch (error) {
      expect(String(error)).contains('offline')
    }
    expect(listed).equals(false)
    expect(f.engine.conversations()).deep.equals([])
    f.engine.stop()
  })
  it('serializes a stale read before the write and rejects later completions after stop', async () => {
    const f = fixture()
    const read = deferred<ChatBlock[]>()
    let started!: () => void
    const requested = new Promise<void>(resolve => {
      started = resolve
    })
    let rows: ChatBlock[] = []
    let writes = 0
    f.client.chatBlocks = async () => {
      started()
      return await read.promise
    }
    f.client.setChatBlock = async () => {
      writes++
      rows = [block]
      return rows
    }
    const refresh = f.engine.refresh()
    await requested
    const write = f.engine.setBlocked(peer, true)
    expect(writes).equals(0)
    f.client.chatBlocks = async () => rows
    read.resolve([])
    await Promise.all([refresh, write])
    expect(f.engine.isBlocked(alias)).equals(true)
    const late = deferred<ChatBlock[]>()
    f.client.setChatBlock = async () => await late.promise
    const pending = f.engine.setBlocked(peer, false)
    f.engine.stop()
    late.resolve([])
    await pending
    expect(f.engine.isBlocked(peer)).equals(true)
  })
  it('purges cached plaintext, pins and typing while retaining moderator deletion metadata', async () => {
    const f = fixture()
    await f.engine.refresh()
    const state = f.memory.state('cnv_1')!
    const post = envelope(1, alias)
    const deletion = envelope(2, peer, 'moderatorDelete', ['msg_3'])
    state.envelopes.set(1, post)
    state.envelopes.set(2, deletion)
    state.opened.set(post.id, {
      status: 'ok',
      content: {
        type: 'text',
        body: 'Private cached content',
        mentions: [],
        attachments: []
      },
      replacedIdentity: false
    })
    state.typing.set(peer, Date.now() + 10000)
    f.client.setChatBlock = async () => [block]
    f.client.chatBlocks = async () => [block]
    await f.engine.setBlocked(peer, true)
    expect(state.opened.size).equals(0)
    expect([...state.envelopes.keys()]).deep.equals([2])
    expect(state.typing.size).equals(0)
    expect(f.engine.view('cnv_1')!.messages).deep.equals([])
    expect(f.engine.conversations()[0].preview).equals('')
    f.engine.stop()
  })
  it('restores blocked messages across every previously loaded page on unblock', async () => {
    const f = fixture()
    await f.engine.refresh()
    const state = f.memory.state('cnv_1')!
    const rows = Array.from({ length: 6 }, (_, i) =>
      envelope(i + 1, i % 2 === 0 ? peer : me)
    )
    for (const row of rows) state.envelopes.set(row.seq, row)
    state.oldestSeq = 1
    state.newestSeq = 6
    state.summary.lastSeq = 6
    let blocked = false
    f.client.setChatBlock = async (_id, value) => {
      blocked = value
      return value ? [block] : []
    }
    f.client.chatBlocks = async () => (blocked ? [block] : [])
    f.client.chatMessages = async (_id, query = {}) => {
      const visible = rows.filter(
        row =>
          (!blocked || row.senderUserId !== peer) &&
          (query.before == null || row.seq < query.before) &&
          (query.after == null || row.seq > query.after)
      )
      return query.after == null
        ? visible.slice(-(query.limit ?? 2))
        : visible.slice(0, query.limit ?? 2)
    }
    const record = newRecord(me, 'cdv_test', newDeviceKeys())
    const ctx: EngineContext = {
      client: f.client,
      memory: f.memory,
      pageSize: 2,
      userId: me,
      keys: new KeyHolder(
        {
          load: async () => record,
          save: async () => {},
          wipe: async () => {},
          exists: async () => true
        },
        record
      ),
      identities: new IdentityCache(f.client),
      refreshKeys: async () => {}
    }
    await f.engine.setBlocked(peer, true)
    await syncMessages(ctx, 'cnv_1')
    expect([...state.envelopes.keys()].sort((a, b) => a - b)).deep.equals([
      2, 4, 6
    ])
    await f.engine.setBlocked(peer, false)
    await syncMessages(ctx, 'cnv_1')
    expect([...state.envelopes.keys()].sort((a, b) => a - b)).deep.equals([
      1, 2, 3, 4, 5, 6
    ])
    expect(state.oldestSeq).equals(1)
    f.engine.stop()
  })
  it('discards a list fetched before block policy changes', async () => {
    const f = fixture()
    const oldList = await f.client.chatConversations()
    const stale = deferred<ChatConversation[]>()
    let calls = 0
    f.client.chatConversations = async () =>
      ++calls === 1 ? await stale.promise : []
    const pending = syncList({ client: f.client, memory: f.memory })
    f.memory.blockRevision++
    stale.resolve(oldList)
    await pending
    expect(calls).equals(2)
    expect(f.memory.conversations.size).equals(0)
    f.engine.stop()
  })
  it('ignores a blocked sender in an in-flight server page and processes personal change hints', async () => {
    const f = fixture()
    await f.engine.refresh()
    f.memory.blockedUserIds.add(peer)
    let page = 0
    f.client.chatMessages = async () =>
      ++page === 1 ? [envelope(1, peer)] : []
    const record = newRecord(me, 'cdv_test', newDeviceKeys())
    const ctx: EngineContext = {
      client: f.client,
      memory: f.memory,
      pageSize: 50,
      userId: me,
      keys: new KeyHolder(
        {
          load: async () => record,
          save: async () => {},
          wipe: async () => {},
          exists: async () => true
        },
        record
      ),
      identities: new IdentityCache(f.client),
      refreshKeys: async () => {}
    }
    await syncMessages(ctx, 'cnv_1')
    expect(f.memory.state('cnv_1')!.envelopes.size).equals(0)
    f.client.chatBlocks = async () => [block]
    const internal = f.engine as unknown as {
      hint: (event: { type: 'chatUser'; kind: 'blocks' }) => void
    }
    internal.hint({ type: 'chatUser', kind: 'blocks' })
    await f.engine.idle()
    expect(f.engine.isBlocked(alias)).equals(true)
    f.engine.stop()
  })
  it('rejects an attachment download that finishes after a block change', async () => {
    const f = fixture()
    await f.engine.refresh()
    ;(
      f.engine as unknown as { context: Pick<EngineContext, 'client'> }
    ).context = { client: f.client }
    ;(f.engine as unknown as { status: string }).status = 'ready'
    const sealed = sealAttachment(new Uint8Array([1, 2, 3]))
    const download = deferred<Uint8Array>()
    const options = (
      f.engine as unknown as {
        options: { fetchBytes: () => Promise<Uint8Array> }
      }
    ).options
    options.fetchBytes = async () => await download.promise
    f.client.chatAttachment = async () => ({
      id: 'fixture',
      conversationId: 'cnv_1',
      size: 3,
      digest: b64(sealed.digest),
      expiresAt: undefined,
      completed: true,
      url: 'https://example.test/fixture'
    })
    const pending = f.engine.openAttachment({
      id: 'fixture',
      key: b64(sealed.key),
      digest: b64(sealed.digest),
      size: 3,
      contentType: 'application/octet-stream',
      fileName: 'fixture.bin'
    })
    f.memory.blockRevision++
    download.resolve(sealed.blob)
    try {
      await pending
      expect.fail('must reject')
    } catch (error) {
      expect(String(error)).contains('no longer available')
    }
    f.engine.stop()
  })
  it('folds blocked posts and reactions out but honors a blocked moderator removal', () => {
    const rows = [
      envelope(1, peer),
      envelope(2, me),
      envelope(3, peer, 'reaction'),
      envelope(4, peer, 'moderatorDelete', ['msg_2'])
    ]
    const folded = foldMessages({
      envelopes: rows,
      opened: new Map(),
      me,
      names: new Map(),
      reads: [],
      blockedUserIds: new Set([peer])
    })
    expect(folded).has.length(1)
    expect(folded[0]).includes({
      id: 'msg_2',
      status: 'removed',
      removedBy: 'moderator'
    })
    expect(folded[0].reactions).deep.equals([])
  })
})
