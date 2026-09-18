/**
 * Photograph every screen, at the widths where the layout changes.
 *
 * The plan's deliverable is not a folder of pictures: it is that each one was
 * looked at. This only takes them, repeatably, so that the looking is the work
 * and the taking is not.
 *
 *   node tools/screenshots.mjs --out ../shots --only home,videos
 *
 * It expects `npm run start` (the API) and `node build.mjs --serve` (the app)
 * to be running already, and signs in as the local test account through the
 * real sign-in screen — the cookie the server sets is what everything after it
 * depends on, so faking it would be photographing a state the app cannot
 * actually reach.
 */
import { mkdir } from 'fs/promises'
import puppeteer from 'puppeteer'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const out = flag('out', 'screenshots')
const appUrl = flag('app', 'http://127.0.0.1:8080')
const email = flag('email', 'uitest@gamestation.local')
const password = flag('password', 'uitest-local-2609')
const only = flag('only', '')

/** The widths the layout actually changes at, per the plan. */
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, deviceScaleFactor: 2 },
  { name: 'narrow', width: 640, height: 900, deviceScaleFactor: 1 },
  { name: 'tablet', width: 800, height: 900, deviceScaleFactor: 1 },
  { name: 'stacked999', width: 999, height: 900, deviceScaleFactor: 1 },
  { name: 'split1000', width: 1000, height: 900, deviceScaleFactor: 1 },
  { name: 'wide', width: 1440, height: 900, deviceScaleFactor: 1 }
]

/** Each screen, and how to get there from the home screen. */
const SCREENS = [
  { id: 'home', path: '/' },
  { id: 'videos', path: '/videos' },
  { id: 'schedule', path: '/schedule' },
  { id: 'account', path: '/account' }
]

async function main() {
  await mkdir(out, { recursive: true })
  // `PUPPETEER_EXECUTABLE_PATH` rather than downloading another Chrome: this
  // machine already has one under ~/.cache/puppeteer from an earlier version,
  // and a second 150MB copy per npm version is a waste of a laptop.
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 })

  // Sign in once; the session cookie is per host, so every viewport after this
  // one is already signed in.
  await page.goto(appUrl, { waitUntil: 'networkidle2' })
  const onSignIn = await page.$('input[type="email"]')
  if (onSignIn != null) {
    // The screen offers a code first, which is right for a parent and useless
    // here; the password field appears behind `Use a password instead`.
    /* eslint-disable no-undef -- runs in the browser, not in node */
    const switched = await page.evaluate(() => {
      const wanted = [...document.querySelectorAll('div,span')].find(
        node => node.textContent?.trim() === 'Use a password instead'
      )
      if (wanted == null) return false
      ;(wanted.closest('[role="button"]') ?? wanted).dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
      return true
    })
    if (!switched) throw new Error('no password option on the sign-in screen')
    await page.waitForSelector('input[type="password"]', { timeout: 10000 })
    await page.type('input[type="email"]', email)
    await page.type('input[type="password"]', password)
    // A Pressable, not a form: there is no submit for Enter to find.
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('[role="button"]')].find(
        node => node.textContent?.trim() === 'Sign in'
      )
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    /* eslint-enable no-undef */
    await page.waitForFunction(
      () => document.querySelector('input[type="password"]') == null,
      { timeout: 20000 }
    )
  }

  const wanted = only === '' ? null : new Set(only.split(','))
  for (const screen of SCREENS) {
    if (wanted != null && !wanted.has(screen.id)) continue
    for (const view of VIEWPORTS) {
      await page.setViewport(view)
      await page.goto(`${appUrl}${screen.path}`, { waitUntil: 'networkidle2' })
      // Let the fonts settle and any first paint of a list finish.
      await new Promise(resolve => setTimeout(resolve, 900))
      const file = `${out}/${screen.id}-${view.name}.png`
      await page.screenshot({ path: file })
      console.log(file)
    }
  }
  await browser.close()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
