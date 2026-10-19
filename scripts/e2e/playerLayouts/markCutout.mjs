// Draws a phone's camera cutout onto a screenshot of it, which a screenshot
// never shows: a black disc ringed in red where the hole is, so a picture
// says whether the board is under the camera.
//
//   node scripts/e2e/playerLayouts/markCutout.mjs <in.png> <out.png> <cx> <cy> <r>
//
// The centre and radius are the cutout's, in the screenshot's pixels, as
// `adb shell dumpsys display` gives them (`cutoutSpec`).
/* global Image, document */
import { readFileSync, writeFileSync } from 'node:fs'

import puppeteer from 'puppeteer'

const [input, output, cx, cy, r] = process.argv.slice(2)
const browser = await puppeteer.launch({
  executablePath:
    process.env.TS_PLAYER_BROWSER ??
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: true
})
const page = await browser.newPage()
const data = `data:image/png;base64,${readFileSync(input).toString('base64')}`
const png = await page.evaluate(
  async (source, x, y, radius) => {
    const image = new Image()
    image.src = source
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    context.beginPath()
    context.arc(x, y, radius, 0, 2 * Math.PI)
    context.fillStyle = '#000'
    context.fill()
    context.lineWidth = 6
    context.strokeStyle = '#ff2828'
    context.stroke()
    return canvas.toDataURL('image/png').split(',')[1]
  },
  data,
  Number(cx),
  Number(cy),
  Number(r)
)
writeFileSync(output, Buffer.from(png, 'base64'))
await browser.close()
