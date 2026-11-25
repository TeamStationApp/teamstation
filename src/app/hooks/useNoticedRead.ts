import { useEffect, useRef } from 'react'

import { useSceneShown } from '../components/sceneShown'
import { usePageActive } from '../components/TabPages'

/**
 * Reads when the screen is first on show, and again each time it is shown
 * again: chosen again among a screen's pages, or uncovered by Back. Nothing
 * else reads: no timer, no return to the foreground. What changes while it
 * is on show reaches it as a notice, through `useScreenScope` or a user
 * topic, which `refresh` stands behind.
 *
 * A screen mounted out of sight (beneath the top, never on show) still has
 * its first read, so Back reveals it loaded; a page kept out of sight reads
 * nothing until it is chosen.
 */
export function useNoticedRead(refresh: () => Promise<void>): void {
  const pageActive = usePageActive()
  const shown = useSceneShown()
  const active = pageActive && shown
  const read = useRef(false)
  useEffect(() => {
    if (!active && read.current) return
    read.current = true
    refresh().catch(() => undefined)
  }, [refresh, active])
}
