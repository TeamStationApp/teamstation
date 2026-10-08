import { asBoolean, asObject, asOptional, asString } from 'cleaners'

import { type Approval, asApproval } from '../../common/distribution'

declare const window: { location: { origin: string } }

const asResult = asObject({
  redirectTo: asOptional(asString),
  pending: asOptional(asBoolean)
})
export function approvalClient(
  uid: string,
  doFetch: typeof fetch = fetch
): {
  details: () => Promise<Approval>
  decide: (approve: boolean) => Promise<string>
  native: () => Promise<string>
  resume: () => Promise<string | undefined>
} {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error('Invalid approval')
  const prefix = `/oauth/approve/${uid}`
  let csrf = ''
  const request = async (suffix: string, body?: unknown): Promise<unknown> => {
    const response = await doFetch(prefix + suffix, {
      method: body == null ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers:
        body == null
          ? {}
          : { 'content-type': 'application/json', 'x-oauth-csrf': csrf },
      body: body == null ? undefined : JSON.stringify(body)
    })
    if (!response.ok) throw new Error('Approval expired or unavailable')
    return await response.json()
  }
  const redirect = (text: string): string => {
    const url = new URL(text, window.location.origin)
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith('/oauth/')
    )
      throw new Error('Invalid approval redirect')
    return url.href
  }
  return {
    details: async () => {
      const info = asApproval(await request('/details'))
      csrf = info.csrfToken ?? ''
      return info
    },
    decide: async approve =>
      redirect(
        asObject({ redirectTo: asString })(
          await request('/decision', { approve })
        ).redirectTo
      ),
    native: async () => {
      const { appUrl } = asObject({ appUrl: asString })(
        await request('/native', {})
      )
      if (
        !/^teamstation:\/\/\/oauth\/native-approval\/[A-Za-z0-9_-]{43}$/.test(
          appUrl
        )
      )
        throw new Error('Invalid app approval link')
      return appUrl
    },
    resume: async () => {
      const answer = asResult(await request('/resume', {}))
      return answer.pending === true
        ? undefined
        : redirect(asString(answer.redirectTo))
    }
  }
}
