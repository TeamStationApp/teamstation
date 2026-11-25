// The sponsor screens' types: the wire shapes from src/common/sponsors, and
// the files the screens pick and shrink before they are uploaded.
import type { PickedFile as CommonPickedFile } from '../../common/sponsors/types'

export type {
  EventPlacement,
  PlacementDraft,
  PlacementField,
  PlacementProblems,
  SampleVideo,
  SponsoredTextColor,
  SponsorLogo,
  SponsorMediaPurpose,
  SponsorReel,
  SponsorState,
  SponsorTotals
} from '../../common/sponsors/types'

/**
 * A file the administrator dropped, chose or picked from the photo album,
 * held as a URL the preview shows. A phone's album also says how large a
 * picture or video is and how long a video runs.
 */
export interface PickedFile extends CommonPickedFile {
  width?: number
  height?: number
  durationSec?: number
}

/**
 * A picked file after it was shrunk on the device, with its bytes for the
 * upload and a URL for the preview. It is a `PickedFile` too, so the
 * screens' file checks and previews take it as they take a picked one.
 */
export interface PreparedFile extends PickedFile {
  bytes: Uint8Array
  width: number
  height: number
  durationMs?: number
}
