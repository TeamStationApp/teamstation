import {
  b64,
  type ChatKeyRecord,
  newRecord,
  recordFromJson,
  recordToJson,
  withEpochKey
} from '../app/chat/keyRecord'
import type { WakeDeps, WakeNotification } from '../app/push/chatWake'
import type {
  ChatEpoch,
  ChatEpochs,
  ChatIdentity,
  ChatMessage
} from '../common/api'
import {
  type AttachmentRef,
  type ChatContent,
  encodeContent
} from '../common/chatContent'
import { sealPreviousEpochKey, signEpoch } from '../common/chatCrypto/chain'
import { epochAad, hpkeSeal, type KeyPair } from '../common/chatCrypto/hpke'
import {
  newDeviceKeys,
  newEpochKey,
  newIdentityKey,
  newPukKey
} from '../common/chatCrypto/keys'
import { newIdentityId, newMessageId } from '../common/chatCrypto/messageIds'
import { type EnvelopeKind, sealMessage } from '../common/chatCrypto/seal'
import { notFound } from '../common/errors'
import type { ChatWake } from '../common/push'
import { userIdOfGumbo } from '../common/userId'

/**
 * The chat wakes a device opens (`app/push/chatWake.ts`), made with the real
 * chat crypto: fresh throwaway keys for a reader and a sender, the epochs the
 * sender signed, the reader's boxes, and the sealed envelopes. Each case
 * names what the device should show. `chatWake.test.ts` runs them, and
 * `scripts/pushWakeVectors.ts` writes them out for the iOS extension's tests.
 */

export interface WakeCase {
  name: string
  wake: ChatWake
  /** The reader's record, or undefined when this device holds none for `u`. */
  record: ChatKeyRecord | undefined
  /** What `fetchMessage` answers; undefined for a wake with `env`. */
  message: ChatMessage | undefined
  /** What `fetchEpochs(c, epoch - 1)` answers. */
  epochs: ChatEpochs
  identities: ChatIdentity[]
  expected: WakeNotification | null
}

interface Person {
  userId: string
  identityId: string
  identity: KeyPair
}

const AT = '2027-04-10T12:00:00Z'
const FROM = 'Clayton K'
const TITLE = 'Eagles Members'

const personOf = (gumbo: number): Person => ({
  userId: userIdOfGumbo(gumbo),
  identityId: newIdentityId(),
  identity: newIdentityKey()
})

const identityOf = (person: Person): ChatIdentity => ({
  id: person.identityId,
  userId: person.userId,
  publicKey: b64(person.identity.publicKey),
  createdAt: AT,
  replacedAt: null
})

/** One chat, its epochs in order, each with its key. */
interface Chat {
  id: string
  dm: boolean
  keys: Uint8Array[]
  epochs: ChatEpoch[]
}

function chatOf(id: string, dm: boolean, sender: Person, count = 1): Chat {
  const keys = Array.from({ length: count }, () => newEpochKey())
  const epochs = keys.map((key, index): ChatEpoch => {
    const epoch = index + 1
    const box =
      epoch === 1
        ? null
        : sealPreviousEpochKey({
            conversationId: id,
            epoch,
            epochKey: key,
            previousEpochKey: keys[index - 1]
          })
    return {
      epoch,
      createdByUserId: sender.userId,
      identityId: sender.identityId,
      previousKeyBox: box == null ? null : b64(box),
      chainBreak: false,
      signature: b64(
        signEpoch(
          { conversationId: id, epoch, previousKeyBox: box },
          sender.identity.secretKey
        )
      ),
      createdAt: AT
    }
  })
  return { id, dm, keys, epochs }
}

/** A sealed envelope from `sender` in `chat`'s epoch `epoch`. */
function envelopeOf(
  chat: Chat,
  sender: Person,
  content: ChatContent,
  options: { epoch?: number; seq?: number; kind?: EnvelopeKind } = {}
): ChatMessage {
  const epoch = options.epoch ?? chat.keys.length
  const kind = options.kind ?? 'post'
  const id = newMessageId()
  const sealed = sealMessage({
    conversationId: chat.id,
    epoch,
    messageId: id,
    senderUserId: sender.userId,
    kind,
    epochKey: chat.keys[epoch - 1],
    identitySecretKey: sender.identity.secretKey,
    plaintext: encodeContent(content)
  })
  return {
    id,
    conversationId: chat.id,
    seq: options.seq ?? 7,
    epoch,
    senderUserId: sender.userId,
    senderIdentityId: sender.identityId,
    kind,
    targetIds: content.type === 'delete' ? [content.targetId] : null,
    nonce: b64(sealed.nonce),
    ciphertext: b64(sealed.ciphertext),
    signature: b64(sealed.signature),
    attachmentIds: [],
    clearedAt: null,
    createdAt: AT
  }
}

const text = (
  body: string,
  mentions: string[] = [],
  attachments: AttachmentRef[] = []
): ChatContent => ({ type: 'text', body, mentions, attachments })

/** The test that opens these cases, and the vectors written from them. */
export function wakeCases(): WakeCase[] {
  const reader = personOf(2)
  const sender = personOf(1)
  const puk = newPukKey()
  const base = newRecord(reader.userId, 'cdv_reader', newDeviceKeys())
  base.identity = { id: reader.identityId, keys: reader.identity }
  base.puks = [{ generation: 1, keys: puk }]

  const dm = chatOf('cnv_wakeDm', true, sender)
  const group = chatOf('cnv_wakeGroup', false, sender)
  const chained = chatOf('cnv_wakeChain', false, sender, 2)
  const locked = chatOf('cnv_wakeLocked', true, sender)

  const boxOf = (chat: Chat, epoch: number): ChatEpochs['boxes'][number] => ({
    epoch,
    identityId: reader.identityId,
    pukGeneration: 1,
    box: b64(
      hpkeSeal(
        'epoch',
        puk.publicKey,
        epochAad({
          conversationId: chat.id,
          epoch,
          recipientUserId: reader.userId,
          identityId: reader.identityId,
          generation: 1
        }),
        chat.keys[epoch - 1]
      )
    ),
    grantedByUserId: null
  })
  const epochsOf = (
    chat: Chat,
    from: number,
    boxes: ChatEpochs['boxes']
  ): ChatEpochs => ({
    latest: chat.keys.length,
    needsRotation: false,
    noHolder: false,
    epochs: chat.epochs.filter(epoch => epoch.epoch >= from),
    boxes
  })

  // The DM's and the group's keys are cached; the others are opened here.
  const record = withEpochKey(
    withEpochKey(base, dm.id, 1, dm.keys[0]),
    group.id,
    1,
    group.keys[0]
  )
  const identities = [identityOf(sender), identityOf(reader)]

  const wakeOf = (
    chat: Chat,
    envelope: ChatMessage | undefined,
    seq = envelope?.seq ?? 7
  ): ChatWake => ({
    t: 'chat',
    u: reader.userId,
    c: chat.id,
    seq,
    dm: chat.dm,
    from: FROM,
    title: chat.dm ? null : TITLE,
    url: `teamstation://chat/${chat.id}`,
    ...(envelope == null ? {} : { env: envelope })
  })
  const shown = (
    chat: Chat,
    title: string,
    body: string
  ): WakeNotification => ({
    title,
    body,
    url: `teamstation://chat/${chat.id}`,
    tag: `chat:${chat.id}`
  })
  const inline = (
    name: string,
    chat: Chat,
    envelope: ChatMessage,
    expected: WakeNotification | null,
    over: Partial<WakeCase> = {}
  ): WakeCase => ({
    name,
    wake: wakeOf(chat, envelope),
    record,
    message: undefined,
    epochs: epochsOf(chat, envelope.epoch, []),
    identities,
    expected,
    ...over
  })

  const dmPost = envelopeOf(dm, sender, text('Bring water and a glove.'))
  const mention = envelopeOf(
    group,
    sender,
    text('Can you bring the scorebook?', [reader.userId])
  )
  const plain = envelopeOf(group, sender, text('Practice moved to 6.'))
  const target = newMessageId()
  const photo: AttachmentRef = {
    id: 'att_wakePhoto',
    key: b64(newEpochKey()),
    digest: b64(newEpochKey()),
    size: 1024,
    contentType: 'image/jpeg',
    fileName: 'lineup.jpg'
  }
  const forged = envelopeOf(
    group,
    sender,
    text('Signed by somebody else.', [reader.userId])
  )
  forged.signature = b64(new Uint8Array(64))
  const chainPost = envelopeOf(
    chained,
    sender,
    text('Older news for you.', [reader.userId]),
    { epoch: 1 }
  )
  const lockedPost = envelopeOf(locked, sender, text('No key for this.'))
  const fallback = shown(dm, FROM, `New message from ${FROM}`)

  return [
    inline('dm', dm, dmPost, shown(dm, FROM, 'Bring water and a glove.')),
    inline(
      'mention',
      group,
      mention,
      shown(group, `${FROM} in ${TITLE}`, 'Can you bring the scorebook?')
    ),
    inline('groupPlain', group, plain, null),
    inline(
      'reaction',
      dm,
      envelopeOf(
        dm,
        sender,
        { type: 'reaction', targetId: target, emoji: '👍', remove: false },
        { kind: 'reaction' }
      ),
      null
    ),
    inline(
      'edit',
      dm,
      envelopeOf(
        dm,
        sender,
        { type: 'edit', targetId: target, body: 'Edited.', mentions: [] },
        { kind: 'edit' }
      ),
      null
    ),
    inline(
      'delete',
      dm,
      envelopeOf(
        dm,
        sender,
        { type: 'delete', targetId: target },
        {
          kind: 'delete'
        }
      ),
      null
    ),
    {
      name: 'fetched',
      wake: wakeOf(dm, undefined, dmPost.seq),
      record,
      message: dmPost,
      epochs: epochsOf(dm, 1, []),
      identities,
      expected: shown(dm, FROM, 'Bring water and a glove.')
    },
    inline(
      'uncachedEpoch',
      group,
      mention,
      shown(group, `${FROM} in ${TITLE}`, 'Can you bring the scorebook?'),
      { record: base, epochs: epochsOf(group, 1, [boxOf(group, 1)]) }
    ),
    inline(
      'chainedEpoch',
      chained,
      chainPost,
      shown(chained, `${FROM} in ${TITLE}`, 'Older news for you.'),
      { epochs: epochsOf(chained, 1, [boxOf(chained, 2)]) }
    ),
    inline('groupBadSignature', group, forged, null),
    inline('dmUndecryptable', locked, lockedPost, {
      ...fallback,
      url: `teamstation://chat/${locked.id}`,
      tag: `chat:${locked.id}`
    }),
    inline(
      'attachmentOnly',
      dm,
      envelopeOf(dm, sender, text('', [], [photo])),
      shown(dm, FROM, 'Photo')
    ),
    inline('dmNoRecord', dm, dmPost, fallback, { record: undefined }),
    inline('groupNoRecord', group, mention, null, { record: undefined })
  ]
}

/** The deps `openWake` reads for a case, as a device's would answer. */
export function depsOf(item: WakeCase, calls: string[] = []): WakeDeps {
  return {
    record: item.record,
    fetchMessage: async (conversationId, seq) => {
      calls.push(`message ${conversationId} ${seq}`)
      return item.message?.conversationId === conversationId &&
        item.message.seq === seq
        ? item.message
        : undefined
    },
    fetchEpochs: async (conversationId, after) => {
      calls.push(`epochs ${conversationId} ${after}`)
      return item.epochs
    },
    fetchIdentity: async identityId => {
      const identity = item.identities.find(held => held.id === identityId)
      if (identity == null) throw notFound('No such identity')
      return identity
    }
  }
}

/**
 * The record as a vector holds it: the stored JSON (`recordToJson`, bytes
 * in base64url) without this device's own two key pairs, which opening a
 * wake never reads.
 */
type VectorRecord = Record<string, unknown>

export interface WakeVector {
  name: string
  wake: ChatWake
  record: VectorRecord | null
  /** `fetchMessage(wake.c, wake.seq)`; null for an inline envelope. */
  message: ChatMessage | null
  /** `fetchEpochs(wake.c, epoch - 1)`. */
  epochs: ChatEpochs
  /** `fetchIdentity` by id; any other id is a 404. */
  identities: ChatIdentity[]
  expected: WakeNotification | null
}

/** The cases as JSON test vectors, for another platform's decryptor. */
export function wakeVectors(): { version: 1; cases: WakeVector[] } {
  return {
    version: 1,
    cases: wakeCases().map(item => {
      let record: VectorRecord | null = null
      if (item.record != null) {
        const {
          deviceId: _deviceId,
          device: _device,
          ...rest
        } = JSON.parse(recordToJson(item.record)) as VectorRecord
        record = rest
      }
      return {
        name: item.name,
        wake: item.wake,
        record,
        message: item.message ?? null,
        epochs: item.epochs,
        identities: item.identities,
        expected: item.expected
      }
    })
  }
}

/** A vector's record back, with throwaway device keys in place of its own. */
export function recordOfVector(record: VectorRecord): ChatKeyRecord {
  const device = newDeviceKeys()
  return recordFromJson(
    JSON.stringify({
      ...record,
      deviceId: 'cdv_vector',
      device: {
        box: {
          secretKey: b64(device.box.secretKey),
          publicKey: b64(device.box.publicKey)
        },
        sign: {
          secretKey: b64(device.sign.secretKey),
          publicKey: b64(device.sign.publicKey)
        }
      }
    })
  )
}
