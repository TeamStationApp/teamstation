import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import puppeteer from 'puppeteer'

const manifestPath = 'src/common/sportsCatalog.json'
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const browser = await puppeteer.launch({ headless: true })
try {
  const page = await browser.newPage()
  for (const entry of manifest.entries) {
    const source = await readFile(
      `src/app/assets/sports/${entry.id}.svg`,
      'utf8'
    )
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{width:100%;height:100%}</style>${source}`
    )
    for (const size of [96, 192]) {
      await page.setViewport({
        width: size,
        height: size,
        deviceScaleFactor: 1
      })
      const bytes = await page.screenshot({ type: 'png', omitBackground: true })
      await writeFile(`src/app/assets/sports/${entry.id}-${size}.png`, bytes)
      if (size === 192) {
        entry.sha256 = createHash('sha256').update(bytes).digest('hex')
        entry.prefix = `images/catalog/v1/${entry.id}/${entry.sha256.slice(0, 12)}`
      }
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
} finally {
  await browser.close()
}
console.log(
  `Rendered ${manifest.entries.length} transparent illustrations at two sizes`
)
