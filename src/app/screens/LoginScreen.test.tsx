import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { TeamStationClient } from '../../common/api'
import { fill, mount, press, settle, unmount } from '../../test/gameFormDom'
import { LoginScreen } from './LoginScreen'

const input = (label: string): HTMLInputElement => {
  const node = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )
  expect(node, label).not.equals(null)
  return node!
}

/** A client whose sign-in calls are recorded and never reach a server. */
function client(): {
  client: TeamStationClient
  codesSent: string[]
  passwordSignIns: string[]
} {
  const codesSent: string[] = []
  const passwordSignIns: string[] = []
  const value = new TeamStationClient({ baseUrl: '/api/v1' })
  value.requestEmailCode = async email => {
    codesSent.push(email)
    return { requestId: 'synthetic-request', clientSecret: 'synthetic-secret' }
  }
  // The code screen polls for a sign-in approved elsewhere; none is.
  value.claimSignIn = async () => undefined
  value.signInWithPassword = async email => {
    passwordSignIns.push(email)
    return { user: { id: 'synthetic-user' } } as unknown as Awaited<
      ReturnType<TeamStationClient['signInWithPassword']>
    >
  }
  return { client: value, codesSent, passwordSignIns }
}

afterEach(async () => {
  await unmount()
})

describe('Sign-in screen', () => {
  it('tags the address as the username and the password as the current password', async () => {
    const f = client()
    await mount(<LoginScreen client={f.client} onSignedIn={() => undefined} />)
    const email = input('E-mail address')
    expect(email.getAttribute('autocomplete')).equals('username')
    expect(email.getAttribute('type')).equals('email')
    await press('Use a password instead')
    expect(input('Password').getAttribute('autocomplete')).equals(
      'current-password'
    )
    // The address keeps its tag across the swap.
    expect(input('E-mail address').getAttribute('autocomplete')).equals(
      'username'
    )
  })

  it('keeps the sign-in code field’s one-time-code translation', async () => {
    const f = client()
    await mount(<LoginScreen client={f.client} onSignedIn={() => undefined} />)
    await fill('E-mail address', 'synthetic@example.com')
    await press('Send me a sign-in code')
    await settle(0)
    // A browser has no `one-time-code`; TextField gives it `sms-otp`.
    expect(input('Sign-in code').getAttribute('autocomplete')).equals('sms-otp')
  })

  it('sends the code when Enter is pressed in the address field', async () => {
    const f = client()
    await mount(<LoginScreen client={f.client} onSignedIn={() => undefined} />)
    await fill('E-mail address', ' synthetic@example.com ')
    await act(async () => {
      input('E-mail address').dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true
        })
      )
    })
    await settle(0)
    expect(f.codesSent).deep.equals(['synthetic@example.com'])
    expect(
      document.querySelector('input[aria-label="Sign-in code"]')
    ).not.equals(null)
  })

  it('holds the address and the password in one form on the web', async () => {
    const f = client()
    await mount(<LoginScreen client={f.client} onSignedIn={() => undefined} />)
    await press('Use a password instead')
    const form = document.querySelector('form')
    expect(form, 'form').not.equals(null)
    expect(form!.contains(input('E-mail address'))).equals(true)
    expect(form!.contains(input('Password'))).equals(true)
    expect(form!.noValidate).equals(true)
  })

  it('signs in once on a form submit, and cancels the page load', async () => {
    const f = client()
    const signedIn: unknown[] = []
    await mount(
      <LoginScreen
        client={f.client}
        onSignedIn={session => signedIn.push(session)}
      />
    )
    await press('Use a password instead')
    await fill('E-mail address', ' synthetic@example.com ')
    await fill('Password', 'synthetic-password')
    const submit = new window.Event('submit', {
      bubbles: true,
      cancelable: true
    })
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(submit)
    })
    await settle(0)
    expect(submit.defaultPrevented, 'page load cancelled').equals(true)
    expect(f.passwordSignIns).deep.equals(['synthetic@example.com'])
    expect(signedIn).has.length(1)
  })
})
