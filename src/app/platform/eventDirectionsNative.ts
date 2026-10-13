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

export async function openNativeDirections(
  address: string,
  platform: string,
  links: MappingLinks,
  sheet: MappingSheet
): Promise<void> {
  const query = encodeURIComponent(address)
  if (platform === 'ios') {
    let hasGoogle = false
    try {
      hasGoogle = await links.canOpenURL('comgooglemaps://')
    } catch {}
    const urls = [
      `https://maps.apple.com/?q=${query}`,
      ...(hasGoogle ? [`comgooglemaps://?q=${query}`] : [])
    ]
    const options = [
      'Apple Maps',
      ...(hasGoogle ? ['Google Maps'] : []),
      'Cancel'
    ]
    await new Promise<void>((resolve, reject) => {
      sheet.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1 },
        index => {
          if (index < 0 || index >= urls.length) {
            resolve()
            return
          }
          links.openURL(urls[index]).then(() => {
            resolve()
          }, reject)
        }
      )
    })
    return
  }
  try {
    await links.openURL(`geo:0,0?q=${query}`)
  } catch {
    await links.openURL(googleDirectionsUrl(address))
  }
}
