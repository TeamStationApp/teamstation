import { createHash } from 'node:crypto'

import { httpsOrigin } from '../validation'
import type { Remote } from './config'

export function digest(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}
export function service(remote: Remote, prune = false): string {
  const { root } = remote
  return `[Unit]
Description=Application distribution${prune ? ' retention' : ''}
After=network-online.target

[Service]
Type=${prune ? 'oneshot' : 'simple'}
User=${remote.user}
Group=${remote.group}
WorkingDirectory=${root}/current
ExecStart=${remote.node} ${root}/current/lib/cli.js ${prune ? 'prune' : 'serve'} --config ${root}/config.json
${prune ? '' : 'Restart=on-failure\nRestartSec=5\n'}UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${root}/state
MemoryMax=${remote.memoryBytes}
TasksMax=${remote.tasks}
LimitNOFILE=4096
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30s
LogRateLimitBurst=100

[Install]
WantedBy=multi-user.target
`
}
export function timer(remote: Remote): string {
  return `[Unit]\nDescription=Application distribution retention schedule\n\n[Timer]\nOnCalendar=hourly\nPersistent=true\nRandomizedDelaySec=300\nUnit=${remote.service}-prune.service\n\n[Install]\nWantedBy=timers.target\n`
}
export function caddySite(origin: string, port: number): string {
  const host = new URL(httpsOrigin(origin)).host
  return `${host} {\n\t# Request URLs can contain short-lived installation credentials.\n\tlog_skip\n\treverse_proxy 127.0.0.1:${port}\n}\n`
}
export const oauthRoutes = `\n\t@masonOAuth {\n\t\tpath /oauth/* /.well-known/openid-configuration\n\t\tnot path /oauth/approve/*\n\t}\n\tlog_skip /oauth/*\n\thandle @masonOAuth {\n\t\treverse_proxy 127.0.0.1:{args[0]}\n\t}\n`
export function buildRedirect(origin: string): string {
  return `\n\t@masonLegacyBuilds path /builds /builds/*\n\thandle @masonLegacyBuilds {\n\t\theader Cache-Control no-store\n\t\tredir ${httpsOrigin(origin)}/ 302\n\t}\n`
}
interface Block {
  header: string
  start: number
  open: number
  end: number
  depth: number
}
/** Locate structural blocks while leaving all unmodified bytes intact. Placeholders are tokens. */
export function blocks(input: string): Block[] {
  const out: Block[] = []
  const stack: Block[] = []
  let start = 0
  let quoted = false
  let comment = false
  let escaped = false
  for (let i = 0; i < input.length; ++i) {
    const char = input[i]
    if (comment) {
      if (char === '\n') {
        comment = false
        start = i + 1
      }
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === '#') {
      comment = true
      continue
    }
    if (char === '\n') {
      start = i + 1
      continue
    }
    if (
      char === '{' &&
      (i === 0 || /\s/.test(input[i - 1])) &&
      (i + 1 === input.length || /\s/.test(input[i + 1]))
    ) {
      const block = {
        header: input.slice(start, i).trim(),
        start,
        open: i,
        end: -1,
        depth: stack.length
      }
      stack.push(block)
      out.push(block)
      start = i + 1
    } else if (
      char === '}' &&
      (i === 0 || /\s/.test(input[i - 1])) &&
      (i + 1 === input.length || /\s/.test(input[i + 1]))
    ) {
      const block = stack.pop()
      if (block == null) throw new Error('Unbalanced Caddy configuration')
      block.end = i + 1
      start = i + 1
    }
  }
  if (stack.length !== 0 || quoted)
    throw new Error('Unbalanced Caddy configuration')
  return out
}
export function caddyCandidate(
  live: string,
  remote: Remote,
  origin: string
): string {
  const parsed = blocks(live)
  const only = (header: string): Block => {
    const matches = parsed.filter(
      block => block.depth === 0 && block.header === header
    )
    if (matches.length !== 1)
      throw new Error('Caddy site or snippet is ambiguous')
    return matches[0]
  }
  const snippet = only(`(${remote.teamstationSnippet})`)
  const site = only(new URL(remote.teamstationOrigin).host)
  const old = parsed.filter(
    block =>
      block.depth === 1 &&
      block.start > site.open &&
      block.end < site.end &&
      block.header === 'handle /builds/*'
  )
  const edits: Array<{ start: number; end: number; value: string }> = []
  const section = live.slice(site.open, site.end)
  if (old.length === 1)
    edits.push({
      start: old[0].start,
      end: old[0].end,
      value: buildRedirect(origin)
    })
  else if (old.length > 1) throw new Error('Ambiguous legacy build route')
  else if (!section.includes('@masonLegacyBuilds'))
    edits.push({
      start: site.open + 1,
      end: site.open + 1,
      value: buildRedirect(origin)
    })
  else if (!section.includes(`redir ${httpsOrigin(origin)}/ 302`))
    throw new Error('Existing build destination differs')
  if (!live.slice(snippet.open, snippet.end).includes('@masonOAuth'))
    edits.push({
      start: snippet.open + 1,
      end: snippet.open + 1,
      value: oauthRoutes
    })
  for (const edit of edits.sort((a, b) => b.start - a.start))
    live = live.slice(0, edit.start) + edit.value + live.slice(edit.end)
  const include = `import ${remote.caddyInclude}`
  if (!live.split('\n').some(line => line.trim() === include))
    live += `\n${include}\n`
  return live
}
