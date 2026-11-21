import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e } from '../../../core/spec'
import {
  TESS_GOLDEN,
  TESS_WEB_SPEC,
  type TessWeb,
  withTess
} from '../../../rigs/tessWeb'

/** A 2 × 2 PNG, for the Choose files step. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64'
)
const ATTACH = '[role="button"][aria-label="Attach a file"]'
const DROP_ZONE = '[data-testid="Tess drop zone"]'
const FILE_INPUT = 'input[type="file"]'

async function attachmentCount(web: TessWeb): Promise<number> {
  return await web.page.$$eval(
    '[data-testid="Tess attachment"]',
    nodes => nodes.length
  )
}

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/attachments',
  title:
    'A file dropped on her panel and a picture chosen from it both reach the model with the message',
  covers: [
    'src/app/tess/AttachPanel.tsx',
    'src/app/tess/Composer.tsx',
    'src/app/tess/tessUploads.ts',
    'src/server/routes/tess.ts'
  ],
  minutes: 1,
  faults: ['api-500', 'not-saved'],
  scenarios: {
    'dropped-and-chosen-files-reach-the-model': async ctx => {
      await withTess(ctx, async web => {
        const { m, page, t } = web
        await web.open('/')
        await web.openChat()
        await web.tap(ATTACH)
        await web.see(DROP_ZONE)
        await ctx.checkpoint('attach-panel', {
          expect: [{ id: 'Tess drop zone' }, { text: 'Choose files' }],
          golden: TESS_GOLDEN
        })
        // Chromium only sends a real drop from the operating system's own drag, so
        // this is the event the panel listens for.
        await m.evalBrowserScript({
          script: `const zone = document.querySelector(${JSON.stringify(DROP_ZONE)})
            const data = new DataTransfer()
            data.items.add(new File(['game,runs\\n1,5\\n2,2\\n'], 'stats.csv', { type: 'text/csv' }))
            zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))`
        })
        await eventually(async () => {
          expect(await attachmentCount(web)).greaterThanOrEqual(1)
        }, 15000)
        if ((await page.$(DROP_ZONE)) == null) await web.tap(ATTACH)
        // The button opens the chooser, which is the operating system's: it is seen
        // opening, and maestro-d sets the file it would have returned.
        await m.evalBrowserScript({
          script: `document.querySelector(${JSON.stringify(FILE_INPUT)})
            .addEventListener('click', () => { window.__chooserOpened = true })`
        })
        await m.tapOn({ text: 'Choose files', role: 'button', timeout: 15000 })
        await eventually(async () => {
          expect(
            await page.evaluate(() => (window as any).__chooserOpened)
          ).equals(true)
        }, 5000)
        const png = ctx.artifact('tess-logo.png')
        writeFileSync(png, PNG)
        await m.uploadFile({ css: FILE_INPUT, path: png, timeout: 15000 })
        await eventually(async () => {
          expect(await attachmentCount(web)).greaterThanOrEqual(2)
        }, 15000)
        const callsBefore = t.model.calls.length
        await web.say('Here are our stats', 'I have your CSV and your picture')
        const sentWith = t.model.calls
          .slice(callsBefore)
          .find(call => call.request?.said === 'Here are our stats')
        expect(sentWith, 'the model was asked').not.equals(undefined)
        const last = sentWith!.request!.messages.at(-1)!
        const blocks = Array.isArray(last.content) ? last.content : []
        expect(blocks.map(block => block.type)).deep.equals([
          'text',
          'text',
          'image',
          'text'
        ])
        expect(String(blocks[1].text)).includes('stats.csv')
        // The message ends with when it was sent and the page beside the chat.
        expect(String(blocks[3].text)).match(/^\(Sent .*Beside this chat/)
        await ctx.checkpoint('files-sent', {
          expect: [{ text: 'I have your CSV and your picture' }],
          golden: TESS_GOLDEN
        })
      })
    }
  }
})
