import { expect } from 'chai'
import { describe, it } from 'mocha'

import { openDocumentCache } from './cache'
import { CachingClient } from './cachingClient'
import {
  choosePicture,
  PICTURE_FILES_KEPT,
  PictureDirectories,
  pictureDirectories,
  pictureFileKey,
  pictureFileName,
  type PictureStorage
} from './imageCache'

/** Picture files in memory, by directory, and every download asked for. */
function memoryStorage(): PictureStorage & {
  directories: Map<string, Map<string, string>>
  downloads: string[]
  /** Set to make each download fail. */
  failing: boolean
  /** Set to hold each download until `release`. */
  held?: Promise<void>
} {
  const directories = new Map<string, Map<string, string>>()
  const storage = {
    directories,
    downloads: [] as string[],
    failing: false,
    held: undefined as Promise<void> | undefined,
    directoryOf: (userId: string) => `/docs/pictures/${userId}`,
    list: async (directory: string) => [
      ...(directories.get(directory)?.keys() ?? [])
    ],
    download: async (url: string, path: string) => {
      storage.downloads.push(url)
      await storage.held
      if (storage.failing) throw new Error('offline')
      const at = path.lastIndexOf('/')
      const directory = path.slice(0, at)
      const files = directories.get(directory) ?? new Map<string, string>()
      files.set(path.slice(at + 1), url)
      directories.set(directory, files)
    },
    remove: async (directory: string) => {
      directories.delete(directory)
    },
    unlink: async (path: string) => {
      const at = path.lastIndexOf('/')
      directories.get(path.slice(0, at))?.delete(path.slice(at + 1))
    },
    uriOf: (path: string) => `file://${path}`
  }
  return storage
}

const URL_A = 'https://cdn.example.test/images/team/aa-192.png'
const settle = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('picture files', function () {
  it('names a file for the URL without its query, keeping the path', function () {
    expect(pictureFileKey(`${URL_A}?X-Amz-Signature=1`)).equals(URL_A)
    expect(pictureFileKey(URL_A)).equals(URL_A)
    expect(pictureFileKey(`${URL_A}#frag`)).equals(URL_A)
    // Two signatures of one path are one file.
    expect(
      pictureFileName(pictureFileKey(`${URL_A}?X-Amz-Signature=1&X-Amz-Date=2`))
    ).equals(pictureFileName(pictureFileKey(`${URL_A}?X-Amz-Signature=3`)))
    // A still's token is dropped; another second is another file.
    const still = 'https://app.test/api/v1/videos/v1/stills/12.jpg'
    expect(pictureFileKey(`${still}?t=abc`)).equals(still)
    expect(pictureFileName(still)).not.equals(
      pictureFileName(still.replace('12.jpg', '13.jpg'))
    )
    expect(pictureFileName(still)).matches(/^[0-9a-f]{16}$/)
  })

  it('chooses a download online, the file or the fallback offline, and the URL with no directory', function () {
    const file = { uri: 'file:///a', exists: true, fresh: false }
    expect(choosePicture({ url: URL_A, file, offline: false })).deep.equals({
      uri: 'file:///a',
      download: true
    })
    expect(
      choosePicture({
        url: URL_A,
        file: { ...file, exists: false },
        offline: false
      })
    ).deep.equals({ uri: URL_A, download: true })
    expect(
      choosePicture({
        url: URL_A,
        file: { ...file, fresh: true },
        offline: false
      })
    ).deep.equals({ uri: 'file:///a', download: false })
    expect(choosePicture({ url: URL_A, file, offline: true })).deep.equals({
      uri: 'file:///a',
      download: false
    })
    expect(
      choosePicture({
        url: URL_A,
        file: { ...file, exists: false },
        offline: true
      })
    ).deep.equals({ uri: undefined, download: false })
    // The TV and the web: no directory, the URL.
    expect(
      choosePicture({ url: URL_A, file: undefined, offline: true })
    ).deep.equals({ uri: URL_A, download: false })
    // A picture that is not on the network is never fetched.
    expect(
      choosePicture({ url: 'data:image/png;base64,AA', file, offline: false })
    ).deep.equals({ uri: 'data:image/png;base64,AA', download: false })
    expect(choosePicture({ url: '', file, offline: false })).deep.equals({
      uri: undefined,
      download: false
    })
    expect(choosePicture({ url: null, file, offline: false })).deep.equals({
      uri: undefined,
      download: false
    })
  })

  it('downloads once online, draws the file, and keeps it when a download fails', async function () {
    const storage = memoryStorage()
    const directories = new PictureDirectories(storage)
    const changes: number[] = []
    const stop = directories.subscribe(() => changes.push(directories.revision))
    directories.open('usr_1')
    expect(directories.userId).equals('usr_1')
    await settle()

    expect(directories.choose(`${URL_A}?sig=1`)).deep.equals({
      uri: `${URL_A}?sig=1`,
      download: true
    })
    // Two at once fetch once.
    await Promise.all([
      directories.refresh(`${URL_A}?sig=1`),
      directories.refresh(`${URL_A}?sig=2`)
    ])
    expect(storage.downloads).deep.equals([`${URL_A}?sig=1`])
    const file = `file:///docs/pictures/usr_1/${pictureFileName(URL_A)}`
    expect(directories.choose(`${URL_A}?sig=3`)).deep.equals({
      uri: file,
      download: false
    })

    // Offline: the file, and the fallback for a picture never stored.
    directories.offline = true
    expect(directories.offline).equals(true)
    expect(directories.choose(URL_A).uri).equals(file)
    expect(directories.choose(`${URL_A}x`).uri).equals(undefined)

    // A new session fetches again; a failed download keeps the file.
    directories.close()
    directories.offline = false
    directories.open('usr_1')
    await settle()
    expect(directories.choose(URL_A)).deep.equals({ uri: file, download: true })
    storage.failing = true
    await directories.refresh(URL_A)
    expect(directories.choose(URL_A)).deep.equals({
      uri: file,
      download: false
    })
    // Signed again, as an expired signature is, it is tried again at once;
    // the URL that failed is not (2.harness-review.2).
    expect(directories.choose(`${URL_A}?sig=new`).download).equals(true)
    expect(directories.choose(URL_A).download).equals(false)
    // Back online, it is fetched again.
    directories.offline = true
    directories.offline = false
    expect(directories.choose(URL_A).download).equals(true)
    stop()
    expect(changes.length).greaterThan(0)
  })

  it('keeps the files drawn or written most recently, and deletes the rest', async function () {
    expect(PICTURE_FILES_KEPT).greaterThan(100)
    const storage = memoryStorage()
    const at = (letter: string): string =>
      `https://cdn.example.test/images/team/${letter}-192.png`
    const name = (letter: string): string => pictureFileName(at(letter))
    // Listed oldest first: an earlier session's files.
    storage.directories.set(
      '/docs/pictures/usr_1',
      new Map([
        [name('old'), at('old')],
        [name('older'), at('older')]
      ])
    )
    const directories = new PictureDirectories(storage, 3)
    directories.open('usr_1')
    const held = (): string[] =>
      [...(storage.directories.get('/docs/pictures/usr_1')?.keys() ?? [])]
        .map(
          file =>
            ['old', 'older', 'a', 'b', 'c', 'd'].find(l => name(l) === file) ??
            file
        )
        .sort()
    // A replaced picture is drawn from a new URL, so a new file.
    await directories.refresh(at('a'))
    await settle()
    expect(held()).deep.equals(['a', 'old', 'older'])
    await directories.refresh(at('b'))
    // The listing's first, the least recently written, goes.
    expect(held()).deep.equals(['a', 'b', 'older'])
    // Drawn again, a file is used most recently.
    expect(directories.choose(at('older')).uri).contains(name('older'))
    await directories.refresh(at('c'))
    expect(held()).deep.equals(['b', 'c', 'older'])
    directories.offline = true
    expect(directories.choose(at('a')).uri).equals(undefined)
    expect(directories.choose(at('b')).uri).contains(name('b'))
  })

  it('ignores a listing or download that lands after its directory closed', async function () {
    const storage = memoryStorage()
    storage.directories.set('/docs/pictures/usr_1', new Map([['x', URL_A]]))
    const directories = new PictureDirectories(storage)
    directories.open('usr_1')
    directories.open('usr_1')
    directories.close()
    directories.close()
    await settle()
    expect(directories.userId).equals(undefined)
    expect(directories.choose(URL_A)).deep.equals({
      uri: URL_A,
      download: false
    })
    await directories.refresh(URL_A)
    expect(storage.downloads).deep.equals([])

    let release = (): void => {}
    storage.held = new Promise(resolve => {
      release = resolve
    })
    directories.open('usr_2')
    const fetching = directories.refresh(URL_A)
    directories.open('usr_3')
    release()
    await fetching
    expect(directories.userId).equals('usr_3')
    expect(storage.directories.has('/docs/pictures/usr_2')).equals(true)

    // Signed out while a download is under way: what it wrote goes too.
    storage.held = new Promise(resolve => {
      release = resolve
    })
    const late = directories.refresh(URL_A)
    await directories.remove('usr_3')
    release()
    await late
    expect(storage.directories.has('/docs/pictures/usr_3')).equals(false)
  })

  it('deletes the signed-out person’s pictures and leaves another person’s', async function () {
    const storage = memoryStorage()
    const directories = new PictureDirectories(storage)
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      fetch: async () => {
        throw new TypeError('offline')
      },
      openCache: openDocumentCache,
      pictureFiles: directories
    })
    client.openFor('usr_2')
    await directories.refresh(URL_A)
    client.openFor('usr_1')
    expect(directories.userId).equals('usr_1')
    await directories.refresh(URL_A)
    expect([...storage.directories.keys()].sort()).deep.equals([
      '/docs/pictures/usr_1',
      '/docs/pictures/usr_2'
    ])

    await client.signedOut()
    expect(directories.userId).equals(undefined)
    expect([...storage.directories.keys()]).deep.equals([
      '/docs/pictures/usr_2'
    ])

    // Refused, the directory closes and keeps its files.
    client.openFor('usr_2')
    await client.sessionRefused()
    expect(directories.userId).equals(undefined)
    expect([...storage.directories.keys()]).deep.equals([
      '/docs/pictures/usr_2'
    ])
    // Discarded while closed, it is deleted.
    await client.discard('usr_2')
    expect(storage.directories.size).equals(0)

    // The client's network state is the pictures'.
    client.offline = true
    expect(directories.offline).equals(true)
    client.offline = false
    expect(directories.offline).equals(false)
  })

  it('keeps no files on the web, where every picture is its URL', async function () {
    pictureDirectories.open('usr_1')
    expect(pictureDirectories.userId).equals(undefined)
    expect(pictureDirectories.choose(`${URL_A}?sig=1`)).deep.equals({
      uri: `${URL_A}?sig=1`,
      download: false
    })
    await pictureDirectories.refresh(URL_A)
    await pictureDirectories.remove('usr_1')
    expect(pictureDirectories.userId).equals(undefined)
  })
})
