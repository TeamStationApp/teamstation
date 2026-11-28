import type { faultControl } from '../core/dropletStack'

export interface ViewportBox {
  left: number
  right: number
  width: number
  top: number
  bottom: number
  height: number
}
export interface Reading {
  documentId: string
  width: number
  small: number
  top: number
  bottom: number
  root?: ViewportBox
  strip?: ViewportBox
  deck?: ViewportBox
  catcher?: number
  holder?: ViewportBox
  face?: ViewportBox
  side?: ViewportBox
  boxScore?: ViewportBox
  menu?: ViewportBox
  logText?: string
  undo?: string
  collapsed?: boolean
  buttons?: Record<string, ViewportBox>
  landmarks?: {
    board: { top: number; width: number }
    corners: Array<[number, number]>
  }
  logBand?: ViewportBox
  notice?: ViewportBox
  noticeText?: string
  noticeTextBottom?: number
  log?: ViewportBox
  page: string
  exposed?: string | null
  insets: number[]
}
export function freshReading(
  control: ReturnType<typeof faultControl>,
  run: string
) {
  const originPath = `/api/v1/viewport-observation/${run}/`
  return async (
    channel: string,
    widthCheck: (r: Reading) => boolean
  ): Promise<Reading> => {
    const prefix = originPath + channel + '/'
    const rows = async (): Promise<Array<{ at: number; path: string }>> => {
      const rows = (await control.call(
        'GET',
        'requests?path=' + encodeURIComponent(prefix)
      )) as { requests: Array<{ at: number; path: string }> }
      return rows.requests
    }
    const previous = (await rows()).at(-1)?.at ?? 0
    for (const end = Date.now() + 15000; Date.now() < end;) {
      await new Promise(resolve => setTimeout(resolve, 400))
      const row = (await rows()).at(-1)
      if (row == null || row.at <= previous) continue
      const measurement = JSON.parse(
        Buffer.from(row.path.slice(prefix.length), 'base64url').toString()
      ) as Reading
      if (widthCheck(measurement)) return measurement
    }
    // The probe was checked as staged before the phone opened it
    // (requireStagedProbe): this is a page that sent nothing that matched.
    throw new Error(`No fresh ${channel} reading matched within 15 s`)
  }
}
