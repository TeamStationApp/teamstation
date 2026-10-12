import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { RoleFlag } from '../../common/roles'
import { ThemeProvider } from '../theme/ThemeContext'
import { RolesModal, type RolesModalProps } from './RolesModal'

let root: Root | undefined

async function mount(
  props: Partial<RolesModalProps> = {}
): Promise<Array<{ admin: boolean; flags: RoleFlag[] }>> {
  const saved: Array<{ admin: boolean; flags: RoleFlag[] }> = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <RolesModal
          displayName="Sam Keeper"
          scopeKind="team"
          scopeName="Hawks"
          held={[]}
          onSave={roles => {
            saved.push(roles)
          }}
          onClose={() => undefined}
          {...props}
        />
      </ThemeProvider>
    )
  })
  return saved
}

/** The switch named `label`, which react-native-web draws as a checkbox. */
function toggle(label: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )
  expect(found, label).not.equals(null)
  return found!
}

async function flip(label: string): Promise<void> {
  await act(async () => {
    toggle(label).click()
  })
}

function saveButton(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="button"]')]
    .reverse()
    .find(node => node.textContent === 'Save')
  expect(found).not.equals(undefined)
  return found!
}

const LABELS = [
  'Team admin',
  'Coach',
  'Assistant',
  'Scorekeeper',
  'Songkeeper',
  'Videographer'
]

describe('the roles of one person on one level', function () {
  // Inside the suite, so it runs before the DOM setup empties the body: the
  // modal's portal must still be there to be taken down.
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('shows six switches, each saying what it allows here', async function () {
    await mount()
    for (const label of LABELS)
      expect(toggle(label).checked, label).equals(false)
    const text = document.body.textContent ?? ''
    expect(text).includes('Roles for Sam Keeper')
    expect(text).includes('Same as a coach')
    expect(text).includes(
      'Scores the games of Hawks, sets walk-up songs and DJs them.'
    )
    expect(text).includes('Sets walk-up songs and DJs the games of Hawks.')
    expect(text).includes('Films and streams the games of Hawks.')
    expect(text).includes('full names')
  })

  it('shows every flag on and fixed while Admin is on', async function () {
    await mount({ held: ['admin', 'songkeeper'] })
    expect(toggle('Team admin').checked).equals(true)
    for (const label of LABELS.slice(1)) {
      expect(toggle(label).checked, label).equals(true)
      expect(toggle(label).disabled, label).equals(true)
    }
    expect(
      (document.body.textContent ?? '').split('Admins can do all of this')
        .length - 1
    ).equals(5)
  })

  it('shows a flag set above on and fixed, naming where it comes from', async function () {
    await mount({ inherited: { scorekeeper: 'Spring league' } })
    expect(toggle('Scorekeeper').checked).equals(true)
    expect(toggle('Scorekeeper').disabled).equals(true)
    expect(document.body.textContent).includes('From Spring league')
    expect(toggle('Coach').disabled).equals(false)
    // A scorekeeper from above keeps the songs here too.
    expect(toggle('Songkeeper').checked).equals(true)
    expect(toggle('Songkeeper').disabled).equals(true)
    expect(document.body.textContent).includes('Scorekeepers can do this')
  })

  it('shows Songkeeper on and fixed while Scorekeeper is on, and saves only Scorekeeper', async function () {
    const saved = await mount()
    await flip('Scorekeeper')
    expect(toggle('Songkeeper').checked).equals(true)
    expect(toggle('Songkeeper').disabled).equals(true)
    expect(document.body.textContent).includes('Scorekeepers can do this')
    await flip('Scorekeeper')
    expect(toggle('Songkeeper').checked).equals(false)
    expect(toggle('Songkeeper').disabled).equals(false)
    expect(document.body.textContent).not.includes('Scorekeepers can do this')
    await flip('Scorekeeper')
    await act(async () => {
      saveButton().click()
    })
    expect(saved).deep.equals([{ admin: false, flags: ['scorekeeper'] }])
  })

  it('keeps a Songkeeper set here when Scorekeeper goes off', async function () {
    const saved = await mount({ held: ['scorekeeper', 'songkeeper'] })
    expect(toggle('Songkeeper').disabled).equals(true)
    await flip('Scorekeeper')
    expect(toggle('Songkeeper').checked).equals(true)
    expect(toggle('Songkeeper').disabled).equals(false)
    await act(async () => {
      saveButton().click()
    })
    expect(saved).deep.equals([{ admin: false, flags: ['songkeeper'] }])
  })

  it('shows an admin from above on and fixed, with every flag', async function () {
    await mount({ inherited: { admin: 'Spring league' } })
    expect(toggle('Team admin').checked).equals(true)
    expect(toggle('Team admin').disabled).equals(true)
    expect(toggle('Coach').disabled).equals(true)
  })

  it('saves only the switches set on this level', async function () {
    const saved = await mount({
      held: ['songkeeper'],
      inherited: { videographer: 'Spring league' }
    })
    expect(saveButton().getAttribute('aria-disabled')).equals('true')
    await flip('Assistant')
    await flip('Coach')
    await flip('Songkeeper')
    await act(async () => {
      saveButton().click()
    })
    expect(saved).deep.equals([{ admin: false, flags: ['coach', 'assistant'] }])
  })

  it('saves admin with the flags held under it', async function () {
    const saved = await mount({ held: ['videographer'] })
    await flip('Team admin')
    await act(async () => {
      saveButton().click()
    })
    expect(saved).deep.equals([{ admin: true, flags: ['videographer'] }])
  })

  it('names the admin of a season and of a league', async function () {
    await mount({ scopeKind: 'season', scopeName: 'Spring 2026' })
    expect(toggle('Season admin').checked).equals(false)
    await act(async () => {
      root?.unmount()
    })
    await mount({ scopeKind: 'league', scopeName: 'Spring league' })
    expect(toggle('League admin').checked).equals(false)
  })
})
