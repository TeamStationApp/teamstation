import { Platform } from 'react-native'

import { appOrigin } from '../native/config'
import { linkDeviceNameFor, signInRequestFor } from './signInRequestFor'

/**
 * How the installed app asks for a sign-in: as the phone it is, and with its
 * own link host, so the mailed link opens the app rather than the browser.
 */
export const signInRequest = signInRequestFor(Platform.OS, appOrigin)

/** The name the installed app's link sign-in session is kept under. */
export const linkDeviceName: string | undefined = linkDeviceNameFor(Platform.OS)
