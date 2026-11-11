import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import {
  byLabel,
  byTestId,
  click,
  render,
  settle,
  unmount
} from '../../test/tessTestKit'
import { AppHeader, type AppHeaderProps } from './AppHeader'

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
})
