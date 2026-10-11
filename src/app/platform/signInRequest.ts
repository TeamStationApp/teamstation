import type { SignInRequestOptions } from '../../common/api'

/**
 * How the web asks for a sign-in: as the web, so the link comes back to this
 * site.
 */
export const signInRequest: SignInRequestOptions = {}

/** The web spends a sign-in link as a browser, so its session is a browser's. */
export const linkDeviceName: string | undefined = undefined
