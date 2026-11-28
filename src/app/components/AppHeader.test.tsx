import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  byLabel,
  byTestId,
  click,
  render,
  settle,
  unmount
} from '../../test/tessTestKit'
import { AppHeader, type AppHeaderProps } from './AppHeader'
import { markPinned } from './pinnedGlass'

const account = {
  userId: 'usr_ruth',
  name: 'Babe Ruth',
  onPress: () => undefined
}
const notifications = { pending: false, onPress: () => undefined }
const tess = { onPress: () => undefined }
const PICTURE = 'Account, Babe Ruth'
const MARK = 'TeamStation menu'

const labelled = (label: string): Element | null =>
  document.querySelector(`[aria-label="${label}"]`)

async function header(props: Partial<AppHeaderProps>): Promise<void> {
  await render(<AppHeader title="Your Home" {...props} />)
}

async function openMenu(label: string): Promise<void> {
  await click(byLabel(label))
  await settle()
}

const rows = (): Array<string | null> =>
  [...byTestId('header-menu-panel')!.querySelectorAll('[role="button"]')].map(
    row => row.getAttribute('aria-label')
  )

describe('AppHeader', () => {
  afterEach(unmount)

  it('has no Tess, bell or umpire button of its own', async () => {
    await header({ showMark: true, account, notifications, tess })
    for (const label of ['Tess', 'Notifications', 'Umpire schedule'])
      expect(labelled(label), label).equals(null)
  })

  describe('the mark', () => {
    it('opens a menu with About and then Ask Tess, which opens her', async () => {
      const pressed: string[] = []
      await header({
        showMark: true,
        account,
        tess: { onPress: () => pressed.push('tess') }
      })
      await openMenu(MARK)
      expect(rows()).deep.equals(['About TeamStation', 'Ask Tess'])
      expect(byTestId('header-menu-panel')!.textContent).contains(
        'Your AI chatbot'
      )
      await click(byLabel('Ask Tess'))
      await settle()
      expect(pressed).deep.equals(['tess'])
      expect(byTestId('header-menu-panel')).equals(null)
    })

    it('opens About from its row', async () => {
      await header({ showMark: true, account, tess })
      await openMenu(MARK)
      await click(byLabel('About TeamStation'))
      await settle()
      expect(labelled('Close build information')).not.equals(null)
      await click(byLabel('Close build information'))
      expect(labelled('Close build information')).equals(null)
    })

    it('still offers About where Tess is absent', async () => {
      await header({ showMark: true, account })
      await openMenu(MARK)
      expect(rows()).deep.equals(['About TeamStation'])
    })

    it('opens About directly on a header with no picture', async () => {
      await header({ showMark: true })
      expect(labelled(MARK)).equals(null)
      await click(byLabel('About TeamStation'))
      expect(labelled('Close build information')).not.equals(null)
    })

    it('is not drawn where the screen has none', async () => {
      await header({ account, notifications, tess })
      expect(labelled(MARK)).equals(null)
      expect(labelled('Ask Tess')).equals(null)
    })
  })

  describe('the picture', () => {
    it('opens Account and then Notifications', async () => {
      const pressed: string[] = []
      await header({
        account: { ...account, onPress: () => pressed.push('account') },
        notifications: {
          pending: false,
          onPress: () => pressed.push('notifications')
        }
      })
      await openMenu(PICTURE)
      expect(rows()).deep.equals(['Account', 'Notifications'])
      await click(byLabel('Account'))
      await settle()
      await openMenu(PICTURE)
      await click(byLabel('Notifications'))
      await settle()
      expect(pressed).deep.equals(['account', 'notifications'])
    })

    it('ends with Node administration for a node administrator, and only then', async () => {
      let opened = 0
      await header({
        account,
        notifications,
        nodeAdministration: { onPress: () => opened++ }
      })
      await openMenu(PICTURE)
      expect(rows()).deep.equals([
        'Account',
        'Notifications',
        'Node administration'
      ])
      await click(byLabel('Node administration'))
      await settle()
      expect(opened).equals(1)
    })

    it('leaves out Notifications where the header has none', async () => {
      await header({ account })
      await openMenu(PICTURE)
      expect(rows()).deep.equals(['Account'])
    })

    it('uses the initials as the Account row icon when there is no photo', async () => {
      await header({ account })
      await openMenu(PICTURE)
      expect(byLabel('Account').textContent).contains('BR')
    })

    it('is not drawn for someone signed out', async () => {
      await header({ showMark: true, notifications })
      expect(document.querySelector('[aria-label^="Account, "]')).equals(null)
    })
  })

  describe('the notification dots', () => {
    const pending = { pending: true, onPress: () => undefined }

    it('dot the picture and, once open, the bell, and say so', async () => {
      await header({ account, notifications: pending })
      expect(byTestId('notification-pending-dot')).not.equals(null)
      expect(byTestId('notification-row-dot')).equals(null)
      const label = `${PICTURE}, notifications waiting`
      await openMenu(label)
      expect(byTestId('notification-row-dot')).not.equals(null)
      expect(byLabel('Notifications').getAttribute('aria-label')).equals(
        'Notifications'
      )
    })

    it('stay away with nothing pending', async () => {
      await header({ account, notifications })
      expect(byTestId('notification-pending-dot')).equals(null)
      await openMenu(PICTURE)
      expect(byTestId('notification-row-dot')).equals(null)
    })
  })

  describe('closing', () => {
    it('reports its menus to the owner, and closes them on a new key', async () => {
      const reported: boolean[] = []
      const element = (menuKey: string): React.ReactElement => (
        <AppHeader
          account={account}
          menuKey={menuKey}
          onMenuOpenChange={open => reported.push(open)}
        />
      )
      await render(element('/'))
      await openMenu(PICTURE)
      expect(reported).deep.equals([true])
      await click(byLabel('Close menu'))
      await settle()
      expect(reported).deep.equals([true, false])
    })
  })

  describe('the glass handed to a pinned band', () => {
    const band = {}
    const carry = async (on: boolean): Promise<void> => {
      await act(async () => {
        markPinned(band, on)
      })
    }
    const glass = (): HTMLElement => byTestId('app-header')!
    const style = (): CSSStyleDeclaration => getComputedStyle(glass())
    const strip = (): HTMLElement | null => byTestId('app-header-sidebar-glass')
    afterEach(async () => {
      await carry(false)
    })

    it('goes bare with no lower line while a band carries the glass, and comes back', async () => {
      await header({ glassHandover: true })
      const glassColor = style().backgroundColor
      expect(glassColor).not.equals('')
      expect(style().borderBottomWidth).equals('1px')
      await carry(true)
      expect(glass().style.backgroundColor).equals('')
      expect(style().borderBottomWidth).equals('0px')
      // The line's row is kept, so nothing inside the header moves.
      expect(style().paddingBottom).equals('1px')
      await carry(false)
      expect(style().backgroundColor).equals(glassColor)
      expect(style().borderBottomWidth).equals('1px')
    })

    it('keeps its glass and line where it is not the shell’s header', async () => {
      await header({})
      const glassColor = style().backgroundColor
      await carry(true)
      expect(style().backgroundColor).equals(glassColor)
      expect(style().borderBottomWidth).equals('1px')
      expect(strip()).equals(null)
    })

    it('keeps its glass and line over the sidebar, left of the scene', async () => {
      await header({ glassHandover: true, sceneLeft: 240, sidebar: true })
      expect(strip()).equals(null)
      await carry(true)
      const sidebar = strip()!
      expect(getComputedStyle(sidebar).position).equals('absolute')
      expect(getComputedStyle(sidebar).left).equals('0px')
      expect(getComputedStyle(sidebar).width).equals('240px')
      expect(sidebar.style.backgroundColor).not.equals('')
      // Drawn first, behind the columns.
      expect(glass().firstElementChild).equals(sidebar)
      const line = sidebar.firstElementChild as HTMLElement
      expect(getComputedStyle(line).height).equals('1px')
      expect(getComputedStyle(line).bottom).equals('0px')
      // And bare from there on.
      expect(glass().style.backgroundColor).equals('')
      await carry(false)
      expect(strip()).equals(null)
    })

    it('keeps its content mounted as the glass goes and comes back', async () => {
      await header({
        glassHandover: true,
        showMark: true,
        account,
        tess,
        onBack: () => undefined
      })
      await openMenu(MARK)
      const back = byLabel('Back')
      const title = [...glass().querySelectorAll('div')].find(
        node => node.textContent === 'Your Home'
      )
      expect(title).not.equals(undefined)
      await carry(true)
      expect(byTestId('header-menu-panel')).not.equals(null)
      expect(byLabel('Back')).equals(back)
      expect(glass().contains(title!)).equals(true)
      await carry(false)
      expect(byTestId('header-menu-panel')).not.equals(null)
      expect(byLabel('Back')).equals(back)
      expect(glass().contains(title!)).equals(true)
    })
  })
})
