/**
 * The pictures a phone keeps: one file per picture it has drawn, in a
 * directory of the signed-in person's own, so a picture seen online is
 * there to draw offline.
 *
 * This is the rule both platforms share. The phone's files are written by
 * `imageCache.native.ts`; the web and the TV open no directory, and every
 * picture is drawn from its URL, as it always was.
 *
 * A file is named for the URL without its query: a signature that is still
 * on an old picture's URL, or a still's `?t=` token, changes on every answer,
 * and must not split one picture into many files.
 */

/** What a platform does with picture files. */
export interface PictureStorage {
  /** The directory that holds one person's pictures. */
  directoryOf: (userId: string) => string
  /** The names of the files in `directory`, none when it is not there. */
  list: (directory: string) => Promise<string[]>
  /**
   * Fetches `url` into `path`, replacing what is there only once every byte
   * has arrived: a download that fails leaves the previous file.
   */
  download: (url: string, path: string) => Promise<void>
  /** Deletes `directory` and every file in it. */
  remove: (directory: string) => Promise<void>
  /** What an `Image` is pointed at to draw the file at `path`. */
  uriOf: (path: string) => string
}

/** The URL a picture's file is named for: no query, no fragment. */
export function pictureFileKey(url: string): string {
  const end = url.search(/[?#]/)
  return end === -1 ? url : url.slice(0, end)
}

/**
 * The file name for a picture's key: two 32-bit hashes of it, so a long URL
 * makes a short name and no character of it reaches the file system.
 */
export function pictureFileName(key: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 15)
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
  return `${hex(a)}${hex(b)}`
}

/** What a picture is drawn from, and whether to fetch it again. */
export interface PictureChoice {
  /** The file, the URL, or nothing: the caller's fallback. */
  uri: string | undefined
  /** Fetch the URL into the file. */
  download: boolean
}

/**
 * The shared rule.
 *
 * - No URL: the fallback.
 * - No open directory (the web, the TV, nobody signed in): the URL.
 * - Offline: the file when there is one, the fallback when there is not.
 * - Online: the file when there is one, the URL until there is, and a fresh
 *   download unless one has already been made this session.
 */
export function choosePicture(options: {
  url: string | null | undefined
  /** The picture's file, with a directory open. */
  file: { uri: string; exists: boolean; fresh: boolean } | undefined
  offline: boolean
}): PictureChoice {
  const { url, file, offline } = options
  if (url == null || url === '') return { uri: undefined, download: false }
  if (file == null || !/^https?:\/\//.test(url))
    return { uri: url, download: false }
  if (offline)
    return { uri: file.exists ? file.uri : undefined, download: false }
  return { uri: file.exists ? file.uri : url, download: !file.fresh }
}

interface OpenDirectory {
  userId: string
  path: string
  /** The files in it, once they have been listed. */
  files: Set<string>
  /** The pictures fetched again since it was opened. */
  fresh: Set<string>
  /** The downloads under way, by file name. */
  fetching: Map<string, Promise<void>>
  /** The downloads that failed, not tried again until the network returns. */
  failed: Set<string>
}

/**
 * The signed-in person's picture directory: opened from `CachingClient.openFor`,
 * deleted from `signedOut` and `discard`. Without a `PictureStorage` (the
 * web) nothing is ever open, and every picture is its URL.
 */
export class PictureDirectories {
  private readonly storage: PictureStorage | undefined
  private opened: OpenDirectory | undefined
  private offlineNow = false
  private readonly listeners = new Set<() => void>()
  /** Directories deleted since they were last opened. */
  private readonly removed = new Set<string>()
  /** Bumped on each change, for `useSyncExternalStore`. */
  private version = 0

  constructor(storage?: PictureStorage) {
    this.storage = storage
  }

  /** Whose directory is open, if any. */
  get userId(): string | undefined {
    return this.opened?.userId
  }

  get offline(): boolean {
    return this.offlineNow
  }

  /** Whether the client could reach the server, as it last said. */
  set offline(value: boolean) {
    if (value === this.offlineNow) return
    this.offlineNow = value
    // Back online, a picture whose download failed is fetched again.
    if (!value) this.opened?.failed.clear()
    this.changed()
  }

  /** A change to draw again for: a directory, a file, the network. */
  get revision(): number {
    return this.version
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Opens `userId`'s directory, closing any other. */
  open(userId: string): void {
    const storage = this.storage
    if (storage == null || this.opened?.userId === userId) return
    const opened: OpenDirectory = {
      userId,
      path: storage.directoryOf(userId),
      files: new Set(),
      fresh: new Set(),
      fetching: new Map(),
      failed: new Set()
    }
    this.opened = opened
    this.removed.delete(opened.path)
    this.changed()
    storage.list(opened.path).then(
      names => {
        if (this.opened !== opened) return
        for (const name of names) opened.files.add(name)
        this.changed()
      },
      () => undefined
    )
  }

  /** Closes the open directory and keeps its files. */
  close(): void {
    if (this.opened == null) return
    this.opened = undefined
    this.changed()
  }

  /** Deletes `userId`'s directory, closing it when it is the open one. */
  async remove(userId: string): Promise<void> {
    const storage = this.storage
    if (storage == null) return
    if (this.opened?.userId === userId) this.close()
    const directory = storage.directoryOf(userId)
    this.removed.add(directory)
    await storage.remove(directory).catch(() => undefined)
  }

  /** What to draw for `url` now. */
  choose(url: string | null | undefined): PictureChoice {
    const opened = this.opened
    const storage = this.storage
    const name =
      url == null || url === '' ? '' : pictureFileName(pictureFileKey(url))
    return choosePicture({
      url,
      offline: this.offlineNow,
      file:
        opened == null || storage == null
          ? undefined
          : {
              uri: storage.uriOf(`${opened.path}/${name}`),
              exists: opened.files.has(name),
              fresh:
                opened.fresh.has(name) ||
                opened.fetching.has(name) ||
                opened.failed.has(name)
            }
    })
  }

  /**
   * Fetches `url` into its file, once at a time and once a session. A
   * download that fails leaves the file that was there, and is tried again
   * once the client is back online.
   */
  async refresh(url: string): Promise<void> {
    const opened = this.opened
    const storage = this.storage
    if (opened == null || storage == null) return
    const name = pictureFileName(pictureFileKey(url))
    const under = opened.fetching.get(name)
    if (under != null) {
      await under
      return
    }
    const fetching = (async () => {
      try {
        await storage.download(url, `${opened.path}/${name}`)
        opened.fresh.add(name)
        opened.files.add(name)
      } catch {
        // The file that was there, if any, is still what is drawn.
        opened.failed.add(name)
      } finally {
        opened.fetching.delete(name)
      }
      // Signed out while it downloaded: the file it wrote goes too.
      if (this.removed.has(opened.path))
        await storage.remove(opened.path).catch(() => undefined)
      if (this.opened === opened) this.changed()
    })()
    opened.fetching.set(name, fetching)
    await fetching
  }

  private changed(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}
