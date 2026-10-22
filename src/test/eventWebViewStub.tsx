import React from 'react'

export let webViewProps: {
  source?: { html: string; baseUrl: string }
  onMessage?: (event: { nativeEvent: { data: string } }) => void
  userAgent?: string
  onShouldStartLoadWithRequest?: (request: {
    url: string
    isTopFrame?: boolean
  }) => boolean
}
export function WebView(props: typeof webViewProps): React.ReactElement {
  const navigate = props.onShouldStartLoadWithRequest
  webViewProps = {
    ...props,
    onShouldStartLoadWithRequest:
      navigate == null
        ? undefined
        : request => navigate({ isTopFrame: true, ...request })
  }
  return <div data-testid="native-event-map-test" />
}
