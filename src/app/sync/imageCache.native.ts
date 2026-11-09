import ReactNativeBlobUtil from 'react-native-blob-util'

import { PictureDirectories, type PictureStorage } from './imageCacheRule'

export * from './imageCacheRule'

const { fs } = ReactNativeBlobUtil

/**
 * The phone's picture files, written with `react-native-blob-util` under the
 * app's documents: `pictures/<userId>/<name>`, one directory per person. The
 * web's twin, which keeps none, is `imageCache.ts`.
 */
const storage: PictureStorage = {
  directoryOf: userId =>
    `${fs.dirs.DocumentDir}/pictures/${encodeURIComponent(userId)}`,
  list: async directory =>
    (await fs.isDir(directory)) ? await fs.ls(directory) : [],
  download: async (url, path) => {
    const directory = path.slice(0, path.lastIndexOf('/'))
    if (!(await fs.isDir(directory))) await fs.mkdir(directory)
    // Into a file of its own first: the picture on screen is replaced only
    // by a whole one.
    const part = `${path}.part`
    try {
      const answer = await ReactNativeBlobUtil.config({ path: part }).fetch(
        'GET',
        url
      )
      const status = answer.info().status
      if (status < 200 || status > 299)
        throw new Error(`The picture answered ${status}`)
      if (await fs.exists(path)) await fs.unlink(path)
      await fs.mv(part, path)
    } finally {
      if (await fs.exists(part)) await fs.unlink(part)
    }
  },
  remove: async directory => {
    if (await fs.exists(directory)) await fs.unlink(directory)
  },
  uriOf: path => `file://${path}`
}

export const pictureDirectories = new PictureDirectories(storage)
