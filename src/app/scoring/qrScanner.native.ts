import React, { useEffect, useRef, useState } from 'react'
import { PermissionsAndroid, Platform } from 'react-native'

import { type QrScannerProps, qrScannerStatusOf } from './qrScannerProps'
import TSQrScanner from './TSQrScannerNativeComponent'

/** A phone scans with its camera. */
export const qrScannerSupported = true

/**
 * The phone's QR camera, `TSQrScanner`. It reports each code once, as the
 * native view sends a code for every frame it sees it in, and maps the view's
 * statuses to the app's. On Android it asks for the camera itself, once per
 * scan step and only after the view has said there is one, before it turns the
 * camera on; a refusal is reported as `denied`, not asked again. iOS asks in
 * the view. A device with no camera is never asked.
 */
export function QrScanner({
  active,
  onCode,
  onStatus
}: QrScannerProps): React.ReactElement {
  const [present, setPresent] = useState(false)
  const [allowed, setAllowed] = useState(Platform.OS !== 'android')
  const last = useRef<string>(undefined)
  // The sheet passes a new onStatus on every render; the request must not
  // follow it, or each render would ask again while the dialog is up and a
  // refusal would only bring the dialog back.
  const status = useRef(onStatus)
  status.current = onStatus
  const asked = useRef(false)
  const refused = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const refuse = (): void => {
    refused.current = true
    status.current('denied')
  }
  useEffect(() => {
    if (!present || allowed || asked.current || Platform.OS !== 'android')
      return
    asked.current = true
    PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA)
      .then(result => {
        if (!mounted.current) return
        if (result === PermissionsAndroid.RESULTS.GRANTED) setAllowed(true)
        else refuse()
      })
      .catch(() => {
        if (mounted.current) refuse()
      })
  }, [present, allowed])
  useEffect(() => {
    // Stopped for a warning: Scan Again reads whatever is in view again.
    if (!active) {
      last.current = undefined
      return
    }
    if (!refused.current) return
    // After a refusal, Scan Again looks again, with no dialog: the scorer may
    // have allowed the camera in Settings. If not, it says so again, as iOS
    // does, rather than leave a dark square.
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA)
      .then(granted => {
        if (!mounted.current) return
        if (granted) {
          refused.current = false
          setAllowed(true)
        } else status.current('denied')
      })
      .catch(() => {
        if (mounted.current) status.current('denied')
      })
  }, [active])
  return React.createElement(TSQrScanner, {
    style: { flex: 1 },
    active: active && present && allowed,
    onCode: event => {
      const { text } = event.nativeEvent
      if (text === last.current) return
      last.current = text
      onCode(text)
    },
    onStatus: event => {
      const { status } = event.nativeEvent
      if (status === 'available') {
        setPresent(true)
        return
      }
      onStatus(qrScannerStatusOf(status))
    }
  })
}
