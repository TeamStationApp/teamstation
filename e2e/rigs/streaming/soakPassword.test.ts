import { expect } from 'chai'

import { pairSoakTv, signInSoakSurface } from './soakPassword'
import { fakeDevice } from './surfaces/fakes.test'

describe('pairing the soak TV from the fixture owner’s app', function () {
  const app = "Application, 0x1, label: 'TeamStation'\n"
  const home = app + "Other, 0x2, identifier: 'tv-page-home'"
  const login =
    app +
    "StaticText, 0x3, identifier: 'tv-login-code', label: 'TV login code ABCD–EFGH'"

  it('signs the previous viewer out and waits for the newly paired home', async function () {
    const screens = [home, login, login, home]
    const { device, calls } = fakeDevice()
    let signsOut = 0
    let opens = 0
    await pairSoakTv(
      async () => screens.shift()!,
      async () => {
        signsOut++
      },
      device,
      async () => {
        opens++
      }
    )
    expect(signsOut).equals(1)
    expect(opens).equals(1)
    expect(calls[0][0]).equals('tapOn')
    expect(calls.slice(1, -1)).deep.equals(
      'ABCDEFGH'.split('').map(text => ['inputText', { text }])
    )
    expect(calls.at(-1)?.[0]).equals('assertVisible')
  })

  it('does not approve a code from another foreground application', async function () {
    const { device, calls } = fakeDevice()
    const error = await pairSoakTv(
      async () => login.replace("'TeamStation'", "'Other'"),
      async () => undefined,
      device,
      async () => undefined
    ).catch((error: unknown) => error)
    expect(error).is.an('error')
    expect(calls).has.length(0)
  })
})

describe('signing in on an Android phone', function () {
  const account = { email: 'viewer@example.test', password: 'test-only-value' }
  function form(focusPassword: boolean): ReturnType<typeof fakeDevice> {
    let focus = -1
    return fakeDevice({
      hierarchy: () => ({
        children: [0, 1].map(index => ({
          type: 'EditText',
          bounds: { x: 0, y: index * 100, width: 80, height: 40 },
          focused: index === focus
        }))
      }),
      tapOn: (value: unknown) => {
        const point = (value as { point?: string }).point
        if (point === '40,20') focus = 0
        if (point === '40,120' && focusPassword) focus = 1
      }
    })
  }

  it('dismisses the keyboard between inputs and submits the password form', async function () {
    const { device, calls } = form(true)
    await signInSoakSurface(device, account, true)
    expect(
      calls.filter(([name]) => name === 'inputText' || name === 'hideKeyboard')
    ).deep.equals([
      ['inputText', { text: account.email }],
      ['hideKeyboard', undefined],
      ['inputText', { text: account.password }],
      ['hideKeyboard', undefined]
    ])
    const taps = calls.filter(([command]) => command === 'tapOn')
    expect(taps.slice(-2)).deep.equals([
      ['tapOn', { text: '^Sign in$', traits: 'button' }],
      [
        'tapOn',
        { id: 'android:id/autofill_save_no', optional: true, timeout: 8000 }
      ]
    ])
  })

  it('stops before typing the password when the email input retains focus', async function () {
    const { device, calls } = form(false)
    const error = await signInSoakSurface(device, account, true).catch(
      (e: unknown) => e
    )
    expect(error).to.be.instanceOf(Error)
    expect(calls.filter(([name]) => name === 'inputText')).deep.equals([
      ['inputText', { text: account.email }]
    ])
  })
})
