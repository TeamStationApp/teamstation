/**
 * What a QR scanner reports: `ready` once the camera shows, `denied` when the
 * camera may not be used, and `unavailable` when there is no camera, as on
 * every simulator and emulator.
 */
export type QrScannerStatus = 'ready' | 'denied' | 'unavailable'

const STATUSES: readonly string[] = ['ready', 'denied', 'unavailable']

/** A native view's status, with anything this app does not know as no camera. */
export function qrScannerStatusOf(status: string): QrScannerStatus {
  return STATUSES.includes(status) ? (status as QrScannerStatus) : 'unavailable'
}

/** A live camera that reports each QR code it reads. */
export interface QrScannerProps {
  /** Whether the camera runs; it stops while a warning covers the scan. */
  active: boolean
  onCode: (text: string) => void
  onStatus: (status: QrScannerStatus) => void
}
