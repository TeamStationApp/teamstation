import { PictureDirectories } from './imageCacheRule'

export * from './imageCacheRule'

/**
 * The web's pictures, which keeps no files: no directory ever opens, and
 * every picture is drawn from the URL it was given. The phone's files are
 * `imageCache.native.ts`.
 */
export const pictureDirectories = new PictureDirectories()
