import { isIP } from 'node:net'
import path from 'node:path'

import { asArray, asOptional } from 'cleaners'

import { branchName, httpsOrigin, integer, object, text } from '../validation'

export function name(value: unknown): string {
  const out = text(80)(value)
  if (!/^[a-z][a-z0-9-]*$/.test(out)) throw new Error('Invalid service name')
  return out
}
export function remotePath(value: unknown): string {
  const out = text()(value)
  if (
    !/^\/[A-Za-z0-9_./-]+$/.test(out) ||
    path.posix.normalize(out) !== out ||
    out === '/'
  )
    throw new Error('Expected a normalized absolute server path')
  return out
}
export function hostname(value: unknown): string {
  const out = text(253)(value)
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(out) || out.includes('..'))
    throw new Error('Invalid hostname')
  return out
}
export const asDns = object({
  domain: hostname,
  name: hostname,
  address: (v: unknown): string => {
    const out = text(80)(v)
    if (isIP(out) !== 4) throw new Error('Expected IPv4 address')
    return out
  },
  ipv6: asOptional((v: unknown): string => {
    const out = text(80)(v)
    if (isIP(out) !== 6) throw new Error('Expected IPv6 address')
    return out
  }),
  tokenFile: text()
})
export const asRemote = object({
  root: remotePath,
  node: remotePath,
  npm: remotePath,
  user: name,
  group: name,
  service: name,
  systemdDirectory: remotePath,
  caddyFile: remotePath,
  caddyInclude: remotePath,
  caddy: remotePath,
  caddyService: name,
  protectedPaths: asArray(remotePath),
  teamstationOrigin: httpsOrigin,
  teamstationSnippet: name,
  port: integer(1024, 65535),
  memoryBytes: integer(256 * 1024 ** 2),
  tasks: integer(32, 4096),
  oauth: asOptional(
    object({
      serverConfigFile: remotePath,
      signingKeysFile: remotePath,
      storageKeyFile: remotePath,
      cookieKeysFile: remotePath,
      user: name,
      group: name,
      providerId: name,
      clientName: text(120)
    })
  )
})
export const asHosting = object({
  repository: text(),
  branch: branchName,
  configFile: text(),
  ssh: object({
    host: hostname,
    user: name,
    port: integer(1, 65535),
    identityFile: text(),
    knownHostsFile: text()
  }),
  remote: asRemote,
  dns: asOptional(asDns)
})
export type Hosting = ReturnType<typeof asHosting>
export type Remote = ReturnType<typeof asRemote>
export type Dns = ReturnType<typeof asDns>
export function validateLayout(remote: Remote): void {
  function overlaps(a: string, b: string): boolean {
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
  }
  if (
    remote.protectedPaths.length === 0 ||
    remote.user === 'root' ||
    remote.group === 'root'
  )
    throw new Error(
      'Dedicated service account and protected paths are required'
    )
  const outside = [
    remote.systemdDirectory,
    remote.caddyFile,
    remote.caddyInclude,
    remote.node,
    remote.npm,
    ...remote.protectedPaths
  ]
  if (
    outside.some(file => overlaps(file, remote.root)) ||
    remote.protectedPaths.some(file => overlaps(file, remote.caddyInclude)) ||
    remote.caddyFile === remote.caddyInclude
  )
    throw new Error('Mason must have an independent directory')
}
