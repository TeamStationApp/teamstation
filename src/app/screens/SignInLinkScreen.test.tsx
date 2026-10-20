import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Session, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import { SignInLinkScreen } from './SignInLinkScreen'

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const session: Session = {
  token: 'session-token',
  expiresAt: '2026-11-01T00:00:00.000Z',
  user: {
    id: userIdOfGumbo(1),
    displayName: 'Pat',
    email: 'pat@example.com',
    isAdmin: false,
    avatarUrl: null,
    gumboId: null
  }
}

/** A client whose link sign-in answers each call from the list in turn. */
function clientAnswering(answers: Array<() => Promise<Session>>): {
  client: TeamStationClient
  posts: string[]
} {
  const posts: string[] = []
  const client = {
    signInWithLink: async (token: string) => {
      posts.push(token)
      const answer = answers[Math.min(posts.length, answers.length) - 1]
      return await answer()
    }
  } as unknown as TeamStationClient
  return { client, posts }
}

/** A promise the test settles when it chooses. */
function held(): {
  answer: () => Promise<Session>
  resolve: (session: Session) => void
} {
  let resolve: (session: Session) => void = () => undefined
  const promise = new Promise<Session>(_resolve => {
    resolve = _resolve
  })
  return { answer: async () => await promise, resolve }
}

async function show(
  client: TeamStationClient,
  token: string,
  calls: { signedIn: Session[]; again: boolean[] },
  onSignedIn = (signed: Session): void => {
    calls.signedIn.push(signed)
  }
): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <SignInLinkScreen
          client={client}
          token={token}
          onSignedIn={onSignedIn}
          onSignInAgain={linkSpent => {
            calls.again.push(linkSpent)
          }}
        />
      </ThemeProvider>
    )
    await delay(10)
  })
}

async function hide(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
}

function text(): string {
  return document.body.textContent ?? ''
}

function button(words: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].filter(node => (node.textContent ?? '').endsWith(words))
  expect(found, words).has.lengthOf(1)
  return found[0]
}

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await delay(10)
  })
}

describe('the sign-in link screen', function () {
  afterEach(async function () {
    await hide()
    document.body.innerHTML = ''
  })

  it('signs in as soon as it opens, without a tap', async function () {
    const { client, posts } = clientAnswering([async () => session])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-straight-in', calls)
    expect(posts).deep.equals(['tok-straight-in'])
    expect(calls.signedIn).deep.equals([session])
    expect(text()).not.includes('no longer good')
    expect(text()).not.includes('Couldn’t sign you in')
  })

  it('keeps the sign-in form one tap away while it waits', async function () {
    const pending = held()
    const { client } = clientAnswering([pending.answer])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-hanging', calls)
    expect(text()).includes('Signing you in…')
    await press(button('Sign in another way'))
    // Not spent yet, so the link stays behind the form in the history.
    expect(calls.again).deep.equals([false])
  })

  it('hands the session to the screen that asked last', async function () {
    const pending = held()
    const { client, posts } = clientAnswering([pending.answer])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    const later: Session[] = []
    await show(client, 'tok-handed-on', calls)
    await hide()
    await show(client, 'tok-handed-on', calls, signed => {
      later.push(signed)
    })
    await act(async () => {
      pending.resolve(session)
      await delay(10)
    })
    expect(posts).deep.equals(['tok-handed-on'])
    expect(calls.signedIn).deep.equals([])
    expect(later).deep.equals([session])
  })

  it('asks once while a request is out, however often its screen is drawn', async function () {
    const pending = held()
    const { client, posts } = clientAnswering([pending.answer])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-redrawn', calls)
    await hide()
    await show(client, 'tok-redrawn', calls)
    await act(async () => {
      pending.resolve(session)
      await delay(10)
    })
    expect(posts).deep.equals(['tok-redrawn'])
    expect(calls.signedIn).deep.equals([session])
  })

  it('keeps no session once it has signed in', async function () {
    const { client, posts } = clientAnswering([
      async () => session,
      async () => {
        throw new HttpError('unauthorized', 'That link is no longer good')
      }
    ])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-signed-out-later', calls)
    await hide()
    // Signed out since: the same link must ask, and be refused, rather than
    // hand back the session it got the first time.
    await show(client, 'tok-signed-out-later', calls)
    expect(posts).has.lengthOf(2)
    expect(calls.signedIn).deep.equals([session])
    expect(text()).includes('This sign-in link is no longer good')
  })

  it('sends a refused link to the sign-in form, and never asks again', async function () {
    const { client, posts } = clientAnswering([
      async () => {
        throw new HttpError('unauthorized', 'That link is no longer good')
      }
    ])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-refused', calls)
    expect(text()).includes('This sign-in link is no longer good')
    expect(text()).not.includes('Try again')
    await press(button('Sign in'))
    expect(calls.again).deep.equals([true])
    await hide()
    await show(client, 'tok-refused', calls)
    expect(posts).deep.equals(['tok-refused'])
    expect(text()).includes('This sign-in link is no longer good')
  })

  it('offers to try again when the link was never looked at', async function () {
    const { client, posts } = clientAnswering([
      async () => {
        throw new TypeError('Failed to fetch')
      },
      async () => session
    ])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-offline', calls)
    expect(text()).includes('Couldn’t sign you in')
    expect(text()).includes('Failed to fetch')
    expect(text()).not.includes('no longer good')
    await press(button('Try again'))
    expect(posts).deep.equals(['tok-offline', 'tok-offline'])
    expect(calls.signedIn).deep.equals([session])
    expect(calls.again).deep.equals([])
  })

  it('always offers the sign-in form, so a failure is never a dead end', async function () {
    const { client } = clientAnswering([
      async () => {
        throw new HttpError('rateLimited', 'Too many tries')
      }
    ])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-dead-end', calls)
    expect(text()).includes('Too many tries')
    // Asking again at once cannot beat a rate limit, so it is not offered.
    expect(text()).not.includes('Try again')
    await press(button('Sign in another way'))
    expect(calls.again).deep.equals([false])
  })

  it('asks nobody again when it is drawn with a new handler', async function () {
    const pending = held()
    const { client, posts } = clientAnswering([pending.answer])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    const newer: Session[] = []
    await show(client, 'tok-new-handler', calls)
    await show(client, 'tok-new-handler', calls, signed => {
      newer.push(signed)
    })
    await act(async () => {
      pending.resolve(session)
      await delay(10)
    })
    expect(posts).deep.equals(['tok-new-handler'])
    expect(calls.signedIn).deep.equals([])
    expect(newer).deep.equals([session])
  })

  it('signs nobody in behind the back of a person who has moved on', async function () {
    const pending = held()
    const { client } = clientAnswering([
      async () => {
        throw new TypeError('Failed to fetch')
      },
      pending.answer
    ])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-walked-away', calls)
    await press(button('Try again'))
    await hide()
    await act(async () => {
      pending.resolve(session)
      await delay(10)
    })
    // They may have signed in as somebody else since, or signed out.
    expect(calls.signedIn).deep.equals([])
  })

  it('says so when the app cannot take the session it was given', async function () {
    const { client } = clientAnswering([async () => session])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-not-taken', calls, () => {
      throw new Error('Could not save the sign-in')
    })
    expect(text()).includes('Could not save the sign-in')
    expect(text()).not.includes('Try again')
  })

  it('tries the link afresh when it is opened again after a failure', async function () {
    const { client, posts } = clientAnswering([
      async () => {
        throw new HttpError('rateLimited', 'Too many tries')
      },
      async () => session
    ])
    const calls = { signedIn: [] as Session[], again: [] as boolean[] }
    await show(client, 'tok-limited', calls)
    expect(text()).includes('Too many tries')
    await hide()
    await show(client, 'tok-limited', calls)
    expect(posts).has.lengthOf(2)
    expect(calls.signedIn).deep.equals([session])
  })
})
