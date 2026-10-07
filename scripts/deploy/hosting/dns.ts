import { isIP } from 'node:net'

import { asArray, asObject, asOptional, asString } from 'cleaners'

import { integer, text } from '../validation'
import type { Dns } from './config'

const asRecord = asObject({
  id: integer(1),
  type: asString,
  name: asString,
  data: asString
})
const asPage = asObject({
  domain_records: asArray(asRecord),
  links: asOptional(
    asObject({ pages: asOptional(asObject({ next: asOptional(asString) })) })
  )
})
export class DnsRecords {
  constructor(
    readonly config: Dns,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch
  ) {
    text()(token)
  }

  private async request(
    endpoint: string,
    method = 'GET',
    body?: unknown
  ): Promise<unknown> {
    const url = `https://api.digitalocean.com/v2/domains/${encodeURIComponent(this.config.domain)}/records${endpoint}`
    const response = await this.fetcher(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json'
      },
      body: body == null ? undefined : JSON.stringify(body)
    })
    if (!response.ok) throw new Error('DNS request failed')
    if (method === 'DELETE') return undefined
    let bytes = 0
    const chunks: Buffer[] = []
    if (response.body == null) throw new Error('Missing DNS response')
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 1024 * 1024) {
        await response.body.cancel().catch(() => {})
        throw new Error('DNS response is too large')
      }
      chunks.push(Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks).toString())
  }

  async records(): Promise<Array<ReturnType<typeof asRecord>>> {
    const out: Array<ReturnType<typeof asRecord>> = []
    for (let page = 1; page <= 100; page++) {
      const result = asPage(await this.request(`?per_page=200&page=${page}`))
      out.push(...result.domain_records)
      if (result.links?.pages?.next == null) return out
    }
    throw new Error('Too many DNS records')
  }

  async ensure(
    type: 'A' | 'AAAA',
    ipv6Verified = false
  ): Promise<number | undefined> {
    const address = type === 'A' ? this.config.address : this.config.ipv6
    if (
      address == null ||
      (type === 'AAAA' && !ipv6Verified) ||
      isIP(address) !== (type === 'A' ? 4 : 6)
    )
      throw new Error('DNS address has not been verified')
    const current = (await this.records()).filter(
      record => record.name === this.config.name
    )
    if (
      current.some(
        record =>
          record.type === 'CNAME' ||
          (record.type === type && record.data !== address)
      )
    )
      throw new Error('Conflicting DNS record; no changes made')
    if (current.some(record => record.type === type)) return undefined
    const result = asObject({ domain_record: asRecord })(
      await this.request('', 'POST', {
        type,
        name: this.config.name,
        data: address,
        ttl: 300
      })
    )
    if (
      result.domain_record.type !== type ||
      result.domain_record.name !== this.config.name ||
      result.domain_record.data !== address
    )
      throw new Error('DNS response did not match requested record')
    return result.domain_record.id
  }

  async rollback(id: number, type: 'A' | 'AAAA'): Promise<void> {
    const current = (await this.records()).find(record => record.id === id)
    if (current == null) return
    if (
      current.type !== type ||
      current.name !== this.config.name ||
      current.data !== (type === 'A' ? this.config.address : this.config.ipv6)
    )
      throw new Error('DNS record changed; manual reconciliation required')
    await this.request(`/${integer(1)(id)}`, 'DELETE')
  }
}
