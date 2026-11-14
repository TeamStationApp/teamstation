import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore
} from 'react'
import { Image, type ImageProps } from 'react-native'

import { type PictureChoice, PictureDirectories } from '../sync/imageCacheRule'

/**
 * The picture files pictures are drawn from: the phone's `CachingClient`'s,
 * which the app provides and which it opens for the signed-in person. With
 * none provided — the web, the TV — no directory is ever open and each
 * picture is its URL. Only the shared rule is imported here, so the TV's
 * bundle never loads the phone's file module.
 */
export const PictureDirectoriesContext = createContext<PictureDirectories>(
  new PictureDirectories()
)

/**
 * What to point an `Image` at for `url`, or undefined for the caller's
 * fallback (`choosePicture`). Online, it fetches the picture into its file,
 * and draws the file once the file is there.
 */
export function useCachedPicture(
  url: string | null | undefined
): string | undefined {
  const directories = useContext(PictureDirectoriesContext)
  const subscribe = useCallback(
    (listener: () => void) => directories.subscribe(listener),
    [directories]
  )
  // What this picture draws, as text: another picture's download changes
  // the directory, not this choice, and does not draw this one again.
  const snapshot = (): string => JSON.stringify(directories.choose(url))
  const choice = JSON.parse(
    useSyncExternalStore(subscribe, snapshot, snapshot)
  ) as PictureChoice
  useEffect(() => {
    if (choice.download && url != null)
      directories.refresh(url).catch(() => undefined)
  }, [choice.download, directories, url])
  return choice.uri
}

export type CachedPictureProps = Omit<ImageProps, 'source' | 'onError'> & {
  /** The remote picture. */
  uri: string | null | undefined
  /**
   * Drawn when there is no picture to draw: no URL, offline with no file,
   * or a picture that will not load.
   */
  fallback?: React.ReactNode
}

/**
 * A remote picture, drawn from the phone's file of it when there is one
 * (`useCachedPicture`). A file on screen stays there until the new bytes
 * replace it; with no open directory — the web, the TV — it is the URL.
 */
export function CachedPicture(props: CachedPictureProps): React.ReactElement {
  const { uri, fallback = null, ...image } = props
  const shown = useCachedPicture(uri)
  const [failed, setFailed] = useState<string>()
  if (shown == null || shown === failed) return <>{fallback}</>
  return (
    <Image
      {...image}
      source={{ uri: shown }}
      onError={() => {
        setFailed(shown)
      }}
    />
  )
}
