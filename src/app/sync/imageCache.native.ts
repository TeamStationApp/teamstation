import ReactNativeBlobUtil from 'react-native-blob-util'

import {
  isPictureAnswer,
  PictureDirectories,
  type PictureStorage
} from './imageCacheRule'

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
  // The least recently written first: every picture drawn online is
  // fetched again once a session, so that is how recently it was drawn.
  list: async directory =>
    (await fs.isDir(directory))
      ? (await fs.lstat(directory))
          .filter(
            file => file.type === 'file' && !file.filename.endsWith('.part')
          )
          .sort((a, b) => Number(a.lastModified) - Number(b.lastModified))
          .map(file => file.filename)
      : [],
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
      const { status, headers } = answer.info()
      const named = Object.entries(
        (headers ?? {}) as Record<string, unknown>
      ).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
      const type = typeof named === 'string' ? named : undefined
      if (!isPictureAnswer(status, type))
        throw new Error(`The picture answered ${status} ${type ?? ''}`)
      if (await fs.exists(path)) await fs.unlink(path)
      await fs.mv(part, path)
    } finally {
      if (await fs.exists(part)) await fs.unlink(part)
    }
  },
  remove: async directory => {
    if (await fs.exists(directory)) await fs.unlink(directory)
  },
  unlink: async path => {
    if (await fs.exists(path)) await fs.unlink(path)
  },
  uriOf: path => `file://${path}`
}

export const pictureDirectories = new PictureDirectories(storage)
