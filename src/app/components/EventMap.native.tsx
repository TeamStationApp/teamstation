import React, { useMemo } from 'react'
import { Linking } from 'react-native'
import { WebView } from 'react-native-webview'

import type { EventLocation } from '../../common/eventInfo'
import { eventMapDocument } from './eventMapDocument'

export function EventMap({
  location
}: {
  location: EventLocation
}): React.ReactElement {
  const html = useMemo(() => eventMapDocument(location), [location])
  return (
    <WebView
      testID="event-location-map"
      accessibilityLabel="Event location map"
      source={{ html, baseUrl: 'https://app.teamstation.app/' }}
      originWhitelist={['https://*', 'about:*']}
      userAgent="TeamStation/1.0"
      style={{ height: 260, backgroundColor: 'transparent', borderRadius: 16 }}
      scrollEnabled={false}
      onShouldStartLoadWithRequest={request => {
        if (
          request.url === 'about:blank' ||
          request.url.startsWith('https://app.teamstation.app/')
        )
          return true
        if (request.url === 'https://www.openstreetmap.org/copyright')
          Linking.openURL(request.url).catch(() => undefined)
        return false
      }}
    />
  )
}
