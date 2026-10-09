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
  uploadFile: (options: { css: string; path: string }) => Promise<unknown>
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
    console.log(
      await m.evalBrowserScript({
        script: `${listScript}const compare=(a,b)=>{const at=a.lastPostAt==null?null:Date.parse(a.lastPostAt);const bt=b.lastPostAt==null?null:Date.parse(b.lastPostAt);if(at!==bt)return at==null?1:bt==null?-1:bt-at;return a.id<b.id?-1:a.id>b.id?1:0};const expected=[true,false].flatMap(pin=>['dm','group'].flatMap(kind=>chats.filter(x=>Boolean(x.preferences.pinned)===pin&&(x.kind==='dm'?'dm':'group')===kind).sort(compare)));const labels=[...document.querySelector('[data-testid="chat-list-pane"]').querySelectorAll('[role="button"][aria-label]')].map(x=>x.getAttribute('aria-label'));const rendered=labels.filter(x=>chats.some(c=>c.title===x));const ordered=expected.filter(x=>rendered.includes(x.title)).map(x=>x.title);if(rendered.length<4||JSON.stringify(rendered)!==JSON.stringify(ordered))throw new Error('Rendered four-band order disagrees with pin/kind/post/id order');const selected=${JSON.stringify(targets.map(x => x.id))};if(!selected.every(id=>rendered.includes(chats.find(x=>x.id===id).title)))throw new Error('One required band is not rendered');return JSON.stringify({fourBands:true,visibleRows:rendered.length,postRecencyOrder:true,unreadExcluded:true,viewport:innerWidth})`
      })
    )
    if (width === 320)
      console.log(
        await m.evalBrowserScript({
          script: `const pill=[...document.querySelector('[data-testid="chat-list-pane"]').querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent==='Season Announcements');if(!pill)throw new Error('Constrained scope row missing');const title=pill.parentElement.parentElement.children[0];const a=title.getBoundingClientRect(),b=pill.getBoundingClientRect();if(a.width<60)throw new Error('Organization title reduced to a sliver');if(a.top<b.bottom&&b.top<a.bottom&&a.left<b.right&&b.left<a.right)throw new Error('Title and scope pill overlap');return JSON.stringify({width:innerWidth,organizationTitleWidth:a.width,readableTitleAndScope:true,pillWraps:b.top>=a.bottom})`
        })
      )
    if (!narrow) {
      await m.tapOn({
        css:
          '[role="button"][aria-label=' + JSON.stringify(targets[1].title) + ']'
      })
      await m.assertVisible({
        text: required('CHAT_UI_TARGET_TEXT'),
        timeout: 60000
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

async function main(): Promise<void> {
  const scenario = process.argv[2]
  assert(
    scenario === 'S1' ||
      scenario === 'S2' ||
      scenario === 'S4' ||
      scenario === 'S4full' ||
      scenario === 'bands' ||
      scenario === 'historyFixture' ||
      scenario === 'composeFull' ||
      scenario === 'picker' ||
      scenario === 'reader' ||
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
    else if (scenario === 'historyFixture') await historyFixture(daemon)
    else if (scenario === 'composeFull') await composeFull(daemon)
    else if (scenario === 'picker') await picker(daemon)
    else if (scenario === 'reader') await reader(daemon)
    else if (scenario === 'S5') await s5(daemon)
    else if (scenario === 'S6') await s6(daemon)
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
