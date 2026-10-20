import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Linking, NativeModules, Platform } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { App } from '../App'
import { AppHeader } from '../components/AppHeader'
import { BuildInfoModal } from '../components/BuildInfoModal'
import * as nativeExternal from '../platform/externalBrowser.native'
import { ThemeProvider } from '../theme/ThemeContext'
import { OAuthScreen } from './OAuthScreen'

function urlText(value: RequestInfo | URL): string {
  return typeof value === 'string'
    ? value
    : value instanceof URL
      ? value.href
      : value.url
}
let root: Root | undefined
let host: HTMLDivElement | undefined
const originalFetch = globalThis.fetch
const originalOpen = window.open.bind(window)
async function show(component: React.ReactNode): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{component}</ThemeProvider>)
    await delay()
  })
}
const delay = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 10))
}
async function press(label: string): Promise<void> {
  const button = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    el => el.getAttribute('aria-label') === label || el.textContent === label
  )
  expect(button, label).not.equals(undefined)
  await act(async () => {
    button!.click()
    await delay()
  })
}
const client = {} as unknown as TeamStationClient
describe('OAuth consent and loaded build information', () => {
  it('restores the approval address after an email sign-in completes', async () => {
    window.history.replaceState(
      null,
      '',
      '/sign-in?next=%2Foauth%2Fapprove%2Frequest'
    )
    const originalInterval = globalThis.setInterval
    let poll: (() => void) | undefined
    globalThis.setInterval = ((
      callback: (...args: unknown[]) => void,
      ms?: number
    ) => {
      if (ms === 3000) poll = callback
      return originalInterval(callback, ms)
    }) as typeof setInterval
    const session = {
      token: 'fixture-session',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      user: {
        id: userIdOfGumbo(123),
        displayName: 'Alex Liddi',
        isAdmin: false,
        avatarUrl: null
      }
    }
    globalThis.fetch = async input => {
      const url = urlText(input)
      if (url.endsWith('/auth/me')) return new Response('{}', { status: 401 })
      if (url.endsWith('/auth/email-code'))
        return new Response(
          '{"requestId":"fixture","clientSecret":"fixture-secret"}'
        )
      if (url.endsWith('/auth/request/claim'))
        return new Response(JSON.stringify(session))
      if (url.endsWith('/details'))
        return new Response(
          '{"clientName":"Example builds","scopes":[],"csrfToken":"proof"}'
        )
      return new Response('{"teams":{}}')
    }
    try {
      await show(<App />)
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="E-mail address"]'
      )!
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(input, 'alex@example.test')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
        await delay()
      })
      await press('Send me a sign-in code')
      expect(poll).not.equals(undefined)
      await act(async () => {
        poll!()
        await delay()
      })
      expect(window.location.pathname).equals('/oauth/approve/request')
      expect(document.body.textContent).includes('Example builds')
    } finally {
      globalThis.setInterval = originalInterval
    }
  })
  it('uses Android browser routing rather than an app-linked URL intent', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    const before = NativeModules.TSExternalBrowser
    const seen: string[] = []
    try {
      Object.defineProperty(Platform, 'OS', {
        value: 'android',
        configurable: true
      })
      NativeModules.TSExternalBrowser = {
        open: async (url: string) => {
          seen.push(url)
        }
      }
      await nativeExternal.openExternal(
        'https://app.example.test/oauth/approve/request'
      )
      expect(seen).deep.equals([
        'https://app.example.test/oauth/approve/request'
      ])
      delete NativeModules.TSExternalBrowser
      try {
        await nativeExternal.openExternal('https://app.example.test/')
        throw new Error('unexpected success')
      } catch (error) {
        expect((error as Error).message).includes('not available')
      }
    } finally {
      Object.defineProperty(Platform, 'OS', descriptor)
      NativeModules.TSExternalBrowser = before
    }
  })
  it('resumes a completed native decision when the original browser mounts again', async () => {
    window.history.replaceState(null, '', '/oauth/approve/request')
    const seen: string[] = []
    globalThis.fetch = async input => {
      const url = urlText(input)
      seen.push(url)
      return new Response(
        url.endsWith('/details')
          ? '{"clientName":"Example","scopes":[],"csrfToken":"proof","decision":"approved"}'
          : '{"redirectTo":"/oauth/approve/request"}'
      )
    }
    await show(
      <OAuthScreen client={client} uid="request" onLogin={() => undefined} />
    )
    expect(seen).deep.equals([
      '/oauth/approve/request/details',
      '/oauth/approve/request/resume'
    ])
  })
  it('keeps OAuth navigation in the actual app shell across session restoration', async () => {
    let signedIn = true
    globalThis.fetch = async input => {
      const url = urlText(input)
      if (url.endsWith('/auth/me'))
        return new Response(
          JSON.stringify({
            id: userIdOfGumbo(123),
            displayName: 'Alex Liddi',
            email: 'alex@example.test',
            isAdmin: false,
            avatarUrl: null
          }),
          { status: signedIn ? 200 : 401 }
        )
      if (url.endsWith('/details') || url.includes('/oauth/approvals/'))
        return new Response(
          '{"clientName":"Example builds","scopes":["openid"],"csrfToken":"proof"}'
        )
      return new Response('{"teams":{}}')
    }
    window.history.replaceState(null, '', '/oauth/approve/request')
    await show(<App key="signed" />)
    expect(window.location.pathname).equals('/oauth/approve/request')
    expect(document.body.textContent).includes('Signed in as Alex Liddi')
    signedIn = false
    await show(<App key="unsigned" />)
    await press('Sign in to continue')
    expect(window.location.pathname).equals('/sign-in')
    expect(new URLSearchParams(window.location.search).get('next')).equals(
      '/oauth/approve/request'
    )
    signedIn = true
    window.history.replaceState(
      null,
      '',
      `/oauth/native-approval/${'a'.repeat(43)}`
    )
    await show(<App key="native" />)
    expect(document.body.textContent).includes('Example builds')
  })
  it('signs out to choose a different account while preserving the approval request', async () => {
    const seen: string[] = []
    globalThis.fetch = async input => {
      const url = urlText(input)
      seen.push(url)
      if (url.endsWith('/auth/me'))
        return Response.json({
          id: userIdOfGumbo(123),
          displayName: 'Alex Liddi',
          email: 'alex@example.test',
          isAdmin: false,
          avatarUrl: null
        })
      if (url.endsWith('/details'))
        return Response.json({
          clientName: 'Example builds',
          scopes: ['openid'],
          csrfToken: 'proof'
        })
      return Response.json({ teams: {} })
    }
    window.history.replaceState(null, '', '/oauth/approve/request')
    await show(<App />)
    await press('Use a different account')
    expect(seen.some(url => url.endsWith('/auth/logout'))).equals(true)
    expect(window.location.pathname).equals('/sign-in')
    expect(new URLSearchParams(window.location.search).get('next')).equals(
      '/oauth/approve/request'
    )
    expect(document.body.textContent).includes('Send me a sign-in code')
  })
  it('shows account switching failures without completing authorization', async () => {
    globalThis.fetch = async () =>
      Response.json({ clientName: 'Example', scopes: [], csrfToken: 'proof' })
    await show(
      <OAuthScreen
        client={client}
        uid="switch"
        accountName="Alex"
        onLogin={() => undefined}
        onSwitchAccount={async () => {
          throw new Error('offline')
        }}
      />
    )
    await press('Use a different account')
    expect(document.body.textContent).includes('expired')
  })
  it('can leave native consent from pending, approved, denied and expired states on iOS', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    try {
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: 'ios'
      })
      for (const state of ['pending', 'approved', 'denied', 'expired']) {
        globalThis.fetch = async input => {
          const url = urlText(input)
          if (url.endsWith('/auth/me'))
            return new Response(
              JSON.stringify({
                id: userIdOfGumbo(123),
                displayName: 'Alex Liddi',
                email: 'alex@example.test',
                isAdmin: false,
                avatarUrl: null
              })
            )
          if (url.includes('/oauth/approvals/'))
            return new Response(
              '{"clientName":"Example builds","scopes":["openid"]}',
              { status: state === 'expired' ? 400 : 200 }
            )
          return new Response(url.endsWith('/me/roles') ? '{"teams":{}}' : '[]')
        }
        window.history.replaceState(
          null,
          '',
          `/oauth/native-approval/${'a'.repeat(43)}`
        )
        await show(<App key={state} />)
        if (state === 'approved') await press('Allow')
        if (state === 'denied') await press('Deny')
        if (state === 'expired')
          expect(document.body.textContent).includes('expired')
        await press('Back')
        expect(window.location.pathname).equals('/')
        expect(document.body.textContent).not.includes('Authorize access')
      }
    } finally {
      Object.defineProperty(Platform, 'OS', descriptor)
    }
  })
  it('opens native external links using the platform browser', async () => {
    const original = Linking.openURL.bind(Linking)
    const seen: string[] = []
    Linking.openURL = async url => {
      seen.push(url)
    }
    try {
      expect(nativeExternal.nativeBrowser).equals(true)
      await nativeExternal.openExternal('https://example.test')
      await nativeExternal.resumeBrowser('https://example.test/return')
      expect(seen).deep.equals([
        'https://example.test',
        'https://example.test/return'
      ])
    } finally {
      Linking.openURL = original
    }
  })
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
      await delay()
    })
    root = undefined
    host?.remove()
    host = undefined
    globalThis.fetch = originalFetch
    window.open = originalOpen
  })
  it('shows signed-out consent, scopes and a login action', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          clientName: 'Example Builds',
          scopes: ['openid', 'email', 'profile'],
          csrfToken: 'proof',
          signedIn: false
        })
      )
    let logins = 0
    await show(
      <OAuthScreen
        client={client}
        uid="request"
        onLogin={() => {
          logins++
        }}
      />
    )
    expect(document.body.textContent).includes('Example Builds')
    expect(document.body.textContent).includes('verification status')
    await press('Sign in to continue')
    expect(logins).equals(1)
    expect(document.body.textContent).not.includes('Signed in as')
  })
  it('approves in the browser and reports a rejected decision', async () => {
    window.history.replaceState(null, '', '/oauth/approve/request')
    let reject = false
    globalThis.fetch = async url =>
      urlText(url).endsWith('/details')
        ? new Response(
            '{"clientName":"Example","scopes":[],"csrfToken":"proof"}'
          )
        : new Response(
            JSON.stringify({ redirectTo: '/oauth/approve/request' }),
            { status: reject ? 400 : 200 }
          )
    await show(
      <OAuthScreen
        client={client}
        uid="request"
        accountName="Alex"
        onLogin={() => undefined}
      />
    )
    await press('Allow')
    expect(document.body.textContent).not.includes('expired')
    reject = true
    await press('Deny')
    expect(document.body.textContent).includes('expired')
  })
  it('polls native decisions, resumes the browser and stops on failure or expiry', async () => {
    const originalInterval = globalThis.setInterval
    const originalNow = Date.now
    let poll: (() => void) | undefined
    globalThis.setInterval = ((
      callback: (...args: unknown[]) => void,
      ms?: number
    ) => {
      if (ms === 3000) poll = callback
      return originalInterval(callback, ms)
    }) as typeof setInterval
    window.open = () => null
    window.history.replaceState(null, '', '/oauth/approve/request')
    try {
      for (const outcome of ['success', 'error', 'expired']) {
        let pending = true
        globalThis.fetch = async url => {
          const request = urlText(url)
          const data = request.endsWith('/details')
            ? { clientName: 'Example', scopes: [], csrfToken: 'proof' }
            : request.endsWith('/native')
              ? {
                  appUrl: `teamstation:///oauth/native-approval/${'a'.repeat(43)}`
                }
              : pending
                ? { pending: true }
                : { redirectTo: '/oauth/approve/request' }
          return new Response(JSON.stringify(data), {
            status:
              request.endsWith('/resume') && !pending && outcome === 'error'
                ? 400
                : 200
          })
        }
        await show(
          <OAuthScreen
            key={outcome}
            client={client}
            uid="request"
            onLogin={() => undefined}
          />
        )
        await press('Approve in the TeamStation app')
        await press('Open TeamStation')
        expect(document.body.textContent).includes('Waiting for your decision')
        await act(async () => {
          poll?.()
          poll?.()
          await delay()
        })
        pending = false
        if (outcome === 'expired') Date.now = () => originalNow() + 300001
        await act(async () => {
          poll?.()
          await delay()
        })
        Date.now = originalNow
        expect(document.body.textContent?.includes('expired')).equals(
          outcome !== 'success'
        )
      }
    } finally {
      globalThis.setInterval = originalInterval
      Date.now = originalNow
    }
  })
  it('reports an unavailable app handoff and an external browser failure', async () => {
    globalThis.fetch = async url =>
      new Response(
        urlText(url).endsWith('/details')
          ? '{"clientName":"Example","scopes":[]}'
          : '{}',
        { status: urlText(url).endsWith('/details') ? 200 : 400 }
      )
    await show(
      <OAuthScreen client={client} uid="request" onLogin={() => undefined} />
    )
    await press('Approve in the TeamStation app')
    expect(document.body.textContent).includes('expired')
    window.open = () => {
      throw new Error('unavailable')
    }
    const configured = {
      buildsLink: async () => 'https://builds.example.test'
    } as unknown as TeamStationClient
    await show(<BuildInfoModal client={configured} onClose={() => undefined} />)
    await press('Download builds')
    expect(document.body.textContent).includes('Could not open')
  })
  it('requires explicit native approval and allows returning to the original browser', async () => {
    const decisions: boolean[] = []
    const opened: string[] = []
    window.open = (url): Window | null => {
      opened.push(String(url))
      return null
    }
    const nativeClient = {
      baseUrl: 'https://app.example.test/api/v1',
      oauthApproval: async () => ({
        clientName: 'Example Builds',
        scopes: ['openid'],
        resumeUrl: 'https://app.example.test/oauth/approve/request'
      }),
      decideOAuth: async (_handle: string, approve: boolean) => {
        decisions.push(approve)
      }
    } as unknown as TeamStationClient
    await show(
      <OAuthScreen
        client={nativeClient}
        handle="handle"
        accountName="Alex Liddi"
        onLogin={() => undefined}
      />
    )
    expect(decisions).deep.equals([])
    expect(document.body.textContent).includes('Signed in as Alex Liddi')
    await press('Allow')
    expect(decisions).deep.equals([true])
    expect(document.body.textContent).includes('Your decision was saved')
    await press('Return to browser')
    expect(opened).deep.equals([
      'https://app.example.test/oauth/approve/request'
    ])
  })
  it('supports denial, rejects unsafe resumes and displays failed requests', async () => {
    const decisions: boolean[] = []
    const nativeClient = {
      baseUrl: 'https://app.example.test/api/v1',
      oauthApproval: async () => ({
        clientName: 'Example',
        scopes: [],
        resumeUrl: 'https://evil.example.test/oauth/approve/request'
      }),
      decideOAuth: async (_handle: string, approve: boolean) => {
        decisions.push(approve)
      }
    } as unknown as TeamStationClient
    await show(
      <OAuthScreen
        client={nativeClient}
        handle="one"
        accountName="Alex"
        onLogin={() => undefined}
      />
    )
    await press('Deny')
    expect(decisions).deep.equals([false])
    await press('Return to browser')
    expect(document.body.textContent).includes('expired')
    globalThis.fetch = async () => new Response('{}', { status: 400 })
    await show(
      <OAuthScreen client={client} uid="two" onLogin={() => undefined} />
    )
    expect(document.body.textContent).includes('expired')
  })
  it('keeps a native request on the login screen until a human signs in', async () => {
    let login = false
    await show(
      <OAuthScreen
        client={client}
        handle="handle"
        onLogin={() => {
          login = true
        }}
      />
    )
    await press('Sign in to continue')
    expect(login).equals(true)
  })
  it('shows the active server origin on web and mobile without credentials', async () => {
    const originalOs = Platform.OS
    try {
      for (const os of ['web', 'ios', 'android'] as const) {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: os })
        await show(
          <AppHeader
            showMark
            apiBaseUrl="https://fixture:placeholder@preview.example.test:8443/api/v1"
          />
        )
        await press('About TeamStation')
        expect(document.body.textContent).includes('App server URL')
        expect(document.body.textContent).includes(
          'https://preview.example.test:8443'
        )
        expect(document.body.textContent).not.includes('placeholder')
        expect(document.body.textContent).not.includes('/api/v1')
        await press('Close')
      }
    } finally {
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalOs
      })
    }
  })
  it('sanitizes the authority returned by React Native URL parsing', async () => {
    const OriginalUrl = globalThis.URL
    try {
      for (const origin of [
        'https://fixture:placeholder@preview.example.test:8443',
        ''
      ]) {
        globalThis.URL = class extends OriginalUrl {
          get origin(): string {
            return origin
          }
        }
        await show(
          <BuildInfoModal
            apiBaseUrl="https://preview.example.test/api/v1"
            onClose={() => undefined}
          />
        )
        expect(document.body.textContent).includes(
          origin === ''
            ? 'App server URL—'
            : 'https://preview.example.test:8443'
        )
        expect(document.body.textContent).not.includes('placeholder')
      }
    } finally {
      globalThis.URL = OriginalUrl
    }
  })
  it('resolves relative web APIs and handles unavailable server addresses', async () => {
    for (const base of ['/api/v1', undefined]) {
      await show(<BuildInfoModal apiBaseUrl={base} onClose={() => undefined} />)
      expect(document.body.textContent).includes(window.location.origin)
    }
    for (const base of ['https://[invalid', 'data:text/plain,fixture']) {
      await show(<BuildInfoModal apiBaseUrl={base} onClose={() => undefined} />)
      expect(document.body.textContent).includes('App server URL—')
    }
  })
  it('shows embedded metadata and hides the link when absent or unavailable', async () => {
    const info = {
      app: 'Example',
      version: '1.2.3',
      buildNumber: '25',
      branch: 'feature/camera',
      commit: 'abc123',
      builtAt: '2026-01-02T03:04:05Z'
    }
    let closed = false
    await show(
      <BuildInfoModal
        info={info}
        onClose={() => {
          closed = true
        }}
      />
    )
    expect(document.body.textContent).includes('feature/camera')
    expect(document.body.textContent).includes('abc123')
    expect(document.body.textContent).not.includes('Download builds')
    await press('Close')
    expect(closed).equals(true)
    const unavailable = {
      buildsLink: async () => {
        throw new Error('offline')
      }
    } as unknown as TeamStationClient
    await show(
      <BuildInfoModal client={unavailable} onClose={() => undefined} />
    )
    expect(document.body.textContent).not.includes('Download builds')
  })
  it('opens the configured build service and keeps the header mounted', async () => {
    const opened: string[] = []
    window.open = (url): Window | null => {
      opened.push(String(url))
      return null
    }
    const configured = {
      buildsLink: async () => 'https://builds.example.test'
    } as unknown as TeamStationClient
    await show(
      <AppHeader showMark title="Your Home" buildsClient={configured} />
    )
    await press('About TeamStation')
    await press('Download builds')
    expect(opened).deep.equals(['https://builds.example.test'])
    await press('Close')
    expect(document.body.textContent).includes('Your Home')
    expect(document.body.textContent).not.includes('Download builds')
  })
})
