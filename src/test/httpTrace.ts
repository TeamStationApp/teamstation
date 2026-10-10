import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

const opened = new Set<string>()
function redact(value: unknown, key = ''): unknown {
  if (
    /password|token|code|base64|authorization|clienthash|link|salt|url/i.test(
      key
    )
  )
    return '[redacted]'
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value != null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, key)])
    )
  return value
}

/** Optional synthetic HTTP proof. Credentials and binary image data never enter it. */
export async function traceHttp(
  method: string,
  route: string,
  request: unknown,
  response: Response
): Promise<void> {
  const selected = process.env.TS_CREATION_HTTP_LOG
  if (selected == null) return
  const file = resolve(selected)
  if (file.startsWith(resolve(__dirname, '../..') + sep))
    throw new Error('Store HTTP proving logs outside the checkout')
  mkdirSync(dirname(file), { recursive: true })
  if (!opened.has(file)) {
    writeFileSync(
      file,
      '$ Real synthetic HTTP requests against the application router and PostgreSQL\n'
    )
    opened.add(file)
  }
  const text = await response.clone().text()
  let result: unknown
  try {
    result = JSON.parse(text)
  } catch {
    result = '[non-JSON response]'
  }
  appendFileSync(
    file,
    `$ ${method} /api/v1${route}\n${request == null ? '' : 'Input: ' + JSON.stringify(redact(request)) + '\n'}HTTP ${response.status}: ${JSON.stringify(redact(result))}\n\n`
  )
}
