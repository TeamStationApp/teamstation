import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import {
  DEFAULT_UMPIRE_NOTIFICATIONS,
  type UmpireNotificationSettings
} from '../../common/umpires'
import { userIdOfGumbo } from '../../common/userId'
import { confirmedChatAgeHooks } from '../../test/chatAgeTesting'
import { App } from '../App'
import { parseRoute } from '../navigation/routes'
import { showRoute } from '../navigation/useAddressBar'
import type { AskReason } from '../push/notificationAsk'
import { NotificationAskContext } from '../push/notificationAskContext'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  NOTICE_DAYS,
  noticeDays,
  UmpireNotificationsScreen
} from './UmpireNotificationsScreen'

describe('notificationsScreen.test.tsx', () => {
  let root: Root | undefined
  const originalFetch = globalThis.fetch
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
    globalThis.fetch = originalFetch
  })
  async function wait(milliseconds = 10): Promise<void> {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, milliseconds))
    })
  }
  async function mount(node: React.ReactElement): Promise<void> {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<ThemeProvider>{node}</ThemeProvider>)
    })
    await wait()
  }

  /** A league admin's settings on a fake server, and what each save sent. */
  function server(
    start: UmpireNotificationSettings = DEFAULT_UMPIRE_NOTIFICATIONS,
    failing = false
  ): {
    client: TeamStationClient
    saved: Array<Partial<UmpireNotificationSettings>>
    held: () => UmpireNotificationSettings
  } {
    let held = { ...start }
    const saved: Array<Partial<UmpireNotificationSettings>> = []
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.umpireNotifications = async league => {
      expect(league).equals('lea_demo')
      return { ...held }
    }
    client.setUmpireNotifications = async (league, change) => {
      expect(league).equals('lea_demo')
      saved.push(change)
      if (failing) throw new Error('You no longer administer this league.')
      held = { ...held, ...change }
      return { ...held }
    }
    return { client, saved, held: () => held }
  }

  /** The screen, with the ask requests it makes written down. */
  async function open(
    client: TeamStationClient,
    os: 'web' | 'ios' | 'android' = 'web'
  ): Promise<AskReason[]> {
    const asked: AskReason[] = []
    await mount(
      <NotificationAskContext.Provider
        value={{
          request: reason => asked.push(reason),
          withdraw: () => undefined
        }}
      >
        <UmpireNotificationsScreen client={client} league="lea_demo" os={os} />
      </NotificationAskContext.Provider>
    )
    return asked
  }
  const toggle = (name: string): HTMLInputElement =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
  const rowOf = (key: string): HTMLElement =>
    document.querySelector<HTMLElement>(
      `[data-testid="umpire-notifications-${key}"]`
    )!
  async function flip(name: string): Promise<void> {
    await act(async () => {
      toggle(name).click()
    })
    await wait()
  }
  const cell = (): HTMLElement =>
    document.querySelector<HTMLElement>(
      '[data-testid="grid-cell-umpire-notifications-days"]'
    )!
  const input = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>(
      '[data-testid="grid-cell-input-umpire-notifications-days"]'
    )
  /** The web's Days row, as gated as it is. */
  const daysRow = (): HTMLElement => rowOf('days')
  const gated = (): boolean =>
    daysRow().getAttribute('aria-disabled') === 'true'
  async function tapDays(): Promise<void> {
    await act(async () => {
      cell().click()
    })
    await wait()
  }
  async function type(value: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input(), value)
      input()!.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  async function key(name: string): Promise<void> {
    await act(async () => {
      input()!.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: name,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await wait()
  }
  const text = (): string => document.body.textContent ?? ''
  const MISSING = 'Send notifications for missing slots'
  const SIGN_UPS = 'Receive notifications when umpires sign up'
  const WITHDRAWALS = 'Receive notifications when umpires withdraw'

  it('takes 1 to 30 days, whole', () => {
    expect(NOTICE_DAYS).deep.equals(
      Array.from({ length: 30 }, (unused, i) => i + 1)
    )
    expect(['1', '7', '30'].map(noticeDays)).deep.equals([1, 7, 30])
    for (const refused of ['', '0', '31', '2.5', '-3', 'x'])
      expect(noticeDays(refused), refused).equals(undefined)
  })

  it('opens with the heading and four rows, every toggle off and Days at 7, greyed out', async () => {
    const f = server()
    await open(f.client)
    expect(document.querySelector('[role="heading"]')?.textContent).equals(
      'Umpire Management Notifications'
    )
    for (const name of [MISSING, SIGN_UPS, WITHDRAWALS])
      expect(toggle(name).checked, name).equals(false)
    expect(text()).includes('Number of days prior to send notification')
    expect(cell().textContent).equals('7')
    expect(gated()).equals(true)
    await tapDays()
    expect(input()).equals(null)
    expect(f.saved).deep.equals([])
  })

  it('saves each toggle as it changes, and asks for notifications only when one turns on', async () => {
    const f = server()
    const asked = await open(f.client)
    await flip(SIGN_UPS)
    expect(f.saved).deep.equals([{ signUps: true }])
    expect(toggle(SIGN_UPS).checked).equals(true)
    expect(asked).deep.equals(['leagueManagement'])
    await flip(WITHDRAWALS)
    await flip(SIGN_UPS)
    expect(f.saved).deep.equals([
      { signUps: true },
      { withdrawals: true },
      { signUps: false }
    ])
    expect(asked).deep.equals(['leagueManagement', 'leagueManagement'])
    expect(f.held()).deep.equals({
      ...DEFAULT_UMPIRE_NOTIFICATIONS,
      withdrawals: true
    })
  })

  it('greys out Days until missing slots is on, keeping its value either way', async () => {
    const f = server({ ...DEFAULT_UMPIRE_NOTIFICATIONS, daysBefore: 12 })
    const asked = await open(f.client)
    expect(cell().textContent).equals('12')
    expect(gated()).equals(true)
    await flip(MISSING)
    expect(asked).deep.equals(['leagueManagement'])
    expect(gated()).equals(false)
    expect(cell().textContent).equals('12')
    await flip(MISSING)
    expect(gated()).equals(true)
    expect(cell().textContent).equals('12')
    expect(f.saved).deep.equals([
      { missingSlots: true },
      { missingSlots: false }
    ])
  })

  it('refuses 0 and 31 in the web’s cell, and saves 3 on Enter and on leaving it', async () => {
    const f = server({ ...DEFAULT_UMPIRE_NOTIFICATIONS, missingSlots: true })
    await open(f.client)
    await tapDays()
    expect(input()?.value).equals('7')
    for (const refused of ['0', '31']) {
      await type(refused)
      await key('Enter')
      expect(text(), refused).includes('Choose 1 to 30 days')
      expect(input()?.value).equals(refused)
    }
    expect(f.saved).deep.equals([])
    // Leaving a refused number keeps it open, still refused.
    await act(async () => {
      input()!.blur()
    })
    await wait()
    expect(input()).not.equals(null)
    await type('3')
    expect(text()).not.includes('Choose 1 to 30 days')
    await key('Enter')
    expect(input()).equals(null)
    expect(f.saved).deep.equals([{ daysBefore: 3 }])
    expect(cell().textContent).equals('3')
    await tapDays()
    await type('5')
    await act(async () => {
      input()!.blur()
    })
    await wait()
    expect(input()).equals(null)
    expect(f.saved).deep.equals([{ daysBefore: 3 }, { daysBefore: 5 }])
    // The same number again, and Escape, save nothing.
    await tapDays()
    await key('Enter')
    await tapDays()
    await type('9')
    await key('Escape')
    expect(input()).equals(null)
    expect(cell().textContent).equals('5')
    expect(f.saved).length(2)
  })

  it('turns a wheel of 1 to 30 in the app, at the value held, and Done saves the day turned to', async () => {
    const f = server({ ...DEFAULT_UMPIRE_NOTIFICATIONS, missingSlots: true })
    await open(f.client, 'ios')
    expect(cell()).equals(null)
    const days = (): HTMLElement => rowOf('days')
    expect(days().getAttribute('aria-label')).equals('Number of days prior: 7')
    expect(days().textContent).includes('7')
    await act(async () => {
      days().click()
    })
    await wait()
    const options = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="umpire-notifications-days-wheel-"]'
      )
    ]
    expect(options.map(node => node.textContent)).deep.equals(
      NOTICE_DAYS.map(String)
    )
    const chosen = (): string | null =>
      document
        .querySelector(
          '[aria-label^="Number of days prior to send notification: "]'
        )
        ?.getAttribute('aria-label') ?? null
    expect(chosen()).equals('Number of days prior to send notification: 7')
    const done = (): HTMLElement =>
      [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
        node => node.textContent === 'Done'
      )!
    // Done on the day it opened at saves nothing.
    await act(async () => {
      done().click()
    })
    await wait()
    expect(f.saved).deep.equals([])
    await act(async () => {
      days().click()
    })
    await wait()
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="umpire-notifications-days-wheel-3"]'
        )!
        .click()
    })
    await act(async () => {
      done().click()
    })
    await wait()
    expect(f.saved).deep.equals([{ daysBefore: 3 }])
    expect(days().getAttribute('aria-label')).equals('Number of days prior: 3')
    expect(
      document.querySelector('[data-testid^="umpire-notifications-days-wheel"]')
    ).equals(null)
  })

  it('keeps the app’s Days closed while missing slots is off', async () => {
    const f = server()
    await open(f.client, 'android')
    await act(async () => {
      rowOf('days').click()
    })
    await wait()
    expect(
      document.querySelector('[data-testid^="umpire-notifications-days-wheel"]')
    ).equals(null)
  })

  it('shows why a save failed, puts the toggle back and asks nothing', async () => {
    const f = server(DEFAULT_UMPIRE_NOTIFICATIONS, true)
    const asked = await open(f.client)
    await flip(MISSING)
    expect(f.saved).deep.equals([{ missingSlots: true }])
    expect(text()).includes('You no longer administer this league.')
    expect(toggle(MISSING).checked).equals(false)
    expect(asked).deep.equals([])
  })

  it('says a failed read or a save refused without a reason in its own words', async () => {
    const f = server()
    f.client.umpireNotifications = async () => {
      throw new Error('You are not an admin of this league.')
    }
    await open(f.client)
    expect(text()).includes('You are not an admin of this league.')
    expect(toggle(MISSING).disabled).equals(true)
    const g = server()
    g.client.setUmpireNotifications = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- what a broken client might throw
      throw 'offline'
    }
    await open(g.client)
    await flip(SIGN_UPS)
    expect(text()).includes('Your notifications could not be saved. Try again.')
  })

  describe('in the app', () => {
    confirmedChatAgeHooks()
    it('opens from its address, with the admin’s own settings', async () => {
      const asked: string[] = []
      globalThis.fetch = async input => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        const path = url.split('?')[0]
        asked.push(path)
        const data = path.endsWith('/auth/me')
          ? {
              id: userIdOfGumbo(106),
              displayName: 'Tim Raines',
              isAdmin: false
            }
          : path.endsWith('/me/roles')
            ? { teams: {}, guardianOf: [] }
            : path.endsWith('/umpire-notifications')
              ? { ...DEFAULT_UMPIRE_NOTIFICATIONS, signUps: true }
              : {}
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      showRoute(
        parseRoute('/groups/league/lea_demo/umpire-notifications', ''),
        true
      )
      root = createRoot(
        document.body.appendChild(document.createElement('div'))
      )
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <App />
          </ThemeProvider>
        )
      })
      await wait(50)
      expect(asked).includes('/api/v1/leagues/lea_demo/umpire-notifications')
      expect(text()).includes('Umpire Management Notifications')
      expect(toggle(SIGN_UPS).checked).equals(true)
    })
  })
})
