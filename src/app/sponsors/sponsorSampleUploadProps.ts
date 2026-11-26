// What the node administrator's sample video Upload takes, on the web and
// on a phone.

/** A chosen sample video: its type and size, and its bytes once asked for. */
export interface PickedSample {
  contentType: string
  /** Its size in bytes, so one past the cap is refused before it is sent. */
  size: number
  bytes: () => Promise<Uint8Array>
}

export interface SponsorSampleUploadProps {
  /** An upload is on its way. */
  busy: boolean
  /** Something else on the card is being saved. */
  disabled?: boolean
  onPick: (picked: PickedSample) => void
}
