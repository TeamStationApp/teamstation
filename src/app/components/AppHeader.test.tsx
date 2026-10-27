import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { byLabel, click, render, unmount } from '../../test/tessTestKit'
import { AppHeader, type AppHeaderProps } from './AppHeader'

/** The header's buttons on the right, by label, in the order drawn. */
function rightButtons(): string[] {
  return [...document.querySelectorAll('[role="button"][aria-label]')]
    .map(node => node.getAttribute('aria-label') ?? '')
    .filter(label =>
      ['Umpire schedule', 'Tess', 'Notifications'].includes(label)
    )
}

const notifications = { pending: false, onPress: () => undefined }

async function header(props: Partial<AppHeaderProps>): Promise<void> {
  await render(<AppHeader title="Your Home" {...props} />)
}

describe("the header's Tess button", () => {
  afterEach(unmount)

  it('sits before Notifications, with no umpire button in the header', async () => {
    const pressed: string[] = []
    await header({
      tess: { open: false, onPress: () => pressed.push('tess') },
      notifications
    })
    expect(rightButtons()).deep.equals(['Tess', 'Notifications'])
    expect(document.querySelector('[aria-label="Umpire schedule"]')).equals(
      null
    )
    expect(byLabel('Tess').getAttribute('aria-expanded')).equals('false')
    await click(byLabel('Tess'))
    expect(pressed).deep.equals(['tess'])
  })

  it('says it is open', async () => {
    await header({
      tess: { open: true, onPress: () => undefined },
      notifications
    })
    expect(rightButtons()).deep.equals(['Tess', 'Notifications'])
    expect(byLabel('Tess').getAttribute('aria-expanded')).equals('true')
  })

  it('is not drawn where Tess is not offered', async () => {
    await header({ notifications })
    expect(rightButtons()).deep.equals(['Notifications'])
  })
})
