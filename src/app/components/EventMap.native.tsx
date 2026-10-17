import React, { useMemo } from 'react'
import { Linking, View } from 'react-native'
import { WebView } from 'react-native-webview'

import type { EventLocation } from '../../common/eventInfo'
import { eventMapDocument } from './eventMapDocument'
import { googleMapDocument } from './googleMapDocument'

export function EventMap({
  location
}: {
  location: EventLocation
}): React.ReactElement {
  const html = useMemo(
    () =>
      location.googleMapsApiKey == null || location.googleMapsApiKey === ''
        ? eventMapDocument(location)
        : googleMapDocument(location),
    [location]
  )
  return (
    <View
      style={{
        height: 260,
        width: '100%',
        borderRadius: 16,
        overflow: 'hidden'
      }}
    >
      <WebView
        testID="event-location-map"
        accessibilityLabel="Event location map"
        source={{ html, baseUrl: 'https://app.teamstation.app/' }}
        originWhitelist={['https://*', 'about:*']}
        userAgent="TeamStation/1.0"
        style={{ flex: 1, backgroundColor: 'transparent' }}
        scrollEnabled={false}
        onShouldStartLoadWithRequest={request => {
          if (!request.isTopFrame) return true
          if (
            request.url === 'about:blank' ||
            request.url.startsWith('https://app.teamstation.app/')
          )
            return true
          if (
            request.url === 'https://www.openstreetmap.org/copyright' ||
            /^https:\/\/(?:maps\.google\.com\/|(?:www\.)?google\.com\/(?:maps(?:[/?]|$)|intl\/[^/]+\/help\/terms_maps\.html(?:[?#]|$)))/.test(
              request.url
            )
          )
            Linking.openURL(request.url).catch(() => undefined)
          return false
        }}
      />
    </View>
  )
}
