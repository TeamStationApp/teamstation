import { expect } from 'chai'
import { act } from 'react'

// JSDOM has no scroll implementation; real geometry is proved in Chromium.
if (
  Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'scroll') ==
  null
)
  Object.defineProperty(window.HTMLElement.prototype, 'scroll', {
    configurable: true,
    writable: true,
    value: function (
      this: HTMLElement,
      options?: ScrollToOptions | number
    ): void {
      if (typeof options !== 'number') this.scrollTop = options?.top ?? 0
    }
  })

export async function pressSchedule(selector: string): Promise<void> {
  const node = selector.startsWith('[')
    ? document.querySelector<HTMLElement>(selector)
    : [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
        node =>
          node.getAttribute('aria-label') === selector ||
          node.textContent === selector
      )
  expect(node, selector).not.equals(undefined).and.not.equals(null)
  await act(async () => {
    node!.click()
  })
}
export async function typeSchedule(
  label: string,
  value: string
): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )!
  expect(input, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
export async function chooseSchedule(
  label: string,
  value: string
): Promise<void> {
  const key = {
    Date: 'date',
    'End date': 'endDate',
    Time: 'time',
    'Start time': 'time',
    'End time': 'endTime',
    'Time zone': 'timezone'
  }[label]
  if (key == null) throw new Error(`Unknown schedule field ${label}`)
  await pressSchedule(`[data-testid="event-schedule-${key}"]`)
  if (key === 'date' || key === 'endDate') {
    await typeSchedule('Year', value.slice(0, 4))
    await pressSchedule('[aria-label^="Choose month:"]')
    await pressSchedule(
      [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December'
      ][Number(value.slice(5, 7)) - 1]
    )
    await pressSchedule(`Choose ${value}`)
    await pressSchedule('Use date')
  } else if (key === 'timezone') {
    await typeSchedule('Find time zone', value)
    await pressSchedule(`Use time zone ${value}`)
  } else {
    const [hour, minute] = value.split(':').map(Number)
    await pressSchedule(
      `Hour ${String(hour % 12 === 0 ? 12 : hour % 12).padStart(2, '0')}`
    )
    await pressSchedule(`Minute ${String(minute).padStart(2, '0')}`)
    await pressSchedule(`Period ${hour < 12 ? 'AM' : 'PM'}`)
    await pressSchedule('Use time')
  }
}
