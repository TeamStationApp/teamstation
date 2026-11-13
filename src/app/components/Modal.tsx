import React, { useEffect, useRef } from 'react'
import { Modal as NativeModal, type ModalProps, Platform } from 'react-native'

import {
  type ModalPresence,
  useModalPresence,
  useScreenClaimed
} from './modalPresence'

export interface AppModalProps extends ModalProps {
  /**
   * Claims the screen while on show: every other modal of the app's waits
   * until it has gone, and is not counted meanwhile (`modalPresence`).
   */
  claims?: boolean
}

/**
 * Where a modal hidden while still drawn says when it has gone
 * (`onDismiss`): iOS, once UIKit has finished dismissing it, and the
 * browser, once its animation out has ended. Android's is unmounted at once.
 */
const REPORTS_DISMISS = Platform.OS !== 'android'

/**
 * React Native's `Modal`, counted while on show (`modalPresence`), so the
 * app knows whether any modal is up, whichever screen drew it. Every modal
 * in the app is drawn through this one; lint refuses React Native's own.
 * While another modal claims the screen, this one waits, and shows once it
 * has gone.
 *
 * A modal counts until its dismissal has finished, not only until it is
 * hidden: iOS will not present one view controller while another is still
 * being dismissed from the same one, and drops the presentation, so the
 * next modal shows only after this one's `onDismiss`, or `dismissMs` after
 * it went where nothing reports that.
 */
export function Modal(props: AppModalProps): React.ReactElement {
  const { claims = false, visible = true, onDismiss, ...rest } = props
  const presence = useModalPresence()
  const claimed = useScreenClaimed()
  const shown = visible && (claims || !claimed)
  const dismissing = useHeldUntilDismissed(presence, shown, claims)
  return (
    <NativeModal
      {...rest}
      visible={shown}
      onDismiss={() => {
        dismissing.current?.()
        onDismiss?.()
      }}
    />
  )
}

/**
 * Holds `presence` (a claim, when `claims`) while `shown`, and lets go once
 * the dismissal after it has finished. Answers what finishes that
 * dismissal, for `onDismiss`.
 */
function useHeldUntilDismissed(
  presence: ModalPresence,
  shown: boolean,
  claims: boolean
): React.RefObject<(() => void) | undefined> {
  const dismissing = useRef<(() => void) | undefined>(undefined)
  // Declared before the hold, so its cleanup runs first at an unmount.
  const unmounted = useRef(false)
  useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
    }
  }, [])
  useEffect(() => {
    if (!shown) return
    const release = claims ? presence.claim() : presence.show()
    return () => {
      // Still drawn where `onDismiss` comes: it says when. Otherwise, or
      // should it never come, the dismissal is given its time.
      const reported = REPORTS_DISMISS && !unmounted.current
      const finish = (): void => {
        clearTimeout(timer)
        if (dismissing.current === finish) dismissing.current = undefined
        release()
      }
      const timer = setTimeout(
        finish,
        reported ? presence.dismissMs * 4 : presence.dismissMs
      )
      if (reported) dismissing.current = finish
    }
  }, [shown, claims, presence])
  return dismissing
}
