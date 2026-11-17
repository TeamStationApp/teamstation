import { readFileSync } from 'node:fs'

import { BlockedError } from '../../core/result'
import type { StreamingHandle } from '../../core/streamingStack'
import type { ClockBase } from './clockReader'

/**
 * A synthetic camera sent by the stack's publisher droplet, which replays its
 * pre-encoded fixture (replayServer.ts), driven from here through the
 * droplet's routes. This machine encodes nothing.
 */

/** The publisher droplet's control route and its token, from the stack's handle. */
export interface PublisherRoute {
  url: string
  token: string
}

/** The stack's publisher droplet, or why a scenario cannot run without one. */
export function requirePublisher(handle: StreamingHandle): PublisherRoute {
  const publisher = handle.publisher
  if (publisher == null) {
    throw new BlockedError(
      `stack "${handle.id}" has no publisher droplet for its cameras: take it down and bring it up again with stack up`
    )
  }
  return publisher
}

export interface DropletPublisherOptions {
  publisher: PublisherRoute
  label: string
  /** A mode-600 file holding the rtmp:// URL with its key, which goes to the droplet alone. */
  urlFile: string
}

/** How long a route may take beyond a cut's own seconds. */
const SLACK_MS = 60_000

export class DropletPublisher {
  private base: ClockBase | undefined

  constructor(
    private readonly options: DropletPublisherOptions,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  private async call(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const base = this.options.publisher.url.replace(/\/$/, '')
    const reply = await this.fetchFn(`${base}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.publisher.token}`,
        'content-type': 'application/json'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const answer = (await reply.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    if (!reply.ok) {
      throw new Error(
        `the publisher droplet answered ${method} ${this.options.label} with ${reply.status}${typeof answer.error === 'string' ? `: ${answer.error}` : ''}`
      )
    }
    return answer
  }

  /** Starts the camera at its fixture's beginning. */
  async start(): Promise<void> {
    const url = readFileSync(this.options.urlFile, 'utf8').trim()
    const answer = await this.call('PUT', this.options.label, { url }, SLACK_MS)
    this.base = {
      startedAtMs: Number(answer.startedAtMs),
      loopMs: Number(answer.loopMs)
    }
  }

  /** Drops it for `seconds`, then brings it back where the stream would have been. */
  async cut(
    seconds: number,
    options: { discontinuity?: boolean } = {}
  ): Promise<void> {
    await this.call(
      'POST',
      `${this.options.label}/cut`,
      { seconds, discontinuity: options.discontinuity === true },
      seconds * 1000 + SLACK_MS
    )
  }

  async stop(): Promise<void> {
    await this.call('DELETE', this.options.label, undefined, SLACK_MS)
  }

  /** Where its burned clock starts, once it has started. */
  clockBase(): ClockBase | undefined {
    return this.base
  }
}
