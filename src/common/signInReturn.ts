/**
 * A `next` is a path on this site and nothing else.
 *
 * Without this it is an open redirect: `/sign-in?next=//evil.example` reads as
 * a protocol-relative URL and sends somebody who has just typed their password
 * to another site. One leading slash, and never two.
 */
export function safeNext(raw: string | null | undefined): string | undefined {
  if (raw == null || raw === '') return undefined
  if (!raw.startsWith('/')) return undefined
  if (raw.startsWith('//')) return undefined
  if (raw.includes('\\')) return undefined
  return raw
}
