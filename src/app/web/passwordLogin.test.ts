import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { isDevelopmentWebOrigin } from '../../common/primaryUrl'
import { testPasswordParameters } from '../../test/passwordFixtures'
import { openPasswordLogin, PasswordLinkClient } from './passwordLogin'

describe('web password links', function () {
  let root: HTMLElement
  beforeEach(function () {
    root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
  })
  afterEach(function () {
    root.remove()
  })

  it('uses decoded credentials and opens home after password sign-in', async function () {
    const calls: string[] = []
    const password = ' spaces &+#%\nnext line '
    const query = new URLSearchParams({
      auth: Buffer.from(' reader+web@example.test \n' + password, 'ascii')
        .toString('hex')
        .toUpperCase()
    })
    await openPasswordLogin(
      query,
      async (email, secret) => {
        calls.push(email, secret)
      },
      () => calls.push('home')
    )
    expect(calls).deep.equals(['reader+web@example.test', password, 'home'])
  })

  for (const [label, fragment] of [
    ['missing auth value', 'username=a&password=b'],
    ['empty auth value', 'auth='],
    ['repeated auth value', 'auth=610a62&auth=610a63'],
    ['missing newline', 'auth=6162'],
    ['missing username', 'auth=0a62'],
    ['missing password', 'auth=610a'],
    ['partial byte', 'auth=610a6'],
    ['non-hex digit', 'auth=610a6z'],
    ['non-ASCII byte', 'auth=610a80']
  ]) {
    it('rejects a link with a ' + label, async function () {
      let called = false
      await openPasswordLogin(new URLSearchParams(fragment), async () => {
        called = true
      })
      expect(called).equals(false)
      expect(root.textContent).includes('invalid auth value')
    })
  }

  it('offers ordinary sign-in after rejection without echoing credentials', async function () {
    await openPasswordLogin(
      new URLSearchParams({
        auth: Buffer.from('reader@example.test\nplaceholder', 'ascii').toString(
          'hex'
        )
      }),
      async () => {
        throw new Error('placeholder')
      }
    )
    expect(root.textContent).includes('Sign-in failed')
    expect(root.textContent).not.includes('placeholder')
    expect(root.querySelector('a')?.getAttribute('href')).equals('/sign-in')
  })
  const encoded = (email: string, password: string): URLSearchParams =>
    new URLSearchParams({
      auth: Buffer.from(email + '\n' + password, 'ascii').toString('hex')
    })

  it('accepts the decode limits and refuses oversized fields before authentication', async () => {
    const calls: string[] = []
    const sign = async (email: string): Promise<void> => {
      calls.push(email)
    }
    await openPasswordLogin(
      encoded('a'.repeat(254), 'b'.repeat(1024)),
      sign,
      () => {}
    )
    for (const [email, password] of [
      ['a'.repeat(255), 'b'],
      ['a', 'b'.repeat(1025)],
      ['a', 'b'.repeat(4096)]
    ]) {
      await openPasswordLogin(encoded(email, password), sign)
      expect(root.textContent).includes('invalid auth')
    }
    expect(calls).deep.equals(['a'.repeat(254)])
  })

  it('binds cookie-backed writes to the account shown by the development UI', async () => {
    class AccountClient extends PasswordLinkClient {
      override get cacheUser(): string {
        return 'displayed-account'
      }
    }
    const flags = globalThis as typeof globalThis & {
      TS_PASSWORD_LINK_BUILD?: boolean
    }
    const before = flags.TS_PASSWORD_LINK_BUILD
    const actors: Array<string | null> = []
    try {
      const options = {
        baseUrl: '/api/v1',
        fetch: async (
          _input: RequestInfo | URL,
          init?: RequestInit
        ): Promise<Response> => {
          actors.push(
            new Headers(init?.headers).get('x-teamstation-expected-actor')
          )
          return Response.json({ ok: true })
        }
      }
      flags.TS_PASSWORD_LINK_BUILD = true
      const client = new AccountClient(options)
      await client.signOut()
      await client.health().catch(() => undefined)
      client.token = 'fixture'
      await client.signOut('departing-account')
      await new PasswordLinkClient(options).signOut()
      flags.TS_PASSWORD_LINK_BUILD = false
      await client.signOut()
      expect(actors).deep.equals([
        'displayed-account',
        'displayed-account',
        'departing-account',
        null,
        null
      ])
    } finally {
      if (before == null) delete flags.TS_PASSWORD_LINK_BUILD
      else flags.TS_PASSWORD_LINK_BUILD = before
    }
  })

  it('allows only the exact HTTPS development origin', () => {
    for (const origin of [
      undefined,
      'malformed',
      'http://seat.example.test',
      'https://app.teamstation.app',
      'https://web.teamstation.app',
      'https://seat.example.test/path'
    ]) {
      expect(isDevelopmentWebOrigin(origin, origin)).equals(false)
    }
    const seat = 'https://seat.example.test'
    expect(isDevelopmentWebOrigin(seat, undefined)).equals(false)
    expect(isDevelopmentWebOrigin(seat, 'https://other.example.test')).equals(
      false
    )
    expect(isDevelopmentWebOrigin(seat, seat)).equals(true)
  })

  const ids = { currentId: 'a', targetId: 'b' }
  const switchError = new HttpError('conflict', 'confirm', {
    reason: 'confirmAccountSwitch',
    confirmation: ids,
    currentLabel: 'current@example.test',
    targetLabel: '<script>example</script>'
  })
  for (const action of ['keep', 'switch', 'leave']) {
    it(
      'requires one explicit decision to ' + action + ' a different account',
      async () => {
        const calls: unknown[] = []
        const controller = new AbortController()
        let homes = 0
        await openPasswordLogin(
          encoded('a', 'b'),
          async (_email, _pw, confirmation) => {
            calls.push(confirmation)
            if (confirmation == null) throw switchError
          },
          () => {
            homes++
          },
          controller.signal
        )
        expect(calls).deep.equals([undefined])
        expect(root.textContent).includes('current@example.test')
        expect(root.textContent).includes('<script>')
        expect(root.querySelector('script')).equals(null)
        const [keep, change] = Array.from(root.querySelectorAll('button'))
        if (action === 'leave') controller.abort()
        const button = action === 'keep' ? keep : change
        button.click()
        button.click()
        await Promise.resolve()
        expect(calls).deep.equals(
          action === 'switch' ? [undefined, ids] : [undefined]
        )
        expect(homes).equals(action === 'leave' ? 0 : 1)
      }
    )
  }

  it('asks to reopen after the confirmed account pair changes', async () => {
    await openPasswordLogin(
      encoded('a', 'b'),
      async (_email, _password, confirmation) => {
        throw confirmation == null
          ? switchError
          : new HttpError('conflict', 'stale')
      }
    )
    root.querySelectorAll('button')[1].click()
    await Promise.resolve()
    expect(root.textContent).includes('Open the sign-in link again')
    expect(root.querySelector('button')).equals(null)
  })

  it('ignores a response after leaving, and never prompts on an unrecognized conflict', async () => {
    const controller = new AbortController()
    const home = (): never => {
      throw Error('unexpected navigation')
    }
    await openPasswordLogin(
      encoded('a', 'b'),
      async () => {
        controller.abort()
        throw switchError
      },
      home,
      controller.signal
    )
    expect(root.querySelector('button')).equals(null)
    await openPasswordLogin(
      encoded('a', 'b'),
      async () => {
        throw new HttpError('conflict', 'stale')
      },
      home
    )
    expect(root.querySelector('button')).equals(null)
    expect(root.textContent).includes('Sign-in failed')
  })

  it('uses only the guarded endpoint and sends the derived proof and confirmed IDs', async () => {
    const paths: string[] = []
    const bodies: unknown[] = []
    const client = new PasswordLinkClient({
      baseUrl: '/api/v1',
      passwordKdf: async () => 'ab'.repeat(32),
      fetch: async (input, init) => {
        if (typeof input !== 'string' || typeof init?.body !== 'string')
          throw Error('Expected a JSON request')
        paths.push(input)
        bodies.push(JSON.parse(init.body))
        return paths.length === 1
          ? Response.json(testPasswordParameters)
          : Response.json(
              { code: 'unauthorized', message: 'Invalid' },
              { status: 401 }
            )
      }
    })
    try {
      await client.submit(
        'reader@example.test',
        'synthetic',
        ids,
        new AbortController().signal
      )
      expect.fail('must fail')
    } catch (error) {
      expect(error).instanceOf(HttpError)
    }
    expect(paths).deep.equals([
      '/api/v1/auth/password/parameters',
      '/api/v1/auth/password/link'
    ])
    expect(bodies[1]).deep.equals({
      email: 'reader@example.test',
      clientHash: 'ab'.repeat(32),
      confirmation: ids
    })
  })
})
