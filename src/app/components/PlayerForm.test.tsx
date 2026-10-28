import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { emptyPlayerForm, type PlayerFormValue } from '../../common/playerForm'
import { ThemeProvider } from '../theme/ThemeContext'
import { PlayerForm, type PlayerFormFields } from './PlayerForm'

let root: Root | undefined
let latest: PlayerFormValue | undefined
const node = (label: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const EVERYTHING: PlayerFormFields = {
  name: 'edit',
  hands: 'edit',
  jersey: true,
  positions: true
}

function Harness({
  fields,
  disabled,
  start
}: {
  fields: PlayerFormFields
  disabled?: boolean
  start: PlayerFormValue
}): React.ReactElement {
  const [value, setValue] = useState(start)
  return (
    <PlayerForm
      value={value}
      fields={fields}
      disabled={disabled}
      onChange={next => {
        latest = next
        setValue(next)
      }}
    />
  )
}
async function show(
  fields: PlayerFormFields = EVERYTHING,
  {
    disabled = false,
    start = emptyPlayerForm()
  }: { disabled?: boolean; start?: PlayerFormValue } = {}
): Promise<void> {
  latest = undefined
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Harness fields={fields} disabled={disabled} start={start} />
      </ThemeProvider>
    )
  })
}
async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node(label), value)
    node(label)!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function click(label: string): Promise<void> {
  await act(async () => {
    node(label)!.click()
  })
}
/** The props of the nearest component above a field that takes `name`. */
function propsWith(label: string, name: string): Record<string, any> {
  const element = node(label)!
  const key = Object.keys(element).find(one => one.startsWith('__reactFiber'))!
  let fiber = (element as unknown as Record<string, any>)[key]
  while (fiber != null && !(name in (fiber.memoizedProps ?? {})))
    fiber = fiber.return
  return fiber?.memoizedProps ?? {}
}

describe('PlayerForm', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.innerHTML = ''
  })

  it('lays out two columns: First, Last, Jersey, Throws, Bats, then the positions', async () => {
    await show()
    const form = document.querySelector('[data-testid="Player form"]')!
    expect(form.children).has.length(2)
    const left = form.children[0]
    const order = [...left.querySelectorAll('[aria-label]')].map(one =>
      one.getAttribute('aria-label')
    )
    expect(
      order.filter(label =>
        ['First name', 'Last name', 'Jersey number', 'Throws', 'Bats'].includes(
          label ?? ''
        )
      )
    ).deep.equals([
      'First name',
      'Last name',
      'Jersey number',
      'Throws',
      'Bats'
    ])
    expect(
      form.children[1].querySelector('[data-testid="Position field"]')
    ).not.equals(null)
    expect(form.children[1].textContent).includes('SELECT PLAYER POSITIONS')
  })

  it('reports every edit: names, jersey, hands and positions', async () => {
    await show()
    await type('First name', 'Walker')
    await type('Last name', 'Buehler')
    await type('Jersey number', '21')
    await click('Throws Left')
    await click('Bats Switch')
    await click('Player position P')
    await click('Player position 1B')
    await click('Player position P')
    expect(latest).deep.equals({
      firstName: 'Walker',
      lastName: 'Buehler',
      jersey: '21',
      throws: 'left',
      bats: 'switch',
      positions: ['1B']
    })
    expect(node('Throws Left')!.getAttribute('aria-checked')).equals('true')
    await click('Throws Right')
    expect(latest?.throws).equals('right')
  })

  it('greys read-only names and hands in place, and hides what is hidden', async () => {
    await show(
      { name: 'readOnly', hands: 'readOnly', jersey: true, positions: true },
      {
        start: {
          ...emptyPlayerForm(),
          firstName: 'Corbin',
          lastName: 'B',
          throws: 'right',
          bats: null
        }
      }
    )
    const first = node('First name') as HTMLInputElement
    expect(first.value).equals('Corbin')
    expect(first.readOnly).equals(true)
    // The same capsules as an editable form, greyed, with nothing to press.
    const throws = node('Throws Right')!
    expect(throws.textContent).equals('LR')
    expect(throws.getAttribute('aria-disabled')).equals('true')
    expect(throws.querySelector('[role="radio"]')).equals(null)
    expect(node('Bats unknown')!.textContent).equals('LSR')
    expect(node('Throws Left')).equals(null)
    expect((node('Jersey number') as HTMLInputElement).readOnly).equals(false)
    await act(async () => {
      root!.unmount()
    })
    document.body.innerHTML = ''
    await show({
      name: 'hidden',
      hands: 'hidden',
      jersey: false,
      positions: false
    })
    for (const label of ['First name', 'Jersey number', 'Throws', 'Bats'])
      expect(node(label), label).equals(null)
    expect(document.querySelector('[data-testid="Position field"]')).equals(
      null
    )
  })

  it('takes no edit while disabled', async () => {
    await show(EVERYTHING, { disabled: true })
    await click('Throws Left')
    await click('Player position C')
    expect(latest).equals(undefined)
    expect((node('First name') as HTMLInputElement).readOnly).equals(true)
  })

  it('moves the cursor First name, Last name, Jersey number on return', async () => {
    await show()
    const focused: string[] = []
    for (const label of ['Last name', 'Jersey number'])
      node(label)!.addEventListener('focus', () => focused.push(label))
    await act(async () => {
      propsWith('First name', 'onSubmitEditing').onSubmitEditing()
    })
    await act(async () => {
      propsWith('Last name', 'onSubmitEditing').onSubmitEditing()
    })
    expect(focused).deep.equals(['Last name', 'Jersey number'])
    // With no jersey, Last name is the end.
    await act(async () => {
      root!.unmount()
    })
    document.body.innerHTML = ''
    await show({ ...EVERYTHING, jersey: false })
    expect(propsWith('Last name', 'onSubmitEditing').onSubmitEditing).equals(
      undefined
    )
  })
})
