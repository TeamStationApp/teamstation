/** The URL has already been obtained from the authenticated attachment endpoint. */
export async function readPreviewBlob(
  url: string,
  size: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort()
  }
  if (signal?.aborted === true) abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    controller.abort()
  }, 5000)
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      referrerPolicy: 'no-referrer'
    })
    const length = response.headers.get('content-length')
    if (
      !response.ok ||
      response.body == null ||
      (length != null && Number(length) !== size)
    )
      throw Error('Invalid thumbnail response')
    const reader = response.body.getReader()
    const result = new Uint8Array(size)
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.length > size - received) throw Error('Oversized thumbnail')
      result.set(value, received)
      received += value.length
    }
    if (received !== size) throw Error('Incomplete thumbnail')
    return result
  } finally {
    signal?.removeEventListener('abort', abort)
    clearTimeout(timer)
    controller.abort()
  }
}
