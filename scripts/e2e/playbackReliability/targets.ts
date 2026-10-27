/**
 * Where the suite runs. A target names a surface; the device behind it comes
 * from the environment (`TS_DEVICE`), never from this file, so the same
 * target runs on whichever phone is on the bench.
 */
export type Platform = 'ios' | 'android'
export type Surface = 'browser' | 'app'

export interface Target {
  name: string
  platform: Platform
  surface: Surface
  /** The app maestro-d attaches to: a browser, or TeamStation itself. */
  appId: string
  /** The browser opens addresses through its own bar rather than the system's link handler. */
  typesAddress: boolean
}

export const TARGETS: readonly Target[] = [
  {
    name: 'iphone-safari',
    platform: 'ios',
    surface: 'browser',
    appId: 'com.apple.mobilesafari',
    typesAddress: false
  },
  {
    name: 'iphone-brave',
    platform: 'ios',
    surface: 'browser',
    appId: 'com.brave.ios.browser',
    typesAddress: true
  },
  {
    name: 'pixel8-chrome',
    platform: 'android',
    surface: 'browser',
    appId: 'com.android.chrome',
    typesAddress: false
  },
  {
    name: 'pixel10-chrome',
    platform: 'android',
    surface: 'browser',
    appId: 'com.android.chrome',
    typesAddress: false
  },
  {
    name: 'iphone-app',
    platform: 'ios',
    surface: 'app',
    appId: 'app.teamstation.app',
    typesAddress: false
  },
  {
    name: 'pixel8-app',
    platform: 'android',
    surface: 'app',
    appId: 'app.teamstation.app',
    typesAddress: false
  },
  {
    name: 'pixel10-app',
    platform: 'android',
    surface: 'app',
    appId: 'app.teamstation.app',
    typesAddress: false
  }
]

export interface RunSettings {
  target: Target
  device: string
  /** The server under test, e.g. `https://example.test`. */
  app: string
  daemon: string
  teamId?: string
  artifacts?: string
  webcamUrl?: string
}

/** The run's settings from the environment, failing on anything missing. */
export function settingsFrom(
  env: Record<string, string | undefined>
): RunSettings {
  const need = (key: string): string => {
    const value = env[key]
    if (value == null || value === '') throw new Error(`${key} is required`)
    return value
  }
  const name = need('TS_TARGET')
  const target = TARGETS.find(one => one.name === name)
  if (target == null) {
    throw new Error(
      `TS_TARGET ${name} is not one of ${TARGETS.map(one => one.name).join(', ')}`
    )
  }
  if (target.platform === 'ios' && (env.MAESTRO_D_TEAM_ID ?? '') === '') {
    throw new Error('MAESTRO_D_TEAM_ID is required on iOS')
  }
  return {
    target,
    device: need('TS_DEVICE'),
    app: need('TS_APP').replace(/\/+$/, ''),
    daemon: env.MAESTRO_D ?? `pbr-${target.name}`,
    teamId: env.MAESTRO_D_TEAM_ID,
    artifacts: env.TS_ARTIFACTS,
    webcamUrl: env.TS_WEBCAM_URL
  }
}
