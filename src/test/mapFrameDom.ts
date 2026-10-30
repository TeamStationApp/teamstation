/**
 * The document a map's frame is sent once it says it is ready, as a page test
 * reads it: the frame itself never loads in a test's DOM.
 */
export function mapDocumentOf(iframe: HTMLIFrameElement | null): string {
  const target = iframe?.contentWindow
  if (target == null) return ''
  let html = ''
  target.postMessage = ((data: { html: string }) => {
    html = data.html
  }) as Window['postMessage']
  const ready = new window.Event('message')
  Object.defineProperties(ready, {
    data: { value: { type: 'teamstation:mapFrameReady' } },
    source: { value: target }
  })
  window.dispatchEvent(ready)
  return html
}
