import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

/** Read the synthetic mailbox or network controls on the fixture host. */
export async function navigationControl(url: string): Promise<Response> {
  const command = process.env.TS_NAV_CONTROL_READER
  if (command == null) return await fetch(url)
  const target = new URL(url)
  const { stdout } = await promisify(execFile)(command, [
    target.pathname + target.search
  ])
  const { status, body } = JSON.parse(stdout) as {
    status: number
    body: string
  }
  return new Response(body, { status })
}

interface SignInDevice {
  tapOn: (selector: unknown) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  assertVisible: (selector: unknown) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
}

/** An isolated Android package can share the standard link scheme with a store install. */
export async function signInWithFixturePassword(
  device: SignInDevice,
  email: string,
  file: string
): Promise<void> {
  const credentials = JSON.parse(await readFile(file, 'utf8')) as {
    email: string
    password: string
  }
  if (credentials.email !== email || credentials.password.length === 0)
    throw new Error('Sign-in file does not match this navigation fixture')
  await device.tapOn({ text: 'Use a password instead', timeout: 15000 })
  await device.tapOn({ text: 'parent@example.com', timeout: 15000 })
  await device.inputText({ text: email })
  await device.tapOn({ text: 'Password', timeout: 15000 })
  await device.inputText({ text: credentials.password })
  await device.hideKeyboard()
  await device.tapOn({ id: 'settings-pill-button', text: 'Sign in' })
  const skip = { id: 'android:id/autofill_save_no' }
  if (
    await device.assertVisible({ ...skip, timeout: 1500 }).then(
      () => true,
      () => false
    )
  )
    await device.tapOn(skip)
}
