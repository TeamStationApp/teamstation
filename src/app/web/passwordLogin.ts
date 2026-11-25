import { TeamStationClient } from '../../common/api'
import { passwordKdf } from '../platform/passwordKdf'

declare const TS_API_BASE_URL: string

export async function openPasswordLogin(
  credentials: URLSearchParams,
  signIn = async (email: string, password: string): Promise<unknown> => {
    const client = new TeamStationClient({
      baseUrl: TS_API_BASE_URL,
      passwordKdf
    })
    return await client.signInWithPassword(email, password)
  },
  openHome = (): void => {
    window.location.replace('/')
  }
): Promise<void> {
  const root = document.getElementById('root')!
  const email = credentials.get('username')?.trim()
  const password = credentials.get('password')
  const valid =
    email != null &&
    email !== '' &&
    password != null &&
    password !== '' &&
    credentials.getAll('username').length === 1 &&
    credentials.getAll('password').length === 1

  const status = document.createElement('main')
  status.setAttribute('role', 'status')
  root.replaceChildren(status)
  if (valid) {
    status.textContent = 'Signing in…'
    try {
      await signIn(email, password)
      openHome()
      return
    } catch {
      status.textContent =
        'Sign-in failed. Check your email and password, then try again. '
    }
  } else {
    status.textContent = 'This link needs a username and password. '
  }
  const retry = document.createElement('a')
  retry.href = '/sign-in'
  retry.textContent = 'Open TeamStation sign-in'
  status.append(retry)
}
