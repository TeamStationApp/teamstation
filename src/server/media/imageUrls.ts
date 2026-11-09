import { imageKey, type ImageSize, isPublicImagePrefix } from './images'
import { isReadOnlySourceKey, presignGetUrl } from './presign'
import { mediaBase, spaceConfigured, type SpaceSettings } from './spacesHls'

/**
 * A URL the app can draw a picture from.
 *
 * The app never builds one itself, for the same reason it never builds a media
 * URL: only the server knows where a picture lives and whether the person
 * asking may see it. A picture this server stored under a random name is a
 * public object, and its URL is a plain one on `mediaBase`, the same every
 * time, so a phone can keep the file under it. The bucket still lists
 * nothing, so the name is the secret. Every other picture — a shared catalog
 * picture, or one stored before names were random — stays private, and its
 * link is signed and short-lived.
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
  const key = imageKey(pathPrefix, size)
  if (isPublicImagePrefix(pathPrefix)) {
    // The read-only source holds the object it lists, under its own base.
    const source = space.readOnlySource
    const base =
      source != null && isReadOnlySourceKey(space, key)
        ? mediaBase(source)
        : mediaBase(space)
    return `${base}/${key}`
  }
  return presignGetUrl({
    endpoint: space.endpoint,
    region: space.region,
    bucket: space.bucket,
    accessKeyId: space.accessKeyId,
    secretAccessKey: space.secretAccessKey,
    readOnlySource: space.readOnlySource,
    key,
    expiresSec: IMAGE_URL_SECONDS,
    pathStyle: space.pathStyle,
    now
  })
}
