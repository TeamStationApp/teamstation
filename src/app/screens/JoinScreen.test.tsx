import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  mount as mountInvalid,
  text as textInvalid,
  unmount as unmountInvalid
} from '../../test/gameFormDom'

import type { InviteInfo, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { ThemeProvider } from '../theme/ThemeContext'
import { joinError, JoinScreen } from './JoinScreen'

/**
 * The screen an invite link opens: what it is for, one button for somebody
 * signed in, an address and a code for somebody who is not, and a plain
 * reason when an invitation was made out to another address.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function labelled(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(found, label).not.equals(null)
  return found!
}

function button(words: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(node => node.textContent === words)
  expect(found, words).not.equals(undefined)
  return found!
}

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await delay(10)
  })
}

async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(labelled(label), value)
    labelled(label).dispatchEvent(new window.Event('input', { bubbles: true }))
    await delay(10)
  })
}

const text = (): string => document.body.textContent ?? ''

const hawks: InviteInfo = {
  code: 'abc',
  valid: true,
  problem: null,
  scope: { kind: 'team', id: 'tem_1', name: 'Hawks' },
  signedIn: true,
  alreadyIn: false
}

async function mount(
  info: InviteInfo | Error,
  redeem: () => Promise<unknown>,
  signedIn = true
): Promise<{ opened: string[]; sessions: number }> {
  const seen = { opened: [] as string[], sessions: 0 }
  const client = {
    inviteInfo: async () => {
      if (info instanceof Error) throw info
      return info
    },
    redeemInvite: redeem,
    requestInviteCode: async () => ({ requestId: 'req_1', clientSecret: 's' }),
    claimSignIn: async () => undefined,
    signInWithCode: async (_email: string, code: string) => {
      if (code !== '123456') throw new Error('That code is not right')
      return { token: 't' }
    }
  } as unknown as TeamStationClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <JoinScreen
          client={client}
          code="abc"
          signedIn={signedIn}
          onSignedIn={() => {
            seen.sessions += 1
          }}
          onOpen={scope => {
            seen.opened.push(scope.id)
          }}
        />
      </ThemeProvider>
    )
    await delay(10)
  })
  return seen
}

describe('the invitation screen', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('accepts for somebody signed in, and opens what they joined', async function () {
    const seen = await mount(hawks, async () => ({
      granted: true,
      scope: hawks.scope
    }))
    expect(text()).includes('You are invited to watch Hawks')
    await press(button('Accept the invitation'))
    expect(text()).includes('You are in. Hawks is on your home screen.')
    await press(button('Have a look'))
    expect(seen.opened).deep.equals(['tem_1'])
  })

  it('says an invitation made out to another address is not theirs', async function () {
    await mount(hawks, async () => {
      throw new HttpError('forbidden', 'This invitation was sent elsewhere', {
        reason: 'inviteForAnotherEmail'
      })
    })
    await press(button('Accept the invitation'))
    expect(text()).includes(
      'This invitation was sent to another e-mail address. Sign in with that address to accept it.'
    )
    expect(text()).not.includes('You are in.')
  })

  it('shows any other refusal in the server’s words', function () {
    expect(
      joinError(new HttpError('badRequest', 'That invite is expired'))
    ).equals('That invite is expired')
    expect(joinError(new Error('offline'))).equals('offline')
    expect(joinError('what')).equals('Something went wrong')
  })

  it('asks somebody signed out for an address and the code, then lets them in', async function () {
    const seen = await mount(
      { ...hawks, signedIn: false },
      async () => undefined,
      false
    )
    await type('Your name', 'Ava Aunt')
    await type('E-mail address', 'aunt@example.com')
    await press(button('Send me a sign-in code'))
    expect(text()).includes('A six-digit code is on its way.')
    await type('Sign-in code', '000000')
    await press(button('Join'))
    expect(text()).includes('That code is not right')
    await type('Sign-in code', '123456')
    await press(button('Join'))
    expect(seen.sessions).equals(1)
    expect(text()).includes('You are in.')
  })

  it('says when they are already in, when the link is dead, and when it is unknown', async function () {
    const seen = await mount(
      { ...hawks, alreadyIn: true },
      async () => undefined
    )
    expect(text()).includes('You can already watch Hawks.')
    await press(button('Have a look'))
    expect(seen.opened).deep.equals(['tem_1'])
    await act(async () => {
      root?.unmount()
    })

    await mount(
      { ...hawks, valid: false, problem: 'revoked' },
      async () => undefined
    )
    expect(text()).includes('Invalid invite link')
    await act(async () => {
      root?.unmount()
    })

    await mount(new Error('Not found'), async () => undefined)
    expect(text()).includes('Invalid invite link')
  })
})

describe('invalid invitation language', () => {
  afterEach(unmountInvalid)
  for (const missing of [true, false])
    it(`uses Invalid invite link for ${missing ? 'unknown' : 'expired'} invitations`, async () => {
      const client = {
        inviteInfo: async () => {
          if (missing) throw new Error('Not found')
          return {
            valid: false,
            alreadyIn: false,
            scope: { kind: 'team', id: 'tem_demo', name: 'Demo Owls' },
            needsName: false
          }
        }
      } as unknown as TeamStationClient
      await mountInvalid(
        <JoinScreen
          client={client}
          code="placeholder-invite"
          signedIn
          onSignedIn={() => {}}
          onOpen={() => {}}
        />
      )
      expect(textInvalid()).includes('Invalid invite link')
      expect(textInvalid())
        .not.includes('not good')
        .and.not.includes('no longer good')
      if (missing) expect(textInvalid()).includes('expired or been revoked')
    })
})
