import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Session, TeamStationClient } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { linkIsOurs, SignInLinkScreen } from './SignInLinkScreen'

const OWN = 'https://app.example.test'
const SITE = 'https://web.example.test'

const session: Session = {
  token: 'session-token',
  expiresAt: '2026-11-01T00:00:00.000Z',
  user: {
    id: 1,
    displayName: 'Pat',
    email: 'pat@example.com',
    isAdmin: false,
    avatarUrl: null
  }
}

/** A client on `OWN` whose server reports `issuer`, recording what it spends. */
function clientWith(issuer: string | null | undefined): {
  client: TeamStationClient
  spent: string[]
  asked: number[]
} {
  const spent: string[] = []
  const asked: number[] = []
  const client = {
    serverOrigin: () => OWN,
    issuer: async () => {
      asked.push(1)
      return issuer
    },
    signInWithLink: async (token: string, deviceName?: string) => {
      spent.push(deviceName == null ? token : `${token} as ${deviceName}`)
      return session
    }
  } as unknown as TeamStationClient
  return { client, spent, asked }
}

let root: Root | undefined

async function show(
  client: TeamStationClient,
  token: string,
  server: string | undefined,
  signedIn: Session[],
  deviceName?: string
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <SignInLinkScreen
          client={client}
          token={token}
          server={server}
          deviceName={deviceName}
          onSignedIn={signed => {
            signedIn.push(signed)
          }}
          onSignInAgain={() => undefined}
        />
      </ThemeProvider>
    )
    await new Promise(resolve => setTimeout(resolve, 10))
  })
}

describe('a sign-in link that names its server', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.innerHTML = ''
  })

  it('is ours with no server, or our own origin, without asking the server', async function () {
    const { client, asked } = clientWith(undefined)
    expect(await linkIsOurs(client, undefined)).equals(true)
    expect(await linkIsOurs(client, OWN)).equals(true)
    expect(asked).deep.equals([])
  })

  it('is ours when another name is our server’s issuer', async function () {
    expect(await linkIsOurs(clientWith(`${SITE}/oauth`).client, SITE)).equals(
      true
    )
    expect(
      await linkIsOurs(
        clientWith('https://seat.example.test/oauth').client,
        SITE
      )
    ).equals(false)
    expect(await linkIsOurs(clientWith(undefined).client, SITE)).equals(
      undefined
    )
    // A server that answers with no issuer (OAuth off) vouches for no other name.
    expect(await linkIsOurs(clientWith(null).client, SITE)).equals(false)
  })

  it('spends a link our server issued under its other name', async function () {
    const { client, spent } = clientWith(`${SITE}/oauth`)
    const signedIn: Session[] = []
    await show(client, 'tok-site', SITE, signedIn)
    expect(spent).deep.equals(['tok-site'])
    expect(signedIn).deep.equals([session])
  })

  it('calls a link another server’s when its server answers with no issuer', async function () {
    const { client, spent } = clientWith(null)
    await show(client, 'tok-seat', 'https://other.example.test', [])
    expect(spent).deep.equals([])
    expect(document.body.textContent ?? '').includes(
      'This link is for another server'
    )
  })

  it('says it could not check a link its server cannot be asked about', async function () {
    const { client, spent } = clientWith(undefined)
    await show(client, 'tok-offline', SITE, [])
    expect(spent).deep.equals([])
    const text = document.body.textContent ?? ''
    expect(text).includes(
      `Couldn’t reach ${OWN} to check this link. Try again.`
    )
    expect(text).not.includes('This link is for another server')
  })

  it('asks again when the same link is opened after a refusal', async function () {
    const { client, spent, asked } = clientWith(
      'https://seat.example.test/oauth'
    )
    const signedIn: Session[] = []
    await show(client, 'tok-retry', SITE, signedIn)
    expect(spent).deep.equals([])
    await act(async () => {
      root?.unmount()
    })
    await show(client, 'tok-retry', SITE, signedIn)
    expect(asked.length).equals(2)
    expect(spent).deep.equals([])
  })

  it('keeps an installed app’s link session under its name', async function () {
    const { client, spent } = clientWith(undefined)
    const signedIn: Session[] = []
    await show(client, 'tok-own', OWN, signedIn, 'TeamStation for iOS')
    expect(spent).deep.equals(['tok-own as TeamStation for iOS'])
    expect(signedIn).deep.equals([session])
  })

  it('says whose link it is, and never sends the token, for another server', async function () {
    const { client, spent } = clientWith(`${SITE}/oauth`)
    const signedIn: Session[] = []
    await show(client, 'tok-elsewhere', 'https://seat.example.test', signedIn)
    expect(spent).deep.equals([])
    expect(signedIn).deep.equals([])
    const text = document.body.textContent ?? ''
    expect(text).includes('This link is for another server')
    expect(text).includes(
      'This link is for https://seat.example.test. This app signs in to https://app.example.test.'
    )
  })
})
