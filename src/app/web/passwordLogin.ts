import { TeamStationClient } from '../../common/api'
import { passwordKdf } from '../platform/passwordKdf'

declare const TS_API_BASE_URL: string

function readAuth(
  params: URLSearchParams
): { email: string; password: string } | undefined {
  const values = params.getAll('auth')
  const hex = values[0]
  // Each pair represents one 7-bit ASCII byte.
  if (values.length !== 1 || !/^(?:[0-7][0-9a-f])+$/i.test(hex)) return
  const decoded = hex.replace(/../g, byte =>
    String.fromCharCode(parseInt(byte, 16))
  )
  const newline = decoded.indexOf('\n')
  if (newline < 0) return
  const email = decoded.slice(0, newline).trim()
  const password = decoded.slice(newline + 1)
  if (email !== '' && password !== '') return { email, password }
}

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
  const auth = readAuth(credentials)

  const status = document.createElement('main')
  status.setAttribute('role', 'status')
  root.replaceChildren(status)
  if (auth != null) {
    status.textContent = 'Signing in…'
    try {
      await signIn(auth.email, auth.password)
      openHome()
      return
    } catch {
      status.textContent =
        'Sign-in failed. Check your email and password, then try again. '
    }
  } else {
    status.textContent = 'This sign-in link has an invalid auth value. '
  }
  const retry = document.createElement('a')
  retry.href = '/sign-in'
  retry.textContent = 'Open TeamStation sign-in'
  status.append(retry)
}
