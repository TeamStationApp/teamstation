import { expect } from 'chai'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import type {
  ChatDevice,
  ChatIdentityPublication,
  ChatLink,
  ChatLinkApproval,
  ChatMyKeys,
  ChatPendingLink,
  ChatPukPublication,
  Session,
  TeamStationClient
} from '../../common/api'
import { signPuk } from '../../common/chatCrypto/chain'
import {
  hpkeOpen,
  hpkeSeal,
  type KeyPair,
  linkAad,
  pukAad
} from '../../common/chatCrypto/hpke'
import {
  newBoxKeyPair,
  newIdentityKey,
  newPukKey
} from '../../common/chatCrypto/keys'
import { linkCode } from '../../common/chatCrypto/linkCode'
import { HttpError } from '../../common/errors'
import { App } from '../App'
import { currentRoute, showRoute } from '../navigation/useAddressBar'
import { AccountScreen } from '../screens/AccountScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatDevicesScreen } from './ChatDevicesScreen'
import { type ChatKeysClient, ensureEnrolled } from './engine/links'
import {
  b64,
  type ChatKeyRecord,
  type ChatKeyStore,
  recordFromJson,
  recordToJson,
  unb64
} from './keyRecord'
import { keyStore } from './keyStore'
import { LinkDeviceScreen } from './LinkDeviceScreen'
import { browserName, thisDevice } from './thisDevice'
import { thisDevice as phoneDevice } from './thisDevice.native'

/**
 * U11, the screens: Chat devices, Link this device, and the account
 * screen's row and sign-out, against a stand-in for the key routes that
 * seals and opens with the real `chatCrypto`.
 */
let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const text = (): string => document.body.textContent ?? ''

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(20)
  })
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await delay(ms)
  })
}

async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await settle(20)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

function button(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node =>
      (node.getAttribute('aria-label') ?? '') === label ||
      (node.getAttribute('aria-label') == null &&
        (node.textContent ?? '').endsWith(label))
  )
}

async function press(label: string): Promise<void> {
  const found = button(label)
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
}

function labelled(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}

class MemoryStore implements ChatKeyStore {
  text: string | undefined
  wiped = 0
  constructor(private readonly log?: string[]) {}
  async load(): Promise<ChatKeyRecord | undefined> {
    return this.text == null ? undefined : recordFromJson(this.text)
  }

  async save(record: ChatKeyRecord): Promise<void> {
    this.text = recordToJson(record)
  }

  async wipe(): Promise<void> {
    this.log?.push('wipe')
    this.wiped += 1
    this.text = undefined
  }

  async exists(): Promise<boolean> {
    return this.text != null
  }

  record(): ChatKeyRecord {
    if (this.text == null) throw new Error('no record')
    return recordFromJson(this.text)
  }
}

const USER = 7

/**
 * The key routes, for one user and one session, as far as these screens
 * use them. `other` plays the user's device elsewhere: it holds the
 * identity and per-user keys when the account already has them.
 */
class FakeKeys {
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
          userId: USER,
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
                        userId: USER,
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
      }
    }
  }
}

const DEVICE = { name: 'Chrome on macOS', platform: 'web' as const }

describe('Chat devices', function () {
  this.timeout(15000)

  it('enrols a new user, then shows a request’s six digits, approves it, and removes the device', async function () {
    const fake = new FakeKeys()
    const store = new MemoryStore()
    await render(
      <ChatDevicesScreen
        client={fake.client()}
        userId={USER}
        store={store}
        device={DEVICE}
        pollMs={40}
      />
    )
    await until('the list', () => text().includes('YOUR DEVICES'))
    expect(fake.calls).includes('registerChatDevice')
    expect(fake.calls).includes('enrolChat')
    expect(text()).contains('Chrome on macOS (this device)')
    expect(text()).contains('Web · Linked')
    expect(button('Remove Chrome on macOS')).equals(undefined)
    const record = store.record()
    expect(record.identity).not.equals(undefined)

    // A phone asks to be linked.
    const phone = newBoxKeyPair()
    const phoneId = fake.addDevice('Pixel 10', 'android', phone.publicKey)
    fake.pending = [
      {
        id: 'clk_phone',
        newDevice: {
          id: phoneId,
          name: 'Pixel 10',
          platform: 'android',
          boxPublicKey: b64(phone.publicKey)
        },
        createdAt: '',
        expiresAt: ''
      }
    ]
    await until('the request', () => text().includes('Pixel 10 asks to read'))
    const code = linkCode(phone.publicKey, 'clk_phone')
    expect(labelled(`Code ${code}`)?.textContent).equals(
      `${code.slice(0, 3)} ${code.slice(3)}`
    )
    expect(text()).contains(
      'Approve only if Pixel 10 shows these same six digits.'
    )
    expect(text()).contains('Android · Not linked yet')

    await press('Approve Pixel 10')
    await until('the approval', () => !text().includes('asks to read'))
    const approved = fake.links.find(link => link.id === 'clk_phone')
    // The box opens, on the phone, to this account's identity key.
    const identity = hpkeOpen(
      'link',
      phone.secretKey,
      linkAad({ linkId: 'clk_phone', newDeviceId: phoneId }),
      unb64(approved!.box!)
    )
    expect(b64(identity)).equals(b64(record.identity!.keys.secretKey))
    expect(approved!.approval!.pukBoxes.map(box => box.generation)).deep.equals(
      [1]
    )
    await until('the phone linked', () => text().includes('Android · Linked'))

    // Removed: the per-user key moves on to generation 2, for this device only.
    await press('Remove Pixel 10')
    await until('the removal', () => !text().includes('Pixel 10'))
    expect(fake.calls).includes('revokeChatDevice')
    expect(fake.calls).includes('postChatPuk')
    expect(fake.puks).length(2)
    expect(store.record().puks.map(puk => puk.generation)).deep.equals([1, 2])
  })

  it('declines a request by removing the device that made it', async function () {
    const fake = new FakeKeys()
    const store = new MemoryStore()
    const phone = newBoxKeyPair()
    const phoneId = fake.addDevice('iPhone', 'ios', phone.publicKey)
    fake.pending = [
      {
        id: 'clk_ios',
        newDevice: {
          id: phoneId,
          name: 'iPhone',
          platform: 'ios',
          boxPublicKey: b64(phone.publicKey)
        },
        createdAt: '',
        expiresAt: ''
      }
    ]
    await render(
      <ChatDevicesScreen
        client={fake.client()}
        userId={USER}
        store={store}
        device={DEVICE}
        pollMs={40}
      />
    )
    await until('the request', () => text().includes('iPhone asks to read'))
    expect(text()).contains('iPhone or iPad · Not linked yet')
    fake.pending = []
    await press('Decline iPhone')
    await until('the device gone', () => !text().includes('iPhone'))
    expect(
      fake.devices.find(device => device.id === phoneId)?.revokedAt
    ).not.equals(null)
    expect(fake.calls).not.includes('postChatPuk')
  })

  it('says when an action fails, and when the list cannot be read', async function () {
    const fake = new FakeKeys()
    const store = new MemoryStore()
    const other = fake.addDevice('Old laptop', 'web', newBoxKeyPair().publicKey)
    await render(
      <ChatDevicesScreen
        client={fake.client()}
        userId={USER}
        store={store}
        device={DEVICE}
        pollMs={40}
      />
    )
    await until('the list', () => text().includes('Old laptop'))
    fake.fail.add('revokeChatDevice')
    await press('Remove Old laptop')
    await until('the failure', () => text().includes('That did not work'))
    expect(fake.devices.find(device => device.id === other)?.revokedAt).equals(
      null
    )
    // A missed read later keeps what is showing.
    fake.fail.add('chatDevices')
    await settle(100)
    expect(text()).contains('Old laptop')
    await act(async () => {
      root?.unmount()
    })

    const broken = new FakeKeys()
    broken.fail.add('registerChatDevice')
    await render(
      <ChatDevicesScreen
        client={broken.client()}
        userId={USER}
        store={new MemoryStore()}
        device={DEVICE}
      />
    )
    await until('the failure', () => text().includes('could not be loaded'))

    const unreadable = new FakeKeys()
    unreadable.fail.add('chatLinks')
    await act(async () => {
      root?.unmount()
    })
    await render(
      <ChatDevicesScreen
        client={unreadable.client()}
        userId={USER}
        store={new MemoryStore()}
        device={DEVICE}
      />
    )
    await until('the failure', () => text().includes('could not be loaded'))
  })

  it('shows Link this device in its place on a new device, then the list once linked', async function () {
    const fake = new FakeKeys()
    fake.withOtherDevice('Pixel 10')
    const store = new MemoryStore()
    await render(
      <ChatDevicesScreen
        client={fake.client()}
        userId={USER}
        store={store}
        device={DEVICE}
        pollMs={40}
      />
    )
    await until('the code', () => text().includes('Link this device'))
    const record = store.record()
    const linkId = record.pendingLinkId!
    const code = linkCode(record.device.box.publicKey, linkId)
    expect(labelled(`Six-digit code ${code}`)?.textContent).equals(
      `${code.slice(0, 3)} ${code.slice(3)}`
    )
    expect(text()).contains('Waiting for approval…')
    fake.approve(linkId)
    await until('the list', () => text().includes('YOUR DEVICES'))
    expect(text()).contains('Chrome on macOS (this device)')
    expect(text()).contains('Pixel 10')
    const linked = store.record()
    expect(b64(linked.identity!.keys.secretKey)).equals(
      b64(fake.identity!.keys.secretKey)
    )
    expect(linked.puks).length(1)
  })
})

describe('Link this device', function () {
  this.timeout(15000)

  it('offers I can’t reach my other devices, warns, and resets', async function () {
    const fake = new FakeKeys()
    fake.withOtherDevice('Pixel 10')
    const store = new MemoryStore()
    let done = 0
    await render(
      <LinkDeviceScreen
        client={fake.client()}
        userId={USER}
        store={store}
        device={DEVICE}
        pollMs={40}
        onDone={() => {
          done += 1
        }}
      />
    )
    await until('the code', () => text().includes('Waiting for approval'))
    await press('I can’t reach my other devices')
    expect(text()).contains('Start chat again on this device')
    expect(text()).contains('Your other devices will stop working for chat.')
    expect(text()).not.contains('None of your devices can approve')
    // Back to the code, the same request.
    await press('Back to linking')
    await until('the code again', () => text().includes('Waiting for approval'))
    expect(fake.calls.filter(name => name === 'requestChatLink')).length(1)
    await press('I can’t reach my other devices')
    await press('Reset chat on this device')
    await until('the reset', () => done === 1)
    expect(fake.calls).includes('resetChatIdentity')
    expect(store.record().identity?.id).equals(fake.identity?.id)
    expect(
      fake.devices.find(device => device.name === 'Pixel 10')?.revokedAt
    ).not.equals(null)
  })

  it('goes straight to the reset warning when no device is left to approve', async function () {
    const fake = new FakeKeys()
    const other = fake.withOtherDevice('Old phone')
    fake.devices.find(device => device.id === other)!.revokedAt = 'x'
    await render(
      <LinkDeviceScreen
        client={fake.client()}
        userId={USER}
        store={new MemoryStore()}
        device={DEVICE}
        onDone={() => undefined}
      />
    )
    await until('the warning', () => text().includes('Start chat again'))
    expect(text()).contains('None of your devices can approve this one')
    expect(button('Back to linking')).equals(undefined)
    expect(fake.calls).not.includes('requestChatLink')
    // A reset that fails says so and stays.
    fake.fail.add('resetChatIdentity')
    await press('Reset chat on this device')
    await until('the failure', () => text().includes('That did not work'))
  })

  it('asks again once a request expires', async function () {
    const fake = new FakeKeys()
    fake.withOtherDevice('Pixel 10')
    const store = new MemoryStore()
    await render(
      <LinkDeviceScreen
        client={fake.client()}
        userId={USER}
        store={store}
        device={DEVICE}
        pollMs={40}
        onDone={() => undefined}
      />
    )
    await until('the code', () => text().includes('Waiting for approval'))
    fake.links[0].expired = true
    await until('the expiry', () => text().includes('That request expired.'))
    await press('Ask again')
    await until('a new code', () => text().includes('Waiting for approval'))
    expect(store.record().pendingLinkId).equals(fake.links[1].id)
  })

  it('says a linked device is linked, and when nothing can be read', async function () {
    const fake = new FakeKeys()
    const store = new MemoryStore()
    let done = 0
    await render(
      <LinkDeviceScreen
        client={fake.client()}
        userId={USER}
        store={store}
        device={DEVICE}
        onDone={() => {
          done += 1
        }}
      />
    )
    await until('linked', () => text().includes('This device is linked.'))
    await press('Chat devices')
    expect(done).equals(1)
    await act(async () => {
      root?.unmount()
    })

    const broken = new FakeKeys()
    broken.fail.add('myChatKeys')
    await render(
      <LinkDeviceScreen
        client={broken.client()}
        userId={USER}
        store={new MemoryStore()}
        device={DEVICE}
        onDone={() => undefined}
      />
    )
    await until('the failure', () => text().includes('could not be loaded'))
  })

  it('turns to the reset warning when the last device goes while asking', async function () {
    const fake = new FakeKeys()
    const other = fake.withOtherDevice('Pixel 10')
    const client = fake.client()
    const asking: ChatKeysClient = {
      ...client,
      requestChatLink: async () => {
        fake.devices.find(device => device.id === other)!.revokedAt = 'x'
        return await client.requestChatLink()
      }
    }
    await render(
      <LinkDeviceScreen
        client={asking}
        userId={USER}
        store={new MemoryStore()}
        device={DEVICE}
        onDone={() => undefined}
      />
    )
    await until('the warning', () => text().includes('None of your devices'))
  })
})

describe('the account screen’s chat', function () {
  this.timeout(15000)

  const session: Session = {
    token: '',
    expiresAt: '',
    user: {
      id: USER,
      displayName: 'Blair B',
      email: undefined,
      isAdmin: false,
      avatarUrl: null
    }
  }

  /** The account screen's client: the fake's chat keys, and account
   * settings that never arrive (this suite is about chat). */
  const accountClient = (keys: ChatKeysClient): TeamStationClient =>
    ({
      ...keys,
      accountSettings: async () => await new Promise<never>(() => {})
    }) as unknown as TeamStationClient

  it('opens Chat devices, and signs out only after this device leaves chat', async function () {
    const log: string[] = []
    const fake = new FakeKeys()
    const store = new MemoryStore(log)
    // This device enrolled earlier.
    await ensureEnrolled({
      client: fake.client(),
      store,
      userId: USER,
      device: DEVICE
    })
    let opened = 0
    await render(
      <AccountScreen
        session={session}
        client={accountClient(fake.client(log))}
        chatStore={store}
        onChatDevices={() => {
          opened += 1
        }}
        onSignOut={() => {
          log.push('signOut')
        }}
      />
    )
    await press('Chat devices, The devices that can read your chats')
    expect(opened).equals(1)
    await press('Sign out')
    await until('the sign-out', () => log.includes('signOut'))
    expect(log).deep.equals(['revokeChatDevice', 'wipe', 'signOut'])
    expect(store.text).equals(undefined)
    expect(fake.devices[0].revokedAt).not.equals(null)
  })

  it('signs out at once with nothing stored, and offers Chat devices only with a way there', async function () {
    let signedOut = 0
    await render(
      <AccountScreen
        session={session}
        client={accountClient(new FakeKeys().client())}
        chatStore={new MemoryStore([])}
        onSignOut={() => {
          signedOut += 1
        }}
      />
    )
    expect(text()).not.contains('Chat devices')
    await press('Sign out')
    await until('the sign-out', () => signedOut === 1)
  })
})

describe('how a device names itself', function () {
  it('reads the browser and system from the user agent', function () {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    expect(browserName(mac)).equals('Chrome on macOS')
    expect(browserName(`${mac} Edg/141.0`)).equals('Edge on macOS')
    expect(
      browserName(
        'Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0'
      )
    ).equals('Firefox on Windows')
    expect(
      browserName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).equals('Safari on iOS')
    expect(
      browserName(
        'Mozilla/5.0 (Linux; Android 15) Chrome/141.0 Mobile Safari/537.36'
      )
    ).equals('Chrome on Android')
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0')).equals(
      'Chrome on Linux'
    )
    expect(browserName('curl/8')).equals('A browser')
    expect(thisDevice().platform).equals('web')
    expect(thisDevice().name).equals(browserName(navigator.userAgent))
  })

  it('names a phone by its kind, or its maker and model', function () {
    const platform = Platform as unknown as {
      OS: string
      constants?: Record<string, unknown>
    }
    const held = { OS: platform.OS, constants: platform.constants }
    try {
      platform.OS = 'ios'
      platform.constants = { interfaceIdiom: 'phone' }
      expect(phoneDevice()).deep.equals({ name: 'iPhone', platform: 'ios' })
      platform.constants = { interfaceIdiom: 'pad' }
      expect(phoneDevice()).deep.equals({ name: 'iPad', platform: 'ios' })
      platform.OS = 'android'
      platform.constants = { Brand: 'google', Model: 'Pixel 10' }
      expect(phoneDevice()).deep.equals({
        name: 'google Pixel 10',
        platform: 'android'
      })
      platform.constants = { Brand: '', Model: '' }
      expect(phoneDevice()).deep.equals({
        name: 'Android',
        platform: 'android'
      })
    } finally {
      platform.OS = held.OS
      platform.constants = held.constants
    }
  })
})

describe('chat devices in the app', function () {
  this.timeout(15000)
  const originalFetch = globalThis.fetch
  const heldIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')

  afterEach(function () {
    globalThis.fetch = originalFetch
    if (heldIndexedDB == null) {
      delete (globalThis as { indexedDB?: unknown }).indexedDB
    } else Object.defineProperty(globalThis, 'indexedDB', heldIndexedDB)
  })

  /**
   * The API as a signed-in user, with the chat key routes answered by
   * `fake`. Every call is logged as `METHOD /path`.
   */
  function fakeApi(
    fake: FakeKeys,
    more?: (method: string, path: string, body: unknown) => unknown
  ): string[] {
    // The browser's own key store, on an IndexedDB of this test's.
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: new IDBFactory()
    })
    const asked: string[] = []
    const client = fake.client()
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const path = url.split('?')[0].replace(/^.*\/api\/v1/, '')
      const method = init?.method ?? 'GET'
      asked.push(`${method} ${path}`)
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      const user = { id: USER, displayName: 'Blair B', isAdmin: false }
      const answer = async (
        work: () => Promise<unknown>
      ): Promise<Response> => {
        try {
          return Response.json(await work())
        } catch (error) {
          if (!(error instanceof HttpError)) throw error
          return Response.json(error.toApiError(), { status: error.status })
        }
      }
      const parts = path.split('/')
      if (path === '/auth/me') return Response.json(user)
      if (path === '/auth/logout') return Response.json({ ok: true })
      if (path === '/me/roles') return Response.json({ teams: {} })
      if (path === '/chat/devices') {
        return await answer(async () =>
          method === 'POST'
            ? await client.registerChatDevice(body)
            : await client.chatDevices()
        )
      }
      if (parts[1] === 'chat' && parts[2] === 'devices') {
        return await answer(async () => await client.revokeChatDevice(parts[3]))
      }
      if (path === '/chat/identity') {
        return await answer(async () => await client.enrolChat(body))
      }
      if (path === '/chat/me/keys') {
        return await answer(async () => await client.myChatKeys())
      }
      if (path === '/chat/links') {
        return await answer(async () =>
          method === 'POST'
            ? await client.requestChatLink()
            : await client.chatLinks()
        )
      }
      if (parts[1] === 'chat' && parts[2] === 'links') {
        return await answer(async () => await client.chatLink(parts[3]))
      }
      const extra = more?.(method, path, body)
      if (extra !== undefined) return Response.json(extra)
      return Response.json([])
    }
    return asked
  }

  it('enrols at /chat/devices, and the account screen’s row opens it', async function () {
    const fake = new FakeKeys()
    fakeApi(fake)
    showRoute({ name: 'chatDevices' }, true)
    await render(<App />)
    await until('the list', () => text().includes('YOUR DEVICES'))
    expect(currentRoute()).deep.equals({ name: 'chatDevices' })
    expect(text()).contains('Chat devices')
    expect(text()).contains('(this device)')
    expect(fake.calls).includes('enrolChat')
    await act(async () => {
      root?.unmount()
    })

    showRoute({ name: 'account' }, true)
    await render(<App />)
    await until('the account', () => text().includes('Sign out'))
    await press('Chat devices, The devices that can read your chats')
    await until('the list', () => text().includes('YOUR DEVICES'))
    expect(currentRoute()).deep.equals({ name: 'chatDevices' })
  })

  it('links at /chat/link and then shows Chat devices in its place', async function () {
    const fake = new FakeKeys()
    fake.withOtherDevice('Pixel 10')
    fakeApi(fake)
    showRoute({ name: 'chatLink' }, true)
    await render(<App />)
    await until('the code', () => text().includes('Waiting for approval'))
    expect(currentRoute()).deep.equals({ name: 'chatLink' })
    fake.approve(fake.links[0].id)
    await until('the devices', () => text().includes('YOUR DEVICES'))
    expect(currentRoute()).deep.equals({ name: 'chatDevices' })
  })

  it('signs out after removing this device from chat', async function () {
    const fake = new FakeKeys()
    const asked = fakeApi(fake)
    showRoute({ name: 'chatDevices' }, true)
    await render(<App />)
    await until('the list', () => text().includes('YOUR DEVICES'))
    await act(async () => {
      root?.unmount()
    })
    showRoute({ name: 'account' }, true)
    await render(<App />)
    await until('the account', () => text().includes('Sign out'))
    await press('Sign out')
    await until('signed out', () => asked.includes('POST /auth/logout'))
    const revoke = asked.findIndex(call =>
      call.startsWith('DELETE /chat/devices/')
    )
    expect(revoke).greaterThan(-1)
    expect(revoke).lessThan(asked.indexOf('POST /auth/logout'))
    expect(fake.devices[0].revokedAt).not.equals(null)
  })

  it('clears chat before switching OAuth accounts even when revocation ends the session', async function () {
    const fake = new FakeKeys()
    const asked = fakeApi(fake)
    const fetchApi = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      if (input === '/oauth/approve/test-approval/details') {
        return Response.json({ clientName: 'Fixture app', scopes: ['openid'] })
      }
      const answer = await fetchApi(input, init)
      if (typeof input === 'string' && input.endsWith('/auth/logout')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }
      return answer
    }
    showRoute({ name: 'chatDevices' }, true)
    await render(<App />)
    await until('the list', () => text().includes('YOUR DEVICES'))
    expect(await keyStore.exists()).equals(true)
    await act(async () => {
      root?.unmount()
    })
    showRoute({ name: 'oauthApprove', uid: 'test-approval' }, true)
    await render(<App />)
    await until('approval', () => text().includes('Use a different account'))
    await press('Use a different account')
    await until('sign in', () => currentRoute().name === 'signIn')
    expect(await keyStore.exists()).equals(false)
    expect(fake.devices[0].revokedAt).not.equals(null)
    const revoke = asked.findIndex(call =>
      call.startsWith('DELETE /chat/devices/')
    )
    expect(revoke).greaterThan(-1)
    expect(revoke).lessThan(asked.indexOf('POST /auth/logout'))
  })

  /** The chat routes' answers: a list, an empty chat, and a new DM. */
  function chats(
    list: Array<Record<string, unknown>>
  ): (method: string, path: string, body: unknown) => unknown {
    return (method, path) => {
      if (path === '/chat/conversations') return list
      if (path === '/chat/grants') return []
      if (path === '/chat/dm-candidates') {
        return [{ userId: 8, shortName: 'Pat P', avatarUrl: null }]
      }
      if (path === '/chat/dms' && method === 'POST') return list[0]
      const parts = path.split('/')
      if (parts[2] === 'conversations' && parts[4] === 'members') {
        return [
          {
            userId: USER,
            shortName: 'Blair B',
            avatarUrl: null,
            label: 'Parent',
            isModerator: false,
            isApprover: false,
            eligible: true,
            hasIdentity: true,
            identityKey: null,
            generation: 1
          }
        ]
      }
      if (parts[2] === 'conversations' && parts[4] === 'epochs') {
        return {
          latest: 0,
          needsRotation: false,
          noHolder: false,
          epochs: [],
          boxes: []
        }
      }
      return undefined
    }
  }

  const summary = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'cnv_hawks',
    kind: 'teamMembers',
    title: 'Hawks Members',
    scope: { type: 'team', id: 'tem_hawks' },
    scopeName: 'Hawks',
    lastSeq: 0,
    lastMessageAt: null,
    unread: 0,
    canPost: true,
    canModerate: false,
    locked: false,
    noHolder: false,
    closed: false,
    memberCount: 3,
    ...over
  })

  it('has a Chat tab with an unread dot, a list, a chat and its members', async function () {
    const fake = new FakeKeys()
    fakeApi(fake, chats([summary({ unread: 2 })]))
    showRoute({ name: 'chat' }, true)
    await render(<App />)
    await until(
      'the list',
      () =>
        document.querySelector('[role="button"][aria-label="Hawks Members"]') !=
        null
    )
    expect(currentRoute()).deep.equals({ name: 'chat' })
    expect(document.querySelector('[data-testid="chat-unread"]')).not.equals(
      null
    )
    expect(text()).contains('New message')
    await press('Hawks Members')
    await until('the chat', () => text().includes('No messages yet'))
    expect(currentRoute()).deep.equals({
      name: 'conversation',
      conversationId: 'cnv_hawks'
    })
    await press('Members')
    await until('the members', () =>
      text().includes('Members of Hawks Members')
    )
    expect(currentRoute()).deep.equals({
      name: 'chatMembers',
      conversationId: 'cnv_hawks'
    })
  })

  it('starts a DM at /chat/new, which takes the form’s place', async function () {
    const fake = new FakeKeys()
    const dm = summary({
      id: 'cnv_dm',
      kind: 'dm',
      title: null,
      scope: null,
      scopeName: null,
      memberCount: 2
    })
    fakeApi(fake, chats([dm]))
    showRoute({ name: 'chatNew' }, true)
    await render(<App />)
    await until('the candidates', () => text().includes('Pat P'))
    await press('Pick Pat P')
    await press('Start conversation')
    await until('the chat', () => text().includes('No messages yet'))
    expect(currentRoute()).deep.equals({
      name: 'conversation',
      conversationId: 'cnv_dm'
    })
  })

  it('opens a DM’s members by address, and leaves it for the list', async function () {
    const fake = new FakeKeys()
    const dm = summary({
      id: 'cnv_dm',
      kind: 'dm',
      title: null,
      scope: null,
      scopeName: null,
      memberCount: 2
    })
    const asked = fakeApi(fake, (method, path, body) =>
      path === '/chat/dms/cnv_dm/members/me'
        ? { closed: false }
        : chats([dm])(method, path, body)
    )
    showRoute({ name: 'chatMembers', conversationId: 'cnv_dm' }, true)
    await render(<App />)
    await until('the members', () => text().includes('Leave this conversation'))
    await press('Leave this conversation')
    await until('the list', () => currentRoute().name === 'chat')
    expect(asked).includes('DELETE /chat/dms/cnv_dm/members/me')
    expect(currentRoute()).deep.equals({ name: 'chat' })
  })

  it('opens a league’s Org chat from its card on Home', async function () {
    const fake = new FakeKeys()
    fakeApi(
      fake,
      chats([
        summary({
          id: 'cnv_org',
          kind: 'leagueOrg',
          title: 'QPLL Org',
          scope: { type: 'league', id: 'lea_qpll' },
          scopeName: 'QPLL'
        })
      ])
    )
    showRoute({ name: 'home' }, true)
    await render(<App />)
    await until('the league card', () => text().includes('LEAGUES'))
    await press('QPLL, QPLL Org')
    await until('the chat', () => text().includes('No messages yet'))
    expect(currentRoute()).deep.equals({
      name: 'conversation',
      conversationId: 'cnv_org'
    })
    expect(document.querySelector('[data-testid="chat-unread"]')).equals(null)
  })
})
