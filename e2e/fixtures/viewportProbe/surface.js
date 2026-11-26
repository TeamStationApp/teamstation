// Loaded only by the isolated, staged fixture. Send measurements in OPTIONS
// paths so the suite can read them from the stack's existing forwarded-request
// log even when the phone browser exposes no DOM text through accessibility.
;(() => {
  const query = new URLSearchParams(window.location.search)
  const run = query.get('run')
  const reference = window.location.pathname.endsWith('/reference.html')
  const game = query.get('game')
  if (
    !/^[a-f0-9-]{36}$/.test(run) ||
    (!reference && !/^[\w-]+$/.test(game ?? ''))
  ) {
    throw new Error('Invalid scoring viewport fixture')
  }
  if (!reference)
    window.history.replaceState(null, '', '/games/' + game + '/score')
  const documentId = crypto.randomUUID()
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;height:100svh;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);box-sizing:border-box'
  if (document.body != null) document.body.append(probe)
  else
    document.addEventListener('DOMContentLoaded', () => document.body.append(probe), {
      once: true
    })
  const rectOf = selector => {
    const rect = document.querySelector(selector)?.getBoundingClientRect()
    if (!rect) return undefined
    const { top, bottom, left, right, width, height } = rect
    return { top, bottom, left, right, width, height }
  }
  const box = id => rectOf('[data-testid="' + id + '"]')
  const matrix = query.has('geometry')
  const timer = setInterval(() => {
    if (document.hidden) return
    const root = box('scoring-viewport')
    const strip = box('scoring-notice-strip')
    const deck = box('scoring-deck')
    if (
      !reference &&
      (!root ||
        !deck ||
        !strip ||
        !document.querySelector('canvas[data-field-ready="true"]'))
    )
      return
    const viewport = window.visualViewport
    const insets = window.getComputedStyle(probe)
    const top = viewport?.offsetTop ?? 0
    const bottom = top + (viewport?.height ?? window.innerHeight)
    let exposed
    if (root && bottom > root.bottom + 2) {
      let el = document.elementFromPoint(
        window.innerWidth / 2,
        (bottom + root.bottom) / 2
      )
      while (
        el &&
        window.getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)'
      )
        el = el.parentElement
      exposed = el && window.getComputedStyle(el).backgroundColor
    }
    const data = {
      ...(matrix && {
        holder: box('scoring-field-holder'),
        face: rectOf('[data-position="C"]'),
        side: box('scoring-side'),
        boxScore: box('replay-box-score'),
        menu: rectOf('[aria-label="Open scoring menu"]'),
        logText: document.querySelector(
          '[data-testid="remote-scoring-update-lines"]'
        )?.textContent,
        undo: document
          .querySelector('[aria-label^="Undo "]')
          ?.getAttribute('aria-label'),
        collapsed: !!document.querySelector(
          '[aria-label="Expand scoring updates"]'
        ),
        landmarks: window.scoringLandmarks?.(
          Number(query.get('radius')),
          Number(query.get('angle'))
        ),
        buttons: Object.fromEntries(
          [
            'Ball',
            'Called Strike',
            'Collapse scoring updates',
            'Expand scoring updates',
            'Dismiss scoring updates',
            'Open scoring menu',
            'Set Team Rosters',
            'Cancel'
          ].map(label => [label, rectOf('[aria-label="' + label + '"]')])
        )
      }),
      documentId,
      width: window.innerWidth,
      small: probe.getBoundingClientRect().height,
      top,
      bottom,
      root,
      strip,
      deck,
      catcher: document
        .querySelector('[data-position="C"]')
        ?.getBoundingClientRect().bottom,
      log: box('remote-scoring-updates'),
      logBand: box('scoring-log-band'),
      notice: box('scoringNotice'),
      noticeText: document.querySelector('[data-testid="scoringNotice"]')
        ?.textContent,
      noticeTextBottom: document
        .querySelector('[data-testid="scoringNotice"] [aria-label]')
        ?.getBoundingClientRect().bottom,
      page: window.getComputedStyle(document.documentElement).backgroundColor,
      exposed,
      insets: [
        insets.paddingTop,
        insets.paddingRight,
        insets.paddingBottom,
        insets.paddingLeft
      ].map(parseFloat)
    }
    const channel = reference ? 'reference' : 'scoring'
    const payload = btoa(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data)))
    )
      .replaceAll('/', '_')
      .replaceAll('+', '-')
    fetch(
      '/api/v1/viewport-observation/' + run + '/' + channel + '/' + payload,
      { method: 'OPTIONS', credentials: 'omit', cache: 'no-store' }
    ).catch(() => {})
  }, 500)
  window.addEventListener('pagehide', () => clearInterval(timer), {
    once: true
  })
})()
