export interface MappingLinks {
  canOpenURL: (url: string) => Promise<boolean>
  openURL: (url: string) => Promise<unknown>
}
export interface MappingSheet {
  showActionSheetWithOptions: (
    options: { options: string[]; cancelButtonIndex: number },
    chosen: (index: number) => void
  ) => void
}

export function googleDirectionsUrl(address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`
}

/** The URLs one destination opens in each maps app. */
interface MappingUrls {
  apple: string
  google: string
  android: string
  /** Google's web directions, when Android has no geo handler. */
  web: string
}

/**
 * Opens a destination: on iOS a sheet offers Apple Maps, and Google Maps
 * when it is installed; on Android the geo handler, falling back to
 * Google's web directions.
 */
async function openMappingUrls(
  urls: MappingUrls,
  platform: string,
  links: MappingLinks,
  sheet: MappingSheet
): Promise<void> {
  if (platform === 'ios') {
    let hasGoogle = false
    try {
      hasGoogle = await links.canOpenURL('comgooglemaps://')
    } catch {}
    const choices = [urls.apple, ...(hasGoogle ? [urls.google] : [])]
    const options = [
      'Apple Maps',
      ...(hasGoogle ? ['Google Maps'] : []),
      'Cancel'
    ]
    await new Promise<void>((resolve, reject) => {
      sheet.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1 },
        index => {
          if (index < 0 || index >= choices.length) {
            resolve()
            return
          }
          links.openURL(choices[index]).then(() => {
            resolve()
          }, reject)
        }
      )
    })
    return
  }
  try {
    await links.openURL(urls.android)
  } catch {
    await links.openURL(urls.web)
  }
}

export async function openNativeDirections(
  address: string,
  platform: string,
  links: MappingLinks,
  sheet: MappingSheet
): Promise<void> {
  const query = encodeURIComponent(address)
  await openMappingUrls(
    {
      apple: `https://maps.apple.com/?q=${query}`,
      google: `comgooglemaps://?q=${query}`,
      android: `geo:0,0?q=${query}`,
      web: googleDirectionsUrl(address)
    },
    platform,
    links,
    sheet
  )
}

/** A point to route to, and what a maps app calls it. */
export interface DirectionsPoint {
  latitude: number
  longitude: number
  label: string
}

/**
 * The URLs that route to a point, by its coordinates rather than an address:
 * Google's web directions, Apple Maps, the Google Maps app and Android's geo
 * handler. Apple and Android show the label.
 */
export function pointDirectionsUrls(point: DirectionsPoint): {
  web: string
  apple: string
  google: string
  android: string
} {
  const at = `${point.latitude},${point.longitude}`
  const label = encodeURIComponent(point.label)
  return {
    web: `https://www.google.com/maps/dir/?api=1&destination=${at}`,
    apple: `https://maps.apple.com/?daddr=${at}&q=${label}`,
    google: `comgooglemaps://?daddr=${at}`,
    android: `geo:${at}?q=${at}(${label})`
  }
}

/**
 * Routes to a point: on iOS a sheet offers Apple Maps, and Google Maps when
 * it is installed; on Android the geo handler, falling back to Google's web
 * directions.
 */
export async function openNativePointDirections(
  point: DirectionsPoint,
  platform: string,
  links: MappingLinks,
  sheet: MappingSheet
): Promise<void> {
  await openMappingUrls(pointDirectionsUrls(point), platform, links, sheet)
}
