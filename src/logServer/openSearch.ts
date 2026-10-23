import https from 'node:https'

import {
  APPS,
  type EventRecord,
  LEVELS,
  userId
} from '../common/observability/contract'

export interface LogDocument extends EventRecord {
  N: string
  T: string
}
export type SearchTransport = (
  method: string,
  path: string,
  body?: unknown
) => Promise<unknown>
export function environment(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value))
    throw new Error('Invalid logging environment')
  return value
}
export function indexOf(row: LogDocument): string {
  return `logs-v1-${environment(row.N)}-${row.D.slice(0, 10).replaceAll('-', '.')}`
}

/** TLS is always verified against the provider hostname and optional supplied CA. */
export function searchTransport(options: {
  url: string
  username: string
  password: string
  ca?: string
}): SearchTransport {
  const origin = new URL(options.url)
  if (
    origin.protocol !== 'https:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  )
    throw new Error('Invalid OpenSearch origin')
  return async (method, path, body) =>
    await new Promise((resolve, reject) => {
      const content =
        body == null
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body)
      const request = https.request(
        new URL(path, origin),
        {
          method,
          ca: options.ca,
          auth: options.username + ':' + options.password,
          timeout: 10000,
          headers: {
            'content-type':
              typeof body === 'string'
                ? 'application/x-ndjson'
                : 'application/json'
          }
        },
        response => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 2 * 1024 * 1024) {
              response.destroy()
              reject(new Error('OpenSearch response too large'))
              return
            }
            chunks.push(chunk)
          })
          response.on('error', () => {
            reject(new Error('OpenSearch response failed'))
          })
          response.on('end', () => {
            if (
              response.statusCode == null ||
              response.statusCode < 200 ||
              response.statusCode >= 300
            ) {
              reject(new Error('OpenSearch request failed'))
              return
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch {
              reject(new Error('Invalid OpenSearch response'))
            }
          })
        }
      )
      request.on('timeout', () => {
        request.destroy(new Error('OpenSearch timeout'))
      })
      request.on('error', () => {
        reject(new Error('OpenSearch connection failed'))
      })
      request.end(content)
    })
}

export class OpenSearch {
  constructor(private readonly request: SearchTransport) {}
  async setup(): Promise<void> {
    const keyword = { type: 'keyword', ignore_above: 128 }
    const properties: Record<string, unknown> = {}
    for (const key of [
      'pg',
      'mt',
      'sp',
      'ec',
      'id',
      'ty',
      'vi',
      'ps',
      'op',
      'c',
      'f0',
      'f1',
      'f2'
    ])
      properties[key] = keyword
    for (const key of [
      'ms',
      'pos',
      'dur',
      'rt',
      'bytes',
      'status',
      'n',
      'l0',
      'l1',
      'l2',
      'c0',
      'c1',
      'c2'
    ])
      properties[key] = { type: 'double' }
    for (const key of ['ok', 'on']) properties[key] = { type: 'boolean' }
    // Updating an existing policy requires its sequence number; reuse an already installed policy.
    let existing = false
    try {
      await this.request('GET', '/_plugins/_ism/policies/logs-v1-retention')
      existing = true
    } catch {}
    if (!existing)
      await this.request('PUT', '/_plugins/_ism/policies/logs-v1-retention', {
        policy: {
          description: 'Expire operational logs after thirty days',
          default_state: 'active',
          states: [
            {
              name: 'active',
              actions: [],
              transitions: [
                { state_name: 'delete', conditions: { min_index_age: '30d' } }
              ]
            },
            { name: 'delete', actions: [{ delete: {} }], transitions: [] }
          ],
          ism_template: [{ index_patterns: ['logs-v1-*'], priority: 100 }]
        }
      })
    await this.request('PUT', '/_index_template/logs-v1', {
      index_patterns: ['logs-v1-*'],
      priority: 100,
      template: {
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: {
          dynamic: 'strict',
          properties: {
            D: { type: 'date' },
            T: { type: 'date' },
            A: keyword,
            I: keyword,
            E: keyword,
            L: keyword,
            N: keyword,
            V: keyword,
            S: keyword,
            R: { type: 'integer' },
            P: { type: 'object', dynamic: 'strict', properties }
          }
        }
      }
    })
    // Templates cover future indexes; existing daily indexes need new fields too.
    await this.request(
      'PUT',
      '/logs-v1-*/_mapping?allow_no_indices=true&ignore_unavailable=true',
      {
        properties: { P: { type: 'object', dynamic: 'strict', properties } }
      }
    )
  }

  async bulk(rows: LogDocument[]): Promise<Array<'done' | 'retry' | 'drop'>> {
    const body = rows
      .map(
        row =>
          JSON.stringify({ index: { _index: indexOf(row), _id: row.I } }) +
          '\n' +
          JSON.stringify(row) +
          '\n'
      )
      .join('')
    const response = (await this.request('POST', '/_bulk', body)) as {
      items?: Array<{ index?: { status?: number } }>
    }
    if (!Array.isArray(response.items) || response.items.length !== rows.length)
      throw new Error('Invalid bulk response')
    return response.items.map(item => {
      const status = item.index?.status
      if (typeof status !== 'number') return 'retry'
      if (status >= 200 && status < 300) return 'done'
      return status === 408 || status === 429 || status >= 500
        ? 'retry'
        : 'drop'
    })
  }

  async search(input: unknown): Promise<unknown> {
    const { prefix, body } = searchQuery(input)
    return await this.request('POST', `/${prefix}/_search`, body)
  }
}

/** Deliberately bounded typed search, never an arbitrary OpenSearch proxy. */
export function searchQuery(input: unknown): { prefix: string; body: unknown } {
  if (input == null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid search')
  const value = input as Record<string, unknown>
  if (
    Object.keys(value).some(
      k =>
        ![
          'environment',
          'from',
          'to',
          'app',
          'event',
          'level',
          'session',
          'user',
          'limit',
          'groupBy'
        ].includes(k)
    )
  )
    throw new Error('Invalid search fields')
  if (typeof value.environment !== 'string')
    throw new Error('Environment required')
  const prefix = `logs-v1-${environment(value.environment)}-*`
  const from = Date.parse(String(value.from))
  const to = Date.parse(String(value.to))
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to < from ||
    to - from > 31 * 86400000
  )
    throw new Error('Invalid search window')
  const filter: unknown[] = [
    {
      range: {
        D: {
          gte: new Date(from).toISOString(),
          lte: new Date(to).toISOString()
        }
      }
    }
  ]
  for (const [key, field] of [
    ['app', 'A'],
    ['event', 'E'],
    ['level', 'L'],
    ['session', 'S'],
    ['user', 'U']
  ] as const) {
    const item = value[key]
    if (item == null) continue
    if (
      typeof item !== 'string' ||
      item.length > 100 ||
      !/^[A-Za-z0-9_ -]+$/.test(item) ||
      (key === 'app' && !APPS.includes(item as never)) ||
      (key === 'level' && !LEVELS.includes(item as never)) ||
      (key === 'user' && userId(item) == null)
    )
      throw new Error('Invalid filter')
    filter.push({ term: { [field]: item } })
  }
  const size = value.limit ?? 100
  if (
    typeof size !== 'number' ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > 1000
  )
    throw new Error('Invalid result limit')
  const body: Record<string, unknown> = {
    query: { bool: { filter } },
    size,
    sort: [{ D: 'desc' }],
    timeout: '2s',
    track_total_hits: 10000
  }
  if (value.groupBy != null) {
    if (
      typeof value.groupBy !== 'string' ||
      !['A', 'E', 'L', 'U', 'P.ec'].includes(value.groupBy)
    )
      throw new Error('Invalid aggregation')
    body.aggs = { groups: { terms: { field: value.groupBy, size: 100 } } }
  }
  return { prefix, body }
}
