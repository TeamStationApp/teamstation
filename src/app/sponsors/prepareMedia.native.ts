// Shrinking a picked file on a phone before it is uploaded, through the
// app's `SponsorMedia` module: the platform's own image code for pictures,
// and its hardware H.264 encoder (AVFoundation on iOS, Media3 Transformer on
// Android) for reels. The server only checks what arrives.
import { NativeModules } from 'react-native'

import {
  LOGO_BOX,
  REEL_BOX,
  REEL_MAX_BYTES,
  ROW_BACKGROUND_BOX,
  ROW_LOGO_SIZE,
  sizeProblem
} from '../../common/sponsors/limits'
import {
  reelLengthProblem,
  SponsorRuleError
} from '../../common/sponsors/sponsorRules'
import { REEL_ENCODING } from './reelEncoding'
import type {
  PickedFile,
  PreparedFile,
  SponsorMediaPurpose
} from './sponsorTypes'

type PictureFormat = 'png' | 'jpeg'

interface NativePicture {
  uri: string
  bytes: number
  width: number
  height: number
}

/** The native module, as src/app/sponsors/prepareMedia.native.ts calls it. */
export interface SponsorMediaModule {
  resizeImage: (
    uri: string,
    maxWidth: number,
    maxHeight: number,
    format: PictureFormat
  ) => Promise<NativePicture>
  cropSquare: (
    uri: string,
    size: number,
    format: PictureFormat
  ) => Promise<NativePicture>
  cropCover: (
    uri: string,
    width: number,
    height: number,
    format: PictureFormat
  ) => Promise<NativePicture>
  encodeReel: (
    uri: string,
    options: {
      width: number
      height: number
      fps: number
      videoBitrate: number
      audioBitrate: number
    }
  ) => Promise<NativePicture & { durationMs: number }>
}

export interface NativeMedia {
  module: SponsorMediaModule | undefined
  /** A local file's bytes. */
  readBytes: (uri: string) => Promise<Uint8Array>
}

const UNSHRINKABLE = 'This file could not be shrunk. Try another file.'

export const phoneMedia: NativeMedia = {
  get module() {
    return (NativeModules as { SponsorMedia?: SponsorMediaModule }).SponsorMedia
  },
  readBytes: async uri => new Uint8Array(await (await fetch(uri)).arrayBuffer())
}

/** A native refusal as the sentence it carries. */
function asRuleError(caught: unknown): SponsorRuleError {
  if (caught instanceof SponsorRuleError) return caught
  const message =
    caught instanceof Error && caught.message !== ''
      ? caught.message
      : UNSHRINKABLE
  return new SponsorRuleError(message)
}

/**
 * `picked`, shrunk for `purpose` and ready to upload. A file that cannot be
 * shrunk rejects with the sentence the screen shows.
 */
export async function prepareMedia(
  purpose: SponsorMediaPurpose,
  picked: PickedFile,
  media: NativeMedia = phoneMedia
): Promise<PreparedFile> {
  const module = media.module
  if (module == null) throw new SponsorRuleError(UNSHRINKABLE)
  const format: PictureFormat =
    purpose === 'logo' || picked.type === 'image/png' ? 'png' : 'jpeg'
  try {
    if (purpose === 'reel') {
      // The album says how long the video is, so a wrong length is refused
      // before anything is encoded.
      const tooLong = reelLengthProblem(picked.durationSec ?? NaN)
      if (tooLong != null) throw new SponsorRuleError(tooLong)
      const reel = await module.encodeReel(picked.url, {
        width: REEL_BOX.width,
        height: REEL_BOX.height,
        fps: REEL_ENCODING.frameRate,
        videoBitrate: REEL_ENCODING.videoBitrate,
        audioBitrate: REEL_ENCODING.audioBitrate
      })
      if (reel.bytes > REEL_MAX_BYTES)
        throw new SponsorRuleError(
          sizeProblem('reel', reel.bytes) ?? UNSHRINKABLE
        )
      const bytes = await media.readBytes(reel.uri)
      return {
        name: picked.name,
        type: 'video/mp4',
        size: bytes.length,
        bytes,
        url: reel.uri,
        width: reel.width,
        height: reel.height,
        durationMs: reel.durationMs,
        durationSec: reel.durationMs / 1000
      }
    }
    const shrunk =
      purpose === 'logo'
        ? await module.resizeImage(
            picked.url,
            LOGO_BOX.width,
            LOGO_BOX.height,
            format
          )
        : purpose === 'rowLogo'
          ? await module.cropSquare(picked.url, ROW_LOGO_SIZE, format)
          : await module.cropCover(
              picked.url,
              ROW_BACKGROUND_BOX.width,
              ROW_BACKGROUND_BOX.height,
              format
            )
    const bytes = await media.readBytes(shrunk.uri)
    const type = format === 'png' ? 'image/png' : 'image/jpeg'
    return {
      name: picked.name,
      type,
      size: bytes.length,
      bytes,
      url: shrunk.uri,
      width: shrunk.width,
      height: shrunk.height
    }
  } catch (caught) {
    throw asRuleError(caught)
  }
}
