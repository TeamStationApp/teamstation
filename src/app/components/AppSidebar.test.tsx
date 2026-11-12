import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Text } from 'react-native'

import {
  byLabel,
  byTestId,
  click,
  render,
  rerender,
  settle,
  unmount,
  windowSize
} from '../../test/tessTestKit'
import { ScopedThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { AppHeader } from './AppHeader'
import { AppSidebar } from './AppSidebar'
import { useSidebarWidth } from './sidebarLayout'

function Width(): React.ReactElement {
  return <Text testID="sidebar-width">{useSidebarWidth()}</Text>
}

describe('wide navigation sidebar', () => {
  let restore: (() => Promise<void>) | undefined
  afterEach(async () => {
    await unmount()
    await restore?.()
    restore = undefined
  })

  it('switches at content maximum plus sidebar, responds to resizing and theme rem size', async () => {
    restore = (await windowSize(1215)).restore
    await render(<Width />)
    const width = (): string | null => byTestId('sidebar-width')!.textContent
    expect(width()).equals('0')
    await windowSize(1216)
    expect(width()).equals('256')
    await windowSize(1600)
    expect(width()).equals('256')
    await rerender(
      <ScopedThemeProvider theme={{ ...tsBallpark, rem: n => n * 24 }}>
        <Width />
      </ScopedThemeProvider>
    )
    expect(width()).equals('0')
    await windowSize(1824)
    expect(width()).equals('384')
    await windowSize(390)
    expect(width()).equals('0')
  })

  it('renders ordered labels/icons, sends each tab to its existing destination and preserves unread selection', async () => {
    const chosen: string[] = []
    await render(
      <AppSidebar selected="chat" onSelect={id => chosen.push(id)} unread />
    )
    const sidebar = byTestId('navigation-sidebar')!
    expect(
      [...sidebar.querySelectorAll('[role="button"], [role="tab"]')].map(n =>
        n.getAttribute('aria-label')
      )
    ).deep.equals([
      'Home',
      'Videos',
      'Schedule',
      'Search',
      'Messages',
      'About TeamStation'
    ])
    for (const name of ['Home', 'Videos', 'Schedule', 'Search', 'Messages'])
      await click(byLabel(name))
    expect(chosen).deep.equals(['home', 'videos', 'schedule', 'search', 'chat'])
    expect(byLabel('Messages').getAttribute('aria-selected')).equals('true')
    expect(byLabel('Home').getAttribute('aria-selected')).equals('false')
    expect(byTestId('chat-unread')).not.equals(null)
    await click(byLabel('About TeamStation'))
    await click(byLabel('Close build information'))
    expect(
      document.querySelector('[aria-label="Close build information"]')
    ).equals(null)
    await rerender(<AppSidebar selected="home" onSelect={() => undefined} />)
    expect(byTestId('chat-unread')).equals(null)
    await rerender(<AppSidebar selected="home" onSelect={() => undefined} />)
    expect(sidebar.querySelector('[aria-label="Ask Tess"]')).equals(null)
  })

  it('offers Tess at the right of the wide header and omits it when unavailable', async () => {
    let opened = 0
    await render(
      <AppHeader showMark sidebar tess={{ onPress: () => opened++ }} />
    )
    await click(byLabel('Ask Tess'))
    expect(opened).equals(1)
    expect(byLabel('Ask Tess').textContent).contains('Ask Tess')
    expect(byTestId('header-menu-panel')).equals(null)
    await rerender(<AppHeader showMark sidebar />)
    expect(document.querySelector('[aria-label="Ask Tess"]')).equals(null)
  })

  it('closes a narrow mark menu on becoming wide and leaves the wide mark noninteractive', async () => {
    const props = {
      showMark: true,
      account: { userId: 'u1', name: 'Babe Ruth', onPress: () => undefined }
    }
    await render(<AppHeader {...props} />)
    await click(byLabel('TeamStation menu'))
    await settle()
    expect(byTestId('header-menu-panel')).not.equals(null)
    await rerender(<AppHeader {...props} sidebar />)
    expect(byTestId('header-menu-panel')).equals(null)
    expect(byTestId('sidebar-header-mark')!.closest('[role="button"]')).equals(
      null
    )
    await click(byTestId('sidebar-header-mark')!)
    expect(
      document.querySelector('[aria-label="Close build information"]')
    ).equals(null)
  })
})
