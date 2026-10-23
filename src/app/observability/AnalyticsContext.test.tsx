import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asSession, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { AnalyticsClient } from '../../common/observability/analyticsClient'
import type { EventRecord } from '../../common/observability/contract'
import { userIdOfGumbo } from '../../common/userId'
import { fill, press } from '../../test/gameFormDom'
import { NativeVideoHandle } from '../player/nativeVideoHandle'
import { LoginScreen } from '../screens/LoginScreen'
import { OnboardingScreen } from '../screens/OnboardingScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  analyticsError,
  analyticsPage,
  AnalyticsProvider,
  useAnalytics
} from './AnalyticsContext'
import { useVideoAnalytics } from './useVideoAnalytics'

let root: Root, analytics: AnalyticsClient | undefined
let rows: EventRecord[]
const originalFetch = globalThis.fetch
function Probe(): null {
  analytics = useAnalytics()
  return null
}
async function render(
  children?: React.ReactNode,
  endpoint = '/api/analytics/events',
  enabled = true
): Promise<void> {
  await act(async () => {
    root.render(
      <React.StrictMode>
        <ThemeProvider>
          <AnalyticsProvider endpoint={endpoint} enabled={enabled}>
            <Probe />
            {children}
          </AnalyticsProvider>
        </ThemeProvider>
      </React.StrictMode>
    )
  })
}
describe('Analytics app lifecycle and funnel', () => {
  it('attaches a passive viewer, changes angles and excludes hidden playback', async () => {
    const player = new NativeVideoHandle(() => {})
    function Viewer({
      selected,
      source = 'https://media.example.test/video'
    }: {
      selected: boolean
      source?: string | null
    }): null {
      useVideoAnalytics(player, 'vid_example', source, selected)
      return null
    }
    await render(<Viewer selected />)
    analytics!.identify(userIdOfGumbo(123), 'synthetic-token')
    player.handlePlaybackState({ isPlaying: true, isSeeking: false })
    await analytics!.flush()
    expect(rows.map(row => row.E)).includes('video_started')
    await render(<Viewer selected={false} />)
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true
    })
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'))
    })
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    })
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'))
    })
    await render(<Viewer selected />)
    await render(<Viewer selected source={null} />)
    await analytics!.flush()
    expect(rows.map(row => row.E)).includes('video_left')
  })
  it('drops old-player callbacks after an account switch', async () => {
    const player = new NativeVideoHandle(() => {})
    function Viewer(): null {
      useVideoAnalytics(player, 'vid_example', 'fixture-source', true)
      return null
    }
    await render(<Viewer />)
    analytics!.identify(userIdOfGumbo(123), 'synthetic-token')
    player.handlePlaybackState({ isPlaying: true, isSeeking: false })
    await analytics!.flush()
    expect(rows.filter(row => row.E === 'video_started')).length(1)
    rows = []
    analytics!.identify(userIdOfGumbo(124), 'second-synthetic-token')
    player.handleBuffer({ isBuffering: true })
    player.handleEnd()
    await analytics!.flush()
    expect(
      rows.some(row => row.E.startsWith('video_') || row.E === 'watch_progress')
    ).equals(false)
  })
  beforeEach(() => {
    rows = []
    analytics = undefined
    window.localStorage.clear()
    globalThis.fetch = (async (_url, options: RequestInit) => {
      rows.push(...JSON.parse(options.body as string))
      return { status: 202 }
    }) as typeof fetch
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
    globalThis.fetch = originalFetch
    document.body.replaceChildren()
  })
  it('has one session in StrictMode, follows visibility and disposes endpoint owners', async () => {
    await render()
    const first = analytics!
    await first.flush()
    expect(rows.filter(row => row.E === 'session_started')).length(1)
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'))
      window.dispatchEvent(new window.Event('pagehide'))
    })
    await render(undefined, '/second/analytics/events')
    expect(analytics).not.equals(first)
    await render(undefined, '/second/analytics/events', false)
    expect(analytics).equals(undefined)
    for (const name of ['signIn', 'signInLink', 'oauthApprove', 'oauthNative'])
      expect(analyticsPage(name)).equals('login')
    for (const name of ['createGame', 'createGroup'])
      expect(analyticsPage(name)).equals('create')
    expect(analyticsPage('scoreGame')).equals('scoring')
    expect(analyticsPage('scoreOptions')).equals('scoring')
    expect(analyticsPage('streaming')).equals('stream')
    expect(analyticsPage('home')).equals('home')
    for (const [code, expected] of [
      ['offline', 'offline'],
      ['rateLimited', 'rate_limited'],
      ['unauthorized', 'invalid'],
      ['unknown', 'internal']
    ])
      expect(analyticsError({ code })).equals(expected)
    expect(analyticsError(null)).equals('internal')
  })
  it('captures unsuccessful anonymous login without form contents or exception messages', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.requestEmailCode = async () => {
      throw new HttpError('offline', 'private-message-canary')
    }
    await render(
      <LoginScreen
        client={client}
        onSignedIn={() => {
          throw new Error('unexpected success')
        }}
      />
    )
    await fill('E-mail address', 'private-email-canary@example.com')
    await press('Send me a sign-in code')
    await analytics!.flush()
    expect(rows.map(row => row.E)).includes('login_failed')
    expect(rows.find(row => row.E === 'login_failed')!.P.ec).equals('offline')
    expect(JSON.stringify(rows)).not.includes('canary')
    expect(rows.every(row => !('U' in row))).equals(true)
  })
  it('records onboarding outcomes and keeps failure detail private', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.pictures = async () => []
    let failure = true
    client.saveOnboardingName = async () => {
      if (failure) throw new Error('private-name-canary')
      return {
        displayName: 'Demo',
        onboarding: { step: 'photo', completedAt: null }
      }
    }
    client.finishOnboarding = async () => {
      if (failure) throw new Error('private-photo-canary')
    }
    await render(
      <OnboardingScreen
        client={client}
        initialName="Demo"
        initialState={{ step: 'name', completedAt: null }}
        onComplete={async () => {}}
      />
    )
    analytics!.identify('fixture-user', 'synthetic-token')
    await press('Continue')
    failure = false
    await press('Continue')
    failure = true
    await press('Use my initials')
    failure = false
    await press('Use my initials')
    await analytics!.flush()
    expect(rows.filter(row => row.E === 'signup_step_failed')).length(2)
    expect(rows.map(row => row.E)).includes('onboarding_completed')
    expect(JSON.stringify(rows)).not.includes('canary')
  })
  it('attributes code, password and claimed-link success to the authenticated identity', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const session = asSession({
      token: 'synthetic-token',
      expiresAt: '2099-01-01',
      user: { id: userIdOfGumbo(123), displayName: 'Demo', isAdmin: false }
    })
    const accepted = async (): Promise<typeof session> => {
      client.token = session.token
      return session
    }
    client.requestEmailCode = async () => ({
      requestId: 'synthetic-request',
      clientSecret: 'synthetic-secret'
    })
    client.signInWithCode = accepted
    client.signInWithPassword = accepted
    client.claimSignIn = accepted
    let signedIn = 0
    const onSignedIn = (): void => {
      signedIn++
    }
    await render(
      <LoginScreen key="code" client={client} onSignedIn={onSignedIn} />
    )
    await fill('E-mail address', 'synthetic@example.com')
    await press('Send me a sign-in code')
    await fill('Sign-in code', '000000')
    await press('Sign in')
    await analytics!.flush()
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 3100))
    })
    await analytics!.flush()
    await render(
      <LoginScreen key="password" client={client} onSignedIn={onSignedIn} />
    )
    await fill('E-mail address', 'synthetic@example.com')
    await press('Use a password instead')
    await fill('Password', 'synthetic-password')
    await press('Sign in')
    await analytics!.flush()
    expect(signedIn).equals(3)
    expect(
      rows.filter(row => row.E === 'login_succeeded').map(row => row.P.mt)
    ).deep.equals(['email_code', 'link', 'password'])
  })
})
