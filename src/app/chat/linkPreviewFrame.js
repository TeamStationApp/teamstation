// Bundled into the opaque-origin preview frame. All network requests originate here.
window.addEventListener('message', async event => {
  if (
    event.source !== window.parent ||
    event.origin !== new URL(window.location.href).origin ||
    event.ports.length !== 1 ||
    event.data?.type !== 'read-preview'
  )
    return
  const port = event.ports[0]
  const { url, kind, id } = event.data
  const limit = kind === 'html' ? 256 * 1024 : 2 * 1024 * 1024
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  port.onmessage = () => controller.abort()
  try {
    const target = new URL(url)
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.origin === event.origin ||
      (kind !== 'html' && kind !== 'image')
    )
      throw Error()
    const request = new Request(target, {
      targetAddressSpace: 'public',
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal
    })
    if (request.targetAddressSpace !== 'public') throw Error()
    const response = await fetch(request)
    const contentType = response.headers.get('content-type') ?? ''
    const mime = contentType.split(';')[0].trim().toLowerCase()
    if (
      !response.ok ||
      (kind === 'html'
        ? mime !== 'text/html'
        : !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) ||
      (kind !== 'html' &&
        Number(response.headers.get('content-length')) > limit) ||
      response.body == null
    )
      throw Error()
    const reader = response.body.getReader()
    const buffer = new Uint8Array(limit)
    let size = 0
    for (;;) {
      const packet = await reader.read()
      if (packet.done) break
      const remaining = limit - size
      if (kind === 'html' && packet.value.length >= remaining) {
        buffer.set(packet.value.subarray(0, remaining), size)
        size = limit
        break
      }
      if (packet.value.length > remaining) throw Error()
      buffer.set(packet.value, size)
      size += packet.value.length
    }
    const bytes = buffer.slice(0, size).buffer
    port.postMessage(
      { id, bytes, mime: kind === 'html' ? contentType : mime },
      [bytes]
    )
  } catch {
    port.postMessage({ id })
  } finally {
    clearTimeout(timeout)
    controller.abort()
    port.close()
  }
})
