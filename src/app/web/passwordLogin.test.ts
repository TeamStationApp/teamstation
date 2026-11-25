import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { openPasswordLogin } from './passwordLogin'

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
})
