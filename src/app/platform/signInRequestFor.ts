import type { SignInRequestOptions } from '../../common/api'

/**
 * The sign-in request an installed app makes on `os`, with the link host its
 * build was given. Without one the link is the server's own web link.
 */
export function signInRequestFor(
  os: string,
  appOrigin: string | undefined
): SignInRequestOptions {
  return {
    origin: os === 'ios' ? 'ios' : 'android',
    ...(appOrigin == null ? {} : { appOrigin })
  }
}

/**
 * The name an installed app's link sign-in is kept under, so it gets the
 * device session a code sign-in in Director or Cameraman gets.
 */
export function linkDeviceNameFor(os: string): string {
  return os === 'ios' ? 'TeamStation for iOS' : 'TeamStation for Android'
}
