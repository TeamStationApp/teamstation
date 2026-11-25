import { isDevelopmentWebOrigin } from '../../common/primaryUrl'
import { ACCOUNT_SWITCH_EVENT } from '../../common/webPasswordLink'

declare const TS_PASSWORD_LINK_BUILD: boolean
type OpenLink = (params: URLSearchParams, signal: AbortSignal) => Promise<void>

// Before navigation, telemetry or loading the main app can inspect the URL.
export async function boot(
  page: Window,
  startApp: () => Promise<unknown>,
  openLink?: OpenLink
): Promise<void> {
  if (page.location.pathname === '/password-login') {
    const fragment = page.location.hash
    page.history.replaceState(null, '', '/sign-in')
    if (
      openLink != null &&
      page.top === page &&
      isDevelopmentWebOrigin(page.location.origin)
    ) {
      const controller = new AbortController()
      page.addEventListener(
        'pagehide',
        () => {
          controller.abort()
        },
        {
          once: true
        }
      )
      await openLink(new URLSearchParams(fragment.slice(1)), controller.signal)
      return
    }
  }
  if (openLink != null && isDevelopmentWebOrigin(page.location.origin)) {
    page.addEventListener('storage', event => {
      if (event.key === ACCOUNT_SWITCH_EVENT) page.location.reload()
    })
  }
  await startApp()
}

if (process.env.NODE_ENV !== 'test') {
  boot(
    window,
    async () => await import('./render'),
    TS_PASSWORD_LINK_BUILD
      ? async (params, signal) => {
          const { openPasswordLogin } = await import('./passwordLogin')
          if (!signal.aborted)
            await openPasswordLogin(params, undefined, undefined, signal)
        }
      : undefined
  ).catch(() => {
    document.getElementById('root')!.textContent =
      'TeamStation could not start. Reload to try again.'
  })
}
