import type { ReactNode } from 'react'

export interface GameRecording {
  /** Present only when this device can record and the viewer may film. */
  open?: () => void
  busy?: boolean
  error?: string
  screen?: ReactNode
}
