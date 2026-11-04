/** Real native permission gates on disposable conversations with locked history. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TeamStationClient } from '../../common/api'
import { passwordBytes } from '../../common/passwordProtocol'
import { nativeArgon } from '../../server/auth/passwords'

interface Node {
  id?: string
  text?: string
  label?: string
  children?: Node[]
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

export async function nativeRecoveryPermissions(options: {
  inputFile: string
  linkReceipt: string
  results: string
  platform: string
  actorUserId: string
  conversationId: string
  apiUrl: string
  api: TeamStationClient
  device: {
    hierarchy: () => Promise<Node>
    screenshot: () => Promise<Uint8Array>
    assertVisible: (options: object) => Promise<unknown>
    tapOn: (options: object) => Promise<unknown>
  }
  open: () => Promise<void>
  openScope: (id: string, expected: string) => Promise<void>
  hold: (id: string, body: string) => Promise<void>
}): Promise<object> {
  const input = JSON.parse(readFileSync(options.inputFile, 'utf8')) as {
    synthetic: true
    scenario: string
    source: string
    platform: string
    actorUserId: string
    conversationId: string
    current: { id: string; body: string }
    readOnlyId: string
    departing: Array<{ userId: string; email: string; password: string }>
  }
  assert.equal(input.synthetic, true)
  assert.equal(input.scenario, 'E6')
  assert.equal(input.platform, options.platform)
  assert.equal(input.actorUserId, options.actorUserId)
  assert.equal(input.conversationId, options.conversationId)
  assert(['127.0.0.1', 'localhost'].includes(new URL(options.apiUrl).hostname))
  assert.equal(input.departing.length, 2)
  const link = JSON.parse(readFileSync(options.linkReceipt, 'utf8')) as {
    unlinkedCompositionBlocked?: boolean
    identityLinked?: { actorUserId: string; historyApproval: boolean }
  }
  assert.equal(link.unlinkedCompositionBlocked, true)
  assert.equal(link.identityLinked?.actorUserId, input.actorUserId)
  assert.equal(link.identityLinked?.historyApproval, false)
  const { api, device: m } = options
  const epochs = (await api.chatEpochs(input.conversationId)).epochs
  assert.deepEqual(
    epochs.map(row => row.chainBreak),
    [false, true]
  )
  const posts = (await api.chatMessages(input.conversationId)).filter(
    row => row.kind === 'post'
  )
  const boxes = await api.chatEpochs(input.conversationId, 0, {
    boxesAfter: '0'
  })
  assert(!boxes.boxes.some(box => box.epoch === 1))
  async function picture(name: string): Promise<void> {
    writeFileSync(
      join(options.results, `${options.platform}-${name}.png`),
      await m.screenshot()
    )
  }
  async function blocked(reason: string, name: string): Promise<void> {
    await m.assertVisible({ text: reason, timeout: 30000 })
    const nodes = flatten(await m.hierarchy())
    assert(!nodes.some(node => node.id === 'chat-composer'))
    assert(!nodes.some(node => node.text === 'Send' || node.label === 'Send'))
    await picture(name)
  }
  await options.open()
  await m.assertVisible({ text: 'Locked message', timeout: 30000 })
  await m.assertVisible({ text: input.current.body, timeout: 30000 })
  await options.hold(input.current.id, input.current.body)
  await m.tapOn({ text: 'Reply' })
  await m.assertVisible({ text: 'Cancel reply', timeout: 10000 })
  await m.tapOn({ text: 'Cancel reply' })
  await picture('readable-actions-with-locked-history')

  const readOnly = (await api.chatConversations()).find(
    row => row.id === input.readOnlyId
  )
  assert(
    readOnly?.kind === 'seasonAnnouncements' &&
      !readOnly.canPost &&
      !readOnly.closed,
    'Actual native actor must have a read-only announcement scope'
  )
  await options.openScope(
    readOnly.id,
    'Only season staff post here. You can react.'
  )
  await blocked(
    'Only season staff post here. You can react.',
    'read-only-blocked'
  )

  for (const person of input.departing) {
    assert(person.email.endsWith('@chat.example.com'))
    assert.notEqual(person.userId, input.actorUserId)
    const peer = new TeamStationClient({
      baseUrl: options.apiUrl,
      passwordKdf: async (password, parameters) =>
        await nativeArgon(passwordBytes(password), parameters)
    })
    await peer.signInWithPassword(person.email, person.password)
    await peer.leaveDm(input.conversationId)
  }
  const closed = (await api.chatConversations()).find(
    row => row.id === input.conversationId
  )
  assert(closed?.closed === true && !closed.canPost)
  await options.openScope(
    input.conversationId,
    'This chat is closed. You can read it, but not post.'
  )
  await blocked(
    'This chat is closed. You can read it, but not post.',
    'closed-blocked'
  )
  await m.assertVisible({ text: input.current.body, timeout: 30000 })
  await m.assertVisible({ text: 'Locked message' })
  assert.deepEqual((await api.chatEpochs(input.conversationId)).epochs, epochs)
  assert.deepEqual(
    (await api.chatMessages(input.conversationId)).filter(
      row => row.kind === 'post'
    ),
    posts
  )
  await api.leaveDm(input.conversationId)
  await options.openScope(input.conversationId, 'Chat could not be opened.')
  await blocked('Chat could not be opened.', 'removed-blocked')
  await assert.rejects(
    async () => await api.chatMessages(input.conversationId),
    { code: 'notFound' }
  )
  return {
    source: input.source,
    platform: input.platform,
    unlinked: true,
    readOnly: true,
    closed: true,
    removed: true,
    readableReplyAction: true,
    epochs: epochs.length,
    posts: posts.length
  }
}
