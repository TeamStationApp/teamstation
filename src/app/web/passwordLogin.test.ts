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
    const password = 'spaces &+#%'
    const query = new URLSearchParams({
      username: ' reader+web@example.test ',
      password
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
    ['missing password', 'username=a'],
    ['missing username', 'password=b'],
    ['repeated password', 'username=a&password=b&password=c']
  ]) {
    it('rejects a link with a ' + label, async function () {
      let called = false
      await openPasswordLogin(new URLSearchParams(fragment), async () => {
        called = true
      })
      expect(called).equals(false)
      expect(root.textContent).includes('needs a username and password')
    })
  }

  it('offers ordinary sign-in after rejection without echoing credentials', async function () {
    await openPasswordLogin(
      new URLSearchParams({
        username: 'reader@example.test',
        password: 'placeholder'
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
