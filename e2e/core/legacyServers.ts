/**
 * Where the legacy stack's database and store are: the servers
 * `TS_TEST_DATABASE_URL` and `TS_TEST_REDIS_URL` name, or this machine's
 * Postgres on 5433 and Valkey on 6379 when they are unset.
 */

export interface StackServers {
  /** `createdb`/`dropdb` arguments that reach the cluster. */
  clusterArgs: string[]
  /** The password for those tools, when the URL carries one. */
  password?: string
  /** The stack's own database, on that cluster. */
  databaseUrl: string
  redisUrl: string
}

export const LOCAL_CLUSTER = 'postgres://localhost:5433/postgres'
export const LOCAL_REDIS = 'redis://127.0.0.1:6379'

/** The stack's servers for `database`, from `env`. */
export function stackServers(
  database: string,
  env: NodeJS.ProcessEnv = process.env
): StackServers {
  const cluster = new URL(
    env.TS_TEST_DATABASE_URL != null && env.TS_TEST_DATABASE_URL !== ''
      ? env.TS_TEST_DATABASE_URL
      : LOCAL_CLUSTER
  )
  const clusterArgs = [
    '-h',
    cluster.hostname,
    '-p',
    cluster.port === '' ? '5432' : cluster.port
  ]
  if (cluster.username !== '') {
    clusterArgs.push('-U', decodeURIComponent(cluster.username))
  }
  const own = new URL(cluster.href)
  own.pathname = `/${database}`
  const redisUrl =
    env.TS_TEST_REDIS_URL != null && env.TS_TEST_REDIS_URL !== ''
      ? env.TS_TEST_REDIS_URL
      : LOCAL_REDIS
  return {
    clusterArgs,
    ...(cluster.password === ''
      ? {}
      : { password: decodeURIComponent(cluster.password) }),
    databaseUrl: own.href,
    redisUrl
  }
}
