/**
 * The app builds the pipeline makes: one row per app and platform, each a
 * member of the `build` group named by `name`.
 */
export interface Row {
  name: string
  app: string
  platform: 'ios' | 'android' | 'macos'
  /** The app's directory, relative to the checkout. */
  path: string
  kind: 'react-native' | 'swift' | 'kotlin'
  scheme?: string
  workspace?: string
  /**
   * The app target's entitlements, relative to the Xcode project's directory:
   * what `TS_APP_ENTITLEMENTS` names when the build has an app link host.
   */
  entitlements?: string
  /** `UIDeviceFamily` must hold this: 2 for iPad apps, 1 for iPhone apps. */
  deviceFamily?: 1 | 2
}

export const rows: readonly Row[] = [
  {
    name: 'teamstation-ios',
    app: 'app.teamstation.app',
    platform: 'ios',
    path: '.',
    kind: 'react-native',
    scheme: 'TeamStation',
    workspace: 'ios/TeamStation.xcworkspace',
    entitlements: 'TeamStation/TeamStation.entitlements',
    deviceFamily: 1
  },
  {
    name: 'cameraman-ios',
    app: 'app.teamstation.cameraman',
    platform: 'ios',
    path: 'mobile/apps/tsCameraman',
    kind: 'swift',
    scheme: 'Cameraman',
    entitlements: 'App/Cameraman.entitlements',
    deviceFamily: 1
  },
  {
    name: 'director-ios',
    app: 'app.teamstation.director',
    platform: 'ios',
    path: 'mobile/apps/tsDirector',
    kind: 'swift',
    scheme: 'Director',
    entitlements: 'App/Director.entitlements',
    deviceFamily: 2
  },
  {
    name: 'preview-ios',
    app: 'app.teamstation.preview',
    platform: 'ios',
    path: 'mobile/apps/tsPreview',
    kind: 'swift',
    scheme: 'Preview',
    deviceFamily: 1
  },
  {
    name: 'teamstation-android',
    app: 'app.teamstation.app',
    platform: 'android',
    path: '.',
    kind: 'react-native'
  },
  {
    name: 'cameraman-android',
    app: 'app.teamstation.cameraman',
    platform: 'android',
    path: 'mobile/apps/tsCameramanAndroid',
    kind: 'kotlin'
  },
  {
    name: 'distributor-macos',
    app: 'app.teamstation.distributor',
    platform: 'macos',
    path: 'mobile/apps/tsDistributor',
    kind: 'swift',
    scheme: 'Distributor'
  }
]

/** The row a stage builds, from its name: `build/<row>`, or `<row>` alone. */
export function rowFor(stage: string): Row {
  const name = stage.split('/').pop()
  const row = rows.find(entry => entry.name === name)
  if (row == null) throw new Error(`No app build is named ${String(name)}`)
  return row
}

/** Every app ID the pipeline publishes, once. */
export function publishedApps(): string[] {
  return [...new Set(rows.map(row => row.app))]
}
