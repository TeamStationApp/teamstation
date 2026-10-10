import { imageKey, type ImageSize } from './images'
import { presignGetUrl } from './presign'
import { spaceConfigured, type SpaceSettings } from './spacesHls'

/**
 * A URL the app can draw a picture from.
 *
 * The app never builds one itself, for the same reason it never builds a media
 * URL: only the server knows where a picture lives and whether the person
 * asking may see it. These are photographs of children, so the bucket stays
 * private and every link is signed and short-lived.
 *
 * Six hours, matching the playback grace. An image URL is cheap to re-fetch
 * and a page open longer than that has been reloaded anyway.
 */
const IMAGE_URL_SECONDS = 6 * 60 * 60

/** The size a list tile draws. */
export const TILE_SIZE: ImageSize = 96
/** The size a profile draws. */
export const PROFILE_SIZE: ImageSize = 192

export function imageUrl(
  space: SpaceSettings,
  pathPrefix: string | null,
  size: ImageSize = TILE_SIZE,
  now?: Date
): string | null {
  if (pathPrefix == null || pathPrefix === '') return null
  if (!spaceConfigured(space)) return null
  return presignGetUrl({
    endpoint: space.endpoint,
    region: space.region,
    bucket: space.bucket,
    accessKeyId: space.accessKeyId,
    secretAccessKey: space.secretAccessKey,
    readOnlySource: space.readOnlySource,
    key: imageKey(pathPrefix, size),
    expiresSec: IMAGE_URL_SECONDS,
    pathStyle: space.pathStyle,
    now
  })
}
