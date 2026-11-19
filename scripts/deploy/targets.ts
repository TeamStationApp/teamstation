import type { Platform } from './validation'

export interface Target {
  app: string
  platform: Platform
  path: string
  kind: 'react-native' | 'swift' | 'kotlin'
  scheme?: string
  workspace?: string
  harvester?: boolean
  /**
   * The directory holding a React Native app's locked dependency graph,
   * relative to the source: a workspace root above the app. The app's own
   * directory when absent.
   */
  dependencies?: string
  /**
   * The app target's entitlements, relative to the Xcode project's directory:
   * what `TS_APP_ENTITLEMENTS` names when the build has an app link host.
   */
  entitlements?: string
  /**
   * The bundle ids of the app's extensions. Each is signed with a profile of
   * its own, named in `profileNames` as the app's is, and checked in the
   * exported IPA as the app is; any other extension fails the build.
   */
  extensions?: string[]
  /** Build settings the archive passes to xcodebuild, as `NAME=value`. */
  buildSettings?: string[]
}
const targets: Target[] = [
  {
    app: 'app.teamstation.app',
    platform: 'ios',
    path: '.',
    kind: 'react-native',
    scheme: 'TeamStation',
    workspace: 'ios/TeamStation.xcworkspace',
    entitlements: 'TeamStation/TeamStation.entitlements',
    // The Notification Service Extension (ios/TeamStationNotifications),
    // signed as `Masonfile.ts` signs it: production APNs, and the
    // entitlements without Apple's notification filtering.
    extensions: ['app.teamstation.app.notifications'],
    buildSettings: [
      'TS_APS_ENVIRONMENT=production',
      'TS_NSE_ENTITLEMENTS=TeamStationNotifications.entitlements'
    ]
  },
  {
    app: 'app.teamstation.app',
    platform: 'android',
    path: '.',
    kind: 'react-native'
  },
  {
    app: 'app.teamstation.cameraman',
    platform: 'ios',
    path: 'mobile/apps/tsCameraman',
    kind: 'swift',
    scheme: 'Cameraman',
    entitlements: 'App/Cameraman.entitlements'
  },
  {
    app: 'app.teamstation.cameraman',
    platform: 'android',
    path: 'mobile/apps/tsCameramanAndroid',
    kind: 'kotlin'
  },
  {
    app: 'app.teamstation.director',
    platform: 'ios',
    path: 'mobile/apps/tsDirector',
    kind: 'swift',
    scheme: 'Director',
    entitlements: 'App/Director.entitlements'
  },
  {
    app: 'app.teamstation.preview',
    platform: 'ios',
    path: 'mobile/apps/tsPreview',
    kind: 'swift',
    scheme: 'Preview'
  },
  {
    app: 'app.teamstation.distributor',
    platform: 'macos',
    path: 'mobile/apps/tsDistributor',
    kind: 'swift',
    scheme: 'Distributor'
  },
  {
    app: 'app.teamstation.gcscraper',
    platform: 'ios',
    path: '.',
    kind: 'react-native',
    scheme: 'GcScraper',
    workspace: 'ios/GcScraper.xcworkspace',
    harvester: true
  },
  {
    app: 'app.teamstation.watcher',
    platform: 'android',
    path: 'watcher/apps/tsWatcher',
    kind: 'react-native',
    dependencies: 'watcher'
  }
]
export function target(app: string, platform: Platform): Target {
  const out = targets.find(
    item => item.app === app && item.platform === platform
  )
  if (out == null) throw new Error('Unsupported app/platform combination')
  return { ...out }
}
