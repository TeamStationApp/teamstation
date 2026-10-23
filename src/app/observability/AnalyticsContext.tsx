import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react'
import { Platform } from 'react-native'

import { buildInfo } from '../../common/distribution'
import { AnalyticsClient } from '../../common/observability/analyticsClient'
import { deviceStorage } from '../platform/deviceStorage'
import { randomUuid } from '../stream/deviceId'
import { observeLifecycle } from './lifecycle'

const Context = createContext<AnalyticsClient | undefined>(undefined)
export const useAnalytics = (): AnalyticsClient | undefined =>
  useContext(Context)

export function AnalyticsProvider({
  endpoint,
  enabled = true,
  children
}: {
  endpoint: string
  enabled?: boolean
  children: React.ReactNode
}): React.ReactElement {
  const owner = useRef<
    | {
        endpoint: string
        client: AnalyticsClient
        generation: number
      }
    | undefined
  >(undefined)
  const [client, setClient] = useState<AnalyticsClient>()
  useEffect(() => {
    if (!enabled) return
    if (owner.current?.endpoint !== endpoint) {
      owner.current?.client.close().catch(() => {})
      owner.current = {
        endpoint,
        generation: 0,
        client: new AnalyticsClient({
          endpoint,
          app: Platform.OS === 'web' ? 'TS web' : 'TS',
          version: buildInfo.version + '+' + buildInfo.buildNumber,
          id: randomUuid,
          storage: deviceStorage
        })
      }
    }
    const current = owner.current
    const generation = ++current.generation
    setClient(current.client)
    const stop = observeLifecycle(
      active => {
        current.client.foreground(active)
      },
      () => {
        current.client.flush().catch(() => {})
      }
    )
    return () => {
      stop()
      // StrictMode's setup/cleanup/setup shares one owner and one session.
      queueMicrotask(() => {
        if (current.generation === generation) {
          current.client.close().catch(() => {})
          if (owner.current === current) owner.current = undefined
        }
      })
    }
  }, [endpoint, enabled])
  return (
    <Context.Provider value={enabled ? client : undefined}>
      {children}
    </Context.Provider>
  )
}

export function analyticsError(
  error: unknown
): 'offline' | 'invalid' | 'rate_limited' | 'internal' {
  const code =
    error != null && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined
  return code === 'offline'
    ? 'offline'
    : code === 'rateLimited'
      ? 'rate_limited'
      : ['unauthorized', 'badRequest', 'forbidden', 'gone'].includes(
            String(code)
          )
        ? 'invalid'
        : 'internal'
}

/** Only fixed route names cross the analytics boundary. */
export function analyticsPage(name: string): string {
  if (
    name === 'signIn' ||
    name === 'signInLink' ||
    name === 'oauthApprove' ||
    name === 'oauthNative'
  )
    return 'login'
  if (name === 'createGame' || name === 'createGroup') return 'create'
  if (name === 'scoreGame' || name === 'scoreOptions') return 'scoring'
  if (name === 'streaming') return 'stream'
  return name
}
