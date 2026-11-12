import type { Page } from 'puppeteer'
/** Pin the test calendar without changing application or operating-system clocks. */
export async function freezeBrowserClock(
  page: Page,
  timestamp = Date.parse('2026-10-06T19:00:00Z')
): Promise<void> {
  await page.evaluateOnNewDocument(timestamp => {
    window.Date = new Proxy(Date, {
      construct(target, args) {
        return Reflect.construct(
          target,
          args.length === 0 ? [timestamp] : args
        ) as Date
      },
      apply(target) {
        const NativeDate = target
        return new NativeDate(timestamp).toString()
      },
      get(target, property) {
        return property === 'now'
          ? () => timestamp
          : (Reflect.get(target, property) as unknown)
      }
    })
  }, timestamp)
}

export async function press(
  page: Page,
  label: string,
  role: 'button' | 'tab' = 'button'
): Promise<void> {
  await page
    .waitForFunction(
      // A press during a push or a pop can land on the screen that is going.
      (label, role) =>
        document.querySelector(
          '[data-scene-role="incoming"], [data-scene-role="outgoing"]'
        ) == null &&
        [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].some(
          node =>
            (node.hasAttribute('aria-label')
              ? node.getAttribute('aria-label')
              : node.textContent) === label &&
            node.getAttribute('aria-disabled') !== 'true'
        ),
      {},
      label,
      role
    )
    .catch(async (error: unknown) => {
      const shots = process.env.TS_CREATION_ARTIFACTS
      if (shots != null && shots !== '') {
        await page
          .screenshot({
            path: `${shots}/unavailable-${label.replace(/[^\w-]+/g, '_')}.png`
          })
          .catch(() => undefined)
      }
      console.error(
        'Unavailable browser action:',
        label,
        await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[role="button"]')].map(
            node => ({
              label: node.getAttribute('aria-label'),
              text: node.textContent,
              disabled: node.getAttribute('aria-disabled')
            })
          )
        )
      )
      throw error
    })
  // Found and clicked in one turn of the page: a list that re-renders as a
  // search settles can replace the node between a find and a later click.
  await page.waitForFunction(
    (label, role) => {
      const matches = [
        ...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)
      ].filter(
        node =>
          (node.hasAttribute('aria-label')
            ? node.getAttribute('aria-label')
            : node.textContent) === label &&
          node.getAttribute('aria-disabled') !== 'true'
      )
      // The top scene's own control, when the app's navigation outside the
      // scenes carries one of the same name.
      const onTop = matches.filter(
        node => node.closest('[data-scene-role="top"]') != null
      )
      const button = (onTop.length > 0 ? onTop : matches).at(-1)
      if (button == null) return false
      button.click()
      return true
    },
    { timeout: 10000 },
    label,
    role
  )
}
export async function fill(
  page: Page,
  label: string,
  value: string
): Promise<void> {
  const selector = `:is(input, textarea)[aria-label="${label}"]`
  await page.waitForSelector(selector)
  // Routed sheets can retain hidden inputs from the previous visit. Select the
  // visible field, rather than the first matching node left in the document.
  const fields = await page.$$(selector)
  let field = fields.at(-1)
  for (const candidate of fields)
    if (await candidate.isVisible()) field = candidate
  if (field == null) throw new Error(`Missing visible field: ${label}`)
  await page.waitForFunction(
    input => !(input as HTMLInputElement).disabled,
    {},
    field
  )
  await field.evaluate(input => {
    ;(input as HTMLInputElement).focus()
    ;(input as HTMLInputElement).select()
  })
  await page.keyboard.press('Backspace')
  await page.waitForFunction(
    input => (input as HTMLInputElement).value === '',
    {},
    field
  )
  // Paste one value through the browser input event so React receives one
  // complete edit even while V8 coverage slows successive key events.
  await field.focus()
  await page.keyboard.sendCharacter(value)
  await page
    .waitForFunction(
      (input, value) => (input as HTMLInputElement).value === value,
      {},
      field,
      value
    )
    .catch(async (error: unknown) => {
      console.error(
        'Browser field value mismatch:',
        label,
        /code|password|email|e-mail/i.test(label)
          ? '[redacted]'
          : await page.$eval(
              selector,
              input => (input as HTMLInputElement).value
            )
      )
      throw error
    })
}
export async function text(page: Page, value: string): Promise<void> {
  await page
    .waitForFunction(
      value => {
        const content = document.body.textContent
        if (content === null) return false
        return content.toLowerCase().includes(value.toLowerCase())
      },
      {},
      value
    )
    .catch(async (error: unknown) => {
      console.error(
        'Missing browser state:',
        value,
        await page.evaluate(() => document.body.textContent)
      )
      throw error
    })
}

/**
 * Waits for text a list loads a page at a time: while it is not on the page,
 * scrolls each scrolled list to its end, as a person scrolling for more does.
 */
export async function textInList(page: Page, value: string): Promise<void> {
  for (let tries = 0; tries < 20; tries++) {
    const found = await page.evaluate((value: string) => {
      const content = document.body.textContent
      if (content === null) return false
      return content.toLowerCase().includes(value.toLowerCase())
    }, value)
    if (found) return
    await page.evaluate(() => {
      for (const node of [
        document.scrollingElement,
        ...document.querySelectorAll<HTMLElement>('div')
      ])
        if (node != null && node.scrollHeight > node.clientHeight + 1)
          node.scrollTop = node.scrollHeight
    })
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  await text(page, value)
}

/** Frame the asserted state in the actual scrollable screen before capturing proof. */
export async function frameText(
  page: Page,
  value: string,
  block: 'center' | 'end' = 'center'
): Promise<void> {
  await page.evaluate(
    (value, block) => {
      const node = [...document.querySelectorAll<HTMLElement>('div,span')].find(
        node => {
          if (node.childElementCount !== 0) return false
          const content = node.textContent
          if (content === null) return false
          return content.includes(value)
        }
      )
      if (node == null) throw new Error('Missing screenshot state')
      const frame =
        block === 'end' && node.parentElement !== null
          ? node.parentElement
          : node
      frame.scrollIntoView({ block, behavior: 'instant' })
    },
    value,
    block
  )
  await page
    .waitForFunction(
      value => {
        const node = [
          ...document.querySelectorAll<HTMLElement>('div,span')
        ].find(node => {
          if (node.childElementCount !== 0) return false
          const content = node.textContent
          if (content === null) return false
          return content.includes(value)
        })
        if (node == null) return false
        const bounds = node.getBoundingClientRect()
        return bounds.top >= 50 && bounds.bottom <= window.innerHeight
      },
      { timeout: 3000 },
      value
    )
    .catch(async () => {
      const bounds = await page.evaluate(value => {
        const node = [
          ...document.querySelectorAll<HTMLElement>('div,span')
        ].find(node => {
          if (node.childElementCount !== 0) return false
          const content = node.textContent
          if (content === null) return false
          return content.includes(value)
        })
        return node == null
          ? null
          : {
              top: node.getBoundingClientRect().top,
              bottom: node.getBoundingClientRect().bottom,
              height: window.innerHeight
            }
      }, value)
      throw new Error(
        'Screenshot state outside viewport: ' + JSON.stringify(bounds)
      )
    })
}

/** The value an event schedule row shows, from its label `<field>: <value>`. */
async function scheduleValue(page: Page, field: string): Promise<string> {
  const css = `[data-scene-role="top"] [role="button"][aria-label^="${field}: "]`
  await page.waitForSelector(css, { timeout: 15000 })
  const label = await page.$eval(css, node => node.getAttribute('aria-label'))
  return String(label).slice(field.length + 2)
}

/** Waits for the event schedule row `field` to show `value`. */
async function rowShows(
  page: Page,
  field: string,
  value: string
): Promise<void> {
  await page.waitForSelector(
    `[data-scene-role="top"] [role="button"][aria-label="${field}: ${value}"]`,
    { timeout: 15000 }
  )
}

/**
 * Picks `date` (YYYY-MM-DD) for the event schedule row `field` ("Date",
 * "End date"): opens its calendar, steps from the month it shows to the
 * date's, chooses the day and uses it.
 */
export async function chooseDate(
  page: Page,
  field: string,
  date: string
): Promise<void> {
  const shown = await scheduleValue(page, field)
  const months = (value: string): number =>
    Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7))
  await press(page, `${field}: ${shown}`)
  const delta = months(date) - months(shown)
  for (let i = 0; i < Math.abs(delta); i++)
    await press(page, delta > 0 ? 'Next month' : 'Previous month')
  await press(page, `Choose ${date}`)
  await press(page, 'Use date')
  await rowShows(page, field, date)
}

/**
 * Picks `time` (HH:MM, 24-hour, minutes in fives) for the event schedule row
 * `field` ("Start time", "End time") on its hour, minute and period wheels.
 */
export async function chooseTime(
  page: Page,
  field: string,
  time: string
): Promise<void> {
  const shown = await scheduleValue(page, field)
  const [hour, minute] = time.split(':').map(Number)
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  const minutes = String(minute).padStart(2, '0')
  const period = hour < 12 ? 'AM' : 'PM'
  await press(page, `${field}: ${shown}`)
  await press(page, `Hour ${String(twelve).padStart(2, '0')}`)
  await press(page, `Minute ${minutes}`)
  await press(page, `Period ${period}`)
  await press(page, 'Use time')
  await rowShows(page, field, `${twelve}:${minutes} ${period}`)
}
