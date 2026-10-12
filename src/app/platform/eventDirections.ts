import { googleDirectionsUrl } from './eventDirectionsNative'

export async function openEventDirections(address: string): Promise<void> {
  // A same-origin blank window returns a handle unless pop-ups were blocked.
  // Sever its opener before navigating it to any external content.
  const opened = window.open('about:blank', '_blank')
  if (opened == null)
    throw new Error(
      'Your browser blocked directions. Allow pop-ups and try again.'
    )
  opened.opener = null
  opened.location.replace(googleDirectionsUrl(address))
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
