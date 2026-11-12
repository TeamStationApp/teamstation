/**
 * The maestro-d daemons a legacy sweep drives. `E2E_DAEMON_PREFIX` names them
 * for one agent and run, so two sweeps on one Mac never restart each other's;
 * without it they keep the suite's own names.
 */
export function daemonNames(env: NodeJS.ProcessEnv = process.env): {
  web: string
  ios: string
  android: string
} {
  const prefix = env.E2E_DAEMON_PREFIX ?? 'e2eSuite'
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(prefix)) {
    throw new Error(`E2E_DAEMON_PREFIX "${prefix}" is not a daemon name`)
  }
  return { web: prefix, ios: `${prefix}-ios`, android: `${prefix}-android` }
}
