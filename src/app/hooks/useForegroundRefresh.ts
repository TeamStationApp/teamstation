import { useEffect } from 'react'
import { AppState } from 'react-native'

import { usePageActive } from '../components/TabPages'

interface ForegroundHost {
  document?: { visibilityState?: string }
  addEventListener?: (name: string, action: () => void) => void
  removeEventListener?: (name: string, action: () => void) => void
}

/**
 * Refresh on foreground entry and every thirty seconds while visible.
 *
 * Inside a pill page kept out of sight it reads nothing — a season of rows
 * on a page nobody can see would each read every half minute — and reads
 * once it is chosen again.
 */
export function useForegroundRefresh(refresh: () => Promise<void>): void {
  const active = usePageActive()
  useEffect(() => {
    if (!active) return
    let alive = true
    const root = globalThis as unknown as ForegroundHost & {
      window?: ForegroundHost
    }
    const host = root.window ?? root
    const visible = (): boolean =>
      host.document?.visibilityState !== 'hidden' &&
      (AppState.currentState == null || AppState.currentState === 'active')
    const run = (): void => {
      if (alive && visible()) refresh().catch(() => undefined)
    }
    run()
    const timer = setInterval(run, 30000)
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') run()
    })
    host.addEventListener?.('focus', run)
    host.addEventListener?.('visibilitychange', run)
    return () => {
      alive = false
      clearInterval(timer)
      subscription.remove()
      host.removeEventListener?.('focus', run)
      host.removeEventListener?.('visibilitychange', run)
    }
  }, [refresh, active])
}
