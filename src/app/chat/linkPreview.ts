import ipaddr from 'ipaddr.js'
import { type DefaultTreeAdapterTypes, parse } from 'parse5'

import type { ChatLinkPreview } from '../../common/chatLinkPreview'
import { PRIMARY_HOST, WEB_HOST } from '../../common/primaryUrl'
import { CacheUrl } from '../sync/cacheUrl'
import {
  chatLinkAddress,
  chatLinkSpans,
  outsideQuotedMailboxes
} from './chatMessageLinks'

export const MAX_HTML_BYTES = 256 * 1024
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const PREVIEW_TIMEOUT = 5000

export type PreviewOrigins = string | { active?: string; verified?: string }
export function previewDestination(
  address: string,
  appOrigin?: PreviewOrigins
): string | undefined {
  try {
    const url = new CacheUrl(address)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      (typeof appOrigin === 'string'
        ? url.origin === appOrigin
        : url.origin === appOrigin?.active ||
          url.origin === appOrigin?.verified) ||
      url.href.length > 2048
    )
      return
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
    if (
      [PRIMARY_HOST, WEB_HOST, 'teamstation.app'].some(
        domain => host === domain || host.endsWith('.' + domain)
      ) ||
      /(?:^|\.)(?:localhost|localdomain|local|lan|home|internal|test|invalid|example|onion|arpa)$/.test(
        host
      )
    )
      return
    if (ipaddr.isValid(host)) {
      const ip = ipaddr.process(host)
      if (
        ip.range() !== 'unicast' ||
        (ip.kind() === 'ipv6' && (ip.toByteArray()[0] & 224) !== 32)
      )
        return
    } else if (!host.includes('.')) return
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

export function firstPreviewUrl(
  body: string,
  appOrigin?: PreviewOrigins
): string | undefined {
  const first = chatLinkSpans(body)[0]
  if (first == null) return
  // A malformed or unfinished explicit address still occupies the first slot.
  const candidates = outsideQuotedMailboxes(body).matchAll(
    /(^|[^\p{L}\p{N}_.@+-])(https?:\/\/|www\.)/giu
  )
  for (const candidate of candidates) {
    const start = candidate.index + candidate[1].length
    if (start >= first.start) break
    const tail = body.slice(start).split(/\s/, 1)[0]
    if (!/^[^/?#]*@/.test(tail) || /^https?:\/\//i.test(tail)) return
  }
  const url = chatLinkAddress(first.text)
  return url == null ? undefined : previewDestination(url.href, appOrigin)
}

export type PreviewMetadata = Omit<ChatLinkPreview, 'thumbnail'> & {
  imageUrl?: string
}

const plain = (text: string, limit: number): string =>
  Array.from(
    text
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  )
    .slice(0, limit)
    .join('')

/** Parse the head as data. No document or resource-loading element is created. */
export function pageMetadata(
  html: string,
  url: string,
  appOrigin?: PreviewOrigins
): PreviewMetadata | undefined {
  const doc = parse(html)
  const root = doc.childNodes.find(node => node.nodeName === 'html') as
    DefaultTreeAdapterTypes.Element | undefined
  const head = root?.childNodes.find(node => node.nodeName === 'head') as
    DefaultTreeAdapterTypes.Element | undefined
  const values = new Map<string, string>()
  let pageTitle = ''
  for (const node of head?.childNodes ?? []) {
    if (!('tagName' in node)) continue
    if (node.tagName === 'title')
      pageTitle ||= node.childNodes
        .map(n => ('value' in n ? n.value : ''))
        .join('')
    if (node.tagName !== 'meta') continue
    const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]))
    const name = (attrs.property ?? attrs.name ?? '').trim().toLowerCase()
    if ((attrs.content ?? '').trim() !== '' && !values.has(name))
      values.set(name, attrs.content)
  }
  const field = (name: string, fallback: string, limit: number): string => {
    const value = plain(values.get(name) ?? '', limit)
    return value !== '' ? value : plain(fallback, limit)
  }
  const title = field('og:title', pageTitle, 256)
  const description = field(
    'og:description',
    values.get('description') ?? '',
    512
  )
  const siteName = field('og:site_name', new CacheUrl(url).hostname, 96)
  let imageUrl: string | undefined
  const raw = values.get('og:image:secure_url') ?? values.get('og:image')
  if (raw != null) {
    try {
      imageUrl = previewDestination(new CacheUrl(raw, url).href, appOrigin)
    } catch {
      /* Ignore a malformed optional thumbnail. */
    }
  }
  if (title === '' && description === '' && imageUrl == null) return
  return {
    url,
    title,
    description,
    siteName,
    ...(imageUrl == null ? {} : { imageUrl })
  }
}
