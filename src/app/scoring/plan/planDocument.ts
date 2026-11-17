import type { PlanDocumentAnchor } from './planDocumentAnchor'

const PDF = 'application/pdf'

/** Saves the PDF as a download with its own name. */
function download(bytes: Uint8Array, fileName: string, doc: Document): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: PDF }))
  const link = doc.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  doc.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 60000)
}

/**
 * Shares the game plan PDF through the browser's share sheet where it
 * shares files, and otherwise downloads it. A share the person cancels
 * does nothing more.
 */
export async function sharePlanDocument(
  bytes: Uint8Array,
  fileName: string,
  _anchor?: PlanDocumentAnchor,
  nav: Navigator = navigator,
  doc: Document = document
): Promise<void> {
  const file = new File([bytes], fileName, { type: PDF })
  if (nav.canShare?.({ files: [file] }))
    try {
      await nav.share({ files: [file], title: fileName.replace(/\.pdf$/, '') })
      return
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
    }
  download(bytes, fileName, doc)
}

/** The frame the last print loaded, kept until the next print. */
let printed: { frame: HTMLIFrameElement; url: string } | undefined

/**
 * Whether the browser can show a PDF in a frame and print it from there:
 * not one with no PDF viewer of its own (Chrome on Android, or a desktop
 * browser set to download PDFs), and not Safari on an iPhone or iPad, which
 * prints the page around a frame rather than the frame.
 */
function printsFrames(nav: Navigator): boolean {
  // Only a browser that says it has no viewer is believed: older ones do
  // not say.
  const viewer: boolean | undefined = (nav as { pdfViewerEnabled?: boolean })
    .pdfViewerEnabled
  if (viewer === false) return false
  const touchMac = nav.userAgent.includes('Macintosh') && nav.maxTouchPoints > 1
  return !/iPhone|iPad|iPod/.test(nav.userAgent) && !touchMac
}

/**
 * Prints the game plan PDF: the browser's own viewer loads it in a hidden
 * frame, whose print dialog then opens. A browser that cannot print it that
 * way hands it to the system's share sheet instead, whose Print prints it
 * (or downloads it, where the browser shares no files). It settles once the frame has loaded
 * and been asked to print. A browser that will not let the page print that
 * frame (one whose viewer runs it as another origin) gets the PDF as a
 * download instead, to print from there. The frame stays for its dialog, and
 * goes when the next print comes.
 */
export async function printPlanDocument(
  bytes: Uint8Array,
  fileName: string,
  anchor?: PlanDocumentAnchor,
  nav: Navigator = navigator,
  doc: Document = document
): Promise<void> {
  if (!printsFrames(nav)) {
    await sharePlanDocument(bytes, fileName, anchor, nav, doc)
    return
  }
  if (printed != null) {
    printed.frame.remove()
    URL.revokeObjectURL(printed.url)
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: PDF }))
  const frame = doc.createElement('iframe')
  frame.title = fileName
  frame.setAttribute('aria-hidden', 'true')
  Object.assign(frame.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '0',
    height: '0',
    border: '0'
  })
  printed = { frame, url }
  await new Promise<void>(resolve => {
    frame.addEventListener(
      'load',
      () => {
        try {
          const view = frame.contentWindow
          if (view == null) throw new Error('The frame has no window')
          view.focus()
          view.print()
        } catch {
          download(bytes, fileName, doc)
        }
        resolve()
      },
      { once: true }
    )
    frame.src = url
    doc.body.appendChild(frame)
  })
}
