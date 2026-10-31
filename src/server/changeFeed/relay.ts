import { hostname } from 'node:os'

import { Client } from 'pg'

import {
  makeScoreboardClient,
  quit,
  type ScoreboardClient,
  scoreboardPrefix
} from '../scoreboard/scoreboardStore'
import type { ServerConfig } from '../serverConfig'
import { FEED_CHANNELS } from './feed'
import { feedChannelKey, feedControlKey, feedLeaderKey } from './valkeyFeed'

/** How the relay's connection shows in `pg_stat_activity`. */
export const RELAY_APPLICATION_NAME = 'teamstation-relay'

const LOCK_NAME = 'teamstation:feed-relay'

/** Extends the key only while it still names this leader. */
const RENEW_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`

/** Deletes the key only while it still names this leader. */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`

/** How long the end of a Postgres connection may hold up leaving the role. */
const HANG_UP_WAIT_MS = 1000

/**
 * The relay's connection. The lock goes when Postgres sees the session go, so
 * the settings that release it after a lost machine are the server's, sent at
 * startup: unacknowledged data gives up at 30 s, an idle peer at about the same.
 * `pg` has no `tcp_user_timeout` of its own, so the relay's own view of a lost
 * database rests on its socket keepalive and `checkMs` below.
 */
export function relayConnectionConfig(databaseUrl: string): {
  connectionString: string
  application_name: string
  keepAlive: boolean
  keepAliveInitialDelayMillis: number
  options: string
} {
  return {
    connectionString: databaseUrl,
    application_name: RELAY_APPLICATION_NAME,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    options:
      '-c tcp_keepalives_idle=10 -c tcp_keepalives_interval=5 ' +
      '-c tcp_keepalives_count=3 -c tcp_user_timeout=30000'
  }
}

export interface FeedRelayOptions {
  /** How often a candidate reads the leader key, and up to how much later. */
  pollMs?: number
  jitterMs?: number
  /** The leader key's expiry. */
  leaderTtlMs?: number
  /** How often the leader renews the key and sends its heartbeat. */
  beatMs?: number
  /** How often the leader asks its connection for an answer, and how long it waits. */
  checkMs?: number
  checkWaitMs?: number
  /** What the leader key says. */
  identity?: string
  /** The client it talks to Valkey with, once connected on start. */
  makeClient?: (
    url: string,
    log: (message: string) => void,
    name: string,
    caFile: string
  ) => ScoreboardClient
}

export interface FeedRelay {
  stop: () => Promise<void>
}

/** One turn in the role, from opening the connection to leaving it. */
interface Leadership {
  client: Client
  /** Notices go out. Those before this come before the resync, which covers them. */
  publishing: boolean
  /** The key may hold this leader's name. */
  claimed: boolean
  ended: boolean
  beat?: ReturnType<typeof setInterval>
  renewingSince?: number
  checkingSince?: number
  checkedAt: number
}

/**
 * Elects one process to hold the one direct connection that hears Postgres, and
 * has it publish each notice to Valkey, in the order received, which is commit
 * order.
 *
 * A candidate tries only when the leader key is missing, so standbys hold no
 * Postgres connection. A session lock decides between candidates, and goes with
 * the process, connection or machine. Anything sent while no one led went
 * unheard, so a new leader starts by publishing a control `resync`.
 *
 * Losing the connection, a failed publish or a lost renewal ends the turn, and
 * the process becomes a candidate again. Two leaders overlapping for a moment
 * is harmless: payloads are hints to read current data, and fan-outs coalesce.
 */
class Relay implements FeedRelay {
  private readonly redis: ScoreboardClient
  private readonly databaseUrl: string
  private readonly prefix: string
  private readonly identity: string
  private readonly pollMs: number
  private readonly jitterMs: number
  private readonly leaderTtlMs: number
  private readonly beatMs: number
  private readonly checkMs: number
  private readonly checkWaitMs: number
  private readonly log: (message: string) => void
  private leadership: Leadership | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private polling: Promise<void> | undefined
  private lastComplaint = ''
  private stopped = false

  constructor(
    config: Pick<ServerConfig, 'databaseUrl' | 'redis'>,
    log: (message: string) => void,
    options: FeedRelayOptions
  ) {
    this.databaseUrl = config.databaseUrl
    this.prefix = scoreboardPrefix(config.redis.prefix, config.databaseUrl)
    this.identity = options.identity ?? `${process.pid}@${hostname()}`
    this.pollMs = options.pollMs ?? 1000
    this.jitterMs = options.jitterMs ?? 250
    this.leaderTtlMs = options.leaderTtlMs ?? 5000
    this.beatMs = options.beatMs ?? 1000
    this.checkMs = options.checkMs ?? 10_000
    this.checkWaitMs = options.checkWaitMs ?? 20_000
    this.log = log
    this.redis = (options.makeClient ?? makeScoreboardClient)(
      config.redis.url,
      log,
      'feed relay',
      config.redis.caFile
    )
    this.redis.connect().catch((error: unknown) => {
      log(`feed relay: ${String(error)}`)
    })
    this.schedule()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    if (this.leadership != null)
      await this.end(this.leadership, 'the process is stopping')
    await this.polling
    await quit(this.redis)
  }

  private schedule(): void {
    if (
      this.stopped ||
      this.timer != null ||
      this.polling != null ||
      this.leadership != null
    )
      return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.polling = this.poll().finally(() => {
          this.polling = undefined
          this.schedule()
        })
      },
      this.pollMs + Math.random() * this.jitterMs
    )
  }

  private async poll(): Promise<void> {
    try {
      const holder = await this.redis.get(feedLeaderKey(this.prefix))
      if (holder == null) await this.tryToLead()
      this.lastComplaint = ''
    } catch (error) {
      this.complain(String(error))
    }
  }

  /** Says a failure once, however many polls it lasts. */
  private complain(why: string): void {
    if (why === this.lastComplaint) return
    this.lastComplaint = why
    this.log(`relay candidate: ${why}`)
  }

  private async tryToLead(): Promise<void> {
    const client = new Client(relayConnectionConfig(this.databaseUrl))
    const turn: Leadership = {
      client,
      publishing: false,
      claimed: false,
      ended: false,
      checkedAt: Date.now()
    }
    this.leadership = turn
    client.on('error', error => {
      this.end(turn, String(error)).catch(() => undefined)
    })
    client.on('end', () => {
      this.end(turn, 'the connection ended').catch(() => undefined)
    })
    client.on('notification', message => {
      if (turn.publishing && !turn.ended)
        this.publish(
          turn,
          feedChannelKey(this.prefix, message.channel),
          message.payload ?? ''
        )
    })
    try {
      await client.connect()
      const held = await client.query<{ held: boolean }>(
        'select pg_try_advisory_lock(hashtextextended($1, 0)) as held',
        [LOCK_NAME]
      )
      if (!held.rows[0]?.held) {
        await this.leave(turn)
        return
      }
      for (const channel of FEED_CHANNELS)
        await client.query(`listen ${channel}`)
      if (turn.ended) return
      turn.claimed = true
      await this.redis.set(feedLeaderKey(this.prefix), this.identity, {
        PX: this.leaderTtlMs
      })
      await this.redis.publish(
        feedControlKey(this.prefix),
        JSON.stringify({ kind: 'resync' })
      )
    } catch (error) {
      await this.end(turn, String(error))
      return
    }
    if (turn.ended) return
    turn.publishing = true
    turn.beat = setInterval(() => {
      this.beat(turn)
    }, this.beatMs)
    this.log(`the relay leads here, as ${this.identity}`)
  }

  /** Renews the key, sends the heartbeat and looks after the connection. */
  private beat(turn: Leadership): void {
    const now = Date.now()
    this.publish(
      turn,
      feedControlKey(this.prefix),
      JSON.stringify({ kind: 'heartbeat' })
    )
    if (turn.renewingSince == null) {
      turn.renewingSince = now
      this.redis
        .eval(RENEW_SCRIPT, {
          keys: [feedLeaderKey(this.prefix)],
          arguments: [this.identity, String(this.leaderTtlMs)]
        })
        .then(
          renewed => {
            turn.renewingSince = undefined
            if (renewed === 0)
              this.end(turn, 'the leader key is gone').catch(() => undefined)
          },
          (error: unknown) => {
            this.end(turn, `a renewal failed: ${String(error)}`).catch(
              () => undefined
            )
          }
        )
    } else if (now - turn.renewingSince >= this.leaderTtlMs) {
      this.end(turn, 'a renewal went unanswered').catch(() => undefined)
      return
    }
    if (turn.checkingSince != null) {
      if (now - turn.checkingSince >= this.checkWaitMs)
        this.end(turn, 'the connection went silent').catch(() => undefined)
    } else if (now - turn.checkedAt >= this.checkMs) {
      turn.checkingSince = now
      turn.client.query('select 1').then(
        () => {
          turn.checkingSince = undefined
          turn.checkedAt = Date.now()
        },
        () => undefined
      )
    }
  }

  private publish(turn: Leadership, key: string, payload: string): void {
    this.redis.publish(key, payload).catch((error: unknown) => {
      this.end(turn, `a publish failed: ${String(error)}`).catch(
        () => undefined
      )
    })
  }

  /** Ends a turn: nothing more goes out, and the process is a candidate again. */
  private async end(turn: Leadership, why: string): Promise<void> {
    if (turn.ended) return
    this.log(`the relay stops leading here: ${why}`)
    await this.leave(turn)
  }

  private async leave(turn: Leadership): Promise<void> {
    if (turn.ended) return
    turn.ended = true
    clearInterval(turn.beat)
    const hangingUp = turn.client.end().catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      hangingUp,
      new Promise(resolve => {
        timer = setTimeout(resolve, HANG_UP_WAIT_MS)
      })
    ])
    clearTimeout(timer)
    if (turn.claimed)
      await this.redis
        .eval(RELEASE_SCRIPT, {
          keys: [feedLeaderKey(this.prefix)],
          arguments: [this.identity]
        })
        .catch(() => undefined)
    if (this.leadership === turn) this.leadership = undefined
    this.schedule()
  }
}

/** Runs in each API primary when the feed is Valkey. One of them leads. */
export function startFeedRelay(
  config: Pick<ServerConfig, 'databaseUrl' | 'redis'>,
  log: (message: string) => void,
  options: FeedRelayOptions = {}
): FeedRelay {
  return new Relay(config, log, options)
}
