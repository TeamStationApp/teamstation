// A picture or video picked from a phone's photo album, as the sponsor
// screens hold it: the album's name, type, size and file URL, and what it
// says of the asset's dimensions and length.
import type {
  Asset,
  ImageLibraryOptions,
  ImagePickerResponse
} from 'react-native-image-picker'

import type { PickedFile } from './sponsorTypes'

export type LaunchLibrary = (
  options: ImageLibraryOptions
) => Promise<ImagePickerResponse>

/** What a pick is for: a picture for logos and row images, a video for reels. */
export type PickKind = 'photo' | 'video'

/** The sentence for an album that could not be opened. */
export const ALBUM_UNAVAILABLE =
  'The photo library could not be opened. Please try again.'

/** iOS calls JPEG `image/jpg`; the checks know it as `image/jpeg`. */
function standardType(type: string | undefined, kind: PickKind): string {
  if (type == null || type === '')
    return kind === 'video' ? 'video/mp4' : 'application/octet-stream'
  return type === 'image/jpg' ? 'image/jpeg' : type
}

/** The album's asset as a `PickedFile`, or `null` when it has no file. */
export function pickedFileOfAsset(
  asset: Asset,
  kind: PickKind
): PickedFile | null {
  if (asset.uri == null || asset.uri === '') return null
  const last = asset.uri.replace(/.*\//, '')
  const name = asset.fileName ?? (last === '' ? 'file' : last)
  return {
    name,
    type: standardType(asset.type, kind),
    size: asset.fileSize ?? 0,
    url: asset.uri,
    ...(asset.width != null ? { width: asset.width } : {}),
    ...(asset.height != null ? { height: asset.height } : {}),
    ...(asset.duration != null ? { durationSec: asset.duration } : {})
  }
}

/**
 * Opens the album for one picture or video. Answers the picked file, `null`
 * when the administrator cancelled, and rejects with a sentence when the
 * album could not be opened.
 */
export async function pickFromLibrary(
  launch: LaunchLibrary,
  kind: PickKind
): Promise<PickedFile | null> {
  const result = await launch({
    mediaType: kind,
    selectionLimit: 1,
    assetRepresentationMode: 'current'
  })
  if (result.didCancel === true) return null
  if (result.errorCode != null) throw new Error(ALBUM_UNAVAILABLE)
  const asset = result.assets?.[0]
  if (asset == null) return null
  return pickedFileOfAsset(asset, kind)
}

/**
 * The length of a picked video, in seconds, as the album gave it. Rejects
 * when the album did not say, which the reels screen refuses.
 */
export async function readVideoDuration(picked: PickedFile): Promise<number> {
  if (picked.durationSec == null || !Number.isFinite(picked.durationSec))
    throw new Error('This video could not be read. Try another file.')
  return picked.durationSec
}
