import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Modal as NativeModal, Text, View } from 'react-native'

import type { ChatCoreStatus } from '../../common/chatCrypto/coreCall'
import { CHAT_USER, FakeKeys, MemoryStore } from '../../test/chatKeysFake'
import {
  type ChatAccess,
  ChatAgeContext,
  type ChatAgeState
} from '../chat/AgeGate'
import { AgeSheet } from '../chat/AgeSheet'
import { ChatCoreGate } from '../chat/ChatCoreGate'
import { ChatGate } from '../chat/ChatGate'
import {
  DeviceApprovalContext,
  DeviceApprovalPrompt
} from '../chat/DeviceApprovalPrompt'
import {
  type DeviceApprovals,
  EMPTY_APPROVAL_STATE
} from '../chat/deviceApprovals'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { Modal } from '../components/Modal'
import {
  createModalPresence,
  type ModalPresence,
  ModalPresenceProvider
} from '../components/modalPresence'
import {
  ALL_ON,
  type NotificationSwitches,
  readAsked,
  SWITCHES_OFF,
  writeAsked
} from '../platform/notificationSwitches'
import type { PushClient, PushState } from '../platform/pushState'
import type { UserSettingStorage } from '../platform/userSetting'
import { ThemeProvider } from '../theme/ThemeContext'
import type { AskDevice, AskReason } from './notificationAsk'
import {
  NotificationAskContext,
  type NotificationAskState,
  useNotificationAskState
} from './notificationAskContext'
import { NotificationAskHost } from './NotificationAskHost'

const U = 'usr_1'
const TITLE =
  "TeamStation would like to send you notifications for events you've RSVP'd to and for direct messages from other users"
const HINT =
  "Allow notifications for TeamStation in your browser's site settings."

const client: PushClient = {
  webPushKey: async () => null,
  registerPush: async () => 'reg',
  updatePush: async () => ({
    messages: false,
    rsvpEvents: false,
    leagueManagement: true
  })
}

function memory(): UserSettingStorage {
  const kept = new Map<string, string>()
  return {
    getItem: async key => kept.get(key) ?? null,
    setItem: async (key, value) => {
      kept.set(key, value)
    }
  }
}

/**
 * A device in `permission`, and what the ask did to it. Given `reading`, its
 * permission is read only once that settles.
 */
function stubDevice(
  permission: PushState,
  reading?: Promise<unknown>
): AskDevice & {
  switched: Array<Partial<NotificationSwitches>>
  enabled: number
} {
  const device = {
    switched: [] as Array<Partial<NotificationSwitches>>,
    enabled: 0,
    state: async () => {
      await reading
      return permission
    },
    switches: async () => SWITCHES_OFF,
    setSwitches: async (
      _client: PushClient,
      _user: string,
      change: Partial<NotificationSwitches>
    ) => {
      device.switched.push(change)
      return { ...SWITCHES_OFF, ...change }
    },
    enable: async () => {
      device.enabled++
      return permission
    }
  }
  return device
}

/** Device approvals read (`settled`), with `waiting` links to answer. */
function approvals(settled: boolean): DeviceApprovals {
  const state = { ...EMPTY_APPROVAL_STATE, settled, ready: settled }
  return {
    subscribe: () => () => undefined,
    snapshot: () => state
  } as unknown as DeviceApprovals
}

/** Read, with a request from another device waiting to be answered. */
function waitingLink(): DeviceApprovals {
  const state = {
    ...EMPTY_APPROVAL_STATE,
    settled: true,
    ready: true,
    links: [
      {
        id: 'clk_waiting',
        newDevice: {
          id: 'dev_new',
          name: 'Test phone',
          platform: 'ios' as const,
          boxPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
        },
        createdAt: '2027-04-10T12:00:00.000Z',
        expiresAt: '2027-04-10T12:10:00.000Z'
      }
    ]
  }
  return {
    subscribe: () => () => undefined,
    snapshot: () => state
  } as unknown as DeviceApprovals
}

function chatAge(access: ChatAccess): ChatAgeState {
  return {
    access,
    answer: async () => 'adult',
    apple: 'none',
    retry: () => undefined,
    failed: false,
    ask: () => () => undefined,
    requests: {},
    settle: () => undefined
  }
}

/** Chat's keys, never reached while the gate is starting. */
const NO_KEYS = {} as unknown as React.ComponentProps<typeof ChatGate>['client']

/**
 * A modal of a screen's, on show while it is drawn and `visible`. It slides,
 * so hidden it is still going until its animation ends, which jsdom never
 * plays.
 */
function Holding(props: { visible: boolean }): React.ReactElement {
  return (
    <Modal transparent animationType="slide" visible={props.visible}>
      <View testID="held" />
    </Modal>
  )
}

/**
 * The first chat screen after a page load, on a device of someone who
 * already uses chat elsewhere: chat's core still loading (`core`), then
 * Link this device until `fake`'s other device approves it.
 */
interface Linking {
  core: Promise<ChatCoreStatus>
  fake: FakeKeys
  store: MemoryStore
}

function LinkingChat(props: { linking: Linking }): React.ReactElement {
  const { core, fake, store } = props.linking
  const [client] = React.useState(() => fake.client())
  const [engine] = React.useState(() => {
    let starts = 0
    return {
      start: async (): Promise<'ready' | 'link'> =>
        starts++ === 0 ? 'link' : 'ready'
    }
  })
  return (
    <ChatCoreGate
      loadCore={async () => await core}
      coreStatus={() => ({ ready: false, reason: 'loading' })}
    >
      <ChatGate
        engine={engine}
        client={client}
        userId={CHAT_USER}
        store={store}
        device={{ name: 'Chrome on macOS', platform: 'web' }}
        pollMs={40}
      >
        <Text>the chat list</Text>
      </ChatGate>
    </ChatCoreGate>
  )
}

interface Setup {
  access?: ChatAccess
  approvals?: DeviceApprovals
  chatShown?: boolean
  userId?: string
  held?: boolean
  /** Given `held`, whether its modal is visible; it is by default. */
  heldVisible?: boolean
  linking?: Linking
  ageSheet?: boolean
  /** A chat screen whose device is still being set up for chat. */
  gate?: { start: () => Promise<'ready' | 'link'> }
  prompt?: boolean
  /** A sheet of choices, opened by the person. */
  choices?: boolean
}

let root: Root | undefined
let asks: NotificationAskState | undefined
/** The app's count of modals, given every dismissal at once by default. */
let presence: ModalPresence = createModalPresence(0)

function Harness(
  props: Setup & {
    device: AskDevice
    storage: UserSettingStorage
    openSettings?: () => Promise<boolean>
  }
): React.ReactElement {
  const state = useNotificationAskState()
  useEffect(() => {
    asks = state
  })
  return (
    <ThemeProvider>
      <ModalPresenceProvider presence={presence}>
        <ChatAgeContext.Provider value={chatAge(props.access ?? 'allowed')}>
          <DeviceApprovalContext.Provider value={props.approvals}>
            <NotificationAskContext.Provider value={state.actions}>
              {props.choices === true && (
                <ChoiceSheet
                  title="Create"
                  choices={[{ label: 'Event', onPress: () => undefined }]}
                  onClose={() => undefined}
                />
              )}
              {props.held === true && (
                <Holding visible={props.heldVisible ?? true} />
              )}
              {props.linking != null && <LinkingChat linking={props.linking} />}
              {props.gate != null && (
                <ChatGate engine={props.gate} client={NO_KEYS} userId={U}>
                  <></>
                </ChatGate>
              )}
              {props.prompt === true && <DeviceApprovalPrompt />}
              {props.ageSheet === true && (
                <AgeSheet
                  mode="ask"
                  apple="none"
                  onAnswer={() => undefined}
                  onDecline={() => undefined}
                />
              )}
              <NotificationAskHost
                state={state}
                client={client}
                userId={'userId' in props ? props.userId : U}
                chatShown={props.chatShown ?? true}
                device={props.device}
                storage={props.storage}
                openSettings={props.openSettings}
              />
            </NotificationAskContext.Provider>
          </DeviceApprovalContext.Provider>
        </ChatAgeContext.Provider>
      </ModalPresenceProvider>
    </ThemeProvider>
  )
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

async function mount(
  device: AskDevice,
  storage: UserSettingStorage,
  setup: Setup = {},
  openSettings?: () => Promise<boolean>,
  dismissMs = 0
): Promise<(next: Setup) => Promise<void>> {
  presence = createModalPresence(dismissMs)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  let current = setup
  const draw = async (next: Setup): Promise<void> => {
    current = { ...current, ...next }
    await act(async () => {
      root!.render(
        <Harness
          {...current}
          device={device}
          storage={storage}
          openSettings={openSettings}
        />
      )
    })
    await settle()
  }
  await draw(setup)
  return draw
}

const request = async (reason: AskReason): Promise<void> => {
  await act(async () => {
    asks!.actions.request(reason)
  })
  await settle()
}
const sheet = (): HTMLElement | null =>
  document.querySelector('[data-testid="notification-ask"]')
const press = async (id: 'continue' | 'not-now' | 'done'): Promise<void> => {
  const target = document.querySelector<HTMLElement>(
    `[data-testid="notification-ask-${id}"]`
  )
  if (target == null) throw new Error(`No ${id} on the ask`)
  await act(async () => {
    target.click()
  })
  await settle()
}

/**
 * Back on Android: the sheet's `Modal`'s own `onRequestClose`, read off the
 * rendered element, since react-native-web in jsdom never finishes the
 * animation that would make it take Escape.
 */
const back = async (): Promise<void> => {
  const node = sheet()
  expect(node, 'the ask').not.equals(null)
  const close = nativeModalOf(node!).onRequestClose as (() => void) | undefined
  await act(async () => {
    close?.()
  })
  await settle()
}

/** The props of the React Native `Modal` that drew `node`. */
function nativeModalOf(
  node: Element
): React.ComponentProps<typeof NativeModal> {
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, unknown>)[key] as {
    type: unknown
    memoizedProps: React.ComponentProps<typeof NativeModal>
    return: unknown
  } | null
  while (fiber != null && fiber.type !== NativeModal)
    fiber = fiber.return as typeof fiber
  expect(fiber, 'Modal').not.equals(null)
  return fiber!.memoizedProps
}

const wait = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

describe('the notification ask over the app', function () {
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    asks = undefined
    document.body.innerHTML = ''
  })

  it('asks after an RSVP once the sheet over it has closed, with the question and its two answers', async function () {
    const device = stubDevice('prompt')
    const storage = memory()
    const draw = await mount(device, storage, { held: true })
    await request('rsvp')
    expect(sheet(), 'never over another modal').equals(null)
    await draw({ held: false })
    expect(sheet()).not.equals(null)
    expect(sheet()!.textContent).contains(TITLE)
    const labels = [
      ...sheet()!.querySelectorAll<HTMLElement>('[role="button"]')
    ].map(node => node.textContent)
    expect(labels).includes('Continue')
    expect(labels).includes('Not Now')
    expect(
      document.querySelector('[data-testid="notification-ask-hint"]')
    ).equals(null)
  })

  it('keeps Not Now and never asks that person here again', async function () {
    const device = stubDevice('prompt')
    const storage = memory()
    await mount(device, storage)
    await request('rsvp')
    await press('not-now')
    expect(sheet()).equals(null)
    expect(await readAsked(U, storage)).equals(true)
    expect(device.switched).deep.equals([])
    expect(device.enabled).equals(0)
    await request('rsvp')
    await request('messaging')
    expect(sheet()).equals(null)
    expect(device.switched).deep.equals([])
  })

  it('takes the backdrop for Not Now', async function () {
    const storage = memory()
    await mount(stubDevice('denied'), storage)
    await request('rsvp')
    const behind = sheet()!.parentElement!.querySelector<HTMLElement>(
      '[aria-label="Not Now"]'
    )
    await act(async () => {
      behind!.click()
    })
    await settle()
    expect(sheet()).equals(null)
    expect(await readAsked(U, storage)).equals(true)
  })

  it('on Continue closes at once, turns all three on and asks the system', async function () {
    const device = stubDevice('prompt')
    const storage = memory()
    await mount(device, storage)
    await request('rsvp')
    await press('continue')
    expect(sheet()).equals(null)
    expect(device.switched).deep.equals([ALL_ON])
    expect(device.enabled).equals(1)
    expect(await readAsked(U, storage)).equals(true)
  })

  it('opens the settings on Continue after a refusal, and closes', async function () {
    const device = stubDevice('denied')
    let opened = 0
    await mount(device, memory(), {}, async () => {
      opened++
      return true
    })
    await request('rsvp')
    expect(sheet()!.textContent).contains(TITLE)
    await press('continue')
    expect(opened).equals(1)
    expect(sheet()).equals(null)
    expect(device.switched).deep.equals([ALL_ON])
    expect(device.enabled).equals(0)
  })

  it('says where to allow them where the settings cannot be opened', async function () {
    const device = stubDevice('denied')
    await mount(device, memory(), {}, async () => false)
    await request('messaging')
    await press('continue')
    const hint = document.querySelector('[data-testid="notification-ask-hint"]')
    expect(hint?.textContent).equals(HINT)
    expect(
      document.querySelector('[data-testid="notification-ask-continue"]')
    ).equals(null)
    expect(device.switched).deep.equals([ALL_ON])
    await press('done')
    expect(sheet()).equals(null)
  })

  it('turns all three on quietly on a device allowed already', async function () {
    const device = stubDevice('granted')
    const storage = memory()
    await mount(device, storage)
    await request('messaging')
    expect(sheet()).equals(null)
    expect(device.switched).deep.equals([ALL_ON])
    expect(await readAsked(U, storage)).equals(true)
  })

  describe('a League management request', function () {
    const LEAGUE = [{ leagueManagement: true }]

    it('asks with the existing words, and on a device never asked turns all three on and keeps the ask', async function () {
      const device = stubDevice('prompt')
      const storage = memory()
      await mount(device, storage)
      await request('leagueManagement')
      expect(sheet()!.textContent).contains(TITLE)
      await press('continue')
      expect(sheet()).equals(null)
      expect(device.switched).deep.equals([ALL_ON])
      expect(device.enabled).equals(1)
      expect(await readAsked(U, storage)).equals(true)
      // Allowed already on a device never asked: the same, with no question.
      const granted = stubDevice('granted')
      const fresh = memory()
      await act(async () => root?.unmount())
      await mount(granted, fresh)
      await request('leagueManagement')
      expect(sheet()).equals(null)
      expect(granted.switched).deep.equals([ALL_ON])
      expect(await readAsked(U, fresh)).equals(true)
    })

    it('asks again on a device asked before, turning on only League management, while an RSVP request stays silent', async function () {
      const device = stubDevice('prompt')
      const storage = memory()
      await writeAsked(U, storage)
      await mount(device, storage)
      await request('rsvp')
      expect(sheet()).equals(null)
      await request('leagueManagement')
      expect(sheet()!.textContent).contains(TITLE)
      await press('continue')
      expect(device.switched).deep.equals(LEAGUE)
      expect(device.enabled).equals(1)
      // Not Now changes nothing.
      await request('leagueManagement')
      await press('not-now')
      expect(device.switched).deep.equals(LEAGUE)
      expect(device.enabled).equals(1)
    })

    it('turns on only League management with no question on a device asked before and allowed', async function () {
      const device = stubDevice('granted')
      const storage = memory()
      await writeAsked(U, storage)
      await mount(device, storage)
      await request('leagueManagement')
      expect(sheet()).equals(null)
      expect(device.switched).deep.equals(LEAGUE)
      expect(device.enabled).equals(0)
    })

    it('takes the refused path on a device asked before and refused', async function () {
      const device = stubDevice('denied')
      const storage = memory()
      await writeAsked(U, storage)
      await mount(device, storage, {}, async () => false)
      await request('leagueManagement')
      await press('continue')
      expect(
        document.querySelector('[data-testid="notification-ask-hint"]')
          ?.textContent
      ).equals(HINT)
      expect(device.switched).deep.equals(LEAGUE)
    })

    it('waits for a modal, and again for one that came up while it was worked out', async function () {
      const draw = await mount(stubDevice('prompt'), memory(), { held: true })
      await request('leagueManagement')
      expect(sheet()).equals(null)
      await draw({ held: false })
      expect(sheet()).not.equals(null)

      await act(async () => root?.unmount())
      let read!: () => void
      const reading = new Promise<void>(resolve => {
        read = resolve
      })
      const again = await mount(stubDevice('prompt', reading), memory())
      await request('leagueManagement')
      await again({ choices: true })
      await act(async () => {
        read()
      })
      await settle()
      expect(sheet(), 'never over the sheet of choices').equals(null)
      await again({ choices: false })
      expect(sheet()).not.equals(null)
    })
  })

  it('does nothing on a device that cannot notify, nor for someone asked already', async function () {
    const device = stubDevice('unsupported')
    const storage = memory()
    await mount(device, storage)
    await request('rsvp')
    expect(sheet()).equals(null)
    expect(await readAsked(U, storage)).equals(false)
    const other = stubDevice('prompt')
    const asked = memory()
    await writeAsked(U, asked)
    await act(async () => root?.unmount())
    await mount(other, asked)
    await request('rsvp')
    expect(sheet()).equals(null)
  })

  it('waits on entering messaging for the age sheet, then for this device’s approvals', async function () {
    const device = stubDevice('prompt')
    const draw = await mount(device, memory(), {
      access: 'ask',
      ageSheet: true,
      approvals: approvals(false)
    })
    await request('messaging')
    expect(sheet()).equals(null)
    // Agreed to: the age sheet goes, but the approvals are not read yet.
    await draw({ access: 'allowed', ageSheet: false })
    expect(sheet()).equals(null)
    await draw({ approvals: approvals(true) })
    expect(sheet()).not.equals(null)
  })

  it('waits for this device to be set up for chat, and for a link waiting to be approved', async function () {
    let started!: (status: 'ready') => void
    const gate = {
      start: async () =>
        await new Promise<'ready'>(resolve => {
          started = resolve
        })
    }
    await mount(stubDevice('prompt'), memory(), { gate })
    await request('messaging')
    expect(sheet(), 'chat still starting').equals(null)
    await act(async () => {
      started('ready')
    })
    await settle()
    expect(sheet()).not.equals(null)
    await act(async () => root?.unmount())

    const approving = await mount(stubDevice('prompt'), memory(), {
      approvals: waitingLink(),
      prompt: true
    })
    await request('rsvp')
    expect(
      document.querySelector('[data-testid="chat-device-approval-prompt"]')
    ).not.equals(null)
    expect(sheet(), 'never over the approval').equals(null)
    await approving({ approvals: approvals(true), prompt: false })
    expect(sheet()).not.equals(null)
  })

  it('waits for a chat surface on show before asking on entering messaging', async function () {
    const draw = await mount(stubDevice('prompt'), memory(), {
      chatShown: false
    })
    await request('messaging')
    expect(sheet()).equals(null)
    await draw({ chatShown: true })
    expect(sheet()).not.equals(null)
  })

  it('drops a messaging ask when chat stays locked, or is left before its gates are done', async function () {
    const blocked = await mount(stubDevice('prompt'), memory(), {
      access: 'blocked'
    })
    await request('messaging')
    await blocked({ access: 'allowed' })
    expect(sheet(), 'under 13 on this device').equals(null)
    await act(async () => root?.unmount())

    const left = await mount(stubDevice('prompt'), memory(), {
      access: 'ask'
    })
    await request('messaging')
    await left({ chatShown: false })
    await left({ access: 'allowed', chatShown: true })
    expect(sheet(), 'left chat first').equals(null)
    // An RSVP's ask is not chat's, and goes on.
    await request('rsvp')
    expect(sheet()).not.equals(null)
  })

  it('asks nobody while nobody is signed in, and forgets what waited', async function () {
    const draw = await mount(stubDevice('prompt'), memory(), {
      userId: undefined,
      held: true
    })
    await request('rsvp')
    expect(sheet()).equals(null)
    await draw({ held: false })
    expect(sheet()).equals(null)
    await draw({ userId: U })
    expect(sheet(), 'the request went with nobody').equals(null)
  })

  it('asks the next person after a sign-out with the question up', async function () {
    const device = stubDevice('prompt')
    const storage = memory()
    const draw = await mount(device, storage)
    await request('rsvp')
    expect(sheet()).not.equals(null)
    await draw({ userId: undefined })
    expect(sheet()).equals(null)
    await draw({ userId: 'usr_2' })
    expect(sheet(), 'nothing of the last person’s').equals(null)
    await request('rsvp')
    expect(sheet(), 'asked, the next person').not.equals(null)
    await press('not-now')
    expect(await readAsked('usr_2', storage)).equals(true)
    expect(await readAsked(U, storage), 'never answered').equals(false)
    // The first person, back, is asked afresh.
    await draw({ userId: U })
    expect(sheet()).equals(null)
    await request('rsvp')
    expect(sheet()).not.equals(null)
  })

  it('drops a question worked out for someone who has signed out since', async function () {
    let read!: () => void
    const reading = new Promise<void>(resolve => {
      read = resolve
    })
    const draw = await mount(stubDevice('prompt', reading), memory())
    await request('rsvp')
    await draw({ userId: 'usr_2' })
    await act(async () => {
      read()
    })
    await settle()
    expect(sheet()).equals(null)
  })

  it('waits again when a modal comes up while the question is worked out', async function () {
    let read!: () => void
    const reading = new Promise<void>(resolve => {
      read = resolve
    })
    const draw = await mount(stubDevice('prompt', reading), memory())
    await request('rsvp')
    await draw({ choices: true })
    await act(async () => {
      read()
    })
    await settle()
    expect(sheet(), 'never over the sheet of choices').equals(null)
    await draw({ choices: false })
    expect(sheet()).not.equals(null)
  })

  it('waits for any modal of the app’s, as a sheet of choices', async function () {
    const draw = await mount(stubDevice('prompt'), memory(), { choices: true })
    await request('messaging')
    expect(sheet()).equals(null)
    await draw({ choices: false })
    expect(sheet()).not.equals(null)
  })

  it('holds a device approval that arrives while it is up, until it has gone', async function () {
    const draw = await mount(stubDevice('prompt'), memory(), {
      approvals: approvals(true),
      prompt: true
    })
    await request('rsvp')
    expect(sheet()).not.equals(null)
    await draw({ approvals: waitingLink() })
    const approval = (): Element | null =>
      document.querySelector('[data-testid="chat-device-approval-prompt"]')
    expect(approval(), 'never over the ask').equals(null)
    expect(sheet()).not.equals(null)
    await press('not-now')
    expect(sheet()).equals(null)
    expect(approval()).not.equals(null)
  })

  it('takes no Back or backdrop while Continue is under way', async function () {
    let open!: (opened: boolean) => void
    let opened = 0
    const storage = memory()
    await mount(stubDevice('denied'), storage, {}, async () => {
      opened++
      return await new Promise<boolean>(resolve => {
        open = resolve
      })
    })
    await request('rsvp')
    await press('continue')
    expect(opened).equals(1)
    await back()
    const behind = sheet()!.parentElement!.querySelector<HTMLElement>(
      '[aria-label="Not Now"]'
    )
    await act(async () => {
      behind!.click()
    })
    await settle()
    expect(sheet(), 'still answering Continue').not.equals(null)
    await act(async () => {
      open(true)
    })
    await settle()
    expect(sheet()).equals(null)
  })

  it('takes Back for Not Now', async function () {
    const device = stubDevice('prompt')
    const storage = memory()
    await mount(device, storage)
    await request('rsvp')
    await back()
    expect(sheet()).equals(null)
    expect(await readAsked(U, storage)).equals(true)
    expect(device.switched).deep.equals([])
  })

  it('takes down a question for someone who signed out', async function () {
    const draw = await mount(stubDevice('prompt'), memory())
    await request('rsvp')
    expect(sheet()).not.equals(null)
    await draw({ userId: 'usr_2' })
    expect(sheet()).equals(null)
  })

  it('shows a modal it held only once its own has finished going', async function () {
    const draw = await mount(
      stubDevice('prompt'),
      memory(),
      { approvals: approvals(true), prompt: true },
      undefined,
      150
    )
    await request('rsvp')
    await draw({ approvals: waitingLink() })
    const approval = (): Element | null =>
      document.querySelector('[data-testid="chat-device-approval-prompt"]')
    await press('not-now')
    expect(sheet()).equals(null)
    expect(approval(), 'while the ask is still going').equals(null)
    await wait(200)
    expect(approval(), 'once it has gone').not.equals(null)
  })

  it('waits for a hidden modal’s dismissal to finish before asking', async function () {
    const draw = await mount(
      stubDevice('prompt'),
      memory(),
      { held: true },
      undefined,
      1000
    )
    await request('rsvp')
    const held = document.querySelector('[data-testid="held"]')!
    await draw({ heldVisible: false })
    expect(presence.open(), 'hidden, still going').equals(1)
    expect(sheet()).equals(null)
    // Its dismissal finished (UIKit's completion on iOS, the animation's
    // end in a browser): counted no more.
    await act(async () => {
      nativeModalOf(held).onDismiss?.()
    })
    await settle()
    expect(presence.open()).equals(0)
    expect(sheet()).not.equals(null)
  })

  it('never asks again for chat left while the question was worked out, though a link opens chat after', async function () {
    let read!: () => void
    const reading = new Promise<void>(resolve => {
      read = resolve
    })
    const draw = await mount(stubDevice('prompt', reading), memory(), {
      choices: true
    })
    await request('messaging')
    await draw({ choices: false })
    // Chat is left, then reached again from a link, while it is worked out.
    await draw({ chatShown: false })
    await draw({ chatShown: true })
    await act(async () => {
      read()
    })
    await settle()
    expect(sheet()).equals(null)
    expect(asks!.pending.size, 'nothing left waiting').equals(0)
    await draw({ chatShown: false })
    await draw({ chatShown: true })
    expect(sheet()).equals(null)
  })

  it('asks for chat again once a modal that came up meanwhile has gone, while still in chat', async function () {
    let read!: () => void
    const reading = new Promise<void>(resolve => {
      read = resolve
    })
    const draw = await mount(stubDevice('prompt', reading), memory())
    await request('messaging')
    await draw({ choices: true })
    await act(async () => {
      read()
    })
    await settle()
    expect(sheet()).equals(null)
    expect(asks!.pending.has('messaging')).equals(true)
    await draw({ choices: false })
    expect(sheet()).not.equals(null)
  })

  it('on the first chat after a page load, waits for chat’s core, then Link this device', async function () {
    this.timeout(10000)
    let loaded!: (status: ChatCoreStatus) => void
    const core = new Promise<ChatCoreStatus>(resolve => {
      loaded = resolve
    })
    const fake = new FakeKeys()
    fake.withOtherDevice('Pixel 10')
    const store = new MemoryStore()
    await mount(stubDevice('prompt'), memory(), {
      linking: { core, fake, store }
    })
    const text = (): string => document.body.textContent ?? ''
    expect(text()).contains('Opening chat')
    await request('messaging')
    expect(sheet(), 'over Opening chat…').equals(null)
    await act(async () => {
      loaded({ ready: true })
    })
    for (let i = 0; i < 100 && !text().includes('Waiting for approval'); i++)
      await wait(20)
    expect(text()).contains('Link this device')
    await wait(100)
    expect(sheet(), 'over Link this device').equals(null)
    fake.approve(store.record().pendingLinkId!)
    for (let i = 0; i < 100 && !text().includes('the chat list'); i++)
      await wait(20)
    expect(text()).contains('the chat list')
    await settle()
    expect(sheet(), 'once chat is open').not.equals(null)
  })
})
