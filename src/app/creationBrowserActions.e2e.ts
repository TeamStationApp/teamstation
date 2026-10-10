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
      (label, role) =>
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
  await page.evaluate(
    (label, role) => {
      const button = [
        ...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)
      ].find(
        node =>
          (node.hasAttribute('aria-label')
            ? node.getAttribute('aria-label')
            : node.textContent) === label
      )
      if (button == null) throw new Error('Missing requested action')
      button.click()
    },
    label,
    role
  )
}
export async function fill(
  page: Page,
  label: string,
  value: string
): Promise<void> {
  const selector = `input[aria-label="${label}"]`
  await page.waitForSelector(selector)
  await page.click(selector)
  await page.$eval(selector, input => {
    ;(input as HTMLInputElement).focus()
    ;(input as HTMLInputElement).select()
  })
  await page.keyboard.press('Backspace')
  await page.waitForFunction(
    selector => {
      const input = document.querySelector<HTMLInputElement>(selector)
      return input !== null && input.value === ''
    },
    {},
    selector
  )
  // Paste one value through the browser input event so React receives one
  // complete edit even while V8 coverage slows successive key events.
  await page.focus(selector)
  await page.keyboard.sendCharacter(value)
  await page
    .waitForFunction(
      (selector, value) => {
        const input = document.querySelector<HTMLInputElement>(selector)
        return input !== null && input.value === value
      },
      {},
      selector,
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
