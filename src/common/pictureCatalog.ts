import manifest from './sportsCatalog.json'

export interface PictureCatalogEntry {
  id: string
  label: string
  kind: 'photo' | 'creation'
  prefix: string
  sha256: string
  width: number
  height: number
}

export const pictureCatalogVersion = manifest.version
export const pictureCatalog: PictureCatalogEntry[] = manifest.entries.map(
  entry => ({
    ...entry,
    kind: entry.kind as 'photo' | 'creation'
  })
)

export function catalogPicture(id: string): PictureCatalogEntry | undefined {
  return pictureCatalog.find(entry => entry.id === id)
}

export interface AvailablePicture extends PictureCatalogEntry {
  url: string
}

/** Selection stores a stable catalog id, never a caller-supplied image URL. */
export function asCatalogId(raw: unknown): string {
  if (typeof raw !== 'string' || catalogPicture(raw) == null)
    throw new TypeError('Choose a picture from the catalog')
  return raw
}
