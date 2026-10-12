import React from 'react'

export let webViewProps: {
  source?: { html: string; baseUrl: string }
  userAgent?: string
  onShouldStartLoadWithRequest?: (request: { url: string }) => boolean
}
export function WebView(props: typeof webViewProps): React.ReactElement {
  webViewProps = props
  return <div data-testid="native-event-map-test" />
}
