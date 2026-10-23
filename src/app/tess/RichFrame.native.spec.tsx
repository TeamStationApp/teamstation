import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { webViewProps } from '../../test/eventWebViewStub'
import { render, unmount } from '../../test/tessTestKit'
import { RICH_POLICY } from './richDocument'
import { RichFrame } from './RichFrame.native'

afterEach(async () => {
  await unmount()
})

/** The props the phone's frame handed the WebView, all of them. */
function props(): Record<string, unknown> & typeof webViewProps {
  return webViewProps
}

describe("the phone's rich frame", function () {
  it('loads the wrapped document with JavaScript off', async function () {
    await render(
      <RichFrame html="<table><tr><td>Comets</td></tr></table>" interactive />
    )
    const html = props().source!.html
    expect(html).includes(`content="${RICH_POLICY}"`)
    expect(html).includes('<td>Comets</td>')
    expect(props().javaScriptEnabled).equals(false)
    expect(props().originWhitelist).deep.equals(['about:*'])
    expect(props().allowFileAccess).equals(false)
    expect(props().setSupportMultipleWindows).equals(false)
    expect(props().scrollEnabled).equals(true)
    expect(props().pointerEvents).equals('auto')
    expect(props().accessibilityLabel).equals('A table or chart from Tess')
  })

  it('refuses every navigation but the initial document', async function () {
    await render(<RichFrame html="<svg></svg>" interactive={false} />)
    const navigate = props().onShouldStartLoadWithRequest!
    expect(navigate({ url: 'about:blank' })).equals(true)
    for (const url of [
      'https://example.com/',
      'http://192.0.2.1/beacon',
      'about:srcdoc',
      'data:text/html,hi',
      'file:///etc/hosts',
      'javascript:alert(1)',
      'about:blank#top'
    ])
      expect(navigate({ url }), url).equals(false)
    expect(props().scrollEnabled).equals(false)
    expect(props().pointerEvents).equals('none')
  })
})
