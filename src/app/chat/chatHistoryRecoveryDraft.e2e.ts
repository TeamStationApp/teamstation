/** Real browser draft and reader ownership while historical keys arrive. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  controlRecovery,
  type RecoveryControl
} from '../../test/chatRecoveryControl'

export interface RecoveryDraftDevice {
  evalBrowserScript: (options: { script: string }) => Promise<{ data: unknown }>
  tapOn: (options: Record<string, unknown>) => Promise<unknown>
  inputText: (options: Record<string, unknown>) => Promise<unknown>
  assertVisible: (options: Record<string, unknown>) => Promise<unknown>
  uploadFile: (options: { css: string; path: string }) => Promise<unknown>
  scrollUntilVisible: (options: Record<string, unknown>) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
}

export async function draftRecovery(options: {
  fixture: { source: string; apiUrl: string; artifacts: string }
  recipient: RecoveryDraftDevice
  userId: string
  conversationId: string
  anchorId: string
  anchorBody: string
  returnHolder: () => Promise<void>
  recovered: () => Promise<void>
}): Promise<void> {
  const { fixture: f, recipient: m } = options
  const relayFile = process.env.CHAT_RECOVERY_RELAY
  assert(relayFile != null, 'E5 requires the owned relay settings')
  const relay = JSON.parse(readFileSync(relayFile, 'utf8')) as {
    disposable: true
    source: string
    upstream: string
    endpoint: string
    token: string
    audit: string
  }
  assert.equal(relay.disposable, true)
  assert.equal(relay.source, f.source)
  assert.equal(relay.upstream, f.apiUrl)
  const control: RecoveryControl = {
    disposable: true,
    endpoint: relay.endpoint,
    token: relay.token,
    actors: {
      recipient: {
        userId: options.userId,
        conversationId: options.conversationId
      }
    }
  }
  const draft = 'Keep this draft while older history is recovered'
  const file = join(f.artifacts, 'recovery-draft.txt')
  writeFileSync(
    file,
    'Synthetic attachment prepared during historical recovery.\n',
    { mode: 0o600, flag: 'wx' }
  )
  const anchor = `[data-testid="chat-message-row-${options.anchorId}"]`
  let readerAnchor: string | undefined
  async function snapshot(): Promise<{
    anchor: string
    draft: string
    focused: boolean
    attachment: boolean
    y: number
    scrollTop: number
    height: number
    unread: string | null
  }> {
    const result = await m.evalBrowserScript({
      script: `
      let row=document.querySelector(${JSON.stringify(readerAnchor ?? anchor)});
      const input=document.querySelector('textarea[aria-label="Message"]');
      const history=document.querySelector('[data-testid="chat-message-history"]');
      if(!row || !input || !history) throw new Error('Required reader or draft is absent');
      const scroller=[history,...history.querySelectorAll('*')].find(node => node.contains(row) && node.scrollHeight>node.clientHeight+1 && /auto|scroll/.test(getComputedStyle(node).overflowY));
      if(!scroller) throw new Error('A genuinely scrolling history is required');
      if(${readerAnchor == null}) {
        const top=scroller.getBoundingClientRect().top;
        row=[...history.querySelectorAll('[data-testid^="chat-message-row-"]')].filter(node=>node.getBoundingClientRect().top>=top).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0];
      }
      if(!row) throw new Error('Visible reader anchor is absent');
      return JSON.stringify({anchor:row.getAttribute('data-testid'),draft:input.value,focused:document.activeElement===input,
        attachment:document.querySelector('[aria-label="Remove recovery-draft.txt"]')!==null,
        y:row.getBoundingClientRect().top,scrollTop:scroller.scrollTop,height:scroller.scrollHeight,
        unread:document.querySelector('[data-testid="chat-unread"]')?.textContent ?? null});`
    })
    return JSON.parse(String(result.data))
  }
  try {
    await controlRecovery(control, [
      'recipient',
      'history-delay',
      'draft-recovery',
      '60000'
    ])
    // The public Attach action creates the real file input. Only the OS
    // chooser is intercepted so Maestro can select the owned synthetic file.
    await m.evalBrowserScript({
      script: `window.recoveryInputClick=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type==='file'){this.style.display='block';this.style.width='200px';this.style.height='30px';return}return window.recoveryInputClick.call(this)};return true`
    })
    try {
      await m.tapOn({ text: 'Attach' })
      await m.uploadFile({ css: 'input[type="file"]', path: file })
      await m.assertVisible({
        text: 'Remove recovery-draft.txt',
        timeout: 30000
      })
    } finally {
      await m.evalBrowserScript({
        script:
          'HTMLInputElement.prototype.click=window.recoveryInputClick;delete window.recoveryInputClick;return true'
      })
    }
    await m.tapOn({ css: 'textarea[aria-label="Message"]' })
    await m.inputText({ text: draft })
    await m.scrollUntilVisible({
      element: { css: anchor },
      direction: 'UP',
      timeout: 30000
    })
    const before = await snapshot()
    readerAnchor = `[data-testid="${before.anchor}"]`
    assert.equal(before.draft, draft)
    assert(before.focused && before.attachment)
    assert(
      before.scrollTop > 0,
      'The reader must be away from the absolute start'
    )
    await options.returnHolder()
    const deadline = Date.now() + 10000
    let claimed = false
    while (Date.now() < deadline) {
      const audit = readFileSync(relay.audit, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          line =>
            JSON.parse(line) as {
              gateId: string
              remaining: number
              event?: string
            }
        )
      assert(
        !audit.some(
          row =>
            row.gateId === 'draft-recovery' && row.event === 'delay-released'
        ),
        'Hold expired before the explicit release'
      )
      claimed = audit.some(
        row =>
          row.gateId === 'draft-recovery' &&
          row.remaining === 0 &&
          row.event == null
      )
      if (claimed) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(claimed, 'Actual recipient history delivery must be held')
    writeFileSync(
      join(f.artifacts, 'draft-before-recovery.png'),
      await m.screenshot()
    )
    await controlRecovery(control, ['clear'])
    await options.recovered()
    // Let real layout measurements settle after the placeholder height changes.
    await new Promise(resolve => setTimeout(resolve, 500))
    const after = await snapshot()
    writeFileSync(
      join(f.artifacts, 'draft-after-recovery.png'),
      await m.screenshot()
    )
    writeFileSync(
      join(f.artifacts, 'draft-preservation.json'),
      JSON.stringify({ source: f.source, before, after }, null, 2)
    )
    assert.equal(after.draft, draft)
    assert(after.focused && after.attachment)
    assert(after.height > before.height, 'Recovery must resize historical rows')
    assert(
      Math.abs(after.y - before.y) <= 2,
      'Recovery moved the visible reader anchor'
    )
    assert.equal(
      after.unread,
      before.unread,
      'Old history caused a new unread indication'
    )
    console.log(
      'PASS E5 web: held historical delivery preserves prepared file, draft, focus, reader anchor and unread indication'
    )
  } finally {
    await controlRecovery(control, ['clear'])
  }
}
