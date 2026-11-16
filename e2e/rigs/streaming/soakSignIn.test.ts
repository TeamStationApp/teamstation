import { expect } from 'chai'

import {
  approveTvCode,
  sessionToken,
  signInApp,
  type SignInStack,
  signInToken,
  signOutApp,
  tvCodeIn
} from './soakSignIn'
import { fakeDevice } from './surfaces/fakes.test'
import { tapIfShown } from './surfaces/surface'

/** A stack whose API answers `answers` and whose log grows by `logged` per request. */
function stack(
  answers: Record<string, { status: number; body?: unknown }>,
  logged: Record<string, string>
): {
  stack: SignInStack
  sent: Array<{ path: string; body: unknown; auth?: string }>
} {
  let log = 'earlier line\n'
  const sent: Array<{ path: string; body: unknown; auth?: string }> = []
  return {
    sent,
    stack: {
      api: 'https://stack.example.test/api/v1/',
      serverLog: '/mirror/api.log',
      readLog: () => log,
      sleep: async () => undefined,
      timeoutMs: 50,
      fetch: (async (url: string, init: RequestInit) => {
        const path = url.replace('https://stack.example.test/api/v1', '')
        const headers = init.headers as Record<string, string>
        sent.push({
          path,
          body: JSON.parse(init.body as string),
          ...(headers.authorization == null
            ? {}
            : { auth: headers.authorization })
        })
        log += logged[path] ?? ''
        const answer = answers[path] ?? { status: 404 }
        return {
          status: answer.status,
          json: async () => answer.body
        } as unknown as Response
      }) as unknown as typeof fetch
    }
  }
}

describe('the soak sign-ins', function () {
  it('takes a sign-in link from the e-mail the stack logs', async function () {
    const { stack: s, sent } = stack(
      { '/auth/email-code': { status: 202 } },
      {
        '/auth/email-code':
          'mail to a@example.test link: https://stack.example.test/signin/tok_123-x\n'
      }
    )
    expect(await signInToken(s, 'a@example.test')).equals('tok_123-x')
    expect(sent[0]).deep.equals({
      path: '/auth/email-code',
      body: { email: 'a@example.test' }
    })
  })

  it('reads only what the log gained after asking', async function () {
    const { stack: s } = stack({ '/auth/email-code': { status: 202 } }, {})
    s.readLog = () => 'link: https://x.example.test/signin/old\n'
    expect(
      await signInToken(s, 'a@example.test').catch(
        (e: unknown) => (e as Error).message
      )
    ).includes('never showed')
  })

  it('refuses when the stack will not send a code', async function () {
    const { stack: s } = stack({ '/auth/email-code': { status: 429 } }, {})
    expect(
      await signInToken(s, 'a@example.test').catch(
        (e: unknown) => (e as Error).message
      )
    ).includes('429')
  })

  it('verifies the logged code for a session token', async function () {
    const { stack: s, sent } = stack(
      {
        '/auth/email-code': { status: 202 },
        '/auth/email-code/verify': { status: 200, body: { token: 'session' } }
      },
      { '/auth/email-code': 'sign-in code for a+b@example.test: 123456\n' }
    )
    let resets = 0
    s.resetLimits = async () => {
      resets++
    }
    expect(await sessionToken(s, 'a+b@example.test')).equals('session')
    expect(resets).equals(1)
    expect(sent[1].body).deep.equals({
      email: 'a+b@example.test',
      code: '123456'
    })
    const { stack: refused } = stack(
      {
        '/auth/email-code': { status: 202 },
        '/auth/email-code/verify': { status: 401 }
      },
      { '/auth/email-code': 'sign-in code for c@example.test: 654321\n' }
    )
    expect(
      await sessionToken(refused, 'c@example.test').catch(
        (e: unknown) => (e as Error).message
      )
    ).includes('401')
  })

  it("approves the TV's code as the signed-in account", async function () {
    const { stack: s, sent } = stack(
      { '/auth/tv/approve': { status: 204 } },
      {}
    )
    await approveTvCode(s, 'session', 'ABCD-EFGH')
    expect(sent[0]).deep.equals({
      path: '/auth/tv/approve',
      body: { code: 'abcdefgh' },
      auth: 'Bearer session'
    })
    const { stack: refused } = stack(
      { '/auth/tv/approve': { status: 403 } },
      {}
    )
    expect(
      await approveTvCode(refused, 's', 'ABCDEFGH').catch(
        (e: unknown) => (e as Error).message
      )
    ).includes('403')
  })

  it('finds the eight-letter code in what the TV shows', function () {
    expect(tvCodeIn('Enter ABCD-EFGH on your phone')).equals('ABCD-EFGH')
    expect(tvCodeIn('code WXYZQRST')).equals('WXYZQRST')
    expect(tvCodeIn('Signed in')).equals(undefined)
  })

  /** An app that is signed out when `signedOut` says so, and signs in on a link. */
  function app(
    start: 'in' | 'out',
    linkWorks = true
  ): ReturnType<typeof fakeDevice> & {
    state: () => 'in' | 'out'
  } {
    let state = start
    const made = fakeDevice({
      assertVisible: (arg: unknown) => {
        const target = arg as { text?: string; id?: string }
        if (target.text === 'Sign in to TeamStation' && state === 'out') return
        if (target.id === 'signInLinkSignIn') return
        if (target.text === 'Notifications') return
        throw new Error('not shown')
      },
      hierarchy: () => ({
        children: [
          { text: 'Account, Clayton Kershaw' },
          { text: 'Account', bounds: { x: 10, y: 20, width: 100, height: 40 } },
          {
            text: 'Sign out',
            bounds: { x: 10, y: 100, width: 100, height: 40 }
          }
        ]
      }),
      tapOnPoint: (arg: unknown) => {
        if ((arg as { y: number }).y === 120) state = 'out'
      },
      openLink: () => {
        if (linkWorks) state = 'in'
      }
    })
    return { ...made, state: () => state }
  }

  it('signs a signed-out app in through its link', async function () {
    const out = app('out')
    await signInApp(out.device, 'app.x', async () => 'tok')
    expect(out.state()).equals('in')
    expect(out.calls.find(call => call[0] === 'openLink')![1]).deep.equals({
      link: 'teamstation://signin/tok'
    })
    expect(out.calls.some(call => call[0] === 'scrollUntilVisible')).equals(
      false
    )
  })

  it('leaves an app signed in already as it is', async function () {
    const held = app('in')
    const links: string[] = []
    await signInApp(held.device, 'app.x', async () => 'tok', {
      openIn: async link => {
        links.push(link)
      }
    })
    expect(links).deep.equals([])
    expect(held.calls.some(call => call[0] === 'tapOn')).equals(false)
    expect(held.state()).equals('in')
  })

  it('signs out by the account button, the menu and the foot of the page', async function () {
    const held = app('in')
    await signOutApp(held.device, 0)
    expect(held.state()).equals('out')
    expect(
      held.calls.filter(call => call[0] === 'tapOnPoint').map(call => call[1])
    ).deep.equals([
      { x: 60, y: 40 },
      { x: 60, y: 120 }
    ])
    expect(held.calls.find(call => call[0] === 'tapOn')![1]).deep.equals({
      text: 'Account, Clayton Kershaw'
    })
  })

  it('says when the link leaves the app signed out, or there is no account button', async function () {
    const stuck = app('out', false)
    expect(
      await signInApp(stuck.device, 'app.x', async () => 'tok').catch(
        (e: unknown) => (e as Error).message
      )
    ).equals('the sign-in link left the app signed out')
    const nameless = fakeDevice({
      assertVisible: () => {
        throw new Error('not shown')
      },
      hierarchy: () => ({ children: [{ text: 'Home' }] })
    })
    expect(
      await signOutApp(nameless.device).catch(
        (e: unknown) => (e as Error).message
      )
    ).equals('signed in, but no account button')
    const unmoved = fakeDevice({
      assertVisible: (arg: unknown) => {
        if ((arg as { text?: string }).text === 'Notifications') return
        throw new Error('not shown')
      },
      hierarchy: () => ({
        children: [
          { text: 'Account, X' },
          { text: 'Account', bounds: { x: 0, y: 0, width: 2, height: 2 } },
          { text: 'Sign out', bounds: { x: 0, y: 10, width: 2, height: 2 } }
        ]
      })
    })
    expect(
      await signOutApp(unmoved.device).catch(
        (e: unknown) => (e as Error).message
      )
    ).equals('Sign out did not return to the sign-in page')
  })

  it('taps a prompt only when it shows', async function () {
    const shown = fakeDevice({})
    expect(await tapIfShown(shown.device, { text: 'Watch' }, 10)).equals(true)
    expect(shown.calls.at(-1)).deep.equals(['tapOn', { text: 'Watch' }])
    const hidden = fakeDevice({
      assertVisible: () => {
        throw new Error('not shown')
      }
    })
    expect(await tapIfShown(hidden.device, { text: 'Watch' }, 10)).equals(false)
    expect(hidden.calls.map(call => call[0])).deep.equals(['assertVisible'])
  })
})

describe('the account menu', function () {
  it('needs an exact Account item to tap', async function () {
    const menuless = fakeDevice({
      hierarchy: () => ({ children: [{ text: 'Account, X' }] })
    })
    expect(
      await signOutApp(menuless.device).catch(
        (e: unknown) => (e as Error).message
      )
    ).equals('no "Account" on screen')
  })
})

describe('the account page', function () {
  it('swipes until Sign out is on the screen, and gives up after fifteen', async function () {
    let swipes = 0
    const far = fakeDevice({
      assertVisible: (arg: unknown) => {
        if ((arg as { text?: string }).text === 'Notifications') return
        throw new Error('not shown')
      },
      hierarchy: () => ({
        bounds: { x: 0, y: 0, width: 400, height: 800 },
        children: [
          { text: 'Account, X' },
          { text: 'Account', bounds: { x: 0, y: 10, width: 2, height: 2 } },
          {
            text: 'Sign out',
            bounds: { x: 0, y: swipes >= 3 ? 700 : 1600, width: 2, height: 2 }
          }
        ]
      }),
      swipe: () => {
        swipes++
      }
    })
    expect(
      await signOutApp(far.device, 0).catch(
        (e: unknown) => (e as Error).message
      )
    ).equals('Sign out did not return to the sign-in page')
    expect(swipes).equals(3)
    swipes = -100
    expect(
      await signOutApp(far.device, 0).catch(
        (e: unknown) => (e as Error).message
      )
    ).equals('no Sign out on the account page')
  })
})
