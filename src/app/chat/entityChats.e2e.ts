/** Run in the task's one already-attached Maestro D Chromium tab. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

async function main(): Promise<void> {
  const {
    MAESTRO_D_CLIENT_ROOT,
    MAESTRO_D,
    MAESTRO_DEVICE,
    TS_CHAT_FIXTURE,
    TS_CHAT_ARTIFACTS,
    TS_CHAT_WEB
  } = process.env
  assert(MAESTRO_D_CLIENT_ROOT != null && MAESTRO_D_CLIENT_ROOT !== '')
  assert(MAESTRO_D != null && MAESTRO_D !== '')
  assert(MAESTRO_DEVICE != null && MAESTRO_DEVICE !== '')
  assert(TS_CHAT_FIXTURE != null && TS_CHAT_FIXTURE !== '')
  assert(TS_CHAT_ARTIFACTS != null && TS_CHAT_ARTIFACTS !== '')
  assert(TS_CHAT_WEB != null && TS_CHAT_WEB !== '')
  const { MaestroD } = require(
    resolve(MAESTRO_D_CLIENT_ROOT, 'dist/cjs/index.js')
  )
  const daemon = await MaestroD.connect({ name: MAESTRO_D, spawn: false })
  const status = await daemon.status()
  assert(
    status.devices.some(
      (device: { id: string }) => device.id === MAESTRO_DEVICE
    ) === true,
    'Reuse the existing browser; never launch another'
  )
  const m = await daemon.attach({ device: MAESTRO_DEVICE })
  const fixture = JSON.parse(readFileSync(TS_CHAT_FIXTURE, 'utf8'))
  const phase = process.argv[2] ?? 'after'
  const read = async <T = unknown>(expression: string): Promise<T> =>
    JSON.parse(
      (
        await m.evalBrowserScript({
          script: `return JSON.stringify(await (${expression}))`
        })
      ).data
    )
  const waitForPath = async (target: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await read('location.pathname+location.search')) === target) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(await read('location.pathname+location.search'), target)
  }
  try {
    for (const [name, path, kind, id] of [
      ['team', `/teams/${fixture.teams.hawks}`, 'team', fixture.teams.hawks],
      [
        'season',
        `/groups/season/${fixture.seasonId}`,
        'season',
        fixture.seasonId
      ]
    ]) {
      const target = phase === 'before' ? path : path + '?tab=chats'
      await m.openBrowser({ url: TS_CHAT_WEB + target })
      await m.assertVisible({
        text: name === 'team' ? 'Team sections' : 'Season sections',
        timeout: 15000
      })
      if (phase === 'before') {
        if (name === 'team')
          await m.assertVisible({
            css: '[aria-label^="Open "][aria-label$=" Members"]',
            timeout: 15000
          })
        writeFileSync(
          resolve(TS_CHAT_ARTIFACTS, name + '-before.png'),
          await m.screenshot()
        )
        continue
      }
      await m.assertVisible({ id: 'entity-chat-list', timeout: 15000 })
      if (name === 'team')
        await m.assertVisible({
          text: 'Practice begins at six.',
          timeout: 15000
        })
      const tabs: string[] = await read(
        `Array.from(document.querySelectorAll('[aria-label="${name === 'team' ? 'Team' : 'Season'} sections"] [role="tab"]')).map(x=>x.textContent)`
      )
      assert.equal(
        tabs[tabs.indexOf('Chats') - 1],
        name === 'team' ? 'Stats' : 'Teams'
      )
      if (tabs.includes('People'))
        assert.equal(tabs[tabs.indexOf('Chats') + 1], 'People')
      const expected: Array<{ id: string; scopeName: string }> = await read(
        `(async()=>{const r=await fetch('/api/v1/chat/conversations');const chats=await r.json();return chats.filter(c=>c.scope?.type===${JSON.stringify(kind)}&&c.scope.id===${JSON.stringify(id)})})()`
      )
      const rows: Array<{ id: string; text: string }> = await read(
        `Array.from(document.querySelectorAll('[data-testid^="entity-chat-cnv"]')).map(x=>({id:x.dataset.testid.slice('entity-chat-'.length),text:x.textContent}))`
      )
      assert.deepEqual(
        rows.map(row => row.id).sort(),
        expected.map(row => row.id).sort()
      )
      assert.equal(
        await read(
          `document.querySelectorAll('[data-testid="entity-chat-list"]').length`
        ),
        1
      )
      for (const row of rows) {
        assert(row.text.includes('chat') && row.text.includes('chevron_right'))
        const scopeName = expected.find(chat => chat.id === row.id)?.scopeName
        if (scopeName != null && scopeName !== '')
          assert(!row.text.includes(scopeName))
      }
      writeFileSync(
        resolve(TS_CHAT_ARTIFACTS, name + '-after.png'),
        await m.screenshot()
      )
      for (const row of rows) {
        // Let the prior section transition finish before using row coordinates.
        await new Promise(resolve => setTimeout(resolve, 300))
        await m.tapOn({ css: '[data-testid="entity-chat-' + row.id + '"]' })
        await waitForPath('/chat/' + row.id)
        // The embedded workspace returns directly to its originating section.
        await m.tapOn({ css: '[aria-label="Back"]' })
        await waitForPath(target)
        await m.assertVisible({ id: 'entity-chat-' + row.id, timeout: 10000 })
      }
      console.log(
        `${name}: order, accessible rows, labels, icon/chevron, previews and exact originating-stack routing passed`
      )
    }
  } finally {
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
