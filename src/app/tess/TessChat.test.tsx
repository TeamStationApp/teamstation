import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { byLabel, click, render, unmount } from '../../test/tessTestKit'
import { TessChat } from './TessChat'
import type { TessChatState } from './useTess'

afterEach(unmount)

const tess: TessChatState = {
  loading: false,
  messages: [],
  thinking: false,
  error: null,
  send: async () => true,
  upload: async () => null,
  confirm: async () => undefined,
  showError: () => undefined
}

describe("Tess's chat", () => {
  it('is titled "Ask Tess" after her icon at the top left, with the X at the right', async () => {
    let closed = 0
    const host = await render(
      <TessChat
        tess={tess}
        onClose={() => {
          closed++
        }}
        onNavigate={() => undefined}
      />
    )
    const title = host.querySelector<HTMLElement>('[role="heading"]')!
    expect(title.textContent).equals('Ask Tess')
    const heading = title.parentElement!
    // The icon, then the title, in the bar's first place; the X after them.
    expect(heading.firstElementChild!.textContent).equals('auto_awesome')
    expect(heading.nextElementSibling).equals(byLabel('Close Tess'))
    await click(byLabel('Close Tess'))
    expect(closed).equals(1)
  })
})
