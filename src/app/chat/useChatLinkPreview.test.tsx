import { setTimeout as delay } from 'node:timers/promises'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { AttachmentRef } from '../../common/chatContent'
import type { ChatLinkPreview } from '../../common/chatLinkPreview'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatLinkPreviewCard } from './ChatLinkPreviewCard'
import type * as PreviewTransport from './previewTransport'
import type { ChatScreenEngine } from './screenEngine'
import { useChatLinkPreview } from './useChatLinkPreview'

const transport: typeof PreviewTransport = {
  readPreviewPage: async () => '',
  previewThumbnail: async () => undefined
}
const ref: AttachmentRef = {
  fileName: 'preview.jpg',
  contentType: 'image/jpeg',
  size: 3,
  width: 2,
  height: 1,
  id: 'cat_image',
  key: 'key',
  digest: 'digest'
}
let root: Root | undefined
let host: HTMLElement
let latest: ReturnType<typeof useChatLinkPreview>
type PreviewEngine = Pick<ChatScreenEngine, 'uploadPreviewThumbnail'>
interface Editing {
  id: string
  preview?: ChatLinkPreview
}

async function show(
  engine: PreviewEngine,
  body: string,
  room = 'c1',
  editing?: Editing,
  active = true
): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <Draft
        engine={engine}
        body={body}
        room={room}
        editing={editing}
        active={active}
      />
    )
  })
}
function Draft({
  engine,
  body,
  room,
  editing,
  active
}: {
  engine: PreviewEngine
  body: string
  room: string
  editing?: Editing
  active: boolean
}): React.ReactElement {
  latest = useChatLinkPreview(
    engine,
    room,
    editing,
    body,
    active,
    undefined,
    transport
  )
  return (
    <ThemeProvider>
      {latest.preview != null && (
        <ChatLinkPreviewCard
          preview={latest.preview}
          onDismiss={latest.handleDismiss}
        />
      )}
    </ThemeProvider>
  )
}
async function settled(): Promise<void> {
  await act(async () => {
    await delay(450)
  })
}
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  host?.remove()
  transport.readPreviewPage = async () => ''
  transport.previewThumbnail = async () => undefined
})

describe('chat link preview drafts', function () {
  this.timeout(8000)
  const url = 'https://example.org/team'
  it('keeps ready data and dismissal per draft and clears it after delivery', async () => {
    let reads = 0
    transport.readPreviewPage = async () => {
      reads++
      return '<title>Schedule</title>'
    }
    const engine = {}
    await show(engine, url)
    expect(latest.preview).equals(undefined)
    await settled()
    expect(host.textContent).contains('Schedule')
    expect(latest.submit('new wording ' + url)?.title).equals('Schedule')
    expect(latest.submit('no link')).equals(undefined)
    await show(engine, '', 'c2')
    await show(engine, url)
    expect(latest.preview?.title).equals('Schedule')
    await act(async () => {
      host
        .querySelector<HTMLElement>('[aria-label="Remove link preview"]')!
        .click()
    })
    expect(latest.preview).equals(undefined)
    expect(latest.submit(url)).equals(undefined)
    await show(engine, url, 'c1', { id: 'edit1' })
    await settled()
    expect(latest.preview?.title).equals('Schedule')
    await show(engine, url)
    expect(latest.preview).equals(undefined)
    expect(reads).equals(2)
    latest.sent()
    await show(engine, '')
    await show(engine, url)
    await settled()
    expect(latest.preview?.title).equals('Schedule')
    expect(reads).equals(3)
  })
  it('ignores late and canceled reads, sends immediately and uses only the active account', async () => {
    let deliver: ((html: string) => void) | undefined
    transport.readPreviewPage = async () =>
      await new Promise(resolve => {
        deliver = resolve
      })
    const first = {}
    await show(first, url)
    await settled()
    expect(deliver).not.equals(undefined)
    const stale = deliver!
    expect(latest.submit(url)).equals(undefined)
    const second = {}
    await show(second, url)
    await act(async () => {
      stale('<title>Old account</title>')
    })
    expect(latest.preview).equals(undefined)
    await settled()
    await act(async () => {
      deliver!('<title>Second account</title>')
    })
    expect(latest.preview?.title).equals('Second account')
    await show(second, 'https://example.net/new')
    expect(latest.preview).equals(undefined)
  })
  it('sends available text during upload and drops the thumbnail after 23 hours', async () => {
    let finish: ((value: AttachmentRef) => void) | undefined
    transport.readPreviewPage = async () =>
      '<title>Fixture</title><meta property="og:image" content="thumb.jpg">'
    transport.previewThumbnail = async () => ({
      fileName: ref.fileName,
      contentType: ref.contentType,
      bytes: Uint8Array.of(1, 2, 3)
    })
    const engine: PreviewEngine = {
      uploadPreviewThumbnail: async () =>
        await new Promise(resolve => {
          finish = resolve
        })
    }
    await show(engine, url)
    await settled()
    expect(latest.preview?.title).equals('Fixture')
    expect(latest.preview?.thumbnail).equals(undefined)
    await act(async () => {
      finish!(ref)
    })
    expect(latest.preview?.thumbnail).equals(ref)
    const now = Date.now
    try {
      Date.now = () => now() + 24 * 60 * 60 * 1000
      expect(latest.submit(url)).deep.equals({
        url,
        title: 'Fixture',
        siteName: 'example.org',
        description: ''
      })
    } finally {
      Date.now = now
    }
  })
  it("keeps an edited message's card until the new wording settles its own", async () => {
    const kept = {
      url,
      title: 'Original',
      description: '',
      siteName: 'example.org',
      thumbnail: ref
    }
    const site: { page?: string } = {}
    transport.readPreviewPage = async () => {
      if (site.page == null) throw new Error('Blocked')
      return site.page
    }
    const engine = {}
    const typo = { id: 'edit2', preview: kept }
    await show(engine, 'Fixed typo ' + url, 'c1', typo)
    expect(latest.preview).equals(kept)
    expect(latest.submit('Fixed typo ' + url)).equals(kept)
    await settled()
    expect(latest.submit('Fixed typo ' + url)).equals(kept)
    expect(latest.submit('Elsewhere https://example.net/x')).equals(undefined)
    await act(async () => {
      host
        .querySelector<HTMLElement>('[aria-label="Remove link preview"]')!
        .click()
    })
    expect(latest.preview).equals(undefined)
    expect(latest.submit('Fixed typo ' + url)).equals(undefined)
    site.page = '<title>Regenerated</title>'
    await show(engine, url, 'c1', { id: 'edit3', preview: kept })
    expect(latest.preview).equals(kept)
    await settled()
    expect(latest.preview?.title).equals('Regenerated')
    expect(latest.submit(url)?.title).equals('Regenerated')
  })
  it('resumes an interrupted thumbnail without reading the page again', async () => {
    let reads = 0
    let images = 0
    let hold: AbortSignal | undefined
    transport.readPreviewPage = async () => {
      reads++
      return '<title>Fixture</title><meta property="og:image" content="thumb.jpg">'
    }
    transport.previewThumbnail = async (_, signal) => {
      images++
      if (images === 1) {
        hold = signal
        await new Promise(resolve => {
          signal.addEventListener('abort', resolve, { once: true })
        })
        return undefined
      }
      return {
        fileName: ref.fileName,
        contentType: ref.contentType,
        bytes: Uint8Array.of(1, 2, 3)
      }
    }
    const engine: PreviewEngine = {
      uploadPreviewThumbnail: async () => ref
    }
    await show(engine, url)
    await settled()
    expect(latest.preview?.title).equals('Fixture')
    expect(hold?.aborted).equals(false)
    await show(engine, url, 'c1', undefined, false)
    expect(hold?.aborted).equals(true)
    expect(latest.preview?.thumbnail).equals(undefined)
    await show(engine, url)
    await settled()
    expect(latest.preview?.thumbnail).equals(ref)
    expect(latest.submit(url)?.thumbnail).equals(ref)
    expect([reads, images]).deep.equals([1, 2])
    await show(engine, url, 'c1', undefined, false)
    await show(engine, url)
    await settled()
    expect([reads, images]).deep.equals([1, 2])
  })
  it('opens only the typed address from a received card, preserves holds and loads its encrypted thumbnail', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const opened: string[] = []
    let allowed = false
    const openedRefs: AttachmentRef[] = []
    const address = url + '#schedule'
    const preview = {
      url,
      title: 'Schedule',
      description: 'Details',
      siteName: 'Fixture',
      thumbnail: ref
    }
    const handleOpen = (value: string): void => {
      opened.push(value)
    }
    let readSignal: AbortSignal | undefined
    const load = async (
      image: AttachmentRef,
      signal: AbortSignal
    ): Promise<Uint8Array> => {
      readSignal = signal
      openedRefs.push(image)
      return Uint8Array.of(1, 2, 3)
    }
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ChatLinkPreviewCard
            preview={preview}
            address={address}
            onOpen={handleOpen}
            loadThumbnail={load}
            gesture={{ pressProps: {}, canOpen: () => allowed }}
          />
        </ThemeProvider>
      )
    })
    expect(openedRefs).deep.equals([ref])
    expect(host.innerHTML).contains('data:image/jpeg;base64,AQID')
    const link = host.querySelector<HTMLElement>('[role="link"],a')!
    expect(link.getAttribute('href')).equals(address)
    await act(async () => {
      link.click()
    })
    expect(opened).deep.equals([])
    allowed = true
    await act(async () => {
      link.click()
    })
    expect(opened).deep.equals([address])
    expect(readSignal?.aborted).equals(false)
    await act(async () => {
      root!.render(null)
    })
    expect(readSignal?.aborted).equals(true)
  })
})
