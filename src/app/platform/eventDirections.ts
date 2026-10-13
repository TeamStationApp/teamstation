import { googleDirectionsUrl } from './eventDirectionsNative'

export async function openEventDirections(address: string): Promise<void> {
  // Navigate directly so Safari never adds an intermediate blank history entry.
  // With noopener, a successful new tab can also return null.
  window.open(googleDirectionsUrl(address), '_blank', 'noopener,noreferrer')
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
