import React, { useMemo } from 'react'
import { Linking, View } from 'react-native'
import { WebView } from 'react-native-webview'

import { pinMapDocument, type PinMapProps, pinMovedOf } from './pinMapDocument'

/** The pin map on iOS: the same document in a WebView, posting the pin back. */
export function PinMap({ settings, onMove }: PinMapProps): React.ReactElement {
  const html = useMemo(
    () => pinMapDocument(settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      settings.latitude,
      settings.longitude,
      settings.tileUrl,
      settings.googleMapsApiKey,
      settings.editable
    ]
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
        testID="pin-map"
        accessibilityLabel="Field location map"
        source={{ html, baseUrl: 'https://app.teamstation.app/' }}
        originWhitelist={['https://*', 'about:*']}
        userAgent="TeamStation/1.0"
        style={{ flex: 1, backgroundColor: 'transparent' }}
        scrollEnabled={false}
        onMessage={event => {
          const moved = pinMovedOf(event.nativeEvent.data)
          if (moved != null)
            onMove?.({ latitude: moved.latitude, longitude: moved.longitude })
        }}
        onShouldStartLoadWithRequest={request => {
          if (!request.isTopFrame) return true
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
    </View>
  )
}
