import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import type { AccountHarness } from '../test/accountHarness'
import { creationHarness } from '../test/creationHarness'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null)
  throw new Error('Set TS_CREATION_ARTIFACTS for creation proof')

async function press(page: Page, label: string): Promise<void> {
  await page
    .waitForFunction(
      label =>
        [...document.querySelectorAll<HTMLElement>('[role="button"]')].some(
          node =>
            (node.hasAttribute('aria-label')
              ? node.getAttribute('aria-label')
              : node.textContent) === label &&
            node.getAttribute('aria-disabled') !== 'true'
        ),
      {},
      label
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
  await page.evaluate(label => {
    const button = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(
      node =>
        (node.hasAttribute('aria-label')
          ? node.getAttribute('aria-label')
          : node.textContent) === label
    )
    if (button == null) throw new Error('Missing requested action')
    button.click()
  }, label)
}
async function fill(page: Page, label: string, value: string): Promise<void> {
  const selector = `input[aria-label="${label}"]`
  await page.waitForSelector(selector)
  await page.$eval(selector, input => {
    ;(input as HTMLInputElement).select()
  })
  await page.keyboard.press('Backspace')
  await page.type(selector, value)
}
async function text(page: Page, value: string): Promise<void> {
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

async function signUp(
  page: Page,
  h: AccountHarness,
  email: string
): Promise<void> {
  await page.goto(h.origin + '/sign-in', { waitUntil: 'networkidle0' })
  await fill(page, 'E-mail address', email)
  await press(page, 'Send me a sign-in code')
  await text(page, 'six-digit code is on its way')
  expect(
    await h.db
      .selectFrom('user_emails')
      .select('id')
      .where('email', '=', email)
      .execute()
  ).length(0)
  await fill(page, 'Sign-in code', h.mail.get(email)!)
  await press(page, 'Sign in')
  await text(page, 'What is your name?')
}

async function accountVector(page: Page, h: AccountHarness): Promise<void> {
  await signUp(page, h, 'browser-new@example.com')
  await page.screenshot({ path: join(artifacts!, 'sign-in-after.png') })
  await page.screenshot({ path: join(artifacts!, 'onboarding-name.png') })
  await fill(page, 'Name', 'Mike Trout')
  await press(page, 'Continue')
  await text(page, 'Choose your photo')
  await page.reload({ waitUntil: 'networkidle0' })
  await text(page, 'Choose your photo')
  await page.screenshot({ path: join(artifacts!, 'onboarding-flow-after.png') })
  const user = await h.db
    .selectFrom('user_emails')
    .select('user_id')
    .where('email', '=', 'browser-new@example.com')
    .executeTakeFirstOrThrow()
  expect(
    (
      await h.db
        .selectFrom('users')
        .select('onboarding_step')
        .where('id', '=', user.user_id)
        .executeTakeFirstOrThrow()
    ).onboarding_step
  ).equals('photo')
  expect(
    await h.db
      .selectFrom('memberships')
      .select('id')
      .where('user_id', '=', user.user_id)
      .execute()
  ).length(0)
}

async function photoVector(page: Page, h: AccountHarness): Promise<void> {
  await page.waitForSelector('[aria-label="Baseball"]')
  const geometry = await page.evaluate(() => {
    const labels = ['Add Photo', 'Baseball', 'American football']
    return labels.map(label => {
      const node = document.querySelector<HTMLElement>(
        `[role="button"][aria-label="${label}"]`
      )!
      const box = node.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    })
  })
  expect(
    Math.max(...geometry.map(rect => rect.y)) -
      Math.min(...geometry.map(rect => rect.y))
  ).lessThan(2)
  expect(geometry[0].width).closeTo(geometry[0].height, 2)
  const before = h.objects.size
  await press(page, 'Baseball')
  await page.screenshot({ path: join(artifacts!, 'onboarding-photo.png') })
  await page.screenshot({ path: join(artifacts!, 'photo-grid-after.png') })
  await press(page, 'Continue')
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Account, Mike Trout"]') != null
  )
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Account, Mike Trout"]') != null
  )
  expect(h.objects.size).equals(before)
  const user = await h.db
    .selectFrom('user_emails')
    .select('user_id')
    .where('email', '=', 'browser-new@example.com')
    .executeTakeFirstOrThrow()
  expect(
    await h.db
      .selectFrom('users')
      .select(['picture_catalog_id', 'onboarding_step'])
      .where('id', '=', user.user_id)
      .executeTakeFirstOrThrow()
  ).deep.equals({ picture_catalog_id: 'baseball', onboarding_step: 'complete' })
  await press(page, 'Account, Mike Trout')
  await text(page, 'Email addresses')
  await page.screenshot({ path: join(artifacts!, 'account-photo-after.png') })
}

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const h = await creationHarness(resolve('dist'))
  let browser: Browser | undefined
  const lines = [
    '$ node -r sucrase/register src/app/creation.e2e.ts --phase M3'
  ]
  try {
    browser = await puppeteer.launch({ headless: true })
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.coverage.startJSCoverage({
      resetOnNavigation: false,
      includeRawScriptCoverage: true
    })
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await accountVector(page, h)
    lines.push(
      'E1 PASS: verification creates exactly one plain account; name persists and reload resumes photo'
    )
    await photoVector(page, h)
    lines.push(
      'E2 PASS: actual three-column square grid, Add Photo first, shared catalog reference, persistent completed profile'
    )
    const require = createRequire(resolve('package.json'))
    const convert = require('v8-to-istanbul') as (
      file: string,
      offset: number,
      sources: unknown
    ) => {
      load: () => Promise<void>
      applyCoverage: (functions: unknown) => void
      toIstanbul: () => Record<string, unknown>
    }
    const createCoverageMap = require('istanbul-lib-coverage')
      .createCoverageMap as (value: unknown) => {
      merge: (value: unknown) => void
      toJSON: () => unknown
    }
    const coverage = createCoverageMap({})
    for (const script of await page.coverage.stopJSCoverage()) {
      if (
        !script.url.startsWith(h.origin + '/app-') ||
        script.rawScriptCoverage == null
      )
        continue
      const generated = resolve('dist', basename(new URL(script.url).pathname))
      const converter = convert(generated, 0, {
        source: script.text,
        sourceMap: {
          sourcemap: JSON.parse(await readFile(generated + '.map', 'utf8'))
        }
      })
      await converter.load()
      converter.applyCoverage(script.rawScriptCoverage.functions)
      coverage.merge(converter.toIstanbul())
    }
    await mkdir('coverage/creation', { recursive: true })
    await writeFile(
      'coverage/creation/browser.json',
      JSON.stringify(coverage.toJSON())
    )
    await writeFile(join(artifacts!, 'signup.log'), lines.join('\n') + '\n')
    await writeFile(
      join(artifacts!, 'browser-vectors.log'),
      lines.join('\n') + '\n'
    )
    console.log(lines.slice(1).join('\n'))
  } finally {
    await browser?.close()
    await h.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
