import { expect } from 'chai'
import { describe, it } from 'mocha'

import { sdkOptions, sentryHost } from './sentrySdk.native'

describe('native crash host configuration', () => {
  it('preserves the native host privacy callbacks and disables automatic data capture', () => {
    expect(sdkOptions).deep.equals({
      autoInitializeNativeSdk: false,
      sendDefaultPii: false,
      enableAutoSessionTracking: false,
      sendClientReports: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      enableNetworkBreadcrumbs: false
    })
    expect(sentryHost()).equals('app.example.test')
  })
})
