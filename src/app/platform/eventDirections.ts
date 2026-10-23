import {
  type DirectionsPoint,
  googleDirectionsUrl,
  pointDirectionsUrls
} from './eventDirectionsNative'

// React Native's global; the web build and the test bundles define it, and a
// test run under Node alone does not.
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __DEV__: boolean | undefined

export async function openEventDirections(address: string): Promise<void> {
  // Navigate directly so Safari never adds an intermediate blank history entry.
  // With noopener, a successful new tab can also return null.
  window.open(googleDirectionsUrl(address), '_blank', 'noopener,noreferrer')
}

/**
 * Routes to a point by its coordinates, in Google's web directions. A
 * development build logs the URL as `[directions] <url>`.
 */
export async function openPointDirections(
  point: DirectionsPoint
): Promise<void> {
  const url = pointDirectionsUrls(point).web
  if (typeof __DEV__ === 'boolean' && __DEV__)
    console.info('[directions] ' + url)
  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function copyEventAddress(address: string): Promise<void> {
  if (navigator.clipboard?.writeText != null) {
    await navigator.clipboard.writeText(address)
    return
  }
  const field = document.createElement('textarea')
  field.value = address
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  try {
    field.select()
    if (!document.execCommand('copy'))
      throw new Error(
        'The address could not be copied. Select and copy it instead.'
      )
  } finally {
    field.remove()
  }
}
