import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { AccountSettings } from '../../common/accountSettings'
import { TeamStationClient } from '../../common/api'
import { testPasswordParameters } from '../../test/passwordFixtures'
import { App } from '../App'
import { parseRoute } from '../navigation/routes'
import { showRoute } from '../navigation/useAddressBar'
import { ThemeProvider } from '../theme/ThemeContext'
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
async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay()
  })
}
function fixture(legacy = false): {
  client: TeamStationClient
  session: { token: string; expiresAt: string; user: AccountSettings['user'] }
  calls: string[]
  controls: { fail: string; loadFailures: number }
  fetcher: typeof fetch
} {
  let state: AccountSettings = {
    user: {
      id: 101,
      displayName: 'Alex Morgan',
      email: 'alex@example.com',
      isAdmin: false,
      avatarUrl: null
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
    if (route === '/me/roles')
      return new Response(JSON.stringify({ teams: {} }))
    if (route === '/me/account/name')
      state = {
        ...state,
        user: { ...state.user, displayName: body.displayName.trim() }
      }
    if (route === '/me/account/photo')
      state = {
        ...state,
        user: {
          ...state.user,
          avatarUrl: 'https://images.example.com/photo.png'
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
    expect(text()).includes('PROFILE')
    await change('Name', 'Alex Rivera')
    await press('Save name')
    expect(users).deep.equals(['Alex Rivera'])
    expect(text()).includes('Name saved')
    await press('Add photo')
    expect(f.calls.filter(c => c.endsWith('/photo'))).length(0)
    pick = 'error'
    await press('Add photo')
    expect(text()).includes('Picture unavailable')
    pick = 'photo'
    f.controls.fail = '/me/account/photo'
    await press('Add photo')
    expect(text()).includes('Please try again')
    f.controls.fail = ''
    await press('Add photo')
    expect(text()).includes('Profile picture saved')
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
})
