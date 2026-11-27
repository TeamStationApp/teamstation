import { expect } from 'chai'
import { describe, it } from 'mocha'

import { signedInMark, signInOnAnySurface } from './signIn'

const ACCOUNT = {
  email: 'box+c@example.test',
  password: 'pw-123456789',
  displayName: 'Dave Roberts'
}

/** No waiting between busy tries. */
const NO_WAIT = { sleep: async () => undefined, random: () => 0 }

interface FormOptions {
  /** The home's account button: the phone header's, or the wide sidebar's. */
  layout?: 'phone' | 'sidebar'
  /** What each send answers, in turn; once spent, the last repeats. */
  answers?: Array<'signed-in' | 'busy' | 'refused'>
  /** After the nth send, the form falls back to its code view (the iOS app's). */
  codeViewAfterSend?: number
  /** A device with no keyboard to hide (a browser). */
  keyboard?: boolean
}

/**
 * The sign-in screen as maestro-d sees it: plain text matches a label
 * case-insensitively anywhere in it, as WebDriverAgent does, and text with
 * regex metacharacters is a regex. Typing goes to the field last tapped.
 */
interface FormState {
  view: 'code' | 'password' | 'home'
  email: string
  password: string
  focused: 'email' | 'password' | undefined
  error: string | undefined
  sends: number
  /** The address and password as each send had them. */
  sent: Array<{ email: string; password: string }>
  looked: string[]
}

function fakeForm(options: FormOptions = {}): {
  device: Record<string, any>
  state: FormState
} {
  const answers = options.answers ?? ['signed-in']
  const state: FormState = {
    view: 'code',
    email: '',
    password: '',
    focused: undefined,
    error: undefined,
    sends: 0,
    sent: [],
    looked: []
  }
  const labels = (): string[] => {
    if (state.view === 'home') {
      return [
        options.layout === 'sidebar' ? 'Home' : 'TeamStation menu',
        `Account, ${ACCOUNT.displayName}`
      ]
    }
    const error = state.error == null ? [] : [state.error]
    return state.view === 'code'
      ? [
          'Sign in to TeamStation',
          'E-mail address',
          ...error,
          'Send me a sign-in code',
          'Use a password instead'
        ]
      : [
          'Sign in to TeamStation',
          'E-mail address',
          'Password',
          ...error,
          'Sign in',
          'Use a sign-in code'
        ]
  }
  // A control named exactly so comes first, as a browser's buttons do.
  const find = (text: string): string | undefined =>
    /[\^$()[\]?*+|]/.test(text)
      ? labels().find(label => new RegExp(text).test(label))
      : (labels().find(label => label === text) ??
        labels().find(label =>
          label.toLowerCase().includes(text.toLowerCase())
        ))
  const send = (): void => {
    state.sends++
    state.sent.push({ email: state.email, password: state.password })
    const answer = answers[Math.min(state.sends, answers.length) - 1]
    if (answer === 'signed-in' && state.password === ACCOUNT.password) {
      state.view = 'home'
      return
    }
    state.error =
      answer === 'busy'
        ? 'Password verification is busy. Please try again'
        : 'Wrong e-mail or password'
    if (state.sends === options.codeViewAfterSend) {
      state.view = 'code'
      state.password = ''
    }
  }
  const device: Record<string, any> = {
    assertVisible: async (selector: { text: string }) => {
      state.looked.push(selector.text)
      if (find(selector.text) == null) {
        throw new Error(`Element not visible: text='${selector.text}'`)
      }
    },
    tapOn: async (selector: { text: string }) => {
      const label = find(selector.text)
      if (label == null) throw new Error(`Element not found: ${selector.text}`)
      if (label === 'E-mail address') state.focused = 'email'
      else if (label === 'Password') state.focused = 'password'
      else if (label === 'Use a password instead') {
        state.view = 'password'
        state.password = ''
        state.error = undefined
      } else if (label === 'Use a sign-in code') {
        state.view = 'code'
        state.password = ''
        state.error = undefined
      } else if (label === 'Sign in' && state.view === 'password') send()
    },
    eraseText: async () => {
      if (state.focused === 'email') state.email = ''
      if (state.focused === 'password') state.password = ''
    },
    inputText: async ({ text }: { text: string }) => {
      if (state.focused === 'email') state.email += text
      if (state.focused === 'password') state.password += text
    }
  }
  if (options.keyboard !== false) device.hideKeyboard = async () => undefined
  return { device, state }
}

describe('signing in on any surface', function () {
  it('marks a signed-in screen by the account’s own button, at any width', function () {
    const mark = new RegExp(signedInMark(ACCOUNT))
    expect(mark.test('Account, Dave Roberts')).equals(true)
    expect(mark.test('Account, Dave Roberts, notifications waiting')).equals(
      true
    )
    expect(mark.test('Account, Someone Else')).equals(false)
    expect(mark.test('TeamStation menu')).equals(false)
    // A name with regex metacharacters is matched as written.
    const odd = new RegExp(signedInMark({ displayName: 'A. (Bo) Smith+' }))
    expect(odd.test('Account, A. (Bo) Smith+')).equals(true)
    expect(odd.test('Account, AX (Bo) Smith')).equals(false)
    expect(new RegExp(signedInMark({})).test('Account, Anyone')).equals(true)
  })

  it('signs in at 1280 px, where the sidebar replaces the TeamStation menu', async function () {
    const { device, state } = fakeForm({ layout: 'sidebar', keyboard: false })
    await signInOnAnySurface(device, ACCOUNT)
    expect(state.view).equals('home')
    expect(state.sends).equals(1)
    expect(state.looked).not.includes('TeamStation menu')
    expect(state.sent).deep.equals([
      { email: ACCOUNT.email, password: ACCOUNT.password }
    ])
  })

  it('signs in through the phone header’s account button', async function () {
    const { device, state } = fakeForm({ layout: 'phone' })
    await signInOnAnySurface(device, ACCOUNT)
    expect(state.view).equals('home')
    expect(state.sends).equals(1)
  })

  it('goes back to the password view, empty, when a try leaves the code view', async function () {
    // The iOS app: the first send is refused and the form falls back to its
    // code view, where "Password" would find "Use a password instead".
    const { device, state } = fakeForm({
      answers: ['refused', 'signed-in'],
      codeViewAfterSend: 1
    })
    await signInOnAnySurface(device, ACCOUNT)
    expect(state.view).equals('home')
    expect(state.sent).deep.equals([
      { email: ACCOUNT.email, password: ACCOUNT.password },
      { email: ACCOUNT.email, password: ACCOUNT.password }
    ])
    // The password never went into the e-mail field.
    expect(state.email).equals(ACCOUNT.email)
  })

  it('empties both fields before a try on the password view', async function () {
    const { device, state } = fakeForm({ answers: ['refused', 'signed-in'] })
    const typed: string[] = []
    const input = device.inputText as (value: { text: string }) => Promise<void>
    device.inputText = async (value: { text: string }) => {
      typed.push(`${state.focused}:${state.email}|${state.password}`)
      await input(value)
    }
    await signInOnAnySurface(device, ACCOUNT)
    expect(state.view).equals('home')
    // Each field was empty when its text went in, on both tries.
    expect(typed).deep.equals([
      'email:|',
      `password:${ACCOUNT.email}|`,
      'email:|',
      `password:${ACCOUNT.email}|`
    ])
  })

  it('tries a busy answer again with the busy backoff, and keeps its tries for dropped keys', async function () {
    const waits: number[] = []
    const { device, state } = fakeForm({
      answers: ['busy', 'busy', 'busy', 'signed-in']
    })
    await signInOnAnySurface(device, ACCOUNT, {
      busy: {
        sleep: async ms => {
          waits.push(ms)
        },
        random: () => 0
      }
    })
    expect(state.view).equals('home')
    expect(state.sends).equals(4)
    // busyRetry.ts's backoff: half of 250, 500 and 1000 ms with no jitter.
    expect(waits).deep.equals([125, 250, 500])
  })

  it('gives up on a form that stays busy once the busy budget is spent', async function () {
    let clock = 0
    const { device, state } = fakeForm({ answers: ['busy'] })
    let failure: Error | undefined
    try {
      await signInOnAnySurface(device, ACCOUNT, {
        busy: {
          budgetMs: 1000,
          sleep: async ms => {
            clock += ms
          },
          random: () => 0,
          now: () => clock
        }
      })
    } catch (error) {
      failure = error as Error
    }
    expect(failure?.message).matches(/password verification stayed busy/)
    expect(state.view).not.equals('home')
  })

  it('reports the device’s own failure after three refused tries', async function () {
    const { device, state } = fakeForm({ answers: ['refused'] })
    let failure: Error | undefined
    try {
      await signInOnAnySurface(device, ACCOUNT, { busy: NO_WAIT })
    } catch (error) {
      failure = error as Error
    }
    expect(failure?.message).equals(
      `Element not visible: text='${signedInMark(ACCOUNT)}'`
    )
    expect(state.sends).equals(3)
  })

  it('stops when a try got in after its wait', async function () {
    const { device, state } = fakeForm()
    // The home comes up only once the try's own wait is over.
    let checks = 0
    const assertVisible = device.assertVisible as (s: {
      text: string
    }) => Promise<void>
    device.assertVisible = async (selector: { text: string }) => {
      if (selector.text === signedInMark(ACCOUNT) && checks++ < 3) {
        throw new Error('not yet')
      }
      await assertVisible(selector)
    }
    await signInOnAnySurface(device, ACCOUNT, { busy: NO_WAIT })
    expect(state.view).equals('home')
    expect(state.sends).equals(1)
  })
})
