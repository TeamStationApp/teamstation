import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Text } from 'react-native'

import { byLabel, click, render, unmount } from '../../test/tessTestKit'
import { UmpireMask } from '../umpires/UmpireMask'
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

  it('sits between the umpire button and Notifications', async () => {
    const pressed: string[] = []
    await header({
      umpire: <UmpireMask onPress={() => pressed.push('umpire')} />,
      tess: { open: false, onPress: () => pressed.push('tess') },
      notifications
    })
    expect(rightButtons()).deep.equals([
      'Umpire schedule',
      'Tess',
      'Notifications'
    ])
    expect(byLabel('Tess').getAttribute('aria-expanded')).equals('false')
    await click(byLabel('Tess'))
    expect(pressed).deep.equals(['tess'])
  })

  it('sits before Notifications with no umpire button, and says it is open', async () => {
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

describe("the header's title on a phone", () => {
  afterEach(unmount)

  const long = 'Conversation information for a very long team chat name indeed'
  const node = (id: string): HTMLElement =>
    document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

  /**
   * A phone lays this row out with Yoga, not a browser, so the rules that
   * decide it are checked as the styles Yoga reads: the trailing controls
   * keep their width, and the title alone gives way to them, in a box that
   * starts from nothing and takes what is left, on one truncated line.
   */
  it('takes only the room between back and the trailing controls, on one line', async () => {
    await header({
      title: long,
      onBack: () => undefined,
      notifications,
      account: { name: 'Juan S', onPress: () => undefined }
    })
    const leading = node('headerLeading')
    const trailing = node('headerTrailing')
    const box = node('headerTitle')
    expect(leading.contains(box)).equals(true)
    expect(trailing.contains(box), 'Never under the bell').equals(false)
    expect(
      Boolean(
        box.compareDocumentPosition(trailing) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    ).equals(true)
    const style = (element: HTMLElement): CSSStyleDeclaration =>
      getComputedStyle(element)
    expect(
      style(trailing).flexShrink,
      'The bell and face keep their room'
    ).equals('0')
    for (const element of [leading, box]) {
      expect(style(element).flexGrow).equals('1')
      expect(style(element).flexShrink, 'Gives way').equals('1')
      expect(Number.parseFloat(style(element).flexBasis)).equals(0)
    }
    expect(Number.parseFloat(style(box).minWidth)).equals(0)
    const text = box.firstElementChild as HTMLElement
    expect(text.textContent).equals(long)
    expect(style(text).whiteSpace, 'One line').equals('nowrap')
    expect(style(text).textOverflow, 'Truncated').equals('ellipsis')
  })

  it('leaves a long chat name handed up by the conversation as it was', async () => {
    await header({
      title: long,
      onBack: () => undefined,
      notifications,
      handoff: <Text numberOfLines={1}>{long}</Text>
    })
    expect(document.querySelector('[data-testid="headerTitle"]')).equals(null)
    const handoff = node('headerHandoff')
    expect(node('headerLeading').contains(handoff)).equals(true)
    expect(handoff.textContent).equals(long)
  })
})
