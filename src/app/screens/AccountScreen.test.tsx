import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import type { AccountSettings } from '../../common/accountSettings'
import { TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import {
  testPasswordCosts,
  testPasswordParameters
} from '../../test/passwordFixtures'
import { App } from '../App'
import { parseRoute } from '../navigation/routes'
import { showRoute } from '../navigation/useAddressBar'
import { SLIDE_TRAVEL } from '../stream/overlay/SlideToStop'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  NO_READINESS_FLAGS,
  type ReadinessFlags
} from '../walkup/walkUpReadiness'
import { AccountScreen } from './AccountScreen'

let root: Root | undefined
const originalFetch = globalThis.fetch
const delay = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 15))
}
const text = (): string => document.body.textContent ?? ''
const button = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
async function press(label: string): Promise<void> {
  const node = button(label)
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
    await delay()
  })
}
async function change(label: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )
  expect(input, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input!.dispatchEvent(new window.Event('input', { bubbles: true }))
    await delay()
  })
}
const address = (input: string | URL | Request): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
const slider = (
  part: string,
  prefix = 'delete-account-slide'
): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${prefix}-${part}"]`)
/** A finger dragged across the delete slider, as the responder system hears a mouse. */
async function drag(distance: number): Promise<void> {
  const track = slider('track')
  expect(track, 'the delete slider').not.equals(null)
  const at = (type: string, x: number): MouseEvent =>
    new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: 10,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1
    })
  await act(async () => {
    track!.dispatchEvent(at('mousedown', 100))
    track!.dispatchEvent(at('mousemove', 100 + distance / 2))
    track!.dispatchEvent(at('mousemove', 100 + distance))
    track!.dispatchEvent(at('mouseup', 100 + distance))
    await delay()
  })
}
async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay()
  })
}
function fixture(
  legacy = false,
  node = false
): {
  client: TeamStationClient
  session: { token: string; expiresAt: string; user: AccountSettings['user'] }
  calls: string[]
  controls: { fail: string; loadFailures: number }
  fetcher: typeof fetch
} {
  let state: AccountSettings = {
    user: {
      id: userIdOfGumbo(101),
      displayName: 'Babe Ruth',
      email: 'alex@example.com',
      isAdmin: node,
      avatarUrl: null,
      gumboId: null
    },
    hasPassword: legacy,
    passwordNeedsUpgrade: legacy,
    passwordParameters: null,
    newPasswordSalt: testPasswordParameters.salt,
    emails: [
      { id: 'first', email: 'alex@example.com', isPrimary: true },
      { id: 'second', email: 'other@example.com', isPrimary: false }
    ]
  }
  const calls: string[] = []
  const controls = { fail: '', loadFailures: 0 }
  const apiKeys: unknown[] = []
  let requested = { email: '', replaceEmailId: undefined as string | undefined }
  const fetcher: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const route = url.replace('/api/v1', '')
    calls.push(route)
    if (controls.loadFailures > 0 && route === '/me/account') {
      controls.loadFailures--
      throw new Error('Load failed')
    }
    if (controls.fail === route)
      return new Response(
        JSON.stringify({ code: 'badRequest', message: 'Please try again' }),
        { status: 400 }
      )
    const body = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}'
    ) as Record<string, string>
    if (route === '/auth/me') return new Response(JSON.stringify(state.user))
    if (route === '/me/api-keys' && init?.method === 'POST') {
      const made = {
        id: `uak_${apiKeys.length + 1}`,
        name: body.name,
        secret: `tsk_fixture${apiKeys.length + 1}secret`,
        createdAt: '2026-10-28T00:00:00.000Z',
        permissions: body.permissions
      }
      apiKeys.push(made)
      return new Response(JSON.stringify(made), { status: 201 })
    }
    if (route === '/me/api-keys')
      return new Response(JSON.stringify({ keys: apiKeys }))
    if (route === '/me/roles')
      return new Response(JSON.stringify({ teams: {} }))
    if (route === '/me/account/name')
      state = {
        ...state,
        user: { ...state.user, displayName: body.displayName.trim() }
      }
    if (route === '/pictures')
      return new Response(
        JSON.stringify({
          version: 1,
          entries: [
            {
              id: 'baseball',
              label: 'Baseball',
              kind: 'photo',
              prefix: 'sports/baseball',
              sha256: 'a'.repeat(64),
              width: 192,
              height: 192,
              url: 'https://images.example.com/baseball.png'
            }
          ]
        })
      )
    if (route === '/me/account/catalog-picture') {
      state = {
        ...state,
        user: {
          ...state.user,
          avatarUrl: 'https://images.example.com/baseball.png'
        }
      }
      return new Response(JSON.stringify({ ok: true }))
    }
    if (route === '/me/account/photo')
      state = {
        ...state,
        user: {
          ...state.user,
          avatarUrl:
            init?.method === 'DELETE'
              ? null
              : 'https://images.example.com/photo.png'
        }
      }
    if (route === '/me/account/password')
      state = {
        ...state,
        hasPassword: true,
        passwordNeedsUpgrade: false,
        passwordParameters: {
          client: testPasswordParameters,
          server: { ...testPasswordParameters, iterations: 8 }
        }
      }
    if (route === '/me/account/password/reset')
      return new Response(
        JSON.stringify({ requestId: 'reset', email: 'alex@example.com' })
      )
    if (route === '/me/account/emails/request') {
      requested = { email: body.email, replaceEmailId: body.replaceEmailId }
      return new Response(JSON.stringify({ requestId: 'request' }))
    }
    if (route === '/me/account/emails/confirm') {
      const id = requested.replaceEmailId ?? 'added'
      const primary = state.emails.find(e => e.id === id)?.isPrimary ?? false
      state = {
        ...state,
        emails: [
          ...state.emails.filter(e => e.id !== id),
          { id, email: requested.email, isPrimary: primary }
        ],
        user: { ...state.user, ...(primary ? { email: requested.email } : {}) }
      }
    }
    if (route === '/me/account/emails/primary')
      state = {
        ...state,
        emails: state.emails.map(e => ({
          ...e,
          isPrimary: e.id === body.emailId
        })),
        user: {
          ...state.user,
          email: state.emails.find(e => e.id === body.emailId)!.email
        }
      }
    return new Response(
      JSON.stringify(route.startsWith('/me/account') ? state : [])
    )
  }
  const client = new TeamStationClient({
    baseUrl: '/api/v1',
    fetch: fetcher,
    passwordKdf: async () => 'ab'.repeat(32)
  })
  const session = { token: '', expiresAt: '', user: state.user }
  return { client, session, calls, controls, fetcher }
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    root = undefined
  })
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})

describe('Account settings screen', () => {
  it('opens node administration from the freshly loaded account even when the session predates the grant', async () => {
    const f = fixture(false, true)
    f.session.user = { ...f.session.user, isAdmin: false }
    let opened = false
    await render(
      <AccountScreen
        {...f}
        onSignOut={() => {}}
        onNodeAdministration={() => {
          opened = true
        }}
      />
    )
    await press('Node administration')
    expect(opened).equals(true)
  })
  it('hides node administration after revocation even when the session still advertises that role', async () => {
    const f = fixture()
    f.session.user = { ...f.session.user, isAdmin: true }
    await render(
      <AccountScreen
        {...f}
        onSignOut={() => {}}
        onNodeAdministration={() => {
          throw new Error('Revoked entry must be hidden')
        }}
      />
    )
    expect(button('Node administration')).equals(undefined)
  })
  it('changes an existing account to a shared catalog picture and back to initials, while cancellation preserves the saved picture', async () => {
    const f = fixture()
    await render(<AccountScreen {...f} onSignOut={() => {}} />)
    await press('Add photo')
    await press('Baseball')
    await press('Save photo')
    expect(f.calls).includes('/me/account/catalog-picture')
    await press('Change photo')
    await press('Use initials')
    await press('Cancel')
    expect(button('Change photo')).not.equals(undefined)
    await press('Change photo')
    await press('Use initials')
    await press('Save photo')
    expect(f.calls).includes('/me/account/photo')
    expect(button('Add photo')).not.equals(undefined)
  })
  it('opens the Apple Music settings walkthrough from Walk-up songs, on an iPhone only', async () => {
    const web = Platform.OS
    const written: ReadinessFlags[] = []
    const readiness = {
      read: async () => ({ ...NO_READINESS_FLAGS, promptShown: true }),
      write: async (value: ReadinessFlags) => {
        written.push(value)
      }
    }
    try {
      Platform.OS = 'ios'
      const f = fixture()
      await render(
        <AccountScreen
          {...f}
          onSignOut={() => undefined}
          readiness={readiness}
        />
      )
      const row = button('Apple Music settings')
      const fade = document.querySelector(
        '[aria-label="Fade Apple Music using the phone’s volume"]'
      )
      expect(row).not.equals(undefined)
      expect(fade).not.equals(null)
      expect(
        row!.compareDocumentPosition(fade!) &
          window.Node.DOCUMENT_POSITION_FOLLOWING
      ).not.equals(0)
      expect(text()).not.includes('TeamStation DJ, enable the following')
      await press('Apple Music settings')
      expect(text()).includes('TeamStation DJ, enable the following')
      await press('Close')
      expect(written).deep.equals([{ onboarded: true, promptShown: true }])
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      Platform.OS = 'android'
      await render(<AccountScreen {...fixture()} onSignOut={() => undefined} />)
      expect(button('Apple Music settings')).equals(undefined)
    } finally {
      Platform.OS = web
    }
  })
  it('loads, retries, saves identity and handles photo selection, errors and sign-out', async () => {
    const f = fixture()
    f.controls.loadFailures = 1
    const users: string[] = []
    let signedOut = false
    let pick: 'cancel' | 'error' | 'photo' = 'cancel'
    await render(
      <AccountScreen
        {...f}
        onAccountChanged={user => users.push(user.displayName)}
        onSignOut={() => {
          signedOut = true
        }}
        pickPhoto={async () => {
          if (pick === 'error') throw new Error('Picture unavailable')
          return pick === 'cancel'
            ? null
            : { contentType: 'image/png', base64: 'test' }
        }}
      />
    )
    expect(text()).includes('Cannot reach TeamStation')
    await press('Retry')
    expect(text()).includes('NAME')
    await change('Name', 'Mookie Betts')
    await press('Save name')
    expect(users).deep.equals(['Mookie Betts'])
    expect(text()).includes('Name saved')
    await press('Add photo')
    await press('Add Photo')
    expect(f.calls.filter(c => c.endsWith('/photo'))).length(0)
    pick = 'error'
    await press('Add Photo')
    expect(text()).includes('Picture unavailable')
    pick = 'photo'
    f.controls.fail = '/me/account/photo'
    await press('Add Photo')
    await press('Save photo')
    expect(text()).includes('Please try again')
    f.controls.fail = ''
    await press('Save photo')
    expect(text()).includes('Photo saved')
    expect(button('Change photo')).not.equals(undefined)
    await press('Sign out')
    expect(signedOut).equals(true)
  })
  it('verifies email for legacy upgrade and offers email reset for a forgotten password', async () => {
    const f = fixture(true)
    await render(
      <AccountScreen
        client={f.client}
        session={f.session}
        onSignOut={() => undefined}
      />
    )
    f.controls.fail = '/me/account/password/reset'
    await press('Verify email and set password')
    expect(text()).includes('Please try again')
    f.controls.fail = ''
    await press('Verify email and set password')
    expect(text()).includes('Enter the code sent')
    await press('Resend password code')
    await change('Password reset code', '123456')
    await change('New password', 'invented reset password')
    await change('Confirm new password', 'invented reset password')
    await press('Save password')
    expect(text()).includes('Password saved')
    await press('Change password')
    await press('Reset with an email code')
    expect(text()).includes('Enter the code sent')
    await press('Cancel password change')
    await press('Change password')
    expect(document.querySelector('[aria-label="Password reset code"]')).equals(
      null
    )
  })
  it('sets and changes passwords, validates confirmation, cancels and recovers from errors', async () => {
    const f = fixture()
    await render(<AccountScreen {...f} onSignOut={() => undefined} />)
    await press('Set password')
    expect(document.querySelector('[aria-label="Current password"]')).equals(
      null
    )
    await change('New password', 'invented test password')
    await change('Confirm new password', 'different')
    await press('Save password')
    expect(text()).includes('do not match')
    await change('Confirm new password', 'invented test password')
    f.controls.fail = '/me/account/password'
    await press('Save password')
    expect(text()).includes('Please try again')
    f.controls.fail = ''
    await press('Save password')
    expect(text()).includes('Password saved')
    await press('Change password')
    expect(
      document.querySelector('[aria-label="Current password"]')
    ).not.equals(null)
    await change('Current password', 'invented test password')
    await change('New password', 'another invented password')
    await change('Confirm new password', 'another invented password')
    await press('Save password')
    await press('Change password')
    expect(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Current password"]'
      )!.value
    ).equals('')
    await press('Cancel password change')
    expect(button('Change password')).not.equals(undefined)
  })
  it('shows password requirements once, live completion and only matching feedback for confirmation', async () => {
    const f = fixture()
    await render(<AccountScreen {...f} onSignOut={() => undefined} />)
    await press('Set password')
    expect(text()).not.includes('Passwords do not match')
    const requirement = (label: string): Element | null =>
      document.querySelector(`[aria-label="${label}"]`)
    expect(requirement('At least 8 characters: Required')).not.equals(null)
    await change('New password', 'Abcdefg1')
    for (const label of [
      'At least 8 characters',
      'An uppercase letter',
      'A lowercase letter',
      'A number'
    ])
      expect(requirement(label + ': Complete')).not.equals(null)
    expect(
      document
        .querySelector('[aria-label="New password"]')!
        .getAttribute('autocomplete')
    ).equals('new-password')
    await change('Confirm new password', 'different')
    expect(text()).includes('Passwords do not match')
    expect(button('Save password')!.getAttribute('aria-disabled')).equals(
      'true'
    )
    await change('Confirm new password', 'Abcdefg1')
    expect(text()).includes('Passwords match')
    expect(button('Save password')!.getAttribute('aria-disabled')).not.equals(
      'true'
    )
    await change('New password', 'a'.repeat(16))
    expect(requirement('An uppercase letter: Required')).not.equals(null)
    await change('New password', 'a'.repeat(17))
    expect(
      requirement(
        'An uppercase letter: Not required with 17 or more characters'
      )
    ).not.equals(null)
    await change('Confirm new password', 'a'.repeat(17))
    expect(button('Save password')!.getAttribute('aria-disabled')).not.equals(
      'true'
    )
    expect(
      document.querySelectorAll('[aria-label^="At least 8 characters:"]')
    ).length(1)
    await change('New password', 'a'.repeat(1025))
    expect(text()).includes('at most 1024 UTF-8 bytes')
    expect(button('Save password')!.getAttribute('aria-disabled')).equals(
      'true'
    )
  })
  it('starts password preparation on entry and waits before a single save', async () => {
    const f = fixture()
    let finish!: (costs: typeof testPasswordCosts) => void
    let count = 0
    const pending = new Promise<typeof testPasswordCosts>(resolve => {
      finish = resolve
    })
    f.client.preparePasswordCosts = async () => {
      count++
      return await pending
    }
    await render(<AccountScreen {...f} onSignOut={() => undefined} />)
    expect(count).equals(0)
    await press('Set password')
    expect(count).equals(1)
    expect(text()).includes('You can keep typing')
    await change('New password', 'invented valid password')
    await change('Confirm new password', 'invented valid password')
    await press('Save password')
    const saving = button('Saving password')!
    expect(saving.getAttribute('aria-busy')).equals('true')
    expect(saving.getAttribute('aria-disabled')).equals('true')
    expect(saving.lastElementChild!.getAttribute('role')).equals('progressbar')
    await press('Saving password')
    expect(f.calls.filter(c => c.endsWith('/password'))).length(0)
    await act(async () => {
      finish(testPasswordCosts)
      await delay()
    })
    expect(f.calls.filter(c => c.endsWith('/password'))).length(1)
    expect(text()).includes('Password saved')
  })
  it('handles password preparation failure, retries and ignores completion after closing the editor', async () => {
    const f = fixture()
    let failPreparation!: (error: unknown) => void
    let finishPreparation!: (costs: typeof testPasswordCosts) => void
    let count = 0
    f.client.preparePasswordCosts = async () => {
      count++
      return await new Promise((resolve, reject) => {
        finishPreparation = resolve
        failPreparation = reject
      })
    }
    await render(<AccountScreen {...f} onSignOut={() => undefined} />)
    await press('Set password')
    await act(async () => {
      failPreparation(new Error('Preparation unavailable'))
      await delay()
    })
    expect(text()).includes('Preparation unavailable')
    await press('Retry password preparation')
    expect(count).equals(2)
    await press('Cancel password change')
    await act(async () => {
      finishPreparation(testPasswordCosts)
      await delay()
    })
    expect(text()).not.includes('Preparation unavailable')
    await press('Set password')
    await act(async () => {
      failPreparation('unknown failure')
      await delay()
    })
    expect(text()).includes('Could not prepare your password')
    await press('Retry password preparation')
    await act(async () => {
      finishPreparation(testPasswordCosts)
      await delay()
    })
    expect(text()).not.includes('You can keep typing')
    await press('Cancel password change')
    await press('Set password')
    await press('Cancel password change')
    await act(async () => {
      failPreparation(new Error('stale'))
      await delay()
    })
    expect(text()).not.includes('stale')
  })
  it('cancels a password save when leaving during preparation', async () => {
    const f = fixture()
    let finish!: (costs: typeof testPasswordCosts) => void
    f.client.preparePasswordCosts = async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    let changed = 0
    await render(
      <AccountScreen
        {...f}
        onSignOut={() => undefined}
        onAccountChanged={() => {
          changed++
        }}
      />
    )
    await press('Set password')
    await change('New password', 'invented valid password')
    await change('Confirm new password', 'invented valid password')
    await press('Save password')
    await act(async () => {
      root!.unmount()
      root = undefined
      finish(testPasswordCosts)
      await delay()
    })
    expect(f.calls.filter(c => c.endsWith('/password'))).length(0)
    expect(changed).equals(0)
  })
  it('adds, resends, confirms, replaces and selects primary email addresses', async () => {
    const f = fixture()
    await render(<AccountScreen {...f} onSignOut={() => undefined} />)
    await press('Add email address')
    await change('New email address', 'new@example.com')
    await press('Send confirmation code')
    expect(text()).includes('not active yet')
    await press('Resend code')
    expect(f.calls.filter(c => c.endsWith('/request'))).length(2)
    await change('Confirmation code', 'invented')
    f.controls.fail = '/me/account/emails/confirm'
    await press('Confirm email')
    expect(text()).includes('Please try again')
    f.controls.fail = ''
    await press('Confirm email')
    expect(text()).includes('Email address confirmed')
    await press('Make new@example.com primary')
    expect(text()).includes('Primary email updated')
    await press('Change new@example.com')
    expect(text()).includes('It stays active')
    await change('New email address', 'changed@example.com')
    await press('Send confirmation code')
    await change('Confirmation code', 'invented')
    await press('Confirm email')
    expect(text()).includes('changed@example.com · Primary')
    await press('Add email address')
    await press('Cancel email change')
    expect(button('Add email address')).not.equals(undefined)
    await press('Change alex@example.com')
    await change('New email address', 'cancel@example.com')
    await press('Send confirmation code')
    await press('Cancel email change')
    expect(text()).not.includes('cancel@example.com')
  })
  it('keeps submissions single while a save is pending', async () => {
    const f = fixture()
    let finish: (() => void) | undefined
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: async (input, init) => {
        if (
          (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).endsWith('/name')
        )
          await new Promise<void>(resolve => {
            finish = resolve
          })
        return await f.fetcher(input, init)
      }
    })
    await render(
      <AccountScreen
        session={f.session}
        client={client}
        onSignOut={() => undefined}
      />
    )
    await change('Name', 'New name')
    await press('Save name')
    expect(button('Sign out')!.getAttribute('aria-disabled')).equals('true')
    await press('Save name')
    await act(async () => {
      finish!()
      await delay()
    })
    expect(f.calls.filter(c => c.endsWith('/name'))).length(1)
  })
  it('refreshes the shell identity without replacing its bearer token', async () => {
    const f = fixture()
    globalThis.fetch = f.fetcher
    const tokens: Array<string | undefined> = []
    showRoute(parseRoute('/account'), true)
    await render(
      <App initialToken="test-session" onToken={token => tokens.push(token)} />
    )
    await change('Name', 'Alex Shell')
    await press('Save name')
    expect(text()).includes('Alex Shell')
    expect(tokens).deep.equals([])
    await press('Back')
    expect(button('Account, Alex Shell')).not.equals(undefined)
    await press('Account, Alex Shell')
    await press('Sign out')
    expect(tokens).deep.equals([undefined])
  })
  it('opens TeamStation TV from Account and restores the account route on Back', async () => {
    const f = fixture()
    globalThis.fetch = f.fetcher
    showRoute(parseRoute('/account'), true)
    await render(<App initialToken="test-session" onToken={() => undefined} />)
    await press('TeamStation TV')
    expect(window.location.pathname).equals('/account/tv')
    expect(text()).includes('Enter the eight letters')
    await press('Back')
    expect(window.location.pathname).equals('/account')
  })
  it('opens Create API key at its own address, above Account, and makes a key that Account then lists', async () => {
    const f = fixture()
    globalThis.fetch = f.fetcher
    showRoute(parseRoute('/account/api-keys/new'), true)
    await render(<App initialToken="test-session" onToken={() => undefined} />)
    expect(text()).includes('Create API key')
    expect(text()).includes('Umpire management')
    expect(window.location.pathname).equals('/account/api-keys/new')
    // Back from a deep link is Account, and leaving makes nothing.
    await press('Back')
    expect(window.location.pathname).equals('/account')
    expect(text()).includes('API KEYS')
    expect(f.calls.filter(call => call === '/me/api-keys').length).greaterThan(
      0
    )
    await press('Create API key')
    expect(window.location.pathname).equals('/account/api-keys/new')
    await change('Name', 'Agent')
    const write = document.querySelector<HTMLElement>(
      '[aria-label="Schedule write"]'
    )
    expect(write).not.equals(null)
    await act(async () => {
      write!.click()
      await delay()
    })
    await press('Create API key')
    expect(window.location.pathname).equals('/account')
    expect(text()).includes('Agent')
    expect(text()).includes('tsk_fixt…')
  })
  it('puts Delete account last, behind a slide, with Cancel changing nothing', async () => {
    const f = fixture(false, true)
    const methods: string[] = []
    // What the server answers the next delete with, when not success.
    let refuse: Response | undefined
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: async (input, init) => {
        methods.push(`${init?.method ?? 'GET'} ${address(input)}`)
        if (init?.method === 'DELETE' && refuse != null) {
          const answer = refuse
          refuse = undefined
          return answer
        }
        return await f.fetcher(input, init)
      },
      passwordKdf: async () => 'ab'.repeat(32)
    })
    let deleted = 0
    let signedOut = 0
    await render(
      <AccountScreen
        client={client}
        session={f.session}
        onSignOut={() => {
          signedOut++
        }}
        onAccountDeleted={() => {
          deleted++
        }}
        onNodeAdministration={() => undefined}
      />
    )
    // The very last thing on the screen, after even Node administration.
    const buttons = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ]
    expect(buttons.at(-1)?.textContent).equals('Delete account')
    expect(buttons.at(-2)?.textContent).equals('Node administration')
    // Sign out and Delete account are both bold and centered.
    for (const label of ['Sign out', 'Delete account']) {
      const target = button(label)!
      const words = target.querySelector<HTMLElement>('div[dir], span, div')!
      expect(window.getComputedStyle(words).fontWeight, label).equals('700')
      expect(window.getComputedStyle(target).alignSelf, label).equals('center')
    }
    expect(text()).not.includes('irrecoverable')

    const deletes = (): string[] =>
      methods.filter(call => call === 'DELETE /api/v1/me/account')
    await press('Delete account')
    expect(text()).includes(
      'Are you sure? Deleting an account is irrecoverable.'
    )
    expect(slider('label')?.textContent).equals('Slide to delete')
    const cancel = slider('cancel', 'delete-account')!
    expect(cancel.textContent).equals('Cancel')
    await act(async () => {
      cancel.click()
      await delay()
    })
    expect(text()).not.includes('irrecoverable')
    expect(deletes()).length(0)

    // Short of the end, nothing happens.
    await press('Delete account')
    await drag(Math.floor(SLIDE_TRAVEL * 0.79))
    expect(deletes()).length(0)
    // A refusal says so, with the server's reason, and puts the knob back.
    refuse = new Response(
      JSON.stringify({
        code: 'conflict',
        message:
          'Add another administrator to Demo Owls before deleting your account'
      }),
      { status: 409 }
    )
    await drag(SLIDE_TRAVEL)
    expect(deletes()).length(1)
    expect(text()).includes('Your account could not be deleted.')
    expect(text()).includes(
      'Add another administrator to Demo Owls before deleting your account'
    )
    expect(deleted).equals(0)
    expect(slider('knob')?.style.transform).includes('translateX(3px)')

    // Enter on the focused track is the keyboard's slide.
    const track = slider('track')!
    expect(track.getAttribute('role')).equals('button')
    expect(track.getAttribute('aria-label')).equals('Slide to delete')
    expect(track.tabIndex).equals(0)
    await act(async () => {
      track.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      )
      await delay()
    })
    expect(deletes()).length(2)
    expect(deleted).equals(1)
    expect(signedOut).equals(0)
    // Signed out by deleting, not by asking the server to sign out too.
    expect(methods.filter(call => call.includes('/auth/logout'))).length(0)
  })
  it('asks for sign-in again, claiming nothing, when the session has ended', async () => {
    const f = fixture()
    let left = 0
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: async (input, init) =>
        init?.method === 'DELETE'
          ? new Response(
              JSON.stringify({ code: 'unauthorized', message: 'Sign in' }),
              { status: 401 }
            )
          : await f.fetcher(input, init),
      passwordKdf: async () => 'ab'.repeat(32)
    })
    await render(
      <AccountScreen
        client={client}
        session={f.session}
        onSignOut={() => undefined}
        onAccountDeleted={() => {
          left++
        }}
      />
    )
    await press('Delete account')
    await drag(SLIDE_TRAVEL)
    // Whether this delete went through or the session ended first, it says
    // only that signing in again finishes it, and no longer offers the slide.
    expect(text()).includes(
      'Your session ended. Sign in again to finish deleting your account.'
    )
    expect(text()).not.includes('could not be deleted')
    expect(slider('track')).equals(null)
    expect(left).equals(0)
    const signIn = slider('sign-in', 'delete-account')!
    expect(signIn.textContent).equals('Sign in')
    await act(async () => {
      signIn.click()
      await delay()
    })
    expect(left).equals(1)
  })
  it('falls back to signing out, and leaves the app for sign-in once deleted', async () => {
    const f = fixture()
    let signedOut = false
    await render(
      <AccountScreen
        {...f}
        onSignOut={() => {
          signedOut = true
        }}
      />
    )
    await press('Delete account')
    await drag(SLIDE_TRAVEL)
    expect(signedOut).equals(true)
    await act(async () => {
      root?.unmount()
    })
    root = undefined

    const shell = fixture()
    const calls: string[] = []
    globalThis.fetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${address(input)}`)
      return await shell.fetcher(input, init)
    }
    const tokens: Array<string | undefined> = []
    showRoute(parseRoute('/account'), true)
    await render(
      <App initialToken="test-session" onToken={token => tokens.push(token)} />
    )
    await press('Delete account')
    await drag(SLIDE_TRAVEL)
    expect(calls).includes('DELETE /api/v1/me/account')
    expect(calls.filter(call => call.includes('/auth/logout'))).length(0)
    expect(tokens).deep.equals([undefined])
    expect(button('Account, Babe Ruth')).equals(undefined)
  })
})
