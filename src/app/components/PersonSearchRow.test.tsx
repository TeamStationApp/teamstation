import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { userIdOfGumbo } from '../../common/userId'
import { find, mount, press, text, unmount } from '../../test/gameFormDom'
import { PersonSearchRow } from './PersonSearchRow'

describe('shared person search row', () => {
  afterEach(unmount)
  it('uses two letters for a single-word name', async () => {
    await mount(
      <PersonSearchRow userId="usr_ichiro" name="Ichiro" onPress={() => {}} />
    )
    expect(text()).contains('IC')
  })
  it('shows two compact initials and an affiliation below the name, and selects the person', async () => {
    let selected = false
    await mount(
      <PersonSearchRow
        userId="usr_betts"
        name="Mookie Betts"
        affiliations="Guardian of Mike T · Demo Hawks"
        onPress={() => {
          selected = true
        }}
      />
    )
    expect(text())
      .contains('MB')
      .and.contains('Mookie Betts')
      .and.contains('Guardian of Mike T · Demo Hawks')
    const initials = [...document.querySelectorAll<HTMLElement>('div')].find(
      element => element.textContent === 'MB' && element.style.fontSize !== ''
    )!
    expect(initials).not.equals(undefined)
    expect(Number.parseFloat(initials.style.fontSize)).lessThan(16)
    await press('Mookie Betts')
    expect(selected).equals(true)
  })
  it('shows the photo instead of initials and permits missing affiliations', async () => {
    await mount(
      <PersonSearchRow
        userId="usr_trout"
        name="Mike Trout"
        avatarUrl="https://example.test/avatar.png"
        disabled
        onPress={() => {
          throw new Error('Disabled person selected')
        }}
      />
    )
    expect(document.querySelector('img')?.getAttribute('src')).contains(
      'avatar.png'
    )
    expect(text()).not.contains('MT')
    await press('Mike Trout')
  })
  it('draws its line through the shared affiliation line, with the test id it is given, and none when empty', async () => {
    await mount(
      <>
        <PersonSearchRow
          userId="usr_ripken"
          name="Cal Ripken"
          affiliations="Guardian of Josh S · Demo Hawks"
          affiliationTestID="candidate-affiliation-usr_ripken"
          onPress={() => {}}
        />
        <PersonSearchRow
          userId="usr_jeter"
          name="Derek Jeter"
          affiliations=""
          affiliationTestID="candidate-affiliation-usr_jeter"
          onPress={() => {}}
        />
      </>
    )
    const line = document.querySelector<HTMLElement>(
      '[data-testid="candidate-affiliation-usr_ripken"]'
    )!
    expect(line.textContent).equals('Guardian of Josh S · Demo Hawks')
    expect(Number.parseFloat(getComputedStyle(line).fontSize)).lessThan(16)
    expect(
      document.querySelector(
        '[data-testid="candidate-affiliation-usr_ripken-viewport"]'
      )
    ).not.equals(null)
    expect(
      document.querySelector('[data-testid^="candidate-affiliation-usr_jeter"]')
    ).equals(null)
  })
  it('puts an address beside the name, and draws only the name without one', async function () {
    const pressed: string[] = []
    await mount(
      <>
        <PersonSearchRow
          userId={userIdOfGumbo(101)}
          name="Babe Ruth"
          detail="ruth@example.com"
          affiliations="Demo Hawks"
          onPress={() => {
            pressed.push('ruth')
          }}
        />
        <PersonSearchRow
          userId={userIdOfGumbo(102)}
          name="Lou Gehrig"
          detail=""
          onPress={() => {
            pressed.push('gehrig')
          }}
        />
      </>
    )
    const ruth = find('Babe Ruth')!
    const lines = [...ruth.querySelectorAll('div[dir="auto"]')].map(
      node => node.textContent
    )
    expect(lines).to.include.members(['Babe Ruth', 'ruth@example.com'])
    const name = [
      ...ruth.querySelectorAll<HTMLElement>('div[dir="auto"]')
    ].find(node => node.textContent === 'Babe Ruth')!
    const address = [
      ...ruth.querySelectorAll<HTMLElement>('div[dir="auto"]')
    ].find(node => node.textContent === 'ruth@example.com')!
    // On the name's line, quieter: smaller and not bold.
    expect(name.parentElement).equals(address.parentElement)
    expect(parseFloat(getComputedStyle(address).fontSize)).lessThan(
      parseFloat(getComputedStyle(name).fontSize)
    )
    expect(getComputedStyle(address).fontWeight).not.equals('600')
    expect(text()).includes('Demo Hawks')
    expect(find('Lou Gehrig')!.textContent).equals('LGLou Gehrig')
    await press('Lou Gehrig')
    expect(pressed).deep.equals(['gehrig'])
  })
})
