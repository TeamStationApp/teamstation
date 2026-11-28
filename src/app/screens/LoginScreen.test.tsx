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
function client(): { client: TeamStationClient; codesSent: string[] } {
  const codesSent: string[] = []
  const value = new TeamStationClient({ baseUrl: '/api/v1' })
  value.requestEmailCode = async email => {
    codesSent.push(email)
    return { requestId: 'synthetic-request', clientSecret: 'synthetic-secret' }
  }
  // The code screen polls for a sign-in approved elsewhere; none is.
  value.claimSignIn = async () => undefined
  return { client: value, codesSent }
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
})
