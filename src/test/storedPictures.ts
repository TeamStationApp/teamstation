import {
  PictureDirectories,
  pictureFileKey,
  pictureFileName
} from '../app/sync/imageCache'

/**
 * A picture directory open for `usr_1` that already holds a file of each of
 * `urls`, as a phone does after drawing them online. Offline unless told.
 */
export async function storedPictures(
  urls: string[],
  offline = true
): Promise<{
  directories: PictureDirectories
  fileOf: (url: string) => string
}> {
  const directory = '/docs/pictures/usr_1'
  const names = urls.map(url => pictureFileName(pictureFileKey(url)))
  const directories = new PictureDirectories({
    directoryOf: () => directory,
    list: async () => names,
    download: async () => {
      throw new Error('offline')
    },
    remove: async () => undefined,
    uriOf: path => `file://${path}`
  })
  directories.offline = offline
  directories.open('usr_1')
  // The listing lands after the open.
  await new Promise(resolve => setTimeout(resolve, 0))
  return {
    directories,
    fileOf: url => `file://${directory}/${pictureFileName(pictureFileKey(url))}`
  }
}
