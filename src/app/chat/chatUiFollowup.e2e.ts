/** Functional follow-up scenarios run only on explicitly supplied fixture surfaces. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import puppeteer from 'puppeteer'

interface Device {
  evalBrowserScript: (options: { script: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  openTab: (options: { url: string; tabLabel: string }) => Promise<unknown>
  assertVisible: (options: {
    text: string
    timeout?: number
  }) => Promise<unknown>
  tapOn: (options: {
    text?: string
    css?: string
    optional?: boolean
    timeout?: number
  }) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  pressKey: (options: { key: string }) => Promise<unknown>
  longPressOn: (options: { text?: string; css?: string }) => Promise<unknown>
  setOrientation: (options: { orientation: string }) => Promise<unknown>
  grantPermissions: (options: {
    permissions: string[]
    origin: string
  }) => Promise<unknown>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  close: () => Promise<unknown>
}
function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const WEB = required('TS_CHAT_WEB_URL').replace(/\/+$/, '')
const API = required('TS_CHAT_API_URL').replace(/\/+$/, '')
const hidden: string[] = []

async function signIn(device: Device, key: string): Promise<void> {
  let credentials:
    { userId: number; email: string; password: string } | undefined
  for (const line of readFileSync(required('CHAT_UI_SEED_FILE'), 'utf8').split(
    '\n'
  )) {
    const match = /^(\S+)\s.*?\s(\d{6,})\s+(\S+@\S+)\s+(\S+)$/.exec(line)
    if (match?.[1] === key)
      credentials = {
        userId: Number(match[2]),
        email: match[3],
        password: match[4]
      }
  }
  assert(credentials != null, 'Fixture sign-in unavailable')
  hidden.push(credentials.password)
  await device.openLink({ link: WEB })
  const authorized = (await device.evalBrowserScript({
    script: `const response=await fetch(${JSON.stringify(API + '/auth/me')},{credentials:'include'});if(response.ok){const user=await response.json();if(Number(user.id)!==${credentials.userId})throw new Error('Fixture profile belongs to another user');return true}return false`
  })) as { data?: unknown }
  if (authorized.data === 'true' || authorized.data === true) return
  await device.tapOn({ text: 'Sign in', optional: true, timeout: 3000 })
  await device.tapOn({
    text: 'Use a password instead',
    optional: true,
    timeout: 3000
  })
  const available = (await device.evalBrowserScript({
    script: 'return document.body.innerText.includes("E-mail address")'
  })) as { data?: unknown }
  if (available.data === 'false' || available.data === false) return
  await device.tapOn({ text: 'E-mail address' })
  await device.inputText({ text: credentials.email })
  await device.tapOn({ text: 'Password' })
  await device.inputText({ text: credentials.password })
  await device.tapOn({ text: 'Sign in' })
  await device.assertVisible({ text: 'Follow a team', timeout: 60000 })
}

async function s1(daemon: Daemon): Promise<void> {
  const profile = required('CHAT_UI_PROFILE_DIR')
  const peerProfile = required('CHAT_UI_PEER_PROFILE_DIR')
  const conversationId = required('CHAT_UI_CONVERSATION')
  const messageId = required('CHAT_UI_MESSAGE')
  const browser =
    process.env.TS_CHROME_PATH ?? (await puppeteer.executablePath())
  const make = async (device: string, userDataDir: string): Promise<Device> =>
    await daemon.attach({
      device,
      platform: 'web',
      driver: 'cdp',
      url: WEB,
      artifacts: 'on-failure',
      extra: { browser, windowSize: '1440x1000', userDataDir }
    })
  const primary = await make('chat-ui-s1-primary', profile)
  const peer = await make('chat-ui-s1-peer', peerProfile)
  const preamble = `
    const api = ${JSON.stringify(API)};
    const id = ${JSON.stringify(conversationId)};
    const message = ${JSON.stringify(messageId)};
    async function request(method, path, body) {
      const response = await fetch(api + path, {method, credentials:'include', headers: body == null ? {} : {'Content-Type':'application/json'}, ...(body == null ? {} : {body: JSON.stringify(body)})});
      if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status);
      return await response.json();
    }
    function check(value, message) { if (!value) throw new Error(message); }
    const path = '/chat/conversations/' + encodeURIComponent(id);
  `
  try {
    await signIn(primary, 'Hc')
    await signIn(peer, 'Hs')
    await primary.openLink({ link: `${WEB}/chat` })
    await peer.openLink({ link: `${WEB}/chat` })
    console.log(
      '$ S1 PATCH personal preferences, GET list/pins, and compare public read cursors'
    )
    console.log(
      await primary.evalBrowserScript({
        script: `${preamble}
      const before = (await request('GET','/chat/conversations')).find(chat=>chat.id===id);
      check(before != null, 'Fixture conversation missing');
      window.chatUiRestorePreferences = before.preferences;
      window.chatUiReadCursors = await request('GET', path + '/reads');
      const changed = await request('PATCH',path+'/preferences',{pinned:true,muted:true,manualUnread:true});
      const next = await request('PATCH',path+'/preferences',{manualUnread:true});
      check(next.manualUnreadRevision === changed.manualUnreadRevision + 1, 'Unread revision did not advance');
      await request('PUT',path+'/read',{seq:before.lastSeq,clearManualUnreadRevision:changed.manualUnreadRevision});
      const listed=(await request('GET','/chat/conversations')).find(chat=>chat.id===id);
      check(listed.preferences.pinned && listed.preferences.muted && listed.preferences.manualUnread, 'Personal state or stale-read protection missing');
      check(listed.lastPostAt === before.lastPostAt, 'Preferences changed recency');
      check(JSON.stringify(await request('GET',path+'/reads'))===JSON.stringify(window.chatUiReadCursors),'Mark unread changed public read cursors');
      const pins=await request('PUT',path+'/pins/'+encodeURIComponent(message));
      check(pins.some(pin=>pin.messageId===message),'Pin was not saved');
      await request('PUT',path+'/pins/'+encodeURIComponent(message));
      check((await request('GET',path+'/pins')).filter(pin=>pin.messageId===message).length===1,'Pin not idempotent');
      return {personalState:true,staleReadPreserved:true,publicReceiptsUnchanged:true,pinSavedOnce:true};
    `
      })
    )
    console.log('$ S1 GET another fixture user personal state and pins')
    console.log(
      await peer.evalBrowserScript({
        script: `${preamble}
      const listed=(await request('GET','/chat/conversations')).find(chat=>chat.id===id);
      check(listed != null && !listed.preferences.pinned && !listed.preferences.muted && !listed.preferences.manualUnread,'Another user received personal preferences');
      check(!(await request('GET',path+'/pins')).some(pin=>pin.messageId===message),'Another user received personal pin');
      const denied=await fetch(api+'/chat/conversations/not-a-fixture/pins',{credentials:'include'});
      check(denied.status===404,'Nonmember access not denied');
      return {otherUserIsolated:true,nonmemberDenied:true};
    `
      })
    )
    await primary.openTab({ url: `${WEB}/chat`, tabLabel: 'same-user-client' })
    console.log(
      '$ S1 GET personal state from another signed-in browser document'
    )
    console.log(
      await primary.evalBrowserScript({
        script: `${preamble}
      const listed=(await request('GET','/chat/conversations')).find(chat=>chat.id===id);
      check(listed.preferences.pinned && listed.preferences.muted && listed.preferences.manualUnread,'Same-user client did not reload personal state');
      check((await request('GET',path+'/pins')).some(pin=>pin.messageId===message),'Same-user client did not reload pins');
      await request('PUT',path+'/read',{seq:listed.lastSeq,clearManualUnreadRevision:listed.preferences.manualUnreadRevision});
      check(!(await request('GET','/chat/conversations')).find(chat=>chat.id===id).preferences.manualUnread,'Matching read did not clear unread');
      await request('DELETE',path+'/pins/'+encodeURIComponent(message));
      await request('DELETE',path+'/pins/'+encodeURIComponent(message));
      await request('PATCH',path+'/preferences',{pinned:false,muted:false,manualUnread:false});
      return {sameUserPersisted:true,matchingReadCleared:true,unpinIdempotent:true,fixturePresentationRestored:true};
    `
      })
    )
    console.log('S1 PASS')
  } finally {
    await primary.detach()
    await peer.detach()
  }
}

async function s2(daemon: Daemon): Promise<void> {
  const narrow = process.env.CHAT_UI_VIEWPORT === 'narrow'
  const m = await daemon.attach({
    device: narrow ? 'chat-ui-narrow' : 'chat-ui-wide',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: process.env.TS_CHROME_PATH ?? (await puppeteer.executablePath()),
      windowSize: narrow ? '390x844' : '1440x1000',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  try {
    await signIn(m, narrow ? 'Hs' : 'Hc')
    await m.evalBrowserScript({
      script: `const r=await fetch(${JSON.stringify(API + '/chat/conversations/' + required('CHAT_UI_CONVERSATION') + '/preferences')},{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned:false,muted:false,manualUnread:false})});if(!r.ok)throw new Error('Fixture preferences unavailable');return true`
    })
    await m.openLink({ link: WEB + '/chat' })
    await m.assertVisible({ text: 'Team Members', timeout: 60000 })
    console.log('$ S2 inspect scope pills and responsive pane visibility')
    console.log(
      await m.evalBrowserScript({
        script: `
      const list=document.querySelector('[data-testid="chat-list-pane"]');
      const messages=document.querySelector('[data-testid="chat-message-pane"]');
      if(!list || !messages)throw new Error('Workspace panes missing');
      if(getComputedStyle(list).display==='none')throw new Error('Chat list hidden');
      if(${narrow} && getComputedStyle(messages).display!=='none')throw new Error('Narrow message pane should be hidden on list route');
      if(!${narrow} && getComputedStyle(messages).display==='none')throw new Error('Wide message pane missing');
      if(!document.body.innerText.includes('Team Members') || !document.body.innerText.includes('Season All Staff'))throw new Error('Structured pills missing');
      return JSON.stringify({viewport:innerWidth,paneLayout:${narrow}?'narrow':'wide',scopePills:true});
    `
      })
    )
    const artifacts = required('CHAT_UI_ARTIFACTS')
    await m.tapOn({ css: '[role="button"][aria-label="Hawks Members"]' })
    await m.assertVisible({
      text: 'Practice update: please bring water and arrive at 5:30.',
      timeout: 60000
    })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Mark unread' })
    await m.assertVisible({ text: 'Mute' })
    await m.assertVisible({ text: 'Pin' })
    writeFileSync(
      join(
        artifacts,
        narrow
          ? 'narrow-conversation-menu-after.png'
          : 'wide-conversation-menu-after.png'
      ),
      await m.screenshot()
    )
    await m.tapOn({ text: 'Pin' })
    if (narrow) await m.tapOn({ text: 'Back' })
    await m.assertVisible({ text: 'Pinned', timeout: 30000 })
    writeFileSync(
      join(
        artifacts,
        narrow ? 'narrow-chat-list-after.png' : 'wide-chat-list-after.png'
      ),
      await m.screenshot()
    )
    if (narrow)
      await m.tapOn({ css: '[role="button"][aria-label="Hawks Members"]' })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Unpin' })
    await m.tapOn({ text: 'Unpin' })
    await m.tapOn({ text: 'Conversation actions' })
    await m.tapOn({ text: 'Mute' })
    if (!narrow) await m.assertVisible({ text: 'Muted', timeout: 30000 })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Unmute' })
    await m.tapOn({ text: 'Unmute' })
    await m.tapOn({ text: 'Conversation actions' })
    await m.tapOn({ text: 'Mark unread' })
    console.log('$ S3 manual unread survives the mounted selected pane')
    console.log(
      await m.evalBrowserScript({
        script: `
      await new Promise(resolve=>setTimeout(resolve,1000));
      const response=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});
      const chat=(await response.json()).find(item=>item.id===${JSON.stringify(required('CHAT_UI_CONVERSATION'))});
      if(!chat.preferences.manualUnread)throw new Error('Selected pane immediately cleared Mark unread');
      return JSON.stringify({manualUnreadOnOpenPane:true,mutingAndPinning:true});
    `
      })
    )
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    console.log(
      await m.evalBrowserScript({
        script: `
      await new Promise(resolve=>setTimeout(resolve,500));
      const response=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});
      const chat=(await response.json()).find(item=>item.id===${JSON.stringify(required('CHAT_UI_CONVERSATION'))});
      if(chat.preferences.manualUnread)throw new Error('Explicit composer read did not clear manual unread');
      return JSON.stringify({explicitReadCleared:true});
    `
      })
    )
    console.log(narrow ? 'S2/S3 narrow PASS' : 'S2/S3 wide PASS')
  } finally {
    await m.detach()
  }
}

async function s4(daemon: Daemon): Promise<void> {
  const m = await daemon.attach({
    device: 'chat-ui-resize',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: '390x1440',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  try {
    await signIn(m, 'Hc')
    await m.openLink({
      link: WEB + '/chat/' + required('CHAT_UI_CONVERSATION')
    })
    await m.assertVisible({
      text: required('CHAT_UI_TARGET_TEXT'),
      timeout: 60000
    })
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: 'An unsent practice note' })
    await m.pressKey({ key: 'Shift+Enter' })
    await m.inputText({ text: 'Bring a glove' })
    await m.evalBrowserScript({
      script:
        'window.chatUiResizeDocument=Date.now();window.chatUiResizeField=document.querySelector("[data-testid=chat-composer]");return true'
    })
    console.log(
      '$ S4 same-document portrait→landscape→portrait across960px; retain composer/selected conversation'
    )
    for (const orientation of ['LANDSCAPE', 'PORTRAIT']) {
      await m.setOrientation({ orientation })
      console.log(
        await m.evalBrowserScript({
          script: `
        await new Promise(resolve=>setTimeout(resolve,400));
        const input=document.querySelector('[data-testid="chat-composer"]');
        if(!window.chatUiResizeDocument || input!==window.chatUiResizeField || input.value!=='An unsent practice note\\nBring a glove')throw new Error('Responsive resize discarded the document or draft');
        const list=document.querySelector('[data-testid="chat-list-pane"]');
        if((getComputedStyle(list).display!=='none')!==(innerWidth>=960))throw new Error('Pane breakpoint wrong');
        return JSON.stringify({orientation:${JSON.stringify(orientation)},width:innerWidth,sameDocument:true,sameComposer:true,draftPreserved:true});
      `
        })
      )
    }
    await m.tapOn({ text: 'Back' })
    await m.tapOn({ css: '[role="button"][aria-label="Hawks Members"]' })
    console.log(
      await m.evalBrowserScript({
        script: `const input=document.querySelector('[data-testid="chat-composer"]');if(input.value!=='An unsent practice note\\nBring a glove')throw new Error('Back/reopen lost draft');input.focus();return JSON.stringify({backReopenDraft:true});`
      })
    )
    await m.pressKey({ key: 'Cmd+A' })
    await m.pressKey({ key: 'Backspace' })
    console.log(
      'S4 text and selected-pane PASS; reply/file/offset completed in final scenario'
    )
  } finally {
    await m.detach()
  }
}

async function s5(daemon: Daemon): Promise<void> {
  const id = required('CHAT_UI_MESSAGE')
  const target = required('CHAT_UI_TARGET_TEXT')
  const row = `[data-testid="chat-message-${id}"]`
  const artifacts = required('CHAT_UI_ARTIFACTS')
  const m = await daemon.attach({
    device: 'chat-ui-message-wide',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: '1440x1000',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  try {
    await signIn(m, 'Hc')
    await m.openLink({
      link: WEB + '/chat/' + required('CHAT_UI_CONVERSATION')
    })
    await m.assertVisible({ text: target, timeout: 60000 })
    console.log(
      '$ S5 hover actual original message, inspect named controls, anchored menu and clipboard body'
    )
    await m.evalBrowserScript({
      script: `document.querySelector(${JSON.stringify(row)}).dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
    })
    await m.assertVisible({ text: 'More message actions' })
    writeFileSync(
      join(artifacts, 'desktop-message-hover-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ css: row + ' [aria-label="More message actions"]' })
    await m.assertVisible({ text: 'Copy text' })
    await m.assertVisible({ text: 'Pin' })
    await m.assertVisible({ text: 'Delete' })
    writeFileSync(
      join(artifacts, 'desktop-message-menu-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ text: 'Copy text' })
    await m.grantPermissions({
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      origin: WEB
    })
    console.log(
      await m.evalBrowserScript({
        script: `if(await navigator.clipboard.readText()!==${JSON.stringify(target)})throw new Error('Copy included extra content or failed');return JSON.stringify({copiedOwnBodyOnly:true});`
      })
    )
    await m.tapOn({ css: row + ' [aria-label="Reply"]' })
    await m.assertVisible({ text: 'Replying to You' })
    writeFileSync(
      join(artifacts, 'desktop-replies-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ text: 'Cancel reply' })
    console.log('$ S8 personal message pin badge/header/list and verified jump')
    await m.tapOn({ css: row + ' [aria-label="More message actions"]' })
    await m.tapOn({ text: 'Pin' })
    await m.assertVisible({ text: 'Pinned messages: 1', timeout: 30000 })
    writeFileSync(
      join(artifacts, 'desktop-message-pins-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ text: 'Pinned messages: 1' })
    writeFileSync(
      join(artifacts, 'desktop-pinned-messages-after.png'),
      await m.screenshot()
    )
    await m.tapOn({
      css: '[role="button"][aria-label=' + JSON.stringify(target) + ']'
    })
    await m.assertVisible({ text: target })
    console.log(
      await m.evalBrowserScript({
        script: `const row=document.querySelector(${JSON.stringify(row)});if(!row)throw new Error('Pin jump original missing');return JSON.stringify({pinBadgeHeaderList:true,originalJump:true});`
      })
    )
    await m.tapOn({ css: row + ' [aria-label="More message actions"]' })
    await m.tapOn({ text: 'Unpin' })
    console.log('S5/S7/S8 wide core PASS')
  } finally {
    await m.detach()
  }
}

async function s9(daemon: Daemon, keyboard: boolean): Promise<void> {
  const conversation = keyboard
    ? required('CHAT_UI_TEST_CONVERSATION')
    : required('CHAT_UI_CONVERSATION')
  if (keyboard)
    assert.notEqual(
      conversation,
      required('CHAT_UI_CONVERSATION'),
      'Keyboard sends require a separate synthetic test conversation'
    )
  const m = await daemon.attach({
    device: 'chat-ui-compose-wide',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: '1440x1000',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  const listed = `const response=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});const chat=(await response.json()).find(chat=>chat.id===${JSON.stringify(conversation)});if(!chat)throw new Error('Synthetic conversation unavailable');`
  try {
    await signIn(m, 'Hc')
    await m.openLink({ link: WEB + '/chat/' + conversation })
    await m.assertVisible({ text: 'Message', timeout: 60000 })
    console.log(
      '$ S9 file drag across nested composer children, exact overlay, prepare without sending'
    )
    await m.evalBrowserScript({
      script: `${listed}window.chatUiDropSeq=chat.lastSeq;const pane=document.querySelector('[data-testid="chat-drop-target"]');const transfer=new DataTransfer();transfer.items.add(new File(['Practice notes'],'notes.txt',{type:'text/plain'}));window.chatUiDropTransfer=transfer;pane.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));const input=document.querySelector('[data-testid="chat-composer"]');input.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));pane.dispatchEvent(new DragEvent('dragleave',{bubbles:true,cancelable:true,dataTransfer:transfer,relatedTarget:input}));return true;`
    })
    await m.assertVisible({ text: 'Attaching file to chat' })
    writeFileSync(
      join(required('CHAT_UI_ARTIFACTS'), 'desktop-file-drop-after.png'),
      await m.screenshot()
    )
    console.log(
      await m.evalBrowserScript({
        script: `const pane=document.querySelector('[data-testid="chat-drop-target"]');const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.chatUiDropTransfer});pane.dispatchEvent(event);if(!event.defaultPrevented)throw new Error('File drop could navigate');return JSON.stringify({fileNavigationPrevented:true});`
      })
    )
    await m.assertVisible({ text: 'Remove notes.txt', timeout: 30000 })
    console.log(
      await m.evalBrowserScript({
        script: `${listed}if(chat.lastSeq!==window.chatUiDropSeq)throw new Error('File drop sent automatically');if(document.querySelector('[data-testid="chat-drop-overlay"]'))throw new Error('Drop overlay did not clear');return JSON.stringify({preparedChip:true,noAutomaticSend:true,overlayCleared:true});`
      })
    )
    await m.tapOn({ text: 'Remove notes.txt' })
    if (keyboard) {
      console.log(
        '$ S10 actual desktop Enter once and Shift+Enter newline in a separate synthetic conversation'
      )
      await m.tapOn({ css: '[data-testid="chat-composer"]' })
      await m.inputText({ text: 'Desktop keyboard probe' })
      await m.pressKey({ key: 'Shift+Enter' })
      await m.inputText({ text: 'Second line' })
      console.log(
        await m.evalBrowserScript({
          script: `const input=document.querySelector('[data-testid="chat-composer"]');if(input.value!=='Desktop keyboard probe\\nSecond line')throw new Error('Shift+Enter lost multiline text');return JSON.stringify({shiftEnterNewline:true});`
        })
      )
      await m.pressKey({ key: 'Enter' })
      await m.assertVisible({ text: 'Desktop keyboard probe', timeout: 30000 })
      console.log(
        await m.evalBrowserScript({
          script: `${listed}if(chat.lastSeq!==window.chatUiDropSeq+1)throw new Error('Enter did not send exactly once');if(document.querySelector('[data-testid="chat-composer"]').value!=='')throw new Error('Successful send did not clear draft');return JSON.stringify({enterSentExactlyOnce:true,draftCleared:true});`
        })
      )
    }
    console.log(keyboard ? 'S9/S10 wide core PASS' : 'S9 wide PASS')
  } finally {
    await m.detach()
  }
}

async function main(): Promise<void> {
  const scenario = process.argv[2]
  assert(
    scenario === 'S1' ||
      scenario === 'S2' ||
      scenario === 'S4' ||
      scenario === 'S5' ||
      scenario === 'S9' ||
      scenario === 'S10',
    'Name a supported follow-up scenario'
  )
  const root = required('MAESTRO_D_CLIENT_ROOT')
  const load = createRequire(join(resolve(root), 'package.json'))
  const { MaestroD } = load('maestro-d') as {
    MaestroD: { connect: (options: object) => Promise<Daemon> }
  }
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    bin: required('MAESTRO_D_BIN')
  })
  try {
    if (scenario === 'S1') await s1(daemon)
    else if (scenario === 'S2') await s2(daemon)
    else if (scenario === 'S4') await s4(daemon)
    else if (scenario === 'S5') await s5(daemon)
    else await s9(daemon, scenario === 'S10')
  } finally {
    await daemon.close()
  }
}
main().catch((error: unknown) => {
  let message = String((error as { message?: string }).message ?? error)
  for (const secret of hidden)
    message = message.split(secret).join('[withheld]')
  console.error(message)
  process.exitCode = 1
})
