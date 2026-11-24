import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * For a test's own stand-in Space that keeps objects in a map by path
 * (`/<bucket>/<key>`): answers a ListObjectsV2 and a DELETE as the Space does,
 * and says whether it did. Anything else is the caller's to answer.
 */
export function answerListOrDelete(
  held: Map<string, Buffer>,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const url = new URL(req.url ?? '/', 'http://space')
  if (req.method === 'DELETE') {
    held.delete(url.pathname)
    res.writeHead(204).end()
    return true
  }
  if (req.method !== 'GET' || url.searchParams.get('list-type') !== '2')
    return false
  const bucket = url.pathname.split('/')[1] ?? ''
  const prefix = url.searchParams.get('prefix') ?? ''
  const contents = [...held.entries()]
    .map(([path, body]) => [path.slice(bucket.length + 2), body] as const)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, body]) =>
        `<Contents><Key>${key}</Key><Size>${body.length}</Size><ETag>"e"</ETag></Contents>`
    )
  res
    .writeHead(200, { 'content-type': 'application/xml' })
    .end(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contents.join('')}</ListBucketResult>`
    )
  return true
}
