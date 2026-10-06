/** What both video twins take: where the opened file is, and its box. */
export interface ChatVideoProps {
  /** A Blob URL on the web, a `file://` cache path on a phone. */
  uri: string
  width: number
  height: number
  label: string
}
