import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import type { AccountSettings } from '../../common/accountSettings'
import { TeamStationClient } from '../../common/api'
import {
  testPasswordCosts,
  testPasswordParameters
} from '../../test/passwordFixtures'
import { App } from '../App'
import { parseRoute } from '../navigation/routes'
import { showRoute } from '../navigation/useAddressBar'
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
      id: 101,
      displayName: 'Babe Ruth',
      email: 'alex@example.com',
      isAdmin: node,
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
})
