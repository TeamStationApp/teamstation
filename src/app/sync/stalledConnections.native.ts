import { NativeModules, Platform } from 'react-native'

import { apiBaseUrl } from '../native/config'
import { renewOnDeadline } from './renewOnDeadline'

/** TeamStation's API host: only its requests' progress says the link works. */
// The host alone, as `NSURL` names it: React Native's `URL.host` adds a
// port the URL names.
const apiHost = new URL(apiBaseUrl).hostname

/**
 * The phone's answer to a request that missed its deadline. On iOS every
 * `fetch` shares one connection, which a stalled link can leave unanswering
 * for minutes after the signal returns: `TSConnections.renew`
 * (`ios/TeamStation/Connections/RCTConnections.mm`) puts the next request on
 * a new one, once it has found the link stalled, not slow. Android's kernel
 * closes such a connection itself (`StalledConnections.kt`), so there it is
 * none.
 */
export const leaveStalledConnections: (() => void) | undefined =
  Platform.OS === 'ios'
    ? renewOnDeadline(
        async () =>
          (await (
            NativeModules.TSConnections as
              { renew?: (host: string) => Promise<boolean> } | undefined
          )?.renew?.(apiHost)) ?? false
      )
    : undefined
