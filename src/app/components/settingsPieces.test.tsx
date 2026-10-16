import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient } from '../../common/api'
import type { GroupPicture } from '../../common/groupCreation'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { DangerText } from './DangerText'
import { HeroCard } from './HeroCard'
import { PictureSheet } from './PictureSheet'

let root: Root | undefined
async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
async function cleanup(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
}
function button(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  expect(found, label).not.equals(undefined)
  return found!
}
async function press(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await new Promise(resolve => setTimeout(resolve, 15))
  })
}
const client = { pictures: async () => [] } as unknown as TeamStationClient

describe('settings identity and text actions', () => {
  afterEach(cleanup)
  for (const person of [true, false])
    for (const uri of [null, 'https://images.example.test/picture.png'])
      it(`offers ${person ? 'photo' : 'picture'} editing with ${uri == null ? 'initials' : 'a picture'}`, async () => {
        let edits = 0
        await render(
          <HeroCard
            name="Babe Ruth"
            secondary="Demo City"
            person={person}
            uri={uri}
            onEdit={() => {
              edits++
            }}
          />
        )
        const label = `${uri == null ? 'Add' : 'Change'} ${person ? 'photo' : 'picture'}`
        expect(document.body.textContent)
          .includes('Babe Ruth')
          .and.includes('Demo City')
        await press(label)
        expect(edits).equals(1)
      })
  it('has no editing control or secondary line when neither is supplied', async () => {
    await render(<HeroCard name="Bluebirds" />)
    expect(document.querySelector('[role="button"]')).equals(null)
    expect(document.body.textContent).not.includes('edit')
  })
  it('treats a blank image as initials and makes a disabled hero inert', async () => {
    let edits = 0
    await render(
      <HeroCard
        name="Bluebirds"
        uri=""
        disabled
        onEdit={() => {
          edits++
        }}
      />
    )
    await press('Add picture')
    expect(edits).equals(0)
  })
  for (const disabled of [false, true])
    it(`red text action ${disabled ? 'blocks' : 'performs'} its action with a full touch target`, async () => {
      let calls = 0
      await render(
        <DangerText
          label="Withdraw invitation"
          accessibilityLabel="Withdraw request"
          disabled={disabled}
          onPress={() => {
            calls++
          }}
        />
      )
      const action = button('Withdraw request')
      expect(parseFloat(getComputedStyle(action).minHeight)).at.least(48)
      const colour = document.createElement('span')
      colour.style.color = tsBallpark.dangerColor
      document.body.appendChild(colour)
      expect(getComputedStyle(action.firstElementChild!).color).equals(
        getComputedStyle(colour).color
      )
      await press('Withdraw request')
      expect(calls).equals(disabled ? 0 : 1)
    })
})

describe('photo sheet saves and recovery', () => {
  afterEach(cleanup)
  for (const upload of [false, true])
    it(`saves ${upload ? 'an upload' : 'initials'} and closes only after completion`, async () => {
      const choices: GroupPicture[] = []
      let closes = 0
      await render(
        <PictureSheet
          client={client}
          name="Babe Ruth"
          pickPhoto={async () => ({
            contentType: 'image/png',
            base64: 'placeholder'
          })}
          onSave={async choice => {
            choices.push(choice)
          }}
          onClose={() => {
            closes++
          }}
        />
      )
      expect(button('Save photo').getAttribute('aria-disabled')).equals('true')
      await press(upload ? 'Add Photo' : 'Use initials')
      await press('Save photo')
      expect(choices).deep.equals([
        upload
          ? { image: { contentType: 'image/png', base64: 'placeholder' } }
          : { initials: true }
      ])
      expect(closes).equals(1)
    })
  for (const failure of [new Error('Upload unavailable'), 'unavailable'])
    it(`retains the chosen picture and supports retry after ${typeof failure === 'string' ? 'an unknown failure' : 'an error'}`, async () => {
      let fails = true
      let closes = 0
      await render(
        <PictureSheet
          client={client}
          name="Babe Ruth"
          onSave={async () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise recovery from an unknown rejection.
            if (fails) throw failure
          }}
          onClose={() => {
            closes++
          }}
        />
      )
      await press('Use initials')
      await press('Save photo')
      expect(document.querySelector('[role="alert"]')?.textContent).equals(
        failure instanceof Error
          ? failure.message
          : 'Photo could not be saved. Try again.'
      )
      expect(closes).equals(0)
      fails = false
      await press('Save photo')
      expect(closes).equals(1)
    })
  it('cancels without saving', async () => {
    let saves = 0
    let closes = 0
    await render(
      <PictureSheet
        client={client}
        name="Babe Ruth"
        onSave={async () => {
          saves++
        }}
        onClose={() => {
          closes++
        }}
      />
    )
    await press('Cancel')
    expect(saves).equals(0)
    expect(closes).equals(1)
  })
  it('blocks a second save and cancellation while saving', async () => {
    let release: (() => void) | undefined
    let saves = 0
    let closes = 0
    await render(
      <PictureSheet
        client={client}
        name="Babe Ruth"
        onSave={async () => {
          saves++
          await new Promise<void>(resolve => {
            release = resolve
          })
        }}
        onClose={() => {
          closes++
        }}
      />
    )
    await press('Use initials')
    await press('Save photo')
    await press('Cancel')
    expect(closes).equals(0)
    expect(saves).equals(1)
    await act(async () => {
      release!()
      await new Promise(resolve => setTimeout(resolve, 15))
    })
    expect(closes).equals(1)
  })
})
