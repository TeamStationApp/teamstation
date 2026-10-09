/** Functional follow-up scenarios run only on explicitly supplied fixture surfaces. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import puppeteer from 'puppeteer'

interface Device {
  evalBrowserScript: (options: { script: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  openTab: (options: { url: string; tabLabel: string }) => Promise<unknown>
  assertVisible: (options: {
    text?: string
    css?: string
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
  uploadFile: (options: { css: string; path: string }) => Promise<unknown>
  mockNetwork: (options: {
    url: string
    method: string
    response: object
  }) => Promise<unknown>
  clearNetworkMocks: () => Promise<unknown>
  setNetworkConditions: (options: {
    latency: number
    downloadSpeed: number
    uploadSpeed: number
  }) => Promise<unknown>
  scrollUntilVisible: (options: {
    element: { css: string }
    direction: string
    centerElement?: boolean
    timeout?: number
  }) => Promise<unknown>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  shutdown: (options: { wait: boolean }) => Promise<unknown>
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
  if (authorized.data === 'true' || authorized.data === true) {
    const ready = (await device.evalBrowserScript({
      script: `for(let n=0;n<30;n++){if(document.querySelector('[aria-label^="Account,"]'))return true;await new Promise(r=>setTimeout(r,50))}return false`
    })) as { data?: unknown }
    if (ready.data === 'true' || ready.data === true) return
  }
  await device.tapOn({ text: 'Sign in', optional: true, timeout: 3000 })
  await device.tapOn({
    text: 'Use a password instead',
    optional: true,
    timeout: 3000
  })
  const available = (await device.evalBrowserScript({
    script:
      'return document.querySelector("input[aria-label=\\"E-mail address\\"]")!=null'
  })) as { data?: unknown }
  if (available.data === 'false' || available.data === false) return
  await device.tapOn({ css: 'input[aria-label="E-mail address"]' })
  await device.inputText({ text: credentials.email })
  await device.tapOn({ css: 'input[aria-label="Password"]' })
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
      check(JSON.stringify(await request('GET',path+'/reads'))===JSON.stringify(window.chatUiReadCursors),'Preference-only writes changed public read cursors');
      await request('PUT',path+'/read',{seq:before.lastSeq,clearManualUnreadRevision:changed.manualUnreadRevision});
      const listed=(await request('GET','/chat/conversations')).find(chat=>chat.id===id);
      check(listed.preferences.pinned && listed.preferences.muted && listed.preferences.manualUnread, 'Personal state or stale-read protection missing');
      check(listed.lastPostAt === before.lastPostAt, 'Preferences changed recency');
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
    await m.evalBrowserScript({
      script: `const pane=document.querySelector('[data-testid="chat-list-pane"]');const scroll=[...pane.querySelectorAll('div')].find(x=>['auto','scroll'].includes(getComputedStyle(x).overflowY));if(scroll){scroll.scrollTop=scroll.scrollHeight;await new Promise(r=>setTimeout(r,400));if(!document.body.innerText.includes('Season All Staff'))throw new Error('All Staff scope pill missing after list scroll');scroll.scrollTop=0;await new Promise(r=>setTimeout(r,400))}return true`
    })
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
      if(!document.body.innerText.includes('Team Members'))throw new Error('Structured pills missing');
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
      const row=document.querySelector(${JSON.stringify('[data-testid="chat-conversation-' + required('CHAT_UI_CONVERSATION') + '"]')});
      if(!row?.querySelector('[aria-label="Marked unread"]'))throw new Error('Manual unread indicator is not visible on the selected conversation row');
      return JSON.stringify({manualUnreadOnOpenPane:true,mutingAndPinning:true});
    `
      })
    )
    if (!narrow)
      writeFileSync(
        join(artifacts, 'wide-conversation-unread-after.png'),
        await m.screenshot()
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
  const marker = `Desktop keyboard probe ${Date.now().toString(36)}`
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
      script: `${listed}window.chatUiDropSeq=chat.lastSeq;const initialMessages=await (await fetch(${JSON.stringify(API + '/chat/conversations/' + conversation + '/messages')},{credentials:'include'})).json();window.chatUiDropPosts=initialMessages.filter(row=>row.kind==='post').length;const pane=document.querySelector('[data-testid="chat-drop-target"]');const transfer=new DataTransfer();transfer.items.add(new File(['Practice notes'],'notes.txt',{type:'text/plain'}));window.chatUiDropTransfer=transfer;pane.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));const input=document.querySelector('[data-testid="chat-composer"]');input.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));pane.dispatchEvent(new DragEvent('dragleave',{bubbles:true,cancelable:true,dataTransfer:transfer,relatedTarget:input}));return true;`
    })
    await m.assertVisible({ text: 'Attaching file to chat' })
    if (!keyboard)
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
      await m.inputText({ text: marker })
      await m.pressKey({ key: 'Shift+Enter' })
      await m.inputText({ text: 'Second line' })
      console.log(
        await m.evalBrowserScript({
          script: `const input=document.querySelector('[data-testid="chat-composer"]');if(input.value!==${JSON.stringify(marker + '\nSecond line')})throw new Error('Shift+Enter lost multiline text');return JSON.stringify({shiftEnterNewline:true});`
        })
      )
      await m.pressKey({ key: 'Enter' })
      await m.evalBrowserScript({
        script: `const marker=${JSON.stringify(marker)};for(let attempt=0;attempt<200;attempt++){const rows=[...document.querySelectorAll('[data-testid^="chat-message-"]')].filter(row=>row.getAttribute('data-testid')!=='chat-message-pane' && row.innerText.includes(marker));if(rows.length>1)throw new Error('Duplicate unique message bubbles');if(rows.length===1){await new Promise(resolve=>setTimeout(resolve,500));return true}await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('Unique posted message bubble did not arrive');`
      })
      console.log(
        await m.evalBrowserScript({
          script: `${listed}const messages=await (await fetch(${JSON.stringify(API + '/chat/conversations/' + conversation + '/messages')},{credentials:'include'})).json();if(messages.filter(row=>row.kind==='post').length!==window.chatUiDropPosts+1)throw new Error('Enter did not send exactly one post: '+JSON.stringify({before:window.chatUiDropPosts,after:messages.filter(row=>row.kind==='post').length,hasBaseline:typeof window.chatUiDropPosts==='number'}));if(document.querySelector('[data-testid="chat-composer"]').value!=='')throw new Error('Successful send did not clear draft');const markerRows=[...document.querySelectorAll('[data-testid^="chat-message-"]')].filter(row=>row.getAttribute('data-testid')!=='chat-message-pane' && row.innerText.includes(${JSON.stringify(marker)}));if(markerRows.length!==1)throw new Error('Unique marker did not appear in exactly one post bubble');return JSON.stringify({enterSentExactlyOnce:true,uniqueMarkerBubbleCount:markerRows.length,draftCleared:true});`
        })
      )
    }
    console.log(keyboard ? 'S9/S10 wide core PASS' : 'S9 wide PASS')
  } finally {
    await m.detach()
  }
}

async function s6(daemon: Daemon): Promise<void> {
  const id = required('CHAT_UI_MESSAGE')
  const target = required('CHAT_UI_TARGET_TEXT')
  const row = `[data-testid="chat-message-${id}"]`
  const m = await daemon.attach({
    device: 'chat-ui-mobile-web',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: '390x844',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  const hold = async (): Promise<void> => {
    await m.evalBrowserScript({
      script: `const bubble=document.querySelector(${JSON.stringify(row + ' [tabindex="0"]')});if(!bubble)throw new Error('Target bubble missing');bubble.scrollIntoView({block:'center'});await new Promise(resolve=>setTimeout(resolve,350));return true`
    })
    await m.longPressOn({ css: row + ' [tabindex="0"]' })
  }
  try {
    await signIn(m, 'Hs')
    await m.openLink({
      link: WEB + '/chat/' + required('CHAT_UI_CONVERSATION')
    })
    await m.assertVisible({ text: target, timeout: 60000 })
    console.log(
      '$ S6 390px real browser with coarse-pointer media emulation; actual hold, blur, exact actions'
    )
    await m.evalBrowserScript({
      script: `const original=window.matchMedia.bind(window);window.matchMedia=query=>query.includes('pointer')&&query.includes('fine')?new Proxy(original(query),{get(target,key){if(key==='matches')return false;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}}):original(query);return true`
    })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Mark unread' })
    await m.pressKey({ key: 'Escape' })
    await m.evalBrowserScript({
      script: `for(let attempt=0;attempt<40;attempt++){if(!document.querySelector('[aria-label="Conversation actions"]:not([role="button"])'))return true;await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('Conversation actions did not dismiss')`
    })
    await hold()
    await m.assertVisible({ text: 'Copy' })
    await m.assertVisible({ text: 'Reply' })
    await m.assertVisible({ text: 'Pin' })
    for (const emoji of ['❤️', '👍', '👎', '😂', '😮', '😢'])
      await m.assertVisible({ text: 'React with ' + emoji })
    writeFileSync(
      join(
        required('CHAT_UI_ARTIFACTS'),
        'mobile-web-message-actions-after.png'
      ),
      await m.screenshot()
    )
    await m.tapOn({ text: 'Copy' })
    await m.grantPermissions({
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      origin: WEB
    })
    console.log(
      await m.evalBrowserScript({
        script: `if(await navigator.clipboard.readText()!==${JSON.stringify(target)})throw new Error('Touch Copy changed own body');return JSON.stringify({coarsePointerCopyExact:true});`
      })
    )
    await hold()
    await m.tapOn({ text: 'Reply' })
    await m.assertVisible({ text: 'Replying to Hank C' })
    await m.tapOn({ text: 'Cancel reply' })
    await hold()
    await m.tapOn({ text: 'Pin' })
    await m.assertVisible({ text: 'Pinned messages: 1', timeout: 30000 })
    await hold()
    await m.tapOn({ text: 'Unpin' })
    await m.tapOn({ text: 'Back' })
    await m.longPressOn({ css: '[role="button"][aria-label="Hawks Members"]' })
    await m.assertVisible({ text: 'Mark unread' })
    writeFileSync(
      join(required('CHAT_UI_ARTIFACTS'), 'narrow-conversation-menu-after.png'),
      await m.screenshot()
    )
    await m.pressKey({ key: 'Escape' })
    console.log(
      'S3/S6/S7/S8 narrow core PASS; media query emulated, app/clipboard/pin paths real'
    )
  } finally {
    await m.detach()
  }
}

async function s4Full(daemon: Daemon): Promise<void> {
  const conversation = required('CHAT_UI_TEST_CONVERSATION')
  assert.notEqual(conversation, required('CHAT_UI_CONVERSATION'))
  const m = await daemon.attach({
    device: 'chat-ui-full-resize',
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
  const marker = 'Reading position probe ' + Date.now().toString(36)
  const body =
    marker +
    '\n' +
    Array.from({ length: 65 }, (_, i) => `Practice notes line ${i + 1}`).join(
      '\n'
    )
  const draft = 'An unsent practice note\nBring a glove'
  const typeLines = async (value: string): Promise<void> => {
    for (const [i, line] of value.split('\n').entries()) {
      if (i > 0) await m.pressKey({ key: 'Shift+Enter' })
      await m.inputText({ text: line })
    }
  }
  try {
    await signIn(m, 'Hc')
    await m.openLink({ link: WEB + '/chat/' + conversation })
    await m.assertVisible({ text: 'Message', timeout: 60000 })
    await m.evalBrowserScript({
      script: `const r=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});const chat=(await r.json()).find(x=>x.id===${JSON.stringify(conversation)});window.chatUiResizeTitle=chat?.kind==='dm'?chat.people.filter(x=>!x.left).map(x=>x.shortName).join(', '):chat?.title;if(!window.chatUiResizeTitle)throw new Error('Synthetic DM title unavailable');return true`
    })
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.pressKey({ key: 'Cmd+A' })
    await m.pressKey({ key: 'Backspace' })
    await typeLines(body)
    await m.tapOn({ text: 'Send' })
    await m.evalBrowserScript({
      script: `for(let n=0;n<200;n++){const row=[...document.querySelectorAll('[data-testid^="chat-message-"]')].find(x=>x.getAttribute('data-testid')!=='chat-message-pane'&&x.innerText.includes(${JSON.stringify(marker)}));if(row){window.chatUiResizeRow=row;return true}await new Promise(r=>setTimeout(r,50))}throw new Error('Reading probe was not posted')`
    })
    await m.evalBrowserScript({
      script: `const row=window.chatUiResizeRow;row.scrollIntoView({block:'center'});row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
    })
    await m.tapOn({
      css: '[data-testid^="chat-message-"] [aria-label="Reply"]'
    })
    await m.assertVisible({ text: 'Replying to You' })
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await typeLines(draft)
    await m.evalBrowserScript({
      script: `const target=document.querySelector('[data-testid="chat-drop-target"]');const transfer=new DataTransfer();transfer.items.add(new File(['Practice notes'],'notes.txt',{type:'text/plain'}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return true`
    })
    await m.assertVisible({ text: 'Remove notes.txt' })
    await m.evalBrowserScript({
      script: `let scroll=window.chatUiResizeRow.parentElement;while(scroll&&!['auto','scroll'].includes(getComputedStyle(scroll).overflowY))scroll=scroll.parentElement;if(!scroll||scroll.scrollHeight<=scroll.clientHeight+80)throw new Error('Fixture does not provide a reading position');scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-80}));scroll.scrollTop=40;scroll.dispatchEvent(new Event('scroll',{bubbles:true}));await new Promise(r=>setTimeout(r,250));window.chatUiResizeDocument=Date.now();window.chatUiResizeField=document.querySelector('[data-testid="chat-composer"]');window.chatUiResizeScroller=scroll;window.chatUiResizeOffset=scroll.scrollTop;if(Math.abs(scroll.scrollTop-40)>2)throw new Error('Reading position was not set');return JSON.stringify({reply:true,file:true,readingOffset:scroll.scrollTop})`
    })
    console.log(
      '$ S4 preserve multiline text, reply, prepared file and positive reading position across live960px resize'
    )
    for (const orientation of ['LANDSCAPE', 'PORTRAIT']) {
      await m.setOrientation({ orientation })
      console.log(
        await m.evalBrowserScript({
          script: `await new Promise(r=>setTimeout(r,500));const input=document.querySelector('[data-testid="chat-composer"]');if(!window.chatUiResizeDocument||input!==window.chatUiResizeField||input.value!==${JSON.stringify(draft)})throw new Error('Draft or document lost');if(!document.querySelector('[aria-label="Cancel reply"]')||!document.querySelector('[aria-label="Remove notes.txt"]'))throw new Error('Reply/file context lost');if(Math.abs(window.chatUiResizeScroller.scrollTop-window.chatUiResizeOffset)>2)throw new Error('Reading position lost');return JSON.stringify({width:innerWidth,draftReplyFilePositionPreserved:true})`
        })
      )
    }
    await m.tapOn({ text: 'Back' })
    await m.evalBrowserScript({
      script: `const list=document.querySelector('[data-testid="chat-list-pane"]');const buttons=[...list.querySelectorAll('[role="button"][aria-label]')];const row=buttons.find(x=>x.getAttribute('aria-label')===window.chatUiResizeTitle);if(!row)throw new Error('Synthetic DM row unavailable');row.click();return true`
    })
    await m.assertVisible({ text: 'Remove notes.txt' })
    console.log(
      await m.evalBrowserScript({
        script: `if(document.querySelector('[data-testid="chat-composer"]').value!==${JSON.stringify(draft)}||!document.querySelector('[aria-label="Cancel reply"]'))throw new Error('Back/reopen lost full draft');if(Math.abs(window.chatUiResizeScroller.scrollTop-window.chatUiResizeOffset)>2)throw new Error('Back/reopen lost reading position');return JSON.stringify({backReopenFullDraft:true})`
      })
    )
    writeFileSync(
      join(required('CHAT_UI_ARTIFACTS'), 'web-full-draft-resize-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ text: 'Remove notes.txt' })
    await m.tapOn({ text: 'Cancel reply' })
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.pressKey({ key: 'Cmd+A' })
    await m.pressKey({ key: 'Backspace' })
    console.log('S4 complete draft/position web PASS')
  } finally {
    await m.detach()
  }
}

async function reviewNavigation(daemon: Daemon): Promise<void> {
  const narrow = process.env.CHAT_UI_VIEWPORT === 'narrow'
  const conversation = required('CHAT_UI_CONVERSATION')
  const message = required('CHAT_UI_MESSAGE')
  const row = `[data-testid="chat-message-${message}"]`
  const path = API + '/chat/conversations/' + conversation
  const artifacts = required('CHAT_UI_ARTIFACTS')
  const m = await daemon.attach({
    device: narrow ? 'chat-ui-review-narrow' : 'chat-ui-review-wide',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: narrow ? '390x844' : '1440x1000',
      userDataDir:
        process.env.CHAT_UI_REVIEW_PROFILE ?? required('CHAT_UI_PROFILE_DIR')
    }
  })
  const read = async <T>(script: string): Promise<T> => {
    const result = (await m.evalBrowserScript({ script })) as { data: unknown }
    return (
      typeof result.data === 'string' ? JSON.parse(result.data) : result.data
    ) as T
  }
  interface ListReadingGeometry {
    offset: number
    content: number
    height: number
    width: number
    sampledAt: number
    rows: Array<{
      id: string
      top: number
      height: number
      absoluteTop: number
    }>
  }
  const geometryScript = `const pane=document.querySelector('[data-testid="chat-list-pane"]');const scroll=pane&&[...pane.querySelectorAll('div')].find(x=>['auto','scroll'].includes(getComputedStyle(x).overflowY));if(!scroll||scroll.clientHeight<=0)return null;const box=scroll.getBoundingClientRect();const rows=[...scroll.querySelectorAll('[data-testid^="chat-conversation-cnv_"]')].map(row=>{const r=row.getBoundingClientRect();return{id:row.getAttribute('data-testid').slice('chat-conversation-'.length),top:r.top-box.top,height:r.height,absoluteTop:r.top-box.top+scroll.scrollTop,bottom:r.bottom-box.top}}).filter(row=>row.top>=2&&row.bottom<=box.height-2);return{offset:scroll.scrollTop,content:scroll.scrollHeight,height:scroll.clientHeight,width:scroll.clientWidth,sampledAt:Date.now(),rows}`
  const sampleReading = async (): Promise<ListReadingGeometry> =>
    await read(`return JSON.stringify((()=>{${geometryScript}})())`)
  let previousMuted: boolean | undefined
  const preference = async (muted: boolean): Promise<void> => {
    await read(
      `const r=await fetch(${JSON.stringify(path + '/preferences')},{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({muted:${muted}})});if(!r.ok)throw new Error('Normal personal preference unavailable');return true`
    )
  }
  try {
    await signIn(m, process.env.CHAT_UI_REVIEW_ACTOR ?? (narrow ? 'Hs' : 'Hc'))
    await m.openLink({ link: WEB + '/chat/' + conversation })
    await m.assertVisible({ css: row, timeout: 60000 })
    previousMuted = await read<boolean>(
      `const r=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});const chat=(await r.json()).find(x=>x.id===${JSON.stringify(conversation)});if(!chat)throw new Error('Fixture room missing');return JSON.stringify(chat.preferences.muted)`
    )
    if (narrow) await m.tapOn({ text: 'Back' })
    let offset = await read<number>(
      `const pane=document.querySelector('[data-testid="chat-list-pane"]');const scroll=[...pane.querySelectorAll('div')].find(x=>['auto','scroll'].includes(getComputedStyle(x).overflowY));if(!scroll||scroll.scrollHeight<=scroll.clientHeight+30)throw new Error('Populated list lacks reading geometry');window.chatUiReviewList=scroll;scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:120}));scroll.scrollTop=Math.min(120,scroll.scrollHeight-scroll.clientHeight);scroll.dispatchEvent(new Event('scroll',{bubbles:true}));await new Promise(r=>setTimeout(r,200));return JSON.stringify(scroll.scrollTop)`
    )
    let beforeReading: ListReadingGeometry
    if (narrow) {
      offset = await read<number>(
        `const row=document.querySelector('[data-testid="chat-conversation-${conversation}"]');const scroll=window.chatUiReviewList;row.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,200));const r=row.getBoundingClientRect(),s=scroll.getBoundingClientRect();if(r.top<s.top||r.bottom>s.bottom)throw new Error('Selected row must be visible before navigation');return JSON.stringify(scroll.scrollTop)`
      )
      beforeReading = await sampleReading()
      await m.tapOn({
        css: `[data-testid="chat-conversation-${conversation}"]`
      })
    } else beforeReading = await sampleReading()
    beforeReading.rows = beforeReading.rows.slice(0, 2)
    assert(
      beforeReading.rows.length === 2,
      'Two full identified reading rows are required'
    )
    console.log({ listBeforeMembers: offset, narrow, beforeReading })
    await m.tapOn({ text: 'Members' })
    assert(
      await read<boolean>(
        'return JSON.stringify(location.pathname.endsWith("/members"))'
      ),
      'Members must navigate outside the workspace'
    )
    await m.setNetworkConditions({
      latency: 1200,
      downloadSpeed: -1,
      uploadSpeed: -1
    })
    await m.tapOn({ text: 'Back' })
    if (narrow) await m.tapOn({ text: 'Back' })
    const returned = await read<{
      geometry: ListReadingGeometry | null
      matched: boolean
      unchangedGeometry: boolean
    }>(
      `const before=${JSON.stringify(beforeReading)};const sample=()=>{${geometryScript}};const matches=value=>value&&before.rows.every(row=>{const now=value.rows.find(candidate=>candidate.id===row.id);return now&&Math.abs(now.top-row.top)<=2&&Math.abs(now.height-row.height)<=2});let geometry=null;for(let n=0;n<300;n++){geometry=sample();if(matches(geometry)){await new Promise(r=>setTimeout(r,1400));geometry=sample();break}await new Promise(r=>setTimeout(r,100))}const unchangedGeometry=geometry&&geometry.height===before.height&&geometry.width===before.width&&geometry.content===before.content&&before.rows.every(row=>{const now=geometry.rows.find(candidate=>candidate.id===row.id);return now&&Math.abs(now.absoluteTop-row.absoluteTop)<=2&&Math.abs(now.height-row.height)<=2});return JSON.stringify({geometry,matched:!!matches(geometry),unchangedGeometry:!!unchangedGeometry})`
    )
    // Keep the retained settled identities and geometry even when the assertion
    // fails; duplicate titles and a numeric offset cannot identify the reader.
    writeFileSync(
      join(
        artifacts,
        `${narrow ? 'narrow' : 'wide'}-members-reading-return.json`
      ),
      JSON.stringify({ before: beforeReading, after: returned }, null, 2)
    )
    writeFileSync(
      join(
        artifacts,
        `${narrow ? 'narrow' : 'wide'}-members-reading-return.png`
      ),
      await m.screenshot()
    )
    assert(
      returned.matched,
      'Members return must preserve identified rows and viewport geometry after async refresh'
    )
    if (returned.unchangedGeometry)
      assert(
        Math.abs(returned.geometry!.offset - beforeReading.offset) <= 2,
        'Unchanged measured geometry also preserves its numeric offset'
      )
    console.log({
      membersReturnIdentifiedRows: true,
      unchangedGeometry: returned.unchangedGeometry,
      before: beforeReading,
      after: returned.geometry
    })
    await m.setNetworkConditions({
      latency: 0,
      downloadSpeed: -1,
      uploadSpeed: -1
    })
    if (narrow)
      await m.tapOn({
        css: `[data-testid="chat-conversation-${conversation}"]`
      })
    await m.evalBrowserScript({
      script: `const row=document.querySelector(${JSON.stringify(row)});row.scrollIntoView({block:'center'});row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
    })
    await m.tapOn({ css: row + ' [aria-label="More message actions"]' })
    const pinLabel = await read<string>(
      'const label=[...document.querySelectorAll("[role=\\"button\\"]")].some(x=>x.textContent.trim()==="Unpin")?"Unpin":"Pin";return JSON.stringify(label)'
    )
    for (let n = 0; n < 8; n++) {
      if (
        await read<boolean>(
          `return JSON.stringify(document.activeElement?.textContent.trim()===${JSON.stringify(pinLabel)})`
        )
      )
        break
      await m.pressKey({ key: 'Tab' })
    }
    assert(
      await read<boolean>(
        `return JSON.stringify(document.activeElement?.textContent.trim()===${JSON.stringify(pinLabel)})`
      ),
      'Keyboard focus must reach the personal pin action'
    )
    await preference(!previousMuted)
    console.log(
      await read(
        `for(let n=0;n<80;n++){const r=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});const chat=(await r.json()).find(x=>x.id===${JSON.stringify(conversation)});if(chat.preferences.muted===${!previousMuted}){await new Promise(r=>setTimeout(r,400));if(document.activeElement?.textContent.trim()!==${JSON.stringify(pinLabel)})throw new Error('Metadata update moved popup keyboard focus');return JSON.stringify({menuFocusSurvivesMetadataUpdate:true})}await new Promise(r=>setTimeout(r,100))}throw new Error('Preference update unavailable')`
      )
    )
    await m.mockNetwork({
      url: path + '/pins/' + message,
      method: pinLabel === 'Pin' ? 'PUT' : 'DELETE',
      response: {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Synthetic personal pin failure' })
      }
    })
    await m.pressKey({ key: 'Enter' })
    await m.assertVisible({
      text: 'Could not update this message pin. Try again.',
      timeout: 30000
    })
    console.log(
      await read(
        `const error=[...document.querySelectorAll('*')].find(x=>x.childElementCount===0&&x.textContent==='Could not update this message pin. Try again.');if(!error||error.closest('[aria-hidden="true"]'))throw new Error('Pin feedback hidden from accessibility');if(document.querySelector('[aria-label^="Message actions for"]'))throw new Error('Failed pin left obscuring menu');return JSON.stringify({pinFailureVisibleAndReachable:true})`
      )
    )
    writeFileSync(
      join(
        required('CHAT_UI_ARTIFACTS'),
        narrow
          ? 'narrow-review-pin-failure-after.png'
          : 'wide-review-pin-failure-after.png'
      ),
      await m.screenshot()
    )
    console.log('Review navigation, focus and pin-failure actual browser PASS')
  } finally {
    await m.clearNetworkMocks()
    await m.setNetworkConditions({
      latency: 0,
      downloadSpeed: -1,
      uploadSpeed: -1
    })
    if (previousMuted != null) await preference(previousMuted)
    await m.detach()
  }
}

/** Real peer arrivals and keyboard confirmation on independent owned rooms. */
async function review2Browser(daemon: Daemon): Promise<void> {
  const narrow = process.env.CHAT_UI_VIEWPORT === 'narrow'
  const selected = required('CHAT_UI_CONVERSATION')
  const incoming = required('CHAT_UI_TEST_CONVERSATION')
  assert.notEqual(selected, incoming)
  const browser = await puppeteer.executablePath()
  const attach = async (device: string, profile: string): Promise<Device> =>
    await daemon.attach({
      device,
      platform: 'web',
      driver: 'cdp',
      url: WEB,
      artifacts: 'on-failure',
      extra: {
        browser,
        userDataDir: profile,
        windowSize: narrow ? '390x844' : '1440x1000'
      }
    })
  const primary = await attach(
    'chat-review2-observer',
    required('CHAT_UI_PROFILE_DIR')
  )
  const peer = await attach(
    'chat-review2-peer',
    required('CHAT_UI_PEER_PROFILE_DIR')
  )
  const read = async <T>(m: Device, script: string): Promise<T> => {
    const response = (await m.evalBrowserScript({ script })) as {
      data: unknown
    }
    return (
      typeof response.data === 'string'
        ? JSON.parse(response.data)
        : response.data
    ) as T
  }
  const api = `async function request(method,path,body){const r=await fetch(${JSON.stringify(API)}+path,{method,credentials:'include',headers:body==null?{}:{'Content-Type':'application/json'},...(body==null?{}:{body:JSON.stringify(body)})});if(!r.ok)throw Error(method+' '+path+' '+r.status);return r.json()}`
  const chat = async (
    m: Device
  ): Promise<{ lastSeq: number; preferences: { muted: boolean } }> =>
    await read(
      m,
      `${api};return JSON.stringify((await request('GET','/chat/conversations')).find(c=>c.id===${JSON.stringify(incoming)}))`
    )
  const mute = async (muted: boolean): Promise<void> => {
    await read(
      primary,
      `${api};await request('PATCH',${JSON.stringify('/chat/conversations/' + incoming + '/preferences')},{muted:${muted}});return true`
    )
    await new Promise(resolve => setTimeout(resolve, 600))
  }
  const composer = '[data-testid="chat-composer"]'
  const send = async (m: Device, text: string): Promise<string> => {
    const before = await chat(m)
    assert(
      await read<boolean>(
        m,
        `return JSON.stringify(document.querySelector(${JSON.stringify(composer)})?.value==='')`
      ),
      'Owned composer must start empty'
    )
    await m.tapOn({ css: composer })
    await m.inputText({ text })
    await m.tapOn({ text: 'Send' })
    return await read(
      m,
      `${api};for(let n=0;n<150;n++){const c=(await request('GET','/chat/conversations')).find(c=>c.id===${JSON.stringify(incoming)});const input=document.querySelector(${JSON.stringify(composer)});if(c.lastSeq>${before.lastSeq}&&input?.value===''){const posts=(await request('GET',${JSON.stringify('/chat/conversations/' + incoming + '/messages?after=' + before.lastSeq)})).filter(p=>p.kind==='post');if(posts.length!==1)throw Error('Send must acknowledge exactly one new post');return JSON.stringify(posts[0].id)}await new Promise(r=>setTimeout(r,100))}throw Error('Normal encrypted send did not settle')`
    )
  }
  const observe = async (): Promise<void> => {
    await read(
      primary,
      `window.review2MO?.disconnect();const live=[...document.querySelectorAll('[aria-live="polite"]')];if(live.length!==1)throw Error('Exactly one arrival host required');window.review2Live=live[0];window.review2Updates=[];window.review2MO=new MutationObserver(ms=>{if(ms.some(m=>m.type==='childList'))window.review2Updates.push(window.review2Live.textContent)});window.review2MO.observe(window.review2Live,{childList:true,subtree:true});return true`
    )
  }
  const hostGeometry = async (): Promise<unknown> =>
    await read(
      primary,
      `const live=window.review2Live,list=document.querySelector('[data-testid="chat-list-pane"]'),messages=document.querySelector('[data-testid="chat-message-pane"]'),input=document.querySelector(${JSON.stringify(composer)});const hidden=[];for(let n=live;n;n=n.parentElement)if(getComputedStyle(n).display==='none'||n.getAttribute('aria-hidden')==='true')hidden.push(n.tagName);if(hidden.length||!live.checkVisibility()||!input?.checkVisibility())throw Error('Live host and selected composer must remain exposed');if(${narrow}&&getComputedStyle(list).display!=='none')throw Error('Narrow selected pane must hide its list');return JSON.stringify({width:innerWidth,height:innerHeight,soleExposedHost:true,selectedComposerVisible:true,listDisplay:getComputedStyle(list).display,messagePaneVisible:messages?.checkVisibility(),hostHiddenAncestors:hidden})`
    )
  const quiet = async (name: string): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 2200))
    assert.equal(
      await read(
        primary,
        'return JSON.stringify(window.review2Updates.length)'
      ),
      0,
      name
    )
  }
  const capture = async (name: string): Promise<void> => {
    writeFileSync(
      join(
        required('CHAT_UI_ARTIFACTS'),
        `${narrow ? 'narrow' : 'wide'}-${name}.png`
      ),
      await primary.screenshot()
    )
  }
  let originalMuted: boolean | undefined
  try {
    await signIn(primary, 'Hc')
    await signIn(peer, 'Hs')
    // Fixture membership is supplied privately; no shared-reader room is altered.
    console.log(
      await read(
        primary,
        `${api};const me=await request('GET','/auth/me');const members={};for(const id of ${JSON.stringify([selected, incoming])})members[id]=(await request('GET','/chat/conversations/'+id+'/members')).map(m=>Number(m.userId));const forbidden=Number(${JSON.stringify(process.env.CHAT_UI_EXCLUDED_USER ?? '0')});if(Object.values(members).some(ids=>ids.includes(forbidden)))throw Error('Independent browser room includes reserved native actor');if(members[${JSON.stringify(incoming)}].length!==2)throw Error('Peer fixture must be an ordinary two-adult DM');return JSON.stringify({actor:me.id,members})`
      )
    )
    originalMuted = (await chat(primary)).preferences.muted
    if (process.env.CHAT_UI_REVIEW2_FOCUS_ONLY !== '1') {
      await primary.openLink({ link: `${WEB}/chat/${selected}` })
      await primary.assertVisible({ css: composer, timeout: 60000 })
      await peer.openLink({ link: `${WEB}/chat/${incoming}` })
      await peer.assertVisible({ css: composer, timeout: 60000 })
      await mute(false)
      await observe()
      console.log(await hostGeometry())
      const repeated = 'Repeated arrival ' + Date.now()
      const peerIds: string[] = []
      for (let iteration = 0; iteration < 2; iteration++) {
        await read(
          primary,
          'window.review2PreviousChild=window.review2Live.firstChild;return true'
        )
        peerIds.push(await send(peer, repeated))
        console.log(
          await read(
            primary,
            `for(let n=0;n<150;n++){if(window.review2Updates.length===${iteration + 1}){await new Promise(r=>setTimeout(r,300));if(window.review2Updates.length!==${iteration + 1}||window.review2Live.firstChild===window.review2PreviousChild)throw Error('Peer arrival must replace exactly one alert child');return JSON.stringify({repeat:${iteration + 1},updates:window.review2Updates.length,text:window.review2Live.textContent})}await new Promise(r=>setTimeout(r,100))}throw Error('Peer alert missing')`
          )
        )
      }
      console.log(await hostGeometry())
      await capture('arrival-host-selected-after')
      await mute(true)
      await observe()
      const mutedId = await send(peer, 'Muted delivery ' + Date.now())
      await quiet('Muted peer post must not announce')
      await mute(false)
      await observe()
      // Hold only this normal own POST while selecting a different room.
      await primary.openLink({ link: `${WEB}/chat/${incoming}` })
      await primary.assertVisible({ css: composer, timeout: 60000 })
      const beforeSelf = await chat(primary)
      const gateId = 'review2-self-' + Date.now()
      await primary.tapOn({ css: composer })
      await primary.inputText({ text: 'Disposable self arrival ' + Date.now() })
      execFileSync(
        process.execPath,
        [required('CHAT_UI_PENDING_CONTROL'), 'Hc', 'success', gateId, '15000'],
        { stdio: 'pipe' }
      )
      await primary.tapOn({ text: 'Send' })
      const consumptionDeadline = Date.now() + 8000
      let consumed = false
      while (Date.now() < consumptionDeadline) {
        const hits = readFileSync(required('CHAT_UI_PENDING_AUDIT'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as { gateId: string; event?: string })
        if (hits.some(hit => hit.gateId === gateId && hit.event == null)) {
          consumed = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert(consumed, 'Own normal encrypted send must consume its exact gate')
      if (narrow) await primary.tapOn({ text: 'Back' })
      await primary.evalBrowserScript({
        script: `const row=document.querySelector('[data-testid="chat-conversation-${selected}"]');row.scrollIntoView({block:'center'});return true`
      })
      await primary.tapOn({
        css: `[data-testid="chat-conversation-${selected}"]`
      })
      await primary.assertVisible({ css: composer, timeout: 60000 })
      const ownObserverReadyAt = Date.now()
      await observe()
      const ownId = await read<string>(
        primary,
        `${api};for(let n=0;n<300;n++){const posts=(await request('GET',${JSON.stringify('/chat/conversations/' + incoming + '/messages?after=' + beforeSelf.lastSeq)})).filter(p=>p.kind==='post');if(posts.length===1)return JSON.stringify(posts[0].id);if(posts.length>1)throw Error('Own arrival produced multiple posts');await new Promise(r=>setTimeout(r,100))}throw Error('Own encrypted send missing')`
      )
      const ownHits = readFileSync(required('CHAT_UI_PENDING_AUDIT'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(
          line =>
            JSON.parse(line) as { gateId: string; event?: string; at: string }
        )
        .filter(hit => hit.gateId === gateId)
      assert.equal(ownHits.filter(hit => hit.event == null).length, 1)
      const release = ownHits.find(hit => hit.event === 'delay-released')
      assert(
        release != null && ownObserverReadyAt < Date.parse(release.at),
        'Different selected room must be visible before the own post is forwarded'
      )
      await quiet('Own offscreen post must not announce')
      execFileSync(
        process.execPath,
        [required('CHAT_UI_PENDING_CONTROL'), 'clear'],
        { stdio: 'pipe' }
      )
      console.log({
        ownId,
        ownOffscreenQuiet: true,
        ownObserverReadyAt,
        ownReleaseAt: release.at,
        gateId
      })
      await primary.openLink({ link: `${WEB}/chat/${incoming}` })
      await primary.assertVisible({ css: composer, timeout: 60000 })
      await observe()
      const selectedId = await send(
        peer,
        'Selected conversation arrival ' + Date.now()
      )
      await primary.evalBrowserScript({
        script: `for(let n=0;n<100;n++){const row=document.querySelector(${JSON.stringify(`[data-testid="chat-message-${selectedId}"]`)});if(row){row.scrollIntoView({block:'center'});return true}await new Promise(r=>setTimeout(r,100))}throw Error('Selected received row absent')`
      })
      await primary.assertVisible({
        css: `[data-testid="chat-message-${selectedId}"]`,
        timeout: 30000
      })
      await quiet('Visible selected conversation must not announce')
      console.log({
        repeatedPeerIds: peerIds,
        mutedId,
        ownId,
        selectedId,
        mutedQuiet: true,
        ownQuiet: true,
        selectedQuiet: true,
        selfObserverVisibleBeforeForward: true
      })
    }
    await primary.openLink({ link: `${WEB}/chat/${incoming}` })
    await primary.assertVisible({ css: composer, timeout: 60000 })
    const beforeDelete = (await chat(primary)).lastSeq
    const previewBody = 'Disposable preview ' + Date.now()
    const deleteId = await send(primary, previewBody)
    const row = `[data-testid="chat-message-${deleteId}"]`
    const trigger = row + ' [aria-label="More message actions"]'
    const focusIs = async (label: string): Promise<boolean> =>
      await read(
        primary,
        `return JSON.stringify(document.activeElement?.getAttribute('role')==='button'&&document.activeElement?.textContent.trim()===${JSON.stringify(label)})`
      )
    const openConfirmation = async (): Promise<void> => {
      await primary.evalBrowserScript({
        script: `const row=document.querySelector(${JSON.stringify(row)});row.scrollIntoView({block:'center'});row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
      })
      await primary.tapOn({ css: `[data-testid="chat-bubble-${deleteId}"]` })
      await primary.evalBrowserScript({
        script: `document.removeEventListener('focusin',window.review2FocusListener);window.review2FocusTrail=[];window.review2FocusListener=e=>window.review2FocusTrail.push({label:e.target.getAttribute('aria-label'),row:e.target.closest('[data-testid^="chat-message-"]')?.getAttribute('data-testid'),tag:e.target.tagName});document.addEventListener('focusin',window.review2FocusListener);return true`
      })
      for (let n = 0; n < 40; n++) {
        if (
          await read<boolean>(
            primary,
            `return JSON.stringify(document.activeElement===document.querySelector(${JSON.stringify(trigger)}))`
          )
        )
          break
        await primary.pressKey({ key: 'Shift+Tab' })
      }
      console.log(
        await read(
          primary,
          `const t=document.querySelector(${JSON.stringify(trigger)}),a=document.activeElement;return JSON.stringify({trail:window.review2FocusTrail,keyboardEntryFocus:{tag:a?.tagName,label:a?.getAttribute('aria-label'),text:a?.textContent?.slice(0,80)},triggerPresent:t!=null,triggerTabIndex:t?.tabIndex,triggerVisible:t?.checkVisibility(),isTrigger:a===t,allFocusable:[...document.querySelectorAll('[tabindex="0"],button,textarea')].slice(-12).map(x=>({tag:x.tagName,label:x.getAttribute('aria-label'),text:x.textContent?.slice(0,30)}))})`
        )
      )
      assert(
        await read<boolean>(
          primary,
          `return JSON.stringify(document.activeElement===document.querySelector(${JSON.stringify(trigger)}))`
        ),
        'Physical keyboard must focus the original More trigger before opening'
      )
      await primary.pressKey({ key: 'Enter' })
      for (let n = 0; n < 16 && !(await focusIs('Delete')); n++)
        await primary.pressKey({ key: 'Tab' })
      assert(
        await focusIs('Delete'),
        'Keyboard must reach original Delete action'
      )
      await primary.pressKey({ key: 'Enter' })
      await primary.assertVisible({
        text: 'This message will be removed for everyone.'
      })
      assert(await focusIs('Cancel'), 'Mounted confirmation must focus Cancel')
    }
    const restored = async (): Promise<void> => {
      assert(
        await read<boolean>(
          primary,
          `await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return JSON.stringify(document.activeElement===document.querySelector(${JSON.stringify(trigger)}))`
        ),
        'Closing confirmation must restore the original message trigger'
      )
      assert(
        await read<boolean>(
          primary,
          'return JSON.stringify(!document.querySelector("[aria-label^=\\"Message actions for\\"]"))'
        ),
        'Confirmation must close'
      )
    }
    await openConfirmation()
    await primary.pressKey({ key: 'Tab' })
    assert(await focusIs('Delete'), 'Tab must wrap from Cancel to Delete')
    await primary.pressKey({ key: 'Shift+Tab' })
    assert(await focusIs('Cancel'), 'Shift Tab must return to Cancel')
    await mute(!originalMuted)
    assert(
      await focusIs('Cancel'),
      'Metadata update must preserve confirmation focus'
    )
    await capture('delete-confirmation-focused-after')
    await primary.pressKey({ key: 'Enter' })
    await restored()
    await openConfirmation()
    await primary.pressKey({ key: 'Escape' })
    await restored()
    await openConfirmation()
    await primary.tapOn({ text: 'Cancel' })
    await restored()
    console.log({
      physicalConfirmationCancelTabEnterEscape: true,
      focusSurvivesMetadata: true,
      originalTriggerRestored: true
    })
    // Only the new owned post is deleted; earlier retained originals remain intact.
    await openConfirmation()
    await primary.pressKey({ key: 'Tab' })
    await primary.pressKey({ key: 'Enter' })
    console.log(
      await read(
        primary,
        `${api};for(let n=0;n<100;n++){const posts=await request('GET',${JSON.stringify('/chat/conversations/' + incoming + '/messages?after=' + beforeDelete)});const post=posts.find(p=>p.id===${JSON.stringify(deleteId)});if(post?.clearedAt){return JSON.stringify({newOwnedDelete:true,deletedId:post.id})}await new Promise(r=>setTimeout(r,100))}throw Error('New owned deletion unavailable')`
      )
    )
    if (narrow) await primary.tapOn({ text: 'Back' })
    const listRow = `[data-testid="chat-conversation-${incoming}"]`
    await primary.evalBrowserScript({
      script: `const row=document.querySelector(${JSON.stringify(listRow)});if(!row)throw Error('Preview row missing');row.scrollIntoView({block:'center'});return true`
    })
    await primary.assertVisible({ css: listRow })
    console.log(
      await read(
        primary,
        `for(let n=0;n<100;n++){const row=document.querySelector(${JSON.stringify(listRow)});if(row?.textContent.includes('Message deleted')){if(row.textContent.includes(${JSON.stringify(previewBody)}))throw Error('Deleted latest preview retained plaintext');return JSON.stringify({latestDeletedPreviewPurged:true,deleteId:${JSON.stringify(deleteId)}})}await new Promise(r=>setTimeout(r,100))}throw Error('Latest deleted preview did not refresh')`
      )
    )
    await capture('deleted-latest-preview-after')
    console.log(
      'Review2 exposed-host guards and physical Delete confirmation browser PASS'
    )
  } finally {
    await read(
      primary,
      "window.review2MO?.disconnect();document.removeEventListener('focusin',window.review2FocusListener);return true"
    ).catch(() => {})
    if (originalMuted != null) await mute(originalMuted)
    execFileSync(
      process.execPath,
      [required('CHAT_UI_PENDING_CONTROL'), 'clear'],
      { stdio: 'pipe' }
    )
    await primary.detach()
    await peer.detach()
  }
}

/** A normal peer sends only after a fresh native receiver stage is ready. */
async function arrivalPeer(daemon: Daemon): Promise<void> {
  const request = JSON.parse(
    readFileSync(required('CHAT_UI_ARRIVAL_REQUEST'), 'utf8')
  ) as {
    actorUserId: number
    selectedConversationId: string
    proposedOffscreenConversationId: string
    probeBody: string
  }
  assert.notEqual(
    request.selectedConversationId,
    request.proposedOffscreenConversationId
  )
  const m = await daemon.attach({
    device: 'chat-arrival-peer',
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
  const read = async <T>(script: string): Promise<T> => {
    const result = (await m.evalBrowserScript({ script })) as { data: unknown }
    return (
      typeof result.data === 'string' ? JSON.parse(result.data) : result.data
    ) as T
  }
  const api = `async function get(path){const r=await fetch(${JSON.stringify(API)}+path,{credentials:'include'});if(!r.ok)throw Error('Peer preflight '+r.status);return r.json()}`
  try {
    await signIn(m, 'Hc')
    const preflight = await read<{
      authorUserId: number
      rooms: Array<{
        conversationId: string
        memberIds: number[]
        canPost: boolean
        lastSeq: number
      }>
    }>(
      `${api};const me=await get('/auth/me'),chats=await get('/chat/conversations'),result=[];for(const id of ${JSON.stringify([request.selectedConversationId, request.proposedOffscreenConversationId])}){const chat=chats.find(c=>c.id===id),members=await get('/chat/conversations/'+id+'/members');if(!chat?.canPost||chat.closed||chat.locked||chat.noHolder||!members.some(m=>Number(m.userId)===${request.actorUserId})||!members.some(m=>Number(m.userId)===Number(me.id)))throw Error('Current peer/receiver membership or posting eligibility missing');result.push({conversationId:id,memberIds:members.map(m=>Number(m.userId)),canPost:chat.canPost,lastSeq:chat.lastSeq})}return JSON.stringify({authorUserId:me.id,rooms:result})`
    )
    writeFileSync(
      required('CHAT_UI_ARRIVAL_PREFLIGHT'),
      JSON.stringify(preflight, null, 2) + '\n'
    )
    console.log(
      '$ Authenticated current peer/receiver membership and posting preflight',
      preflight
    )
    if (process.env.CHAT_UI_ARRIVAL_PREFLIGHT_ONLY === '1') return
    const ready = JSON.parse(
      readFileSync(required('CHAT_UI_ARRIVAL_READY'), 'utf8')
    ) as {
      ready: boolean
      stage: string
      phaseToken: string
      conversationId: string
      body: string
      priorSeq: number
      expiresAt: number | string
      sourceHead: string
    }
    assert.equal(ready.ready, true)
    assert.equal(ready.stage, required('CHAT_UI_ARRIVAL_STAGE'))
    assert.equal(ready.sourceHead, required('CHAT_UI_APP_SOURCE'))
    assert(
      ready.phaseToken !== '' &&
        Date.now() <
          (typeof ready.expiresAt === 'number'
            ? ready.expiresAt
            : Date.parse(ready.expiresAt)),
      'Receiver token must be unexpired'
    )
    assert(
      [
        request.selectedConversationId,
        request.proposedOffscreenConversationId
      ].includes(ready.conversationId)
    )
    assert.equal(ready.body, request.probeBody)
    assert(Number.isInteger(ready.priorSeq) && ready.priorSeq >= 0)
    assert(
      Date.now() - statSync(required('CHAT_UI_ARRIVAL_READY')).mtimeMs < 120000,
      'Receiver ready marker must be fresh'
    )
    const ackPath = required('CHAT_UI_ARRIVAL_ACK')
    const attemptedPath = ackPath + '.attempted.json'
    assert(
      !existsSync(ackPath) && !existsSync(attemptedPath),
      'A stage acknowledgement or attempt already exists; never send again'
    )
    await m.openLink({ link: WEB + '/chat/' + ready.conversationId })
    await m.assertVisible({
      css: '[data-testid="chat-composer"]',
      timeout: 60000
    })
    const before = await read<number>(
      `${api};return JSON.stringify((await get('/chat/conversations')).find(c=>c.id===${JSON.stringify(ready.conversationId)}).lastSeq)`
    )
    assert.equal(
      before,
      ready.priorSeq,
      'No other post may race this receiver stage'
    )
    assert(
      await read<boolean>(
        "return JSON.stringify(document.querySelector('[data-testid=\"chat-composer\"]').value==='')"
      ),
      'Peer composer must start empty'
    )
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: ready.body })
    const stillReady = JSON.parse(
      readFileSync(required('CHAT_UI_ARRIVAL_READY'), 'utf8')
    ) as typeof ready
    assert(
      stillReady.ready &&
        stillReady.phaseToken === ready.phaseToken &&
        stillReady.stage === ready.stage &&
        Date.now() <
          (typeof stillReady.expiresAt === 'number'
            ? stillReady.expiresAt
            : Date.parse(stillReady.expiresAt)),
      'Receiver must still own the exact active stage'
    )
    // Claim before clicking so even a transport failure cannot repeat this send.
    writeFileSync(
      attemptedPath,
      JSON.stringify({
        attempted: true,
        stage: ready.stage,
        conversationId: ready.conversationId,
        priorSeq: before
      }) + '\n'
    )
    await m.tapOn({ text: 'Send' })
    const posted = await read<{
      messageId: string
      seq: number
      senderUserId: number
    }>(
      `${api};for(let n=0;n<150;n++){const posts=(await get(${JSON.stringify('/chat/conversations/' + ready.conversationId + '/messages?after=' + before)})).filter(p=>p.kind==='post');if(posts.length===1&&document.querySelector('[data-testid="chat-composer"]').value==='')return JSON.stringify({messageId:posts[0].id,seq:posts[0].seq,senderUserId:posts[0].senderUserId});if(posts.length>1)throw Error('Peer stage appended more than one post');await new Promise(r=>setTimeout(r,100))}throw Error('Normal encrypted peer stage did not settle')`
    )
    assert.equal(
      posted.senderUserId,
      preflight.authorUserId,
      'Exactly the verified normal author must send this stage'
    )
    const ack = {
      stage: ready.stage,
      conversationId: ready.conversationId,
      body: ready.body,
      priorSeq: before,
      phaseToken: ready.phaseToken,
      postId: posted.messageId,
      postSeq: posted.seq,
      senderUserId: posted.senderUserId,
      acknowledged: true,
      normalUi: true
    }
    writeFileSync(ackPath, JSON.stringify(ack, null, 2) + '\n')
    console.log(
      '$ Normal encrypted peer stage acknowledged exactly one post',
      ack
    )
  } finally {
    await m.detach()
  }
}

async function pendingSend(daemon: Daemon): Promise<void> {
  const narrow = process.env.CHAT_UI_VIEWPORT === 'narrow'
  const conversation = required('CHAT_UI_TEST_CONVERSATION')
  const other = required('CHAT_UI_CONVERSATION')
  assert.notEqual(conversation, other)
  const m = await daemon.attach({
    device: narrow ? 'chat-ui-pending-narrow' : 'chat-ui-pending-wide',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: narrow ? '390x844' : '1440x1000',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  const value = (reply: unknown): unknown => {
    const data = (reply as { data: unknown }).data
    return typeof data === 'string' ? JSON.parse(data) : data
  }
  const input = async (text: string): Promise<void> => {
    await m.evalBrowserScript({
      script: `const input=document.querySelector('[data-testid="chat-composer"]');if(!input)throw new Error('Composer missing');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));return true`
    })
  }
  const select = async (id: string, back: boolean): Promise<void> => {
    if (narrow && back) await m.tapOn({ text: 'Back' })
    const css =
      '[data-testid=' + JSON.stringify('chat-conversation-' + id) + ']'
    await m.scrollUntilVisible({
      element: { css },
      direction: 'DOWN',
      timeout: 20000
    })
    await m.tapOn({ css })
    await m.assertVisible({
      css: '[data-testid="chat-composer"]',
      timeout: 30000
    })
  }
  try {
    await signIn(m, narrow ? 'Hs' : 'Hc')
    await m.openLink({ link: WEB + '/chat' })
    await select(conversation, false)
    await select(other, true)
    await select(conversation, true)
    for (const outcome of ['success', 'failure'] as const) {
      const marker = `Submitted ${outcome} ${Date.now()}`
      const next = `New unsent ${outcome} ${Date.now()}`
      await input(marker)
      const before = Number(
        value(
          await m.evalBrowserScript({
            script: `const response=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});const rows=await response.json();return rows.find(row=>row.id===${JSON.stringify(conversation)}).lastSeq`
          })
        )
      )
      const gateId = `web-pending-${narrow ? 'narrow' : 'wide'}-${outcome}-${Date.now()}`
      execFileSync(
        process.execPath,
        [
          required('CHAT_UI_PENDING_CONTROL'),
          narrow ? 'Hs' : 'Hc',
          outcome,
          gateId,
          '15000'
        ],
        { stdio: 'pipe' }
      )
      await m.tapOn({ text: 'Send' })
      const deadline = Date.now() + 10000
      let consumed = false
      while (Date.now() < deadline) {
        if (!existsSync(required('CHAT_UI_PENDING_AUDIT'))) {
          await new Promise(resolve => setTimeout(resolve, 20))
          continue
        }
        const audit = readFileSync(required('CHAT_UI_PENDING_AUDIT'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as { gateId: string; event?: string })
        if (audit.some(hit => hit.gateId === gateId && hit.event == null)) {
          consumed = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert(consumed, 'The normal encrypted POST must consume the scoped gate')
      await select(other, true)
      await select(conversation, true)
      await m.evalBrowserScript({
        script: `const send=document.querySelector('[aria-label="Send"]');const input=document.querySelector('[data-testid="chat-composer"]');if(send.getAttribute('aria-disabled')!=='true')throw new Error('Returning pending composer permitted another submission');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));send.click();return true`
      })
      await input(next)
      const returnedAt = Date.now()
      await m.evalBrowserScript({
        script: `for(let n=0;n<1000;n++){const send=document.querySelector('[aria-label="Send"]');if(send?.getAttribute('aria-disabled')!=='true'){if(document.querySelector('[data-testid="chat-composer"]').value!==${JSON.stringify(next)})throw new Error('Old completion overwrote a newer draft');return true}await new Promise(resolve=>setTimeout(resolve,25))}throw new Error('Pending request did not complete')`
      })
      await select(other, true)
      await select(conversation, true)
      const proof = value(
        await m.evalBrowserScript({
          script: `const response=await fetch(${JSON.stringify(API + '/chat/conversations/' + conversation + '/messages?after=' + before + '&limit=100')},{credentials:'include'});const rows=await response.json();const posts=rows.filter(row=>row.kind==='post');if(posts.length!==${outcome === 'success' ? 1 : 0})throw new Error('Wrong number of encrypted posts after remount: '+posts.length);if(document.querySelector('[data-testid="chat-composer"]').value!==${JSON.stringify(next)})throw new Error('New draft disappeared after later navigation');return JSON.stringify({outcome:${JSON.stringify(outcome)},newPosts:posts.length,pendingRemountDuplicateBlocked:true,newerDraftRetained:true})`
        })
      )
      console.log(
        '$ actual pending send remount and newer draft ' + outcome,
        proof
      )
      const audit = readFileSync(required('CHAT_UI_PENDING_AUDIT'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(
          line =>
            JSON.parse(line) as {
              gateId: string
              event?: string
              at: string
              remaining?: number
            }
        )
        .filter(hit => hit.gateId === gateId)
      assert.equal(audit.filter(hit => hit.event == null).length, 1)
      const released = audit.find(hit => hit.event === 'delay-released')
      assert(
        released != null && returnedAt < Date.parse(released.at),
        'Conversation return and newer typing must occur before actual gate release'
      )
      console.log({
        gateId,
        returnedBeforeRelease: true,
        request: audit[0].at,
        released: released.at,
        exactlyOneConsumed: true
      })
      execFileSync(
        process.execPath,
        [required('CHAT_UI_PENDING_CONTROL'), 'clear'],
        { stdio: 'pipe' }
      )
    }
    await input('')
    console.log(narrow ? 'Pending send narrow PASS' : 'Pending send wide PASS')
  } finally {
    execFileSync(
      process.execPath,
      [required('CHAT_UI_PENDING_CONTROL'), 'clear'],
      { stdio: 'pipe' }
    )
    await m.detach()
  }
}

async function bands(daemon: Daemon): Promise<void> {
  const narrow = process.env.CHAT_UI_VIEWPORT === 'narrow'
  const width = Number(process.env.CHAT_UI_WIDTH ?? (narrow ? 390 : 1440))
  assert(Number.isFinite(width) && width >= 320)
  const m = await daemon.attach({
    device: narrow ? 'chat-ui-bands-narrow' : 'chat-ui-bands-wide',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: `${width}x${narrow ? 844 : 1000}`,
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  const listScript = `const response=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});if(!response.ok)throw new Error('Fixture list unavailable');const chats=await response.json();for(const chat of chats)if(chat.kind==='dm')chat.title=chat.people.filter(x=>!x.left).map(x=>x.shortName).join(', ')||'Just you';`
  const getData = (response: unknown): unknown => {
    const value = (response as { data: unknown }).data
    return typeof value === 'string' ? JSON.parse(value) : value
  }
  let targets: Array<{ id: string; title: string; pinned: boolean }> = []
  async function setPin(chat: { id: string }, desired: boolean): Promise<void> {
    await m.openLink({ link: WEB + '/chat/' + chat.id })
    await m.assertVisible({ text: 'Conversation actions', timeout: 60000 })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Mark unread' })
    const current = getData(
      await m.evalBrowserScript({
        script: `${listScript}return Boolean(chats.find(x=>x.id===${JSON.stringify(chat.id)})?.preferences.pinned)`
      })
    )
    if (current !== desired) await m.tapOn({ text: desired ? 'Pin' : 'Unpin' })
    else await m.pressKey({ key: 'Escape' })
    await m.evalBrowserScript({
      script: `for(let n=0;n<100;n++){${listScript}if(Boolean(chats.find(x=>x.id===${JSON.stringify(chat.id)})?.preferences.pinned)===${desired}){await new Promise(r=>setTimeout(r,250));return true}await new Promise(r=>setTimeout(r,50))}throw new Error('Conversation pin did not persist')`
    })
  }
  try {
    await signIn(m, narrow ? 'Hs' : 'Hc')
    await m.openLink({ link: WEB + '/chat' })
    await m.assertVisible({ text: 'Follow a team', timeout: 60000 })
    const availableDms = getData(
      await m.evalBrowserScript({
        script: `${listScript}return chats.filter(x=>x.kind==='dm').length`
      })
    )
    if (Number(availableDms) < 2) {
      await m.openLink({ link: WEB + '/chat/new' })
      await m.tapOn({ text: 'Name', timeout: 30000 })
      await m.inputText({ text: 'Harper' })
      await m.tapOn({ text: 'Pick Harper H', timeout: 30000 })
      await m.tapOn({ text: 'Start conversation' })
      await m.assertVisible({ text: 'Message', timeout: 60000 })
    }
    targets = getData(
      await m.evalBrowserScript({
        script: `${listScript}const dms=chats.filter(x=>x.kind==='dm');const groups=chats.filter(x=>x.kind!=='dm');if(dms.length<2||groups.length<2)throw new Error('Four-band fixtures unavailable');return JSON.stringify([dms[0],groups.find(x=>x.id===${JSON.stringify(required('CHAT_UI_CONVERSATION'))})??groups[0],dms[1],groups.find(x=>x.id!==${JSON.stringify(required('CHAT_UI_CONVERSATION'))})??groups[1]].map(x=>({id:x.id,title:x.title,pinned:x.preferences.pinned})))`
      })
    ) as typeof targets
    for (let i = 0; i < targets.length; i++) await setPin(targets[i], i < 2)
    await m.openLink({ link: WEB + '/chat' })
    await m.assertVisible({ text: 'Pinned', timeout: 60000 })
    console.log(
      '$ S2 actual web four bands, post-recency order independent of unread, adjacent scope pills'
    )
    const orderingScript = `${listScript}
      const compare=(a,b)=>{const at=a.lastPostAt==null?null:Date.parse(a.lastPostAt);const bt=b.lastPostAt==null?null:Date.parse(b.lastPostAt);if(at!==bt)return at==null?1:bt==null?-1:bt-at;return a.id<b.id?-1:a.id>b.id?1:0};
      const expected=[true,false].flatMap(pin=>['dm','group'].flatMap(kind=>chats.filter(x=>Boolean(x.preferences.pinned)===pin&&(x.kind==='dm'?'dm':'group')===kind).sort(compare)));
      const pane=document.querySelector('[data-testid="chat-list-pane"]');if(!pane)throw new Error('List pane missing');
      const nodes=[...pane.querySelectorAll('[data-testid^="chat-conversation-"]')];
      const ids=nodes.map(node=>node.getAttribute('data-testid').slice('chat-conversation-'.length));
      if(new Set(ids).size!==ids.length)throw new Error('Duplicate row identity');
      if(JSON.stringify(ids)!==JSON.stringify(expected.filter(x=>ids.includes(x.id)).map(x=>x.id)))throw new Error('Rendered exact-ID order differs from pin/kind/post/id order');
      const bounds=pane.getBoundingClientRect();
      const visible=nodes.filter(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=bounds.top&&r.bottom<=bounds.bottom}).map(node=>{const id=node.getAttribute('data-testid').slice('chat-conversation-'.length);const chat=chats.find(x=>x.id===id);return{id,band:(chat.preferences.pinned?'pinned-':'regular-')+(chat.kind==='dm'?'dm':'group')}});
      return JSON.stringify({renderedRows:ids.length,visibleRows:visible.length,visible,postRecencyOrder:true,unreadExcluded:true,viewport:innerWidth,height:innerHeight})`
    console.log(await m.evalBrowserScript({ script: orderingScript }))
    if (width === 320)
      console.log(
        await m.evalBrowserScript({
          script: `const pill=[...document.querySelector('[data-testid="chat-list-pane"]').querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent==='Season Announcements');if(!pill)throw new Error('Constrained scope row missing');const title=pill.parentElement.parentElement.children[0];const a=title.getBoundingClientRect(),b=pill.getBoundingClientRect();if(a.width<60)throw new Error('Organization title reduced to a sliver');if(a.top<b.bottom&&b.top<a.bottom&&a.left<b.right&&b.left<a.right)throw new Error('Title and scope pill overlap');return JSON.stringify({width:innerWidth,organizationTitleWidth:a.width,readableTitleAndScope:true,pillWraps:b.top>=a.bottom})`
        })
      )
    if (!narrow) {
      await m.tapOn({
        css:
          '[data-testid=' +
          JSON.stringify('chat-conversation-' + targets[1].id) +
          ']'
      })
      await m.assertVisible({
        css: '[data-testid="chat-composer"]',
        timeout: 60000
      })
      const scrollScript = `const pane=document.querySelector('[data-testid="chat-list-pane"]');const row=pane?.querySelector('[data-testid^="chat-conversation-"]');let scroll=row?.parentElement;while(scroll&&scroll!==pane&&!(scroll.scrollHeight>scroll.clientHeight+2&&/auto|scroll/.test(getComputedStyle(scroll).overflowY)))scroll=scroll.parentElement;if(!scroll||scroll===pane)throw new Error('Actual sidebar scroll container unavailable');`
      await m.evalBrowserScript({
        script:
          scrollScript +
          'scroll.dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:-scroll.scrollHeight}));scroll.scrollTop=0;return true'
      })
      const top = getData(
        await m.evalBrowserScript({ script: orderingScript })
      ) as { visible: Array<{ id: string; band: string }> }
      assert(
        top.visible.some(row => row.band === 'pinned-dm') &&
          top.visible.some(row => row.band === 'pinned-group'),
        'Top image must actually show a complete pinned DM and group'
      )
      writeFileSync(
        join(required('CHAT_UI_ARTIFACTS'), 'wide-four-bands-top-after.png'),
        await m.screenshot()
      )
      console.log(
        await m.evalBrowserScript({
          script:
            scrollScript +
            'scroll.dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:scroll.scrollHeight}));scroll.scrollTop=scroll.scrollHeight;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return JSON.stringify({scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight})'
        })
      )
      const bottom = getData(
        await m.evalBrowserScript({ script: orderingScript })
      ) as { visible: Array<{ id: string; band: string }> }
      console.log({
        top: top.visible,
        bottom: bottom.visible,
        actualViewportIntersection: true
      })
      assert(
        bottom.visible.some(row => row.band === 'regular-dm') &&
          bottom.visible.some(row => row.band === 'regular-group'),
        'Bottom image must actually show a complete unpinned DM and group'
      )
      writeFileSync(
        join(required('CHAT_UI_ARTIFACTS'), 'wide-four-bands-bottom-after.png'),
        await m.screenshot()
      )
      const observed = [
        ...new Set([...top.visible, ...bottom.visible].map(row => row.band))
      ]
      assert(
        observed.length === 4,
        'All four bands require actual visible rows across normal scrolling'
      )
      console.log({
        fourBands: true,
        top: top.visible,
        bottom: bottom.visible,
        actualViewportIntersection: true,
        width,
        height: 1000
      })
      await m.evalBrowserScript({
        script:
          scrollScript +
          'scroll.dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:-scroll.scrollHeight}));scroll.scrollTop=0;return true'
      })
    }
    writeFileSync(
      join(
        required('CHAT_UI_ARTIFACTS'),
        width === 320
          ? 'narrow-chat-list-320-after.png'
          : narrow
            ? 'narrow-chat-list-after.png'
            : 'wide-chat-list-after.png'
      ),
      await m.screenshot()
    )
    if (narrow) {
      await m.setOrientation({ orientation: 'LANDSCAPE' })
      await m.setOrientation({ orientation: 'PORTRAIT' })
    }
    console.log(
      narrow ? 'S2 narrow four bands PASS' : 'S2 wide four bands PASS'
    )
  } finally {
    try {
      for (const chat of targets) await setPin(chat, chat.pinned)
    } finally {
      await m.detach()
    }
  }
}

async function historyFixture(daemon: Daemon): Promise<void> {
  const m = await daemon.attach({
    device: 'chat-ui-native-history-fixture',
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
  const token = Date.now().toString(36)
  const originalBody = (
    'History original ' +
    token +
    ' ' +
    'Practice notes '.repeat(25)
  ).trim()
  const replyBody = 'History reply ' + token
  const attachmentReplyBody = 'History attachment reply ' + token
  const decode = (response: unknown): any => {
    const value = (response as { data: unknown }).data
    return typeof value === 'string' ? JSON.parse(value) : value
  }
  const send = async (body: string): Promise<string> => {
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.pressKey({ key: 'Cmd+A' })
    await m.pressKey({ key: 'Backspace' })
    await m.inputText({ text: body })
    await m.pressKey({ key: 'Enter' })
    return decode(
      await m.evalBrowserScript({
        script: `for(let n=0;n<200;n++){const rows=[...document.querySelectorAll('[data-testid^="chat-message-"]')].filter(x=>x.getAttribute('data-testid')!=='chat-message-pane'&&x.innerText.includes(${JSON.stringify(body)}));if(rows.length===1&&document.querySelector('[data-testid="chat-composer"]').value==='')return JSON.stringify(rows[0].getAttribute('data-testid').slice('chat-message-'.length));await new Promise(r=>setTimeout(r,50))}throw new Error('Fixture post was not uniquely acknowledged')`
      })
    ) as string
  }
  const reply = async (id: string, body: string): Promise<string> => {
    const selector = `[data-testid="chat-message-${id}"]`
    await m.evalBrowserScript({
      script: `const row=document.querySelector(${JSON.stringify(selector)});row.scrollIntoView({block:'center'});row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));await new Promise(r=>setTimeout(r,250));return true`
    })
    await m.tapOn({ css: selector + ' [aria-label="Reply"]' })
    await m.assertVisible({ text: 'Replying to You' })
    return await send(body)
  }
  try {
    await signIn(m, 'Hc')
    await m.openLink({ link: WEB + '/chat/new' })
    const people: string[] = JSON.parse(required('CHAT_UI_FIXTURE_PEOPLE'))
    assert.equal(
      people.length,
      2,
      'The shared native fixture needs two adult peers'
    )
    for (const name of people) {
      await m.tapOn({ text: 'Clear Name', optional: true })
      await m.tapOn({ css: 'input[aria-label="Name"]', timeout: 30000 })
      await m.inputText({ text: name.split(' ')[0] })
      await m.tapOn({ text: 'Pick ' + name, timeout: 30000 })
    }
    await m.tapOn({ text: 'Start conversation' })
    await m.assertVisible({ text: 'Message', timeout: 60000 })
    let conversationId = decode(
      await m.evalBrowserScript({
        script: `const r=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});if(!r.ok)throw new Error('Created fixture list unavailable');const wanted=${JSON.stringify(people)};const chat=(await r.json()).find(x=>x.kind==='dm'&&x.people.length===2&&wanted.every(name=>x.people.some(p=>!p.left&&p.shortName===name)));if(!chat||chat.memberCount!==3)throw new Error('Shared native fixture membership differs from three adults');return JSON.stringify(chat.id)`
      })
    ) as string
    assert.notEqual(conversationId, required('CHAT_UI_CONVERSATION'))
    console.log(
      '$ Normal encrypted app composer setup for a separate three-adult native history fixture'
    )
    const originalId = await send(originalBody)
    await m.evalBrowserScript({
      script: `const transfer=new DataTransfer();transfer.items.add(new File(['Practice notes'],'notes.txt',{type:'text/plain'}));document.querySelector('[data-testid="chat-drop-target"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return true`
    })
    await m.assertVisible({ text: 'Remove notes.txt' })
    await m.tapOn({ text: 'Send' })
    await m.assertVisible({ text: 'Save notes.txt', timeout: 60000 })
    const attachmentId = decode(
      await m.evalBrowserScript({
        script: `const file=document.querySelector('[aria-label="Save notes.txt"]');return JSON.stringify(file.closest('[data-testid^="chat-message-"]').getAttribute('data-testid').slice('chat-message-'.length))`
      })
    ) as string
    const attachmentReplyId = await reply(attachmentId, attachmentReplyBody)
    for (let i = 0; i < 105; i++) {
      await send('History filler ' + (i + 1) + ' ' + token)
      if ((i + 1) % 25 === 0)
        console.log(
          `$ Native history fixture acknowledged ${i + 1} unique encrypted filler posts`
        )
    }
    const replyId = await reply(originalId, replyBody)
    conversationId = decode(
      await m.evalBrowserScript({
        script: `const r=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});const chat=(await r.json()).find(x=>x.kind==='dm'&&x.lastPostId===${JSON.stringify(replyId)});if(!chat||chat.memberCount!==3)throw new Error('Final unique reply does not identify the shared room');return JSON.stringify(chat.id)`
      })
    ) as string
    writeFileSync(
      required('CHAT_UI_HISTORY_FIXTURE_FILE'),
      JSON.stringify(
        {
          conversationId,
          originalId,
          originalBody,
          attachmentId,
          attachmentReplyId,
          attachmentReplyBody,
          replyId,
          replyBody,
          fileName: 'notes.txt',
          fileBytes: 'Practice notes',
          fillerCount: 105,
          normalComposerEncryption: true
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
    console.log(
      'Shared native history fixture ready: original, attachment quote, self/long quote and105laterposts; originalgroup unchanged'
    )
  } finally {
    await m.detach()
  }
}

async function composeFull(daemon: Daemon): Promise<void> {
  const conversation = required('CHAT_UI_TEST_CONVERSATION')
  assert.notEqual(conversation, required('CHAT_UI_CONVERSATION'))
  const attach = async (
    name: string,
    profile: string,
    narrow: boolean
  ): Promise<Device> =>
    await daemon.attach({
      device: name,
      platform: 'web',
      driver: 'cdp',
      url: WEB,
      artifacts: 'on-failure',
      extra: {
        browser: await puppeteer.executablePath(),
        windowSize: narrow ? '390x844' : '1440x1000',
        userDataDir: profile
      }
    })
  const m = await attach(
    'chat-ui-compose-full',
    required('CHAT_UI_PROFILE_DIR'),
    false
  )
  const peer = await attach(
    'chat-ui-compose-peer',
    required('CHAT_UI_PEER_PROFILE_DIR'),
    true
  )
  const marker = 'Attachment delivery probe ' + Date.now().toString(36)
  const posts = `const raw=await(await fetch(${JSON.stringify(API + '/chat/conversations/' + conversation + '/messages')},{credentials:'include'})).json();const count=raw.filter(x=>x.kind==='post').length;`
  const drop = `const target=document.querySelector('[data-testid="chat-drop-target"]');function drop(files){const data=new DataTransfer();for(const file of files)data.items.add(file);const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});target.dispatchEvent(event);if(!event.defaultPrevented)throw new Error('File navigation not prevented');}`
  try {
    await signIn(m, 'Hc')
    await signIn(peer, 'Hs')
    await m.openLink({ link: WEB + '/chat/' + conversation })
    await peer.openLink({ link: WEB + '/chat/' + conversation })
    await m.assertVisible({ text: 'Message', timeout: 60000 })
    await peer.assertVisible({ text: 'Message', timeout: 60000 })
    await m.evalBrowserScript({
      script: `${posts}window.chatUiComposePosts=count;window.chatUiByteReads=[];const original=File.prototype.arrayBuffer;window.chatUiOriginalRead=original;File.prototype.arrayBuffer=function(){window.chatUiByteReads.push(this.name);if(this.name==='slow.txt')return new Promise(resolve=>{window.chatUiReleaseRead=async()=>resolve(await original.call(this))});if(this.name==='bad.txt')return Promise.reject(new Error('Synthetic file read failure'));return original.call(this)};return true`
    })
    console.log(
      '$ S9 actual File metadata limits before byte reads; delayed preparation blocks both send paths'
    )
    await m.evalBrowserScript({
      script: `${drop}drop(Array.from({length:11},(_,i)=>new File(['Practice notes'],'count-'+i+'.txt',{type:'text/plain'})));return true`
    })
    await m.assertVisible({
      text: 'A message can include up to 10 attachments.'
    })
    await m.evalBrowserScript({
      script: `if(window.chatUiByteReads.length)throw new Error('Count failure read file bytes');return true`
    })
    await m.evalBrowserScript({
      script: `${drop}drop([new File([new Uint8Array(100*1024*1024+1)],'oversize.bin')]);return true`
    })
    await m.assertVisible({
      text: 'oversize.bin is too large: files can be at most 100 MB.'
    })
    await m.evalBrowserScript({
      script: `if(window.chatUiByteReads.length)throw new Error('Size failure read file bytes');return true`
    })
    await m.evalBrowserScript({
      script: `${drop}drop([new File(['Practice notes'],'bad.txt',{type:'text/plain'})]);return true`
    })
    await m.assertVisible({ text: 'That attachment could not be opened.' })
    await m.evalBrowserScript({
      script: `${drop}drop([new File(['Practice notes'],'slow.txt',{type:'text/plain'})]);await new Promise(r=>setTimeout(r,100));const send=document.querySelector('[aria-label="Send"]');if(send.getAttribute('aria-disabled')!=='true'&&!send.disabled)throw new Error('Send allowed during preparation');document.querySelector('[data-testid="chat-composer"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));send.click();${posts}if(count!==window.chatUiComposePosts)throw new Error('Preparation sent a post');await window.chatUiReleaseRead();return true`
    })
    await m.assertVisible({ text: 'Remove slow.txt' })
    await m.tapOn({ text: 'Remove slow.txt' })
    await m.evalBrowserScript({
      script: `${drop}drop([new File(['Practice notes'],'notes.txt',{type:'text/plain'}),new File(['Bring a glove'],'lineup.txt',{type:'text/plain'})]);return true`
    })
    await m.assertVisible({ text: 'Remove notes.txt' })
    await m.assertVisible({ text: 'Remove lineup.txt' })
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: marker })
    await m.tapOn({ text: 'Send' })
    await peer.assertVisible({ text: marker, timeout: 60000 })
    await peer.evalBrowserScript({
      script: `window.chatUiOriginalObjectURL=URL.createObjectURL;URL.createObjectURL=function(blob){window.chatUiDecodedBlob=blob;return window.chatUiOriginalObjectURL.call(URL,blob)};return true`
    })
    for (const [file, bytes] of [
      ['notes.txt', 'Practice notes'],
      ['lineup.txt', 'Bring a glove']
    ]) {
      await peer.tapOn({ text: 'Save ' + file })
      console.log(
        await peer.evalBrowserScript({
          script: `for(let n=0;n<100;n++){if(window.chatUiDecodedBlob){const text=await window.chatUiDecodedBlob.text();if(text!==${JSON.stringify(bytes)})throw new Error('Peer decrypted file bytes differ');window.chatUiDecodedBlob=undefined;return JSON.stringify({file:${JSON.stringify(file)},peerDecryptedExactBytes:true})}await new Promise(r=>setTimeout(r,50))}throw new Error('Peer file was not decrypted')`
        })
      )
    }
    console.log(
      await m.evalBrowserScript({
        script: `${posts}if(count!==window.chatUiComposePosts+1)throw new Error('Multiple files/caption did not send exactly one post');if(document.querySelector('[data-testid="chat-composer"]').value!=='')throw new Error('Submitted caption not cleared');const wire=JSON.stringify(raw);if(wire.includes(${JSON.stringify(marker)})||wire.includes('notes.txt')||wire.includes('Bring a glove'))throw new Error('Plaintext canary entered message API wire');return JSON.stringify({captionAndTwoFiles:true,postCountDelta:1,ciphertextWireCanaryAbsent:true})`
      })
    )
    console.log(
      '$ S10 real textarea composition and rapid button/key guard on encrypted app send'
    )
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: 'Composition probe ' + marker })
    await m.evalBrowserScript({
      script: `const input=document.querySelector('[data-testid="chat-composer"]');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,250));${posts}if(count!==window.chatUiComposePosts+1)throw new Error('Composition confirmation sent');input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,100));return true`
    })
    await m.evalBrowserScript({
      script: `const input=document.querySelector('[data-testid="chat-composer"]');document.querySelector('[aria-label="Send"]').click();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true`
    })
    await peer.assertVisible({
      text: 'Composition probe ' + marker,
      timeout: 60000
    })
    console.log(
      await m.evalBrowserScript({
        script: `await new Promise(r=>setTimeout(r,250));${posts}if(count!==window.chatUiComposePosts+2)throw new Error('Rapid button/key made duplicate posts');File.prototype.arrayBuffer=window.chatUiOriginalRead;return JSON.stringify({compositionQuiet:true,rapidButtonKeyExactlyOne:true,peerDelivered:true})`
      })
    )
    console.log('S9/S10 full encrypted browser peer delivery PASS')
  } finally {
    await m.detach()
    await peer.detach()
  }
}

async function picker(daemon: Daemon): Promise<void> {
  const m = await daemon.attach({
    device: 'chat-ui-picker',
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
      link: WEB + '/chat/' + required('CHAT_UI_TEST_CONVERSATION')
    })
    await m.assertVisible({ text: 'Message', timeout: 60000 })
    console.log(
      '$ S9 actual Attach button creates picker input; browser file chooser is intercepted for maestro uploadFile; prepared chip without send'
    )
    await m.evalBrowserScript({
      script: `window.chatUiInputClick=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type==='file'){this.style.display='block';this.style.width='200px';this.style.height='30px';return}return window.chatUiInputClick.call(this)};return true`
    })
    await m.tapOn({ text: 'Attach' })
    await m.uploadFile({
      css: 'input[type="file"]',
      path: required('CHAT_UI_PICK_FILE')
    })
    await m.assertVisible({ text: 'Remove picker-notes.txt', timeout: 30000 })
    await m.tapOn({ text: 'Remove picker-notes.txt' })
    const marker = 'Picker cancel guard probe ' + Date.now().toString(36)
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: marker })
    await m.tapOn({ text: 'Attach' })
    console.log(
      await m.evalBrowserScript({
        script: `const picker=document.querySelector('input[type="file"]');if(!picker)throw new Error('Pending picker input absent');const send=document.querySelector('[aria-label="Send"]');if(send.getAttribute('aria-disabled')!=='true'&&!send.disabled)throw new Error('Send allowed while picker pending');picker.dispatchEvent(new Event('cancel'));for(let n=0;n<50;n++){await new Promise(r=>setTimeout(r,50));if(!document.querySelector('input[type="file"]')&&send.getAttribute('aria-disabled')!=='true'&&!send.disabled){if(document.querySelector('[data-testid="chat-composer"]').value!==${JSON.stringify(marker)})throw new Error('Cancel lost draft');return JSON.stringify({modernBrowserCancelReleasedPreparation:true,draftPreserved:true})}}throw new Error('Picker cancel left preparation blocked')`
      })
    )
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.pressKey({ key: 'Enter' })
    await m.evalBrowserScript({
      script: `for(let n=0;n<100;n++){const rows=[...document.querySelectorAll('[data-testid^="chat-message-"]')].filter(x=>x.getAttribute('data-testid')!=='chat-message-pane'&&x.innerText.includes(${JSON.stringify(marker)}));if(rows.length===1&&document.querySelector('[data-testid="chat-composer"]').value==='')return JSON.stringify({realEnterAfterCancelSentOnce:true});await new Promise(r=>setTimeout(r,50))}throw new Error('Send guard did not release after picker cancel')`
    })
    await m.evalBrowserScript({
      script: `HTMLInputElement.prototype.click=window.chatUiInputClick;return true`
    })
    console.log('S9 browser button picker parity PASS')
  } finally {
    await m.detach()
  }
}

async function reader(daemon: Daemon): Promise<void> {
  const m = await daemon.attach({
    device: 'chat-ui-reader-narrow',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: '390x844',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  try {
    await signIn(m, 'Hs')
    await m.openLink({ link: WEB + '/chat' })
    await m.assertVisible({ text: 'Follow a team', timeout: 60000 })
    const found = (await m.evalBrowserScript({
      script: `const r=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});const chat=(await r.json()).find(x=>x.kind==='seasonAnnouncements'&&!x.canPost&&x.lastSeq>0);if(!chat)throw new Error('Existing reader fixture unavailable');return JSON.stringify(chat.id)`
    })) as { data: string }
    const id = JSON.parse(found.data) as string
    await m.openLink({ link: WEB + '/chat/' + id })
    await m.assertVisible({ text: 'Practice notes', timeout: 60000 })
    await m.evalBrowserScript({
      script: `const original=window.matchMedia.bind(window);window.matchMedia=q=>q.includes('pointer')&&q.includes('fine')?new Proxy(original(q),{get(t,k){if(k==='matches')return false;const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v}}):original(q);return true`
    })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Mark unread' })
    await m.pressKey({ key: 'Escape' })
    await m.evalBrowserScript({
      script: `const row=[...document.querySelectorAll('[data-testid^="chat-message-"]')].find(x=>x.getAttribute('data-testid')!=='chat-message-pane'&&x.innerText.includes('Practice notes'));if(!row)throw new Error('Reader post missing');row.setAttribute('data-reader-target','true');row.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,350));return true`
    })
    await m.longPressOn({ css: '[data-reader-target="true"] [tabindex="0"]' })
    await m.assertVisible({ text: 'Copy' })
    await m.assertVisible({ text: 'Pin' })
    console.log(
      await m.evalBrowserScript({
        script: `const panel=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label').startsWith('Message from '));if(!panel)throw new Error('Reader menu missing');const labels=[...panel.querySelectorAll('[role="button"]')].map(x=>x.getAttribute('aria-label')||x.innerText);if(labels.includes('Reply')||labels.includes('Delete')||!labels.some(x=>x==='React with 👍'))throw new Error('Reader permissions wrong');return JSON.stringify({readerCopyPinReact:true,replyDeleteAbsent:true})`
      })
    )
    await m.tapOn({ text: 'Pin' })
    await m.assertVisible({ text: 'Pinned messages: 1' })
    await m.longPressOn({ css: '[data-reader-target="true"] [tabindex="0"]' })
    await m.tapOn({ text: 'Unpin' })
    console.log(
      await m.evalBrowserScript({
        script: `const pane=document.querySelector('[data-testid="chat-drop-target"]');const data=new DataTransfer();data.items.add(new File(['Practice notes'],'blocked.txt',{type:'text/plain'}));const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});pane.dispatchEvent(event);await new Promise(r=>setTimeout(r,150));if(!event.defaultPrevented||document.querySelector('[aria-label="Remove blocked.txt"]')||document.querySelector('[data-testid="chat-composer"]'))throw new Error('Reader drop/composer not blocked');return JSON.stringify({readerDropPrevented:true,noPreparedFile:true,noComposer:true})`
      })
    )
    writeFileSync(
      join(
        required('CHAT_UI_ARTIFACTS'),
        'mobile-web-reader-actions-after.png'
      ),
      await m.screenshot()
    )
    console.log('S8 narrow browser reader restrictions PASS')
  } finally {
    await m.detach()
  }
}

async function lockedCurrentReply(daemon: Daemon): Promise<void> {
  const conversation = required('CHAT_UI_LOCKED_CONVERSATION')
  const originalId = required('CHAT_UI_LOCKED_ORIGINAL')
  assert.notEqual(conversation, required('CHAT_UI_CONVERSATION'))
  const m = await daemon.attach({
    device: 'chat-ui-locked-current-reply',
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
  const body = 'Current reply probe ' + Date.now().toString(36)
  try {
    await signIn(m, 'L')
    await m.openLink({ link: WEB + '/chat/' + conversation })
    await m.assertVisible({
      text: required('CHAT_UI_LOCKED_ORIGINAL_BODY'),
      timeout: 60000
    })
    await m.evalBrowserScript({
      script: `const rows=await(await fetch(${JSON.stringify(API + '/chat/conversations/' + conversation + '/messages')},{credentials:'include'})).json();const original=rows.find(x=>x.id===${JSON.stringify(originalId)});if(!original||original.clearedAt!=null)throw new Error('Pre-reset original envelope unavailable');window.chatUiLockedOriginalEpoch=original.epoch;const row=document.querySelector(${JSON.stringify('[data-testid="chat-message-' + originalId + '"]')});if(!row||!row.innerText.includes(${JSON.stringify(required('CHAT_UI_LOCKED_ORIGINAL_BODY'))}))throw new Error('L cannot read the original normally');row.scrollIntoView({block:'center'});row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));await new Promise(r=>setTimeout(r,250));return JSON.stringify({oldEpoch:original.epoch,retainedAuthorReadsOriginal:true})`
    })
    await m.tapOn({
      css: `[data-testid="chat-message-${originalId}"] [aria-label="Reply"]`
    })
    await m.assertVisible({ text: 'Cancel reply' })
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: body })
    await m.pressKey({ key: 'Enter' })
    const result = (await m.evalBrowserScript({
      script: `for(let n=0;n<200;n++){const row=[...document.querySelectorAll('[data-testid^="chat-message-"]')].find(x=>x.getAttribute('data-testid')!=='chat-message-pane'&&x.innerText.includes(${JSON.stringify(body)}));if(row&&document.querySelector('[data-testid="chat-composer"]').value===''){const id=row.getAttribute('data-testid').slice('chat-message-'.length);const raw=await(await fetch(${JSON.stringify(API + '/chat/conversations/' + conversation + '/messages')},{credentials:'include'})).json();const posted=raw.find(x=>x.id===id);if(!posted||posted.epoch<=window.chatUiLockedOriginalEpoch)throw new Error('Current reply did not rotate beyond old epoch');return JSON.stringify({conversationId:${JSON.stringify(conversation)},originalId:${JSON.stringify(originalId)},originalEpoch:window.chatUiLockedOriginalEpoch,replyId:id,replyBody:${JSON.stringify(body)},replyEpoch:posted.epoch,normalReply:true,historyApprovalClicked:false})}await new Promise(r=>setTimeout(r,50))}throw new Error('L current reply not acknowledged')`
    })) as { data: unknown }
    const metadata =
      typeof result.data === 'string' ? JSON.parse(result.data) : result.data
    writeFileSync(
      required('CHAT_UI_LOCKED_REPLY_RESULT'),
      JSON.stringify(metadata, null, 2),
      { mode: 0o600 }
    )
    console.log(
      'Normal L current reply in newer epoch prepared; reset-S decoded-outer/locked-original assertions remain native helper-owned'
    )
  } finally {
    await m.detach()
  }
}

async function lockedProvider(daemon: Daemon, phase: string): Promise<void> {
  const conversation = required('CHAT_UI_LOCKED_CONVERSATION')
  const originalId = required('CHAT_UI_LOCKED_ORIGINAL')
  const m = await daemon.attach({
    device: 'chat-ui-locked-provider-' + phase,
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
    await signIn(m, 'S')
    if (phase === 'prepare') {
      await m.openLink({ link: WEB + '/chat/' + conversation })
      await m.assertVisible({
        text: required('CHAT_UI_LOCKED_ORIGINAL_BODY'),
        timeout: 60000
      })
      const selector = `[data-testid="chat-message-${originalId}"]`
      await m.evalBrowserScript({
        script: `const row=document.querySelector(${JSON.stringify(selector)});if(!row)throw new Error('Pre-reset S original missing');row.scrollIntoView({block:'center'});row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));await new Promise(r=>setTimeout(r,250));return true`
      })
      await m.tapOn({ css: selector + ' [aria-label="Reply"]' })
      await m.assertVisible({ text: 'Replying to You' })
      const body = 'Locked history self quote ' + Date.now().toString(36)
      await m.tapOn({ css: '[data-testid="chat-composer"]' })
      await m.inputText({ text: body })
      await m.pressKey({ key: 'Enter' })
      await m.evalBrowserScript({
        script: `for(let n=0;n<100;n++){const row=[...document.querySelectorAll('[data-testid^="chat-message-"]')].find(x=>x.getAttribute('data-testid')!=='chat-message-pane'&&x.innerText.includes(${JSON.stringify(body)}));if(row&&document.querySelector('[data-testid="chat-composer"]').value===''){window.chatUiLockedSelfReply=row.getAttribute('data-testid').slice('chat-message-'.length);return true}await new Promise(r=>setTimeout(r,50))}throw new Error('Pre-reset self quote not delivered')`
      })
      await m.evalBrowserScript({
        script: `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});return true`
      })
      await m.tapOn({ css: selector + ' [aria-label="More message actions"]' })
      await m.tapOn({ text: 'Pin' })
      await m.assertVisible({ text: 'Pinned messages: 1', timeout: 30000 })
      const result = (await m.evalBrowserScript({
        script: `const raw=await(await fetch(${JSON.stringify(API + '/chat/conversations/' + conversation + '/messages')},{credentials:'include'})).json();const pins=await(await fetch(${JSON.stringify(API + '/chat/conversations/' + conversation + '/pins')},{credentials:'include'})).json();const original=raw.find(x=>x.id===${JSON.stringify(originalId)});if(!original||!pins.some(x=>x.messageId===original.id))throw new Error('Pre-reset pin/envelope not saved');return JSON.stringify({conversationId:${JSON.stringify(conversation)},originalId:original.id,originalBody:${JSON.stringify(required('CHAT_UI_LOCKED_ORIGINAL_BODY'))},originalEpoch:original.epoch,selfReplyId:window.chatUiLockedSelfReply,selfReplyBody:${JSON.stringify(body)},pinnedBeforeReset:true,normalUi:true})`
      })) as { data: unknown }
      writeFileSync(
        required('CHAT_UI_LOCKED_PROVIDER_RESULT'),
        typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data),
        { mode: 0o600 }
      )
      console.log(
        'Task-owned S normal self quote and personal pin prepared before reset'
      )
    } else if (phase === 'reset') {
      await m.openLink({ link: WEB + '/chat/' + conversation })
      await m.assertVisible({ text: 'Link this device', timeout: 60000 })
      await m.tapOn({ text: 'I can’t reach my other devices' })
      await m.assertVisible({ text: 'Reset chat on this device' })
      await m.tapOn({ text: 'Reset chat on this device' })
      await m.evalBrowserScript({
        script: `for(let n=0;n<100;n++){const r=await fetch(${JSON.stringify(API + '/chat/devices')},{credentials:'include'});if(r.ok&&(await r.json()).some(x=>x.current&&x.linked&&x.revokedAt==null)){await new Promise(r=>setTimeout(r,250));return true}await new Promise(r=>setTimeout(r,100))}throw new Error('Normal reset did not link its current device')`
      })
      await m.openLink({ link: WEB + '/chat/devices' })
      await m.assertVisible({ text: 'Your devices', timeout: 60000 })
      await m.evalBrowserScript({
        script: `const pins=await(await fetch(${JSON.stringify(API + '/chat/conversations/' + conversation + '/pins')},{credentials:'include'})).json();if(!pins.some(x=>x.messageId===${JSON.stringify(originalId)}))throw new Error('Normal reset removed personal pin');return true`
      })
      writeFileSync(
        required('CHAT_UI_LOCKED_PROVIDER_RESULT'),
        JSON.stringify(
          {
            resetUiCompleted: true,
            originalPinRetained: true,
            historyApprovalClicked: false,
            providerProfile: required('CHAT_UI_PROFILE_DIR')
          },
          null,
          2
        ),
        { mode: 0o600 }
      )
      console.log(
        'Fresh S provider normally reset; old personal pin retained; old history not approved'
      )
    } else {
      assert.equal(phase, 'approve')
      const request: { code: string; deviceId?: string } = JSON.parse(
        readFileSync(required('CHAT_UI_LOCKED_LINK_REQUEST'), 'utf8')
      )
      assert(
        /^\d{6}$/.test(request.code),
        'A private six-digit native request is required'
      )
      await m.openLink({ link: WEB + '/chat/devices' })
      await m.assertVisible({ text: 'Waiting for approval', timeout: 60000 })
      await m.evalBrowserScript({
        script: `const code=document.querySelector('[aria-label='+JSON.stringify(${JSON.stringify('Code ' + request.code)})+']');if(!code)throw new Error('Native/provider six-digit codes do not match');let card=code.parentElement;while(card&&!card.querySelector('[aria-label^="Approve "]'))card=card.parentElement;const button=card?.querySelector('[aria-label^="Approve "]');if(!button)throw new Error('Matching normal link approval unavailable');button.setAttribute('data-chat-link-approve','true');return true`
      })
      await m.tapOn({ css: '[data-chat-link-approve="true"]' })
      if (request.deviceId != null)
        await m.evalBrowserScript({
          script: `for(let n=0;n<100;n++){const r=await fetch(${JSON.stringify(API + '/chat/devices')},{credentials:'include'});const device=(await r.json()).find(x=>x.id===${JSON.stringify(request.deviceId)});if(device?.linked&&device.revokedAt==null)return true;await new Promise(r=>setTimeout(r,100))}throw new Error('Matching native device did not become linked')`
        })
      console.log(
        'Matching six-digit native request approved through normal Chat devices UI; no history approval'
      )
    }
  } finally {
    await m.detach()
  }
  if (phase === 'prepare') {
    const destination = required('CHAT_UI_LOCKED_PROVIDER_BACKUP')
    mkdirSync(destination, { recursive: true })
    cpSync(required('CHAT_UI_PROFILE_DIR'), destination, {
      recursive: true,
      filter: source =>
        !/^Singleton|^DevToolsActivePort$/.test(
          source.slice(source.lastIndexOf('/') + 1)
        )
    })
    console.log(
      'Closed encrypted provider profile preserved privately before normal reset'
    )
  }
}

async function maappToggle(daemon: Daemon, desired: boolean): Promise<void> {
  const league = required('CHAT_UI_TEST_LEAGUE')
  const m = await daemon.attach({
    device: 'chat-ui-owned-maapp',
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
    await signIn(m, 'L')
    await m.openLink({ link: WEB + '/leagues/' + league + '/manage' })
    await m.scrollUntilVisible({
      element: {
        css: '[aria-label="SafeSport Local Affiliated Organization"]'
      },
      direction: 'DOWN',
      centerElement: true,
      timeout: 30000
    })
    const before = (await m.evalBrowserScript({
      script: `const r=await fetch(${JSON.stringify(API + '/manage/league/' + league)},{credentials:'include'});if(!r.ok)throw new Error('Owned league unavailable');return JSON.stringify((await r.json()).scope.safesportLao)`
    })) as { data: unknown }
    const value =
      typeof before.data === 'string' ? JSON.parse(before.data) : before.data
    assert.equal(typeof value, 'boolean')
    if (value !== desired)
      await m.tapOn({
        css: '[aria-label="SafeSport Local Affiliated Organization"]'
      })
    await m.evalBrowserScript({
      script: `for(let n=0;n<100;n++){const r=await fetch(${JSON.stringify(API + '/manage/league/' + league)},{credentials:'include'});if(r.ok&&(await r.json()).scope.safesportLao===${desired})return true;await new Promise(r=>setTimeout(r,50))}throw new Error('Normal league switch not saved')`
    })
    writeFileSync(
      required('CHAT_UI_MAAPP_RESULT'),
      JSON.stringify(
        { normalUi: true, before: value, after: desired, leagueId: league },
        null,
        2
      ),
      { mode: 0o600 }
    )
    console.log(
      desired
        ? 'Owned synthetic league normal SafeSport switch ON'
        : 'Owned synthetic league normal SafeSport switch OFF restored; closed rooms stay closed'
    )
  } finally {
    await m.detach()
  }
}

async function disposablePrepare(daemon: Daemon): Promise<void> {
  const m = await daemon.attach({
    device: 'chat-ui-disposable-s-room',
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
  const originalBody = 'Disposable original notes ' + Date.now().toString(36)
  const selfReplyBody = 'Disposable self reply notes ' + Date.now().toString(36)
  const decode = (value: unknown): any => {
    const data = (value as { data: unknown }).data
    return typeof data === 'string' ? JSON.parse(data) : data
  }
  try {
    await signIn(m, 'S')
    await m.openLink({ link: WEB + '/chat/new' })
    await m.tapOn({ css: 'input[aria-label="Name"]' })
    await m.inputText({
      text: required('CHAT_UI_DISPOSABLE_PLAYER_NAME').split(' ')[0]
    })
    await m.tapOn({
      text: 'Pick ' + required('CHAT_UI_DISPOSABLE_PLAYER_NAME'),
      timeout: 30000
    })
    await m.tapOn({ text: 'Start conversation' })
    await m.assertVisible({ text: 'Include another adult', timeout: 30000 })
    await m.tapOn({
      text: 'Include ' + required('CHAT_UI_DISPOSABLE_GUARDIAN_NAME'),
      timeout: 30000
    })
    await m.tapOn({ text: 'Start with them' })
    await m.tapOn({ css: '[data-testid="chat-composer"]', timeout: 60000 })
    await m.inputText({ text: originalBody })
    await m.pressKey({ key: 'Enter' })
    const originalId = decode(
      await m.evalBrowserScript({
        script: `for(let n=0;n<100;n++){const row=[...document.querySelectorAll('[data-testid^="chat-message-"]')].find(x=>x.getAttribute('data-testid')!=='chat-message-pane'&&x.innerText.includes(${JSON.stringify(originalBody)}));if(row&&document.querySelector('[data-testid="chat-composer"]').value==='')return JSON.stringify(row.getAttribute('data-testid').slice('chat-message-'.length));await new Promise(r=>setTimeout(r,50))}throw new Error('Disposable original not delivered')`
      })
    ) as string
    const row = `[data-testid="chat-message-${originalId}"]`
    await m.evalBrowserScript({
      script: `document.querySelector(${JSON.stringify(row)}).dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
    })
    await m.tapOn({ css: row + ' [aria-label="Reply"]' })
    await m.assertVisible({ text: 'Replying to You' })
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: selfReplyBody })
    await m.pressKey({ key: 'Enter' })
    const result = decode(
      await m.evalBrowserScript({
        script: `for(let n=0;n<100;n++){const row=[...document.querySelectorAll('[data-testid^="chat-message-"]')].find(x=>x.getAttribute('data-testid')!=='chat-message-pane'&&x.innerText.includes(${JSON.stringify(selfReplyBody)}));if(row&&document.querySelector('[data-testid="chat-composer"]').value===''){const reply=row.getAttribute('data-testid').slice('chat-message-'.length);const chats=await(await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'})).json();const chat=chats.find(x=>x.kind==='dm'&&x.lastPostId===reply);if(!chat||chat.memberCount!==3)throw new Error('Exact three-person room not identified');return JSON.stringify({conversationId:chat.id,originalId:${JSON.stringify(originalId)},originalBody:${JSON.stringify(originalBody)},selfReplyId:reply,selfReplyBody:${JSON.stringify(selfReplyBody)},messageId:reply,bodyStub:${JSON.stringify(selfReplyBody)},pinnedBeforeDelete:false,normalUi:true})}await new Promise(r=>setTimeout(r,50))}throw new Error('Disposable self reply not delivered')`
      })
    )
    assert.notEqual(result.conversationId, required('CHAT_UI_CONVERSATION'))
    await m.tapOn({ css: row + ' [aria-label="More message actions"]' })
    await m.tapOn({ text: 'Pin' })
    await m.assertVisible({ text: 'Pinned messages: 1', timeout: 30000 })
    result.pinnedBeforeDelete = true
    writeFileSync(
      required('CHAT_UI_DISPOSABLE_FIXTURE_FILE'),
      JSON.stringify(result, null, 2),
      { mode: 0o600 }
    )
    console.log(
      'Normal S/player/guardian room prepared via MAAPP picker: original,selfreply andpersonalpin; wait BOTH native delete-ready ACKs'
    )
  } finally {
    await m.detach()
  }
}

async function disposableDelete(daemon: Daemon): Promise<void> {
  const fixture = JSON.parse(
    readFileSync(required('CHAT_UI_DISPOSABLE_FIXTURE_FILE'), 'utf8')
  ) as { conversationId: string; originalId: string; originalBody: string }
  const readyFiles = JSON.parse(
    required('CHAT_UI_DISPOSABLE_READY_FILES')
  ) as string[]
  assert.equal(readyFiles.length, 2)
  for (const file of readyFiles) {
    const ready = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(ready.conversationId, fixture.conversationId)
    assert.equal(ready.originalId, fixture.originalId)
    assert.equal(ready.ready, true)
  }
  const m = await daemon.attach({
    device: 'chat-ui-disposable-s-delete',
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
    await signIn(m, 'S')
    await m.openLink({ link: WEB + '/chat/' + fixture.conversationId })
    await m.assertVisible({ text: fixture.originalBody, timeout: 60000 })
    const row = `[data-testid="chat-message-${fixture.originalId}"]`
    await m.evalBrowserScript({
      script: `const row=document.querySelector(${JSON.stringify(row)});row.scrollIntoView({block:'center'});row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
    })
    await m.tapOn({ css: row + ' [aria-label="More message actions"]' })
    await m.tapOn({ text: 'Delete' })
    await m.assertVisible({
      text: 'This message will be removed for everyone.'
    })
    await m.tapOn({ text: 'Delete' })
    await m.evalBrowserScript({
      script: `for(let n=0;n<100;n++){const pins=await(await fetch(${JSON.stringify(API + '/chat/conversations/' + fixture.conversationId + '/pins')},{credentials:'include'})).json();const raw=await(await fetch(${JSON.stringify(API + '/chat/conversations/' + fixture.conversationId + '/messages')},{credentials:'include'})).json();if(!pins.some(x=>x.messageId===${JSON.stringify(fixture.originalId)})&&raw.find(x=>x.id===${JSON.stringify(fixture.originalId)})?.clearedAt!=null)return true;await new Promise(r=>setTimeout(r,50))}throw new Error('Normal authored deletion/pinpurge not observed')`
    })
    console.log(
      'Normal S authored deletion andpinpurge complete; native live quoted-snapshot suppression remains helper-owned'
    )
  } finally {
    await m.detach()
  }
}

/** Upload a new ordinary video fixture without changing existing messages. */
async function boundedMedia(daemon: Daemon): Promise<void> {
  const fixture = JSON.parse(
    readFileSync(required('CHAT_UI_VIDEO_FIXTURE_FILE'), 'utf8')
  ) as { conversationId: string; videoMessageId: string; fileName: string }
  const narrow =
    process.env.CHAT_UI_VIEWPORT === 'narrow' ||
    process.env.CHAT_UI_MEDIA_WIDTH === '390'
  const m = await daemon.attach({
    device: 'chat-ui-media-bounds',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: narrow ? '390x844' : '1440x1000',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  const bubble = `[data-testid="chat-bubble-${fixture.videoMessageId}"]`
  try {
    await signIn(m, 'Hc')
    await m.openLink({ link: `${WEB}/chat/${fixture.conversationId}` })
    await m.assertVisible({ css: bubble, timeout: 60000 })
    await m.evalBrowserScript({
      script: `const pane=document.querySelector('[data-testid="chat-message-pane"]'),scroll=[...pane.querySelectorAll('div')].find(n=>getComputedStyle(n).overflowY==='auto');scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1}));document.querySelector(${JSON.stringify(bubble)}).scrollIntoView({block:'center'});return true`
    })
    const verify = async (playing: boolean): Promise<void> => {
      console.log(
        await m.evalBrowserScript({
          script: `const bubble=document.querySelector(${JSON.stringify(bubble)}),style=getComputedStyle(bubble),b=bubble.getBoundingClientRect();const media=bubble.querySelector(${JSON.stringify(playing ? 'video' : '[aria-label="Open ' + fixture.fileName + '"]')});if(!media)throw new Error('Actual media element missing');const m=media.getBoundingClientRect(),left=b.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth||0),right=b.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth||0),pane=document.querySelector('[data-testid="chat-message-pane"]').getBoundingClientRect();if(m.left<left-1||m.right>right+1||b.left<pane.left-1||b.right>pane.right+1)throw new Error('Rendered media exceeds bubble content or message pane');return JSON.stringify({viewport:innerWidth,playing:${playing},mediaContained:true,mediaWidth:m.width,bubbleWidth:b.width,contentWidth:right-left,roundingTolerance:1})`
        })
      )
    }
    await verify(false)
    await m.tapOn({
      css: bubble + ` [aria-label="Open ${fixture.fileName}"]`
    })
    await m.evalBrowserScript({
      script: `for(let n=0;n<150;n++){const v=document.querySelector(${JSON.stringify(bubble + ' video')});if(v&&v.readyState>=2)return true;await new Promise(r=>setTimeout(r,100))}throw new Error('Normal video playback did not load')`
    })
    await verify(true)
    writeFileSync(
      join(
        required('CHAT_UI_ARTIFACTS'),
        `web-video-bounded-${narrow ? 'narrow' : 'wide'}-after.png`
      ),
      await m.screenshot()
    )
    console.log('Actual thumbnail/player bounds within bubble content PASS')
  } finally {
    await m.detach()
  }
}

/** Upload a new ordinary video fixture without changing existing messages. */
async function adultReplyFixture(daemon: Daemon): Promise<void> {
  const actor = required('CHAT_UI_FIXTURE_ACTOR')
  const peerActor = required('CHAT_UI_FIXTURE_PEER')
  const output = required('CHAT_UI_FIXTURE_RESULT')
  assert(!existsSync(output), 'Never replace an already prepared fixture')
  const prepared: Record<string, unknown> = { complete: false }
  const checkpoint = (): void => {
    writeFileSync(output, JSON.stringify(prepared, null, 2), { mode: 0o600 })
  }
  const seed = readFileSync(required('CHAT_UI_SEED_FILE'), 'utf8')
  const uid = (key: string): number => {
    for (const line of seed.split('\n')) {
      const match = /^(\S+)\s.*?\s(\d{6,})\s+(\S+@\S+)\s+(\S+)$/.exec(line)
      if (match?.[1] === key) return Number(match[2])
    }
    throw new Error('Explicit fixture actor missing')
  }
  const attach = async (name: string, profile: string): Promise<Device> =>
    await daemon.attach({
      device: name,
      platform: 'web',
      driver: 'cdp',
      url: WEB,
      artifacts: 'on-failure',
      extra: {
        browser: await puppeteer.executablePath(),
        windowSize: '1440x1000',
        userDataDir: profile
      }
    })
  const own = await attach(
    'chat-ui-adult-fixture-owner',
    required('CHAT_UI_PROFILE_DIR')
  )
  const peer = await attach(
    'chat-ui-adult-fixture-peer',
    required('CHAT_UI_PEER_PROFILE_DIR')
  )
  const read = async <T>(device: Device, script: string): Promise<T> => {
    const result = (await device.evalBrowserScript({ script })) as {
      data: unknown
    }
    return (
      typeof result.data === 'string' ? JSON.parse(result.data) : result.data
    ) as T
  }
  const api = `async function get(path){const r=await fetch(${JSON.stringify(API)}+path,{credentials:'include'});if(!r.ok)throw new Error('Normal fixture metadata unavailable');return await r.json()}`
  const send = async (
    device: Device,
    id: string,
    body: string
  ): Promise<string> => {
    const before = await read<number>(
      device,
      `${api};return (await get('/chat/conversations')).find(c=>c.id===${JSON.stringify(id)}).lastSeq`
    )
    assert(
      await read<boolean>(
        device,
        'return JSON.stringify(document.querySelector("[data-testid=\\"chat-composer\\"]").value==="")'
      ),
      'Fixture preparation must not overwrite an existing draft'
    )
    await device.tapOn({ css: '[data-testid="chat-composer"]' })
    await device.inputText({ text: body })
    await device.tapOn({ text: 'Send' })
    return await read<string>(
      device,
      `${api};for(let n=0;n<150;n++){const posts=(await get('/chat/conversations/'+${JSON.stringify(id)}+'/messages?after='+${before})).filter(p=>p.kind==='post');if(posts.length){if(posts.length!==1)throw new Error('Normal fixture Send must create exactlyone post');const row=document.querySelector('[data-testid="chat-message-'+posts[0].id+'"]');if(row&&row.textContent.includes(${JSON.stringify(body)})&&document.querySelector('[data-testid="chat-composer"]').value==='')return JSON.stringify(posts[0].id)}await new Promise(r=>setTimeout(r,100))}throw new Error('Normal fixture post not acknowledged')`
    )
  }
  try {
    await signIn(own, actor)
    await signIn(peer, peerActor)
    await own.openLink({ link: WEB + '/chat' })
    await own.assertVisible({ text: 'New message', timeout: 60000 })
    const before = await read<string[]>(
      own,
      `${api};return JSON.stringify((await get('/chat/conversations')).map(c=>c.id))`
    )
    const candidate = await read<{ shortName: string } | null>(
      own,
      `${api};return JSON.stringify((await get('/chat/dm-candidates?q=')).find(p=>Number(p.userId)===${uid(peerActor)})??null)`
    )
    assert(
      candidate != null,
      'Assigned adult must be a normal eligible candidate'
    )
    await own.tapOn({ text: 'New message' })
    await own.tapOn({
      css:
        '[role="button"][aria-label=' +
        JSON.stringify('Pick ' + candidate.shortName) +
        ']'
    })
    await own.tapOn({ text: 'Start conversation' })
    await own.assertVisible({
      css: '[data-testid="chat-composer"]',
      timeout: 60000
    })
    const conversationId = await read<string>(
      own,
      'return JSON.stringify(location.pathname.split("/")[2])'
    )
    assert(
      conversationId.startsWith('cnv_') && !before.includes(conversationId),
      'A new normal DM is required'
    )
    const members = await read<number[]>(
      own,
      `${api};return JSON.stringify((await get('/chat/conversations/'+${JSON.stringify(conversationId)}+'/members')).map(m=>Number(m.userId)).sort((a,b)=>a-b))`
    )
    assert.deepEqual(
      members,
      [uid(actor), uid(peerActor)].sort((a, b) => a - b),
      'Exact two-adult membership required'
    )
    Object.assign(prepared, {
      conversationId,
      actorUserId: uid(actor),
      peerUserId: uid(peerActor),
      normalMembership: true
    })
    checkpoint()
    const originalBody = 'Adult fixture original ' + Date.now()
    Object.assign(prepared, { originalBody, attemptedOriginalSend: true })
    checkpoint()
    const originalId = await send(own, conversationId, originalBody)
    Object.assign(prepared, { originalId })
    checkpoint()
    await peer.openLink({ link: WEB + '/chat/' + conversationId })
    await peer.assertVisible({ text: originalBody, timeout: 60000 })
    await peer.evalBrowserScript({
      script: `const row=document.querySelector('[data-testid="chat-message-${originalId}"]');row.scrollIntoView({block:'center'});row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
    })
    await peer.tapOn({
      css: `[data-testid="chat-message-${originalId}"] [aria-label="Reply"]`
    })
    const replyBody = 'Incoming adult reply ' + Date.now()
    Object.assign(prepared, { replyBody, attemptedPeerReplySend: true })
    checkpoint()
    const replyId = await send(peer, conversationId, replyBody)
    Object.assign(prepared, { replyId })
    checkpoint()
    await own.assertVisible({ text: replyBody, timeout: 60000 })
    let other = await read<{ id: string; title: string } | null>(
      own,
      `${api};for(const chat of await get('/chat/conversations')){if(chat.id===${JSON.stringify(conversationId)}||!chat.canPost||chat.closed||chat.locked||chat.noHolder||chat.lastSeq!==0)continue;const members=await get('/chat/conversations/'+chat.id+'/members');if(members.some(m=>Number(m.userId)===${uid(peerActor)}))return JSON.stringify({id:chat.id,title:chat.title})}return null`
    )
    if (other == null) {
      await own.openLink({ link: WEB + '/chat/new' })
      await own.tapOn({
        css:
          '[role="button"][aria-label=' +
          JSON.stringify('Pick ' + candidate.shortName) +
          ']',
        timeout: 30000
      })
      await own.tapOn({ text: 'Start conversation' })
      await own.assertVisible({
        css: '[data-testid="chat-composer"]',
        timeout: 60000
      })
      const id = await read<string>(
        own,
        'return JSON.stringify(location.pathname.split("/")[2])'
      )
      assert(
        id.startsWith('cnv_') && id !== conversationId && !before.includes(id),
        'A separate new ordinary scope is required'
      )
      const secondMembers = await read<number[]>(
        own,
        `${api};return JSON.stringify((await get('/chat/conversations/'+${JSON.stringify(id)}+'/members')).map(m=>Number(m.userId)).sort((a,b)=>a-b))`
      )
      assert.deepEqual(
        secondMembers,
        members,
        'Second normal adult room must have the same eligible pair'
      )
      other = { id, title: candidate.shortName }
    }
    await own.openLink({ link: WEB + '/chat/' + other.id })
    await own.assertVisible({
      css: '[data-testid="chat-composer"]',
      timeout: 60000
    })
    const navigationBody = 'Adult navigation notes ' + Date.now()
    Object.assign(prepared, {
      otherConversationId: other.id,
      otherTitle: other.title,
      otherBody: navigationBody,
      attemptedNavigationSend: true
    })
    checkpoint()
    const navigationId = await send(own, other.id, navigationBody)
    Object.assign(prepared, { otherMessageId: navigationId })
    checkpoint()
    await peer.openLink({ link: WEB + '/chat/' + other.id })
    await peer.assertVisible({ text: navigationBody, timeout: 60000 })
    await peer.evalBrowserScript({
      script: `const row=document.querySelector('[data-testid="chat-message-${navigationId}"]');row.scrollIntoView({block:'center'});row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
    })
    await peer.tapOn({
      css: `[data-testid="chat-message-${navigationId}"] [aria-label="Reply"]`
    })
    const navigationReplyBody = 'Adult navigation reply ' + Date.now()
    Object.assign(prepared, {
      otherReplyBody: navigationReplyBody,
      attemptedNavigationReplySend: true
    })
    checkpoint()
    const navigationReplyId = await send(peer, other.id, navigationReplyBody)
    await own.assertVisible({ text: navigationReplyBody, timeout: 60000 })
    writeFileSync(
      output,
      JSON.stringify(
        {
          conversationId,
          actorUserId: uid(actor),
          peerUserId: uid(peerActor),
          originalId,
          originalBody,
          replyId,
          replyBody,
          otherConversationId: other.id,
          otherTitle: other.title,
          otherMessageId: navigationId,
          otherBody: navigationBody,
          otherReplyId: navigationReplyId,
          otherReplyBody: navigationReplyBody,
          normalUi: true,
          normalMembership: true,
          encryptedPosts: true,
          complete: true
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
    console.log(
      'NEW ordinary two-adult DM, incoming reply and separate readable scope READY; identities/protected originals unchanged'
    )
  } finally {
    await own.detach()
    await peer.detach()
  }
}

async function videoFixture(daemon: Daemon): Promise<void> {
  const history = JSON.parse(
    readFileSync(required('CHAT_UI_HISTORY_FIXTURE_FILE'), 'utf8')
  ) as { conversationId: string }
  const m = await daemon.attach({
    device: 'chat-ui-video-fixture',
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
    await m.openLink({ link: `${WEB}/chat/${history.conversationId}` })
    await m.assertVisible({
      css: '[data-testid="chat-composer"]',
      timeout: 60000
    })
    const before = (await m.evalBrowserScript({
      script: `const r=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});if(!r.ok)throw new Error('Video fixture scope unavailable');return (await r.json()).find(c=>c.id===${JSON.stringify(history.conversationId)}).lastSeq`
    })) as { data?: unknown }
    const sequence = Number(before.data)
    assert(Number.isInteger(sequence))
    await m.evalBrowserScript({
      script: `window.chatUiVideoInputClick=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type==='file'){this.style.display='block';return}return window.chatUiVideoInputClick.call(this)};return true`
    })
    await m.tapOn({ text: 'Attach' })
    await m.uploadFile({
      css: 'input[type="file"]',
      path: required('CHAT_UI_VIDEO_FILE')
    })
    await m.assertVisible({ text: 'Remove practice-clip.mp4', timeout: 30000 })
    const caption = `Practice video ${Date.now()}`
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: caption })
    await m.tapOn({ text: 'Send' })
    const result = (await m.evalBrowserScript({
      script: `for(let n=0;n<150;n++){const r=await fetch(${JSON.stringify(API + '/chat/conversations/' + history.conversationId + '/messages?after=')}+${sequence},{credentials:'include'});if(!r.ok)throw new Error('Video acknowledgment unavailable');const posts=(await r.json()).filter(p=>p.kind==='post');if(posts.length){if(posts.length!==1)throw new Error('Video Send must make exactlyone post');const row=document.querySelector('[data-testid="chat-message-'+posts[0].id+'"]');if(row&&row.textContent.includes(${JSON.stringify(caption)})&&row.querySelector('[aria-label="Open practice-clip.mp4"]')&&document.querySelector('[data-testid="chat-composer"]').value==='')return JSON.stringify({conversationId:${JSON.stringify(history.conversationId)},videoMessageId:posts[0].id,videoCaption:${JSON.stringify(caption)},fileName:'practice-clip.mp4',contentType:'video/mp4',normalAttachAndSend:true,encryptedPost:true})}await new Promise(r=>setTimeout(r,100))}throw new Error('Video fixture did not render its decrypted thumbnail')`
    })) as { data?: unknown }
    assert.equal(typeof result.data, 'string')
    writeFileSync(
      required('CHAT_UI_VIDEO_FIXTURE_RESULT'),
      result.data as string,
      { mode: 0o600 }
    )
    console.log(
      'NEW normal encrypted video fixture READY; existing protected messages unchanged'
    )
  } finally {
    await m
      .evalBrowserScript({
        script: `if(window.chatUiVideoInputClick)HTMLInputElement.prototype.click=window.chatUiVideoInputClick;return true`
      })
      .catch(() => undefined)
    await m.detach()
  }
}

/** Refresh only the reply used by live tests; the protected original stays intact. */
async function currentHistoryReply(daemon: Daemon): Promise<void> {
  const original = JSON.parse(
    readFileSync(required('CHAT_UI_HISTORY_FIXTURE_FILE'), 'utf8')
  ) as {
    conversationId: string
    originalId: string
    originalBody: string
    replyId: string
  }
  const m = await daemon.attach({
    device: 'chat-ui-current-history-reply',
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
  const selector = `[data-testid="chat-message-${original.originalId}"]`
  const api = `const path=${JSON.stringify(API + '/chat/conversations/' + original.conversationId)};async function get(url){const r=await fetch(url,{credentials:'include'});if(!r.ok)throw new Error('Owned history metadata unavailable');return r.json()}`
  try {
    await signIn(m, 'Hc')
    await m.openLink({ link: `${WEB}/chat/${original.conversationId}` })
    await m.assertVisible({
      css: '[data-testid="chat-composer"]',
      timeout: 60000
    })
    for (let count = 0; count < 20; count += 1) {
      const result = (await m.evalBrowserScript({
        script: `for(let n=0;n<120;n++){if(document.querySelector(${JSON.stringify(selector)}))return 'found';const earlier=[...document.querySelectorAll('[role="button"]')].find(n=>n.getAttribute('aria-label')==='Load earlier messages'||n.textContent.trim()==='Load earlier messages');if(earlier){const pane=document.querySelector('[data-testid="chat-message-pane"]'),scroll=[...pane.querySelectorAll('div')].find(n=>getComputedStyle(n).overflowY==='auto');scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-1}));earlier.scrollIntoView({block:'center'});earlier.setAttribute('data-chat-current-earlier','true');await new Promise(r=>setTimeout(r,300));return 'page'}await new Promise(r=>setTimeout(r,100))}throw new Error('Protected original is unavailable before current-reply setup')`
      })) as { data?: unknown }
      if (result.data === 'found') break
      await m.tapOn({ css: '[data-chat-current-earlier="true"]' })
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    await m.evalBrowserScript({
      script: `const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Protected original did not load');const pane=document.querySelector('[data-testid="chat-message-pane"]'),scroll=[...pane.querySelectorAll('div')].find(n=>getComputedStyle(n).overflowY==='auto');scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1}));node.scrollIntoView({block:'center'});node.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
    })
    await m.tapOn({ css: selector + ' [aria-label="Reply"]' })
    await m.assertVisible({ text: 'Cancel reply' })
    const before = (await m.evalBrowserScript({
      script: `${api}return (await get(${JSON.stringify(API + '/chat/conversations')})).find(c=>c.id===${JSON.stringify(original.conversationId)}).lastSeq`
    })) as { data?: unknown }
    const seq = Number(before.data)
    assert(Number.isInteger(seq), 'Current sequence required')
    const body = `Current history reply ${Date.now()}`
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: body })
    await m.tapOn({ text: 'Send' })
    const posted = (await m.evalBrowserScript({
      script: `${api}for(let n=0;n<100;n++){const rows=await get(path+'/messages?after='+${seq}),posts=rows.filter(r=>r.kind==='post');if(posts.length){if(posts.length!==1)throw new Error('Current reply must create exactly one post');return JSON.stringify({replyId:posts[0].id,replyBody:${JSON.stringify(body)},targetOriginalUnchanged:true,normalUi:true})}await new Promise(r=>setTimeout(r,100))}throw new Error('Current history reply was not acknowledged')`
    })) as { data?: unknown }
    assert.equal(typeof posted.data, 'string')
    const current = JSON.parse(posted.data as string) as {
      replyId: string
      replyBody: string
    }
    await m.evalBrowserScript({
      script: `for(let n=0;n<100;n++){const row=document.querySelector('[data-testid="chat-message-'+${JSON.stringify(current.replyId)}+'"]');if(row&&row.textContent.includes(${JSON.stringify(body)})&&row.querySelector('[aria-label^="Jump to message from "]')&&document.querySelector('[data-testid="chat-composer"]').value==='')return true;await new Promise(r=>setTimeout(r,100))}throw new Error('Current reply plaintext/quote did not render')`
    })
    writeFileSync(
      required('CHAT_UI_CURRENT_HISTORY_REPLY_RESULT'),
      JSON.stringify(
        { ...original, ...current, previousReplyId: original.replyId },
        null,
        2
      ),
      { mode: 0o600 }
    )
    console.log(
      'NEW normal encrypted current reply READY; protected original/file/old reply unchanged'
    )
  } finally {
    await m.detach()
  }
}

/** Repeatable live-purge fixture: only new normal encrypted posts are deleted. */
async function purgeFixture(daemon: Daemon, deleting: boolean): Promise<void> {
  const fixtureFile = required('CHAT_UI_PURGE_FIXTURE_FILE')
  const conversationId = required('CHAT_UI_PURGE_CONVERSATION')
  const m = await daemon.attach({
    device: 'chat-ui-owned-purge',
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
  const row = (id: string): string => `[data-testid="chat-message-${id}"]`
  const api = `const api=${JSON.stringify(API)},id=${JSON.stringify(conversationId)};async function get(path){const r=await fetch(api+path,{credentials:'include'});if(!r.ok)throw new Error('Owned metadata unavailable');return await r.json()}const path='/chat/conversations/'+encodeURIComponent(id);`
  const data = async <T>(script: string): Promise<T> => {
    const result = (await m.evalBrowserScript({ script })) as { data?: unknown }
    if (typeof result.data === 'string') {
      try {
        return JSON.parse(result.data) as T
      } catch {
        return result.data as T
      }
    }
    return result.data as T
  }
  const send = async (body: string): Promise<string> => {
    const before = await data<number>(
      `${api}return (await get('/chat/conversations')).find(c=>c.id===id).lastSeq`
    )
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    await m.inputText({ text: body })
    await m.tapOn({ text: 'Send' })
    return await data<string>(
      `${api}for(let n=0;n<120;n++){const rows=await get(path+'/messages?after='+${before});const posts=rows.filter(r=>r.kind==='post');if(posts.length){if(posts.length!==1)throw new Error('One normal Send must create exactlyone post');return posts[0].id}await new Promise(r=>setTimeout(r,100))}throw new Error('Owned post not acknowledged')`
    )
  }
  const more = async (id: string): Promise<void> => {
    await m.evalBrowserScript({
      script: `document.querySelector(${JSON.stringify(row(id))}).scrollIntoView({block:'center'});return true`
    })
    await m.tapOn({ css: row(id) })
    await m.tapOn({ css: row(id) + ' [aria-label="More message actions"]' })
  }
  try {
    await signIn(m, 'Hc')
    await m.openLink({ link: `${WEB}/chat/${conversationId}` })
    await m.assertVisible({
      css: '[data-testid="chat-composer"]',
      timeout: 60000
    })
    const authorUserId = await data<number>(
      `${api}return Number((await get('/auth/me')).id)`
    )
    if (!deleting) {
      console.log(
        '$ Normal Hc UI creates new original/selfreply and personalPin for live deletion; protected originals unchanged'
      )
      const originalBody = `Temporary purge note ${Date.now()}`
      const originalId = await send(originalBody)
      await m.assertVisible({ css: row(originalId), timeout: 30000 })
      await m.tapOn({ css: row(originalId) })
      await m.tapOn({ css: row(originalId) + ' [aria-label="Reply"]' })
      const selfReplyBody = `Temporary reply note ${Date.now()}`
      const selfReplyId = await send(selfReplyBody)
      await more(originalId)
      await m.tapOn({ text: 'Pin' })
      await data(
        `${api}for(let n=0;n<100;n++){if((await get(path+'/pins')).some(p=>p.messageId===${JSON.stringify(originalId)}))return true;await new Promise(r=>setTimeout(r,100))}throw new Error('PersonalPin not acknowledged')`
      )
      writeFileSync(
        fixtureFile,
        JSON.stringify(
          {
            synthetic: true,
            conversationId,
            originalId,
            originalBody,
            selfReplyId,
            selfReplyBody,
            authorUserId,
            preparePersonalPin: true,
            pinnedBeforeDelete: true,
            messageId: selfReplyId,
            bodyStub: selfReplyBody,
            normalUi: true
          },
          null,
          2
        )
      )
      console.log('Fresh owned purge fixture READY; no deletion performed')
    } else {
      const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8')) as {
        synthetic: boolean
        conversationId: string
        originalId: string
        authorUserId: number
        attemptedDelete?: boolean
      }
      assert(
        fixture.synthetic &&
          fixture.conversationId === conversationId &&
          fixture.authorUserId === authorUserId,
        'Explicit same-author synthetic fixture required'
      )
      assert(
        fixture.originalId !== required('CHAT_UI_MESSAGE'),
        'Protected original cannot be deleted'
      )
      const protectedMessages: unknown = JSON.parse(
        required('CHAT_UI_PROTECTED_MESSAGE_IDS')
      )
      assert(
        Array.isArray(protectedMessages) &&
          protectedMessages.length > 0 &&
          protectedMessages.every(id => typeof id === 'string'),
        'Explicit protected baseline message IDs required'
      )
      assert(
        !protectedMessages.includes(fixture.originalId),
        'Protected baseline post cannot be deleted'
      )
      const protectedHistory = JSON.parse(
        readFileSync(required('CHAT_UI_HISTORY_FIXTURE_FILE'), 'utf8')
      ) as Record<string, unknown>
      for (const key of [
        'originalId',
        'attachmentId',
        'attachmentReplyId',
        'replyId'
      ])
        assert.notEqual(
          fixture.originalId,
          protectedHistory[key],
          'Shared protected post cannot be deleted'
        )
      assert(
        fixture.attemptedDelete !== true,
        'Never repeat an attempted author Delete'
      )
      const signals = required('CHAT_UI_PURGE_READY_SIGNALS').split(',')
      const platforms = (
        process.env.CHAT_UI_PURGE_EXPECTED_PLATFORMS ?? 'ios,android'
      ).split(',')
      assert(
        platforms.length > 0 &&
          platforms.length <= 2 &&
          new Set(platforms).size === platforms.length &&
          platforms.every(platform => ['ios', 'android'].includes(platform)),
        'Explicit live observer platforms required'
      )
      assert.equal(signals.length, platforms.length)
      const verifyReady = (): void => {
        for (const [index, signal] of signals.entries()) {
          const ready = JSON.parse(readFileSync(signal, 'utf8')) as {
            ready?: boolean
            originalId?: string
            conversationId?: string
            platform?: string
          }
          assert(
            ready.ready === true &&
              ready.originalId === fixture.originalId &&
              ready.conversationId === conversationId &&
              ready.platform === platforms[index] &&
              Date.now() - statSync(signal).mtimeMs < 240000,
            'Exact live native observer must acknowledge with time left before Delete'
          )
        }
      }
      verifyReady()
      const before = await data<number>(
        `${api}return (await get('/chat/conversations')).find(c=>c.id===id).lastSeq`
      )
      await more(fixture.originalId)
      await m.tapOn({ text: 'Delete' })
      await m.assertVisible({
        text: 'This message will be removed for everyone.'
      })
      verifyReady()
      fixture.attemptedDelete = true
      writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2))
      await m.tapOn({ text: 'Delete' })
      console.log(
        '$ Authenticated encrypted author deletion POST kind=delete; GET wire clearedAt and GET personalpins verify disappearance'
      )
      const proof = await data<object>(
        `${api}for(let n=0;n<100;n++){const changes=await get(path+'/messages?after='+${before});const deletion=changes.find(p=>p.kind==='delete'&&p.senderUserId===${authorUserId}&&p.targetIds?.includes(${JSON.stringify(fixture.originalId)}));const all=await get(path+'/messages?limit=100&before='+(${before}+2));const target=all.find(p=>p.id===${JSON.stringify(fixture.originalId)});const pins=await get(path+'/pins');if(deletion&&target?.clearedAt&&!pins.some(p=>p.messageId===${JSON.stringify(fixture.originalId)}))return JSON.stringify({authorizedEncryptedDeletion:true,targetCleared:true,personalPinPurged:true,deletePostId:deletion.id});await new Promise(r=>setTimeout(r,100))}throw new Error('Author deletion/personalpin purge not observed')`
      )
      console.log(JSON.stringify(proof))
      writeFileSync(
        fixtureFile + '.deleted.json',
        JSON.stringify(proof, null, 2)
      )
    }
  } finally {
    await m.detach()
  }
}

async function coarseTouch(daemon: Daemon): Promise<void> {
  const m = await daemon.attach({
    device: 'chat-ui-actual-coarse-touch',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: await puppeteer.executablePath(),
      windowSize: '390x844',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  try {
    await signIn(m, 'Hs')
    await m.openLink({ link: WEB + '/chat' })
    await m.assertVisible({ text: 'Team Members', timeout: 60000 })
    console.log(
      '$ Actual Chrome raw TouchEvent list movement>10px cancels row hold and release navigation; no nativeEvent.pageX shortcut'
    )
    console.log(
      await m.evalBrowserScript({
        script: `const row=document.querySelector('[role="button"][aria-label="Hawks Members"]');row.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,250));const rect=row.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;function event(type,dx,end=false){const touch=new Touch({identifier:1,target:row,clientX:x+dx,clientY:y,pageX:x+dx+scrollX,pageY:y+scrollY,screenX:x+dx,screenY:y});row.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:end?[]:[touch],targetTouches:end?[]:[touch],changedTouches:[touch]}));}event('touchstart',0);await new Promise(r=>setTimeout(r,250));event('touchmove',11);await new Promise(r=>setTimeout(r,350));event('touchend',11,true);row.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));row.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x+11,clientY:y}));await new Promise(r=>setTimeout(r,200));if(document.querySelector('[aria-label="Conversation actions"]:not([role="button"])'))throw new Error('Moved touch opened conversation menu');if(getComputedStyle(document.querySelector('[data-testid="chat-list-pane"]')).display==='none'||document.querySelector('[data-testid="chat-composer"]'))throw new Error('Moved touch opened row');return JSON.stringify({rawBrowserTouchMovementCancelled:true,noMenu:true,noRowNavigation:true})`
      })
    )
    await m.tapOn({ css: '[role="button"][aria-label="Hawks Members"]' })
    await m.assertVisible({
      text: required('CHAT_UI_TARGET_TEXT'),
      timeout: 60000
    })
    await m.evalBrowserScript({
      script: `const original=window.matchMedia.bind(window);window.matchMedia=q=>q.includes('pointer')&&q.includes('fine')?new Proxy(original(q),{get(t,k){if(k==='matches')return false;const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v}}):original(q);return true`
    })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Mark unread' })
    await m.pressKey({ key: 'Escape' })
    console.log(
      '$ Actual Chrome coarse media + rawTouchEvent bubble500ms recognizes exactly one menu'
    )
    await m.evalBrowserScript({
      script: `const bubble=document.querySelector(${JSON.stringify('[data-testid="chat-message-' + required('CHAT_UI_MESSAGE') + '"] [tabindex="0"]')});bubble.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,300));const r=bubble.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,t=new Touch({identifier:2,target:bubble,clientX:x,clientY:y,pageX:x+scrollX,pageY:y+scrollY,screenX:x,screenY:y});bubble.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:true,touches:[t],targetTouches:[t],changedTouches:[t]}));await new Promise(r=>setTimeout(r,550));bubble.dispatchEvent(new TouchEvent('touchend',{bubbles:true,cancelable:true,touches:[],targetTouches:[],changedTouches:[t]}));bubble.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true`
    })
    await m.assertVisible({ text: 'Copy' })
    await m.assertVisible({ text: 'Reply' })
    await m.pressKey({ key: 'Escape' })
    console.log(
      'Actual Chrome coarse touch row cancellation and message hold PASS'
    )
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
      scenario === 'S4full' ||
      scenario === 'bands' ||
      scenario === 'pendingSend' ||
      scenario === 'reviewNavigation' ||
      scenario === 'review2Browser' ||
      scenario === 'arrivalPeer' ||
      scenario === 'historyFixture' ||
      scenario === 'composeFull' ||
      scenario === 'picker' ||
      scenario === 'reader' ||
      scenario === 'lockedCurrentReply' ||
      scenario === 'lockedPrepare' ||
      scenario === 'lockedReset' ||
      scenario === 'lockedApprove' ||
      scenario === 'maappOn' ||
      scenario === 'maappOff' ||
      scenario === 'disposablePrepare' ||
      scenario === 'disposableDelete' ||
      scenario === 'coarseTouch' ||
      scenario === 'purgePrepare' ||
      scenario === 'purgeDelete' ||
      scenario === 'currentHistoryReply' ||
      scenario === 'videoFixture' ||
      scenario === 'adultReplyFixture' ||
      scenario === 'boundedMedia' ||
      scenario === 'S5' ||
      scenario === 'S6' ||
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
    else if (scenario === 'S4full') await s4Full(daemon)
    else if (scenario === 'bands') await bands(daemon)
    else if (scenario === 'pendingSend') await pendingSend(daemon)
    else if (scenario === 'reviewNavigation') await reviewNavigation(daemon)
    else if (scenario === 'review2Browser') await review2Browser(daemon)
    else if (scenario === 'arrivalPeer') await arrivalPeer(daemon)
    else if (scenario === 'historyFixture') await historyFixture(daemon)
    else if (scenario === 'composeFull') await composeFull(daemon)
    else if (scenario === 'picker') await picker(daemon)
    else if (scenario === 'reader') await reader(daemon)
    else if (scenario === 'lockedCurrentReply') await lockedCurrentReply(daemon)
    else if (scenario === 'lockedPrepare')
      await lockedProvider(daemon, 'prepare')
    else if (scenario === 'lockedReset') await lockedProvider(daemon, 'reset')
    else if (scenario === 'lockedApprove')
      await lockedProvider(daemon, 'approve')
    else if (scenario === 'maappOn') await maappToggle(daemon, true)
    else if (scenario === 'maappOff') await maappToggle(daemon, false)
    else if (scenario === 'disposablePrepare') await disposablePrepare(daemon)
    else if (scenario === 'disposableDelete') await disposableDelete(daemon)
    else if (scenario === 'coarseTouch') await coarseTouch(daemon)
    else if (scenario === 'purgePrepare') await purgeFixture(daemon, false)
    else if (scenario === 'purgeDelete') await purgeFixture(daemon, true)
    else if (scenario === 'currentHistoryReply')
      await currentHistoryReply(daemon)
    else if (scenario === 'videoFixture') await videoFixture(daemon)
    else if (scenario === 'adultReplyFixture') await adultReplyFixture(daemon)
    else if (scenario === 'boundedMedia') await boundedMedia(daemon)
    else if (scenario === 'S5') await s5(daemon)
    else if (scenario === 'S6') await s6(daemon)
    else await s9(daemon, scenario === 'S10')
  } finally {
    await daemon.shutdown({ wait: true })
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
