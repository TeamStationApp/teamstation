import type { ChatKeysClient } from '../app/chat/engine/links'
import {
  b64,
  type ChatKeyRecord,
  type ChatKeyStore,
  recordFromJson,
  recordToJson,
  unb64
} from '../app/chat/keyRecord'
import type {
  ChatDevice,
  ChatIdentityPublication,
  ChatLink,
  ChatLinkApproval,
  ChatMyKeys,
  ChatPendingLink,
  ChatPukPublication
} from '../common/api'
import { signPuk } from '../common/chatCrypto/chain'
import {
  hpkeSeal,
  type KeyPair,
  linkAad,
  pukAad
} from '../common/chatCrypto/hpke'
import {
  newBoxKeyPair,
  newIdentityKey,
  newPukKey
} from '../common/chatCrypto/keys'
import { HttpError } from '../common/errors'
import { userIdOfGumbo } from '../common/userId'

/**
 * Chat's key routes and key store, stood in for with the real `chatCrypto`:
 * for the screens that set a device up for chat (`chatScreens.test.tsx`)
 * and what waits for them (the ask about notifications).
 */

/** The person `FakeKeys` answers for, unless told otherwise. */
export const CHAT_USER = userIdOfGumbo(7)

/** A key store in memory, keeping one record for each person. */
export class MemoryStore implements ChatKeyStore {
  private readonly slots = new Map<string, string>()
  private last: string | undefined
  wiped = 0
  constructor(private readonly log?: string[]) {}

  get text(): string | undefined {
    return this.last == null ? undefined : this.slots.get(this.last)
  }

  set text(value: string | undefined) {
    this.slots.clear()
    this.last = undefined
    if (value == null) return
    const parsed = JSON.parse(value) as { userId: string }
    this.slots.set(parsed.userId, value)
    this.last = parsed.userId
  }

  async load(userId: string): Promise<ChatKeyRecord | undefined> {
    const text = this.slots.get(userId)
    return text == null ? undefined : recordFromJson(text)
  }

  async save(record: ChatKeyRecord): Promise<void> {
    this.slots.set(record.userId, recordToJson(record))
    this.last = record.userId
  }

  async wipe(userId: string): Promise<void> {
    if (!this.slots.has(userId)) return
    this.log?.push('wipe')
    this.wiped += 1
    this.slots.delete(userId)
    if (this.last === userId) this.last = [...this.slots.keys()].at(-1)
  }

  async exists(userId: string): Promise<boolean> {
    return this.slots.has(userId)
  }

  record(): ChatKeyRecord {
    if (this.text == null) throw new Error('no record')
    return recordFromJson(this.text)
  }
}

/**
 * The key routes, for one user and one session, as far as these screens
 * use them. `other` plays the user's device elsewhere: it holds the
 * identity and per-user keys when the account already has them.
 */
export class FakeKeys {
  calls: string[] = []
  devices: ChatDevice[] = []
  boxKeys = new Map<string, Uint8Array>()
  bound: string | undefined
  identity: { id: string; keys: KeyPair } | undefined
  puks: KeyPair[] = []
  /** Device id → the generations it holds a box for. */
  held = new Map<string, Set<number>>()
  links: Array<ChatLink & { approval?: ChatLinkApproval }> = []
  pending: ChatPendingLink[] = []
  fail = new Set<string>()
  private serial = 0

  constructor(readonly userId: string = CHAT_USER) {}

  /** The account already has an identity, held by a linked `name`. */
  withOtherDevice(name: string): string {
    this.identity = { id: 'cid_0123456789abcdef', keys: newIdentityKey() }
    this.puks = [newPukKey()]
    const id = this.addDevice(name, 'android', newBoxKeyPair().publicKey)
    this.held.set(id, new Set([1]))
    return id
  }

  addDevice(
    name: string,
    platform: ChatDevice['platform'],
    boxPublicKey: Uint8Array
  ): string {
    this.serial += 1
    const id = `cdv_${this.serial}`
    this.boxKeys.set(id, boxPublicKey)
    this.devices.push({
      id,
      name,
      platform,
      boxPublicKey: b64(boxPublicKey),
      signPublicKey: b64(new Uint8Array(32)),
      createdAt: '2027-04-10T12:00:00.000Z',
      lastSeenAt: '2027-04-10T12:00:00.000Z',
      revokedAt: null,
      linked: false,
      current: false
    })
    return id
  }

  private linked(id: string): boolean {
    const device = this.devices.find(item => item.id === id)
    return (
      device != null &&
      device.revokedAt == null &&
      (this.held.get(id)?.has(this.puks.length) ?? false)
    )
  }

  private view(): ChatDevice[] {
    return this.devices.map(device => ({
      ...device,
      linked: this.linked(device.id),
      current: device.id === this.bound
    }))
  }

  private pukBox(generation: number, deviceId: string): string {
    if (this.identity == null) throw new Error('no identity')
    return b64(
      hpkeSeal(
        'puk',
        this.boxKeys.get(deviceId)!,
        pukAad({
          userId: this.userId,
          identityId: this.identity.id,
          generation,
          deviceId
        }),
        this.puks[generation - 1].secretKey
      )
    )
  }

  /** The device elsewhere approves this one's request. */
  approve(linkId: string): void {
    const link = this.links.find(item => item.id === linkId)
    if (link == null || this.identity == null) throw new Error('no link')
    link.box = b64(
      hpkeSeal(
        'link',
        this.boxKeys.get(link.newDeviceId)!,
        linkAad({ linkId, newDeviceId: link.newDeviceId }),
        this.identity.keys.secretKey
      )
    )
    link.approved = true
    this.held.set(
      link.newDeviceId,
      new Set(this.puks.map((_, index) => index + 1))
    )
  }

  private check(name: string): void {
    this.calls.push(name)
    if (this.fail.has(name)) throw new Error(`${name} failed`)
  }

  client(log?: string[]): ChatKeysClient {
    const call = (name: string): void => {
      log?.push(name)
      this.check(name)
    }
    return {
      registerChatDevice: async registration => {
        call('registerChatDevice')
        const id = this.addDevice(
          registration.name,
          registration.platform,
          unb64(registration.boxPublicKey)
        )
        this.bound = id
        return this.view().find(device => device.id === id)!
      },
      chatDevices: async () => {
        call('chatDevices')
        return this.view()
      },
      revokeChatDevice: async deviceId => {
        call('revokeChatDevice')
        const device = this.devices.find(item => item.id === deviceId)
        if (device == null) throw new HttpError('notFound', 'no')
        device.revokedAt = '2027-04-10T12:00:00.000Z'
        return this.view().find(item => item.id === deviceId)!
      },
      chatResumeChallenge: async () => {
        call('chatResumeChallenge')
        throw new HttpError('forbidden', 'no', { reason: 'unknownDevice' })
      },
      resumeChatDevice: async () => {
        call('resumeChatDevice')
        throw new HttpError('forbidden', 'no', { reason: 'unknownDevice' })
      },
      enrolChat: async (body: ChatIdentityPublication) => {
        call('enrolChat')
        this.identity = {
          id: body.identityId,
          keys: {
            publicKey: unb64(body.identityPublicKey),
            secretKey: new Uint8Array(32)
          }
        }
        this.puks = [
          { publicKey: unb64(body.pukPublicKey), secretKey: new Uint8Array(32) }
        ]
        this.held.set(this.bound!, new Set([1]))
        return { identityId: body.identityId, generation: 1, grantRequests: 0 }
      },
      resetChatIdentity: async (body: ChatIdentityPublication) => {
        call('resetChatIdentity')
        this.identity = {
          id: body.identityId,
          keys: {
            publicKey: unb64(body.identityPublicKey),
            secretKey: new Uint8Array(32)
          }
        }
        this.puks = [
          { publicKey: unb64(body.pukPublicKey), secretKey: new Uint8Array(32) }
        ]
        const revoked: string[] = []
        for (const device of this.devices) {
          if (device.id !== this.bound && device.revokedAt == null) {
            device.revokedAt = '2027-04-10T12:00:00.000Z'
            revoked.push(device.id)
          }
        }
        this.held = new Map([[this.bound!, new Set([1])]])
        return {
          identityId: body.identityId,
          generation: 1,
          revokedDeviceIds: revoked
        }
      },
      postChatPuk: async (body: ChatPukPublication) => {
        call('postChatPuk')
        this.puks.push({
          publicKey: unb64(body.publicKey),
          secretKey: new Uint8Array(32)
        })
        for (const box of body.boxes)
          this.held.get(box.deviceId)?.add(body.generation)
        return { generation: body.generation, grantRequests: 0 }
      },
      myChatKeys: async (): Promise<ChatMyKeys> => {
        call('myChatKeys')
        const bound = this.bound
        const revokedHolder = this.devices.some(
          device =>
            device.revokedAt != null &&
            (this.held.get(device.id)?.has(this.puks.length) ?? false)
        )
        return {
          deviceId: bound ?? null,
          linked: bound != null && this.linked(bound),
          identity:
            this.identity == null
              ? null
              : {
                  id: this.identity.id,
                  publicKey: b64(this.identity.keys.publicKey),
                  createdAt: '2027-04-10T12:00:00.000Z'
                },
          generations: this.puks.map((puk, index) => ({
            generation: index + 1,
            publicKey: b64(puk.publicKey),
            signature:
              this.identity == null || puk.secretKey.every(byte => byte === 0)
                ? b64(new Uint8Array(64))
                : b64(
                    signPuk(
                      {
                        userId: this.userId,
                        generation: index + 1,
                        publicKey: puk.publicKey
                      },
                      this.identity.keys.secretKey
                    )
                  ),
            previousKeysBox: null,
            box:
              bound != null &&
              (this.held.get(bound)?.has(index + 1) ?? false) &&
              !puk.secretKey.every(byte => byte === 0)
                ? this.pukBox(index + 1, bound)
                : null
          })),
          pukNeedsRotation: revokedHolder
        }
      },
      requestChatLink: async () => {
        call('requestChatLink')
        if (!this.devices.some(device => this.linked(device.id))) {
          throw new HttpError('conflict', 'no', { reason: 'noLinkedDevice' })
        }
        this.serial += 1
        const link = {
          id: `clk_${this.serial}`,
          newDeviceId: this.bound!,
          createdAt: '',
          expiresAt: '',
          approved: false,
          expired: false,
          approvedByDeviceId: null,
          box: null
        }
        this.links.push(link)
        return { ...link }
      },
      chatLinks: async () => {
        call('chatLinks')
        return this.pending
      },
      chatLink: async linkId => {
        call('chatLink')
        const link = this.links.find(item => item.id === linkId)
        if (link == null) throw new HttpError('notFound', 'no')
        return { ...link }
      },
      approveChatLink: async (linkId, approval) => {
        call('approveChatLink')
        const pending = this.pending.find(item => item.id === linkId)
        if (pending == null) throw new HttpError('notFound', 'no')
        this.pending = this.pending.filter(item => item.id !== linkId)
        this.held.set(
          pending.newDevice.id,
          new Set(approval.pukBoxes.map(box => box.generation))
        )
        const link = {
          id: linkId,
          newDeviceId: pending.newDevice.id,
          createdAt: '',
          expiresAt: '',
          approved: true,
          expired: false,
          approvedByDeviceId: this.bound ?? null,
          box: approval.box,
          approval
        }
        this.links.push(link)
        return link
      },
      declineChatLink: async linkId => {
        call('declineChatLink')
        const pending = this.pending.find(item => item.id === linkId)
        if (pending == null) throw new HttpError('notFound', 'no')
        this.pending = this.pending.filter(item => item.id !== linkId)
        const link = {
          id: linkId,
          newDeviceId: pending.newDevice.id,
          createdAt: '',
          expiresAt: '',
          approved: false,
          declined: true,
          expired: false,
          approvedByDeviceId: null,
          box: null
        }
        this.links.push(link)
        return link
      }
    }
  }
}
