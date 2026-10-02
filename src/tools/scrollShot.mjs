/**
 * Photograph a screen part-way through a scroll.
 *
 * The handoff into the header only exists in the middle: at rest the header is
 * empty and at the bottom it is full, and a mistimed fade or a jumping baseline
 * shows in neither. This takes the picture where the fault would be.
 *
 *   node tools/scrollShot.mjs --path /videos --scroll 0,120,400 --out /tmp/shots
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
const path = flag('path', '/')
const name = flag('name', path.replace(/\W+/g, '') || 'home')
const offsets = flag('scroll', '0,140,600').split(',').map(Number)
const width = Number(flag('width', '390'))
const height = Number(flag('height', '844'))

async function main() {
  await mkdir(out, { recursive: true })
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox']
  })
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 2 })
  await page.goto(appUrl, { waitUntil: 'networkidle2' })
  if ((await page.$('input[type="email"]')) != null) {
    /* eslint-disable no-undef -- runs in the browser, not in node */
    await page.evaluate(() => {
      const node = [...document.querySelectorAll('div,span')].find(
        item => item.textContent?.trim() === 'Use a password instead'
      )
      ;(node?.closest('[role="button"]') ?? node)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })
    await page.waitForSelector('input[type="password"]')
    await page.type('input[type="email"]', 'uitest@teamstation.local')
    await page.type('input[type="password"]', 'uitest-local-2609')
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('[role="button"]')].find(
        item => item.textContent?.trim() === 'Sign in'
      )
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForFunction(
      () => document.querySelector('input[type="password"]') == null
    )
  }
  await page.goto(`${appUrl}${path}`, { waitUntil: 'networkidle2' })
  await new Promise(resolve => setTimeout(resolve, 1200))
  for (const offset of offsets) {
    await page.evaluate(top => {
      // The app scrolls an element, not the window, and the element is the one
      // that actually overflows — an inner content box is taller than its
      // parent without scrolling anything.
      const scrollers = [...document.querySelectorAll('div')].filter(node => {
        const overflow = getComputedStyle(node).overflowY
        return (
          (overflow === 'auto' || overflow === 'scroll') &&
          node.scrollHeight > node.clientHeight + 8
        )
      })
      const scroller = scrollers.sort(
        (a, b) => b.clientHeight - a.clientHeight
      )[0]
      if (scroller != null) scroller.scrollTop = top
    }, offset)
    /* eslint-enable no-undef */
    await new Promise(resolve => setTimeout(resolve, 500))
    const file = `${out}/${name}-scroll${offset}.png`
    await page.screenshot({ path: file })
    console.log(file)
  }
  await browser.close()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
