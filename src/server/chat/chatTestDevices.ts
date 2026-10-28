import { expect } from 'chai'
import { base64url } from 'rfc4648'

import {
  sealPreviousEpochKey,
  sealPreviousPukKeys,
  signEpoch,
  signPuk
} from '../../common/chatCrypto/chain'
import {
  epochAad,
  hpkeOpen,
  hpkeSeal,
  type KeyPair,
  linkAad,
  pukAad
} from '../../common/chatCrypto/hpke'
import {
  type DeviceKeys,
  newDeviceKeys,
  newIdentityKey,
  newPukKey
} from '../../common/chatCrypto/keys'
import { newIdentityId } from '../../common/chatCrypto/messageIds'
import type { Answer, ChatFixture } from './chatTestFixture'

/**
 * The device side of the chat tests: devices that register, enrol, link
 * and reset through the routes, and make, box and open epoch keys with the
 * real `common/chatCrypto`, as the app will. Keys live here, never on the
 * server.
 */

export const b64 = (bytes: Uint8Array): string =>
  base64url.stringify(bytes, { pad: false })
export const unb64 = (text: string): Uint8Array =>
  base64url.parse(text, { loose: true })

/** One device as the app holds it. */
export interface TestDevice {
  /** The fixture session it is bound to. */
  who: string
  keys: DeviceKeys
  id: string
}

/** One user's keys as their linked devices hold them. */
export interface TestKeys {
  userId: string
  identityId: string
  identity: KeyPair
  /** By generation: `puks[0]` is generation 1. */
  puks: KeyPair[]
}

/** A member to box an epoch key to, at their current PUK. */
export interface Recipient {
  userId: string
  identityId: string
  generation: number
  publicKey: Uint8Array
}

export function ok(answer: Answer, status = 200): any {
  expect(answer.status, JSON.stringify(answer.body)).equals(status)
  return answer.body
}

export function refused(answer: Answer, status: number, reason: string): void {
  expect(answer.status, JSON.stringify(answer.body)).equals(status)
  expect(answer.body.details?.reason).equals(reason)
}

export class ChatDevices {
  private sessions = 0

  constructor(private readonly fixture: ChatFixture) {}

  async call(
    who: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<Answer> {
    return await this.fixture.call(who, method, path, body)
  }

  /** A new session for `key`, as another device signing in. */
  async session(key: string): Promise<string> {
    this.sessions += 1
    const who = `${key}~${this.sessions}`
    await this.fixture.signIn(who, key)
    return who
  }

  async register(who: string): Promise<TestDevice> {
    const keys = newDeviceKeys()
    const body = ok(
      await this.call(who, 'POST', '/chat/devices', {
        name: who,
        platform: 'web',
        boxPublicKey: b64(keys.box.publicKey),
        signPublicKey: b64(keys.sign.publicKey)
      }),
      201
    )
    return { who, keys, id: body.id }
  }

  private pukBox(
    keys: TestKeys,
    generation: number,
    device: TestDevice
  ): string {
    return b64(
      hpkeSeal(
        'puk',
        device.keys.box.publicKey,
        pukAad({
          userId: keys.userId,
          identityId: keys.identityId,
          generation,
          deviceId: device.id
        }),
        keys.puks[generation - 1].secretKey
      )
    )
  }

  private newIdentity(
    key: string,
    device: TestDevice
  ): { keys: TestKeys; body: Record<string, string> } {
    const keys: TestKeys = {
      userId: this.fixture.id(key),
      identityId: newIdentityId(),
      identity: newIdentityKey(),
      puks: [newPukKey()]
    }
    const body = {
      identityId: keys.identityId,
      identityPublicKey: b64(keys.identity.publicKey),
      pukPublicKey: b64(keys.puks[0].publicKey),
      pukSignature: b64(
        signPuk(
          {
            userId: keys.userId,
            generation: 1,
            publicKey: keys.puks[0].publicKey
          },
          keys.identity.secretKey
        )
      ),
      box: this.pukBox(keys, 1, device)
    }
    return { keys, body }
  }

  /** Registers a device on `who` (`key`'s own session by default) and enrols. */
  async enrol(
    key: string,
    who = key
  ): Promise<{ device: TestDevice; keys: TestKeys }> {
    const device = await this.register(who)
    const { keys, body } = this.newIdentity(key, device)
    ok(await this.call(who, 'PUT', '/chat/identity', body), 201)
    return { device, keys }
  }

  /** A device in a new session that resets `key`'s identity. */
  async reset(key: string): Promise<{ device: TestDevice; keys: TestKeys }> {
    const who = await this.session(key)
    const device = await this.register(who)
    const { keys, body } = this.newIdentity(key, device)
    ok(await this.call(who, 'POST', '/chat/identity/reset', body), 201)
    return { device, keys }
  }

  /** A new device for `key` in a new session, linked from `from`. */
  async link(
    key: string,
    keys: TestKeys,
    from: TestDevice
  ): Promise<TestDevice> {
    const who = await this.session(key)
    const device = await this.register(who)
    const link = ok(await this.call(who, 'POST', '/chat/links'), 201)
    ok(
      await this.call(from.who, 'POST', `/chat/links/${link.id}/approve`, {
        box: b64(
          hpkeSeal(
            'link',
            device.keys.box.publicKey,
            linkAad({ linkId: link.id, newDeviceId: device.id }),
            keys.identity.secretKey
          )
        ),
        pukBoxes: keys.puks.map((_, index) => ({
          generation: index + 1,
          box: this.pukBox(keys, index + 1, device)
        }))
      })
    )
    return device
  }

  /** Posts the next PUK generation from `from`, boxed to `devices`. */
  async nextPuk(
    keys: TestKeys,
    from: TestDevice,
    devices: TestDevice[]
  ): Promise<void> {
    const generation = keys.puks.length + 1
    const puk = newPukKey()
    const older = keys.puks.map((key, index) => ({
      generation: index + 1,
      privateKey: key.secretKey
    }))
    keys.puks.push(puk)
    ok(
      await this.call(from.who, 'POST', '/chat/puk', {
        generation,
        publicKey: b64(puk.publicKey),
        signature: b64(
          signPuk(
            { userId: keys.userId, generation, publicKey: puk.publicKey },
            keys.identity.secretKey
          )
        ),
        previousKeysBox: b64(
          sealPreviousPukKeys({
            userId: keys.userId,
            identityId: keys.identityId,
            generation,
            privateKey: puk.secretKey,
            older
          })
        ),
        boxes: devices.map(device => ({
          deviceId: device.id,
          box: this.pukBox(keys, generation, device)
        }))
      }),
      201
    )
  }

  /**
   * The members of a conversation, as `who` reads them, with their current
   * PUKs: everybody with an identity, or only the eligible.
   */
  async recipients(
    who: string,
    conversationId: string,
    which: 'eligible' | 'hasIdentity'
  ): Promise<Recipient[]> {
    const members = ok(
      await this.call(
        who,
        'GET',
        `/chat/conversations/${conversationId}/members`
      )
    ) as Array<{ userId: string; eligible: boolean; hasIdentity: boolean }>
    const recipients: Recipient[] = []
    for (const member of members) {
      if (!member[which]) continue
      const keys = ok(
        await this.call(who, 'GET', `/chat/users/${member.userId}/keys`)
      )
      recipients.push({
        userId: member.userId,
        identityId: keys.identity.id,
        generation: keys.puk.generation,
        publicKey: unb64(keys.puk.publicKey)
      })
    }
    return recipients
  }

  /** An epoch key boxed (HPKE `epoch` or `grant`) to one recipient. */
  box(
    purpose: 'epoch' | 'grant',
    conversationId: string,
    epoch: number,
    recipient: Recipient,
    epochKey: Uint8Array
  ): string {
    return b64(
      hpkeSeal(
        purpose,
        recipient.publicKey,
        epochAad({
          conversationId,
          epoch,
          recipientUserId: recipient.userId,
          identityId: recipient.identityId,
          generation: recipient.generation
        }),
        epochKey
      )
    )
  }

  /** The body of `POST …/epochs`, signed by `creator`. */
  epochBody(fields: {
    conversationId: string
    epoch: number
    creator: TestKeys
    epochKey: Uint8Array
    previousEpochKey: Uint8Array | null
    recipients: Recipient[]
  }): {
    epoch: number
    previousKeyBox: string | null
    signature: string
    boxes: Array<{ userId: string; pukGeneration: number; box: string }>
  } {
    const previousKeyBox =
      fields.previousEpochKey == null
        ? null
        : sealPreviousEpochKey({
            conversationId: fields.conversationId,
            epoch: fields.epoch,
            epochKey: fields.epochKey,
            previousEpochKey: fields.previousEpochKey
          })
    return {
      epoch: fields.epoch,
      previousKeyBox: previousKeyBox == null ? null : b64(previousKeyBox),
      signature: b64(
        signEpoch(
          {
            conversationId: fields.conversationId,
            epoch: fields.epoch,
            previousKeyBox
          },
          fields.creator.identity.secretKey
        )
      ),
      boxes: fields.recipients.map(recipient => ({
        userId: recipient.userId,
        pukGeneration: recipient.generation,
        box: this.box(
          'epoch',
          fields.conversationId,
          fields.epoch,
          recipient,
          fields.epochKey
        )
      }))
    }
  }

  /**
   * Every epoch key `who`'s boxes open, by epoch, with `keys`' PUKs (an
   * older generation's key as the chain would give it).
   */
  async openEpochKeys(
    who: string,
    keys: TestKeys,
    conversationId: string,
    after = 0
  ): Promise<Map<number, Uint8Array>> {
    const answer = ok(
      await this.call(
        who,
        'GET',
        `/chat/conversations/${conversationId}/epochs?after=${after}`
      )
    )
    const opened = new Map<number, Uint8Array>()
    for (const box of answer.boxes as Array<{
      epoch: number
      identityId: string
      pukGeneration: number
      box: string
      grantedByUserId: string | null
    }>) {
      expect(box.identityId).equals(keys.identityId)
      opened.set(
        box.epoch,
        hpkeOpen(
          box.grantedByUserId == null ? 'epoch' : 'grant',
          keys.puks[box.pukGeneration - 1].secretKey,
          epochAad({
            conversationId,
            epoch: box.epoch,
            recipientUserId: keys.userId,
            identityId: keys.identityId,
            generation: box.pukGeneration
          }),
          unb64(box.box)
        )
      )
    }
    return opened
  }
}
