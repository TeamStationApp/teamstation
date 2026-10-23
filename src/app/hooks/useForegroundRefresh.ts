import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'

import { useSceneShown } from '../components/sceneShown'
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
 * once it is chosen again. So does a screen kept covered beneath the top of
 * the stack, until Back shows it again. A screen mounted out of sight (one
 * beneath the top that has never been on show) still has its first read, so
 * Back reveals it loaded; only the repeats wait.
 */
export function useForegroundRefresh(refresh: () => Promise<void>): void {
  const pageActive = usePageActive()
  const shown = useSceneShown()
  const active = pageActive && shown
  const read = useRef(false)
  useEffect(() => {
    if (!active) {
      if (!read.current) {
        read.current = true
        refresh().catch(() => undefined)
      }
      return
    }
    read.current = true
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
