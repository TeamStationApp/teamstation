import { createHash, createHmac } from 'node:crypto'

/**
 * A presigned URL for an S3-compatible object store.
 *
 * DigitalOcean Spaces speaks S3, so this is AWS Signature Version 4 with
 * `s3` as the service and the Space's region. It is computed locally and
 * involves no request to the Space at all: the signature is a function of the
 * key, the time and the secret, nothing more.
 *
 * `Range` is deliberately not part of the signature, which is what lets a
 * player seek: one signed URL serves every byte range of the video.
 *
 * `PUT` signs the same way, so uploading needs no second implementation and
 * no SDK. The payload is unsigned either way, so a body of any size can be
 * streamed against a signature computed before a byte of it is read.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256'
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

/** Existing shared objects can be read without granting the primary writer access. */
export interface ReadOnlySpaceSource {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  pathStyle?: boolean
  keys: readonly string[]
}

export interface PresignOptions {
  /**
   * The verb the URL is good for. A signature covers the method, so a URL
   * signed for `GET` cannot be used to write, nor to delete. Defaults to
   * `GET`.
   */
  method?: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE'
  /** e.g. `https://sfo3.digitaloceanspaces.com`. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** The object's key within the bucket, without a leading slash. */
  key: string
  /** How long the URL stays good for. */
  expiresSec: number
  /**
   * Extra query parameters, which are **signed with the rest**.
   *
   * What listing a prefix needs — `list-type` and `prefix` — and the reason
   * they cannot simply be appended to the returned URL: the signature covers
   * the canonical query, so a parameter added afterwards invalidates it.
   */
  query?: Record<string, string>
  /** Defaults to now. */
  now?: Date
  /**
   * Put the bucket in the host rather than the path. This is what AWS and
   * Spaces both want; path style exists for test doubles that cannot do
   * wildcard DNS.
   */
  pathStyle?: boolean
  readOnlySource?: ReadOnlySpaceSource
}

export function isReadOnlySourceKey(
  options: Pick<PresignOptions, 'readOnlySource'>,
  key: string
): boolean {
  return key !== '' && options.readOnlySource?.keys.includes(key) === true
}

export function presignGetUrl(options: PresignOptions): string {
  const {
    method = 'GET',
    key,
    expiresSec,
    query: extra = {},
    now = new Date()
  } = options
  const readSource = options.readOnlySource
  const signingSpace =
    method === 'GET' && readSource != null && isReadOnlySourceKey(options, key)
      ? readSource
      : options
  const {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    pathStyle = false
  } = signingSpace

  const url = new URL(endpoint)
  const host = pathStyle ? url.host : `${bucket}.${url.host}`
  const path = pathStyle ? `/${bucket}/${encodeKey(key)}` : `/${encodeKey(key)}`

  const amzDate = amzTimestamp(now)
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${region}/s3/aws4_request`

  // The query must be sorted by key, and each part encoded the strict way.
  const query = new Map<string, string>([
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSec)],
    ['X-Amz-SignedHeaders', 'host'],
    ...Object.entries(extra)
  ])
  const canonicalQuery = [...query.entries()]
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    UNSIGNED_PAYLOAD
  ].join('\n')

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest)
  ].join('\n')

  const signature = hmac(
    signingKey(secretAccessKey, dateStamp, region),
    stringToSign
  ).toString('hex')

  return `${url.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/** `20130524T000000Z`. */
function amzTimestamp(when: Date): string {
  return when
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/** The key, with each path segment encoded but the slashes left alone. */
function encodeKey(key: string): string {
  return key.split('/').map(rfc3986).join('/')
}

/**
 * `encodeURIComponent` leaves `!'()*` alone; AWS wants them encoded, and wants
 * nothing else encoded that it does not ask for.
 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const date = hmac(Buffer.from(`AWS4${secret}`, 'utf8'), dateStamp)
  const regional = hmac(date, region)
  const service = hmac(regional, 's3')
  return hmac(service, 'aws4_request')
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}
