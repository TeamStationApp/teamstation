/**
 * The maestro-d daemons a legacy sweep drives. `E2E_DAEMON_PREFIX` names them
 * for one agent and run, so two sweeps on one Mac never restart each other's;
 * without it the run names them for its own process, `e2e-<pid>`, and writes
 * that prefix into `env` so the scripts it starts use the same daemons. No
 * run falls back to a name another may hold.
 */
export function daemonNames(env: NodeJS.ProcessEnv = process.env): {
  web: string
  ios: string
  android: string
} {
  env.E2E_DAEMON_PREFIX ??= `e2e-${process.pid}`
  const prefix = env.E2E_DAEMON_PREFIX
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(prefix)) {
    throw new Error(`E2E_DAEMON_PREFIX "${prefix}" is not a daemon name`)
  }
  return { web: prefix, ios: `${prefix}-ios`, android: `${prefix}-android` }
}
