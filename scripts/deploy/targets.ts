import type { Platform } from './validation'

export interface Target {
  app: string
  platform: Platform
  path: string
  kind: 'react-native' | 'swift' | 'kotlin'
  scheme?: string
  workspace?: string
  harvester?: boolean
}
const targets: Target[] = [
  {
    app: 'app.teamstation.app',
    platform: 'ios',
    path: '.',
    kind: 'react-native',
    scheme: 'TeamStation',
    workspace: 'ios/TeamStation.xcworkspace'
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
    scheme: 'Cameraman'
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
    scheme: 'Director'
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
  }
]
export function target(app: string, platform: Platform): Target {
  const out = targets.find(
    item => item.app === app && item.platform === platform
  )
  if (out == null) throw new Error('Unsupported app/platform combination')
  return { ...out }
}
