/**
 * Functions the browser scenario hands to Puppeteer.
 *
 * They stay in plain JavaScript so the page receives this source. The
 * scenario file is compiled, and a compiled optional chain does not exist
 * in the page.
 */

function buttonEnabled(label) {
  return [...document.querySelectorAll('[role="button"]')].some(
    function (node) {
      return (
        node.textContent === label &&
        node.getAttribute('aria-disabled') !== 'true'
      )
    }
  )
}

function clickLabel(label) {
  const node = [...document.querySelectorAll('[role="button"]')].find(
    function (item) {
      return item.textContent === label
    }
  )
  if (node) node.click()
}

function clickCreate() {
  const node = [...document.querySelectorAll('[role="button"]')].find(
    function (item) {
      return item.textContent === 'Create a stream URL'
    }
  )
  if (node) node.click()
}

function bodyHas(needle) {
  const text =
    document.body.textContent == null ? '' : document.body.textContent
  return text.indexOf(needle) !== -1
}

function bodyText() {
  return document.body.textContent == null ? '' : document.body.textContent
}

function endOnCard(name) {
  const buttons = [...document.querySelectorAll('[role="button"]')].filter(
    function (node) {
      return node.textContent === 'End stream'
    }
  )
  for (let i = 0; i < buttons.length; i++) {
    const button = buttons[i]
    let node = button.parentElement
    while (node != null && node !== document.body) {
      const ends = [...node.querySelectorAll('[role="button"]')].filter(
        function (item) {
          return item.textContent === 'End stream'
        }
      )
      const text = node.textContent == null ? '' : node.textContent
      if (text.indexOf(name) !== -1 && ends.length === 1) {
        button.click()
        return true
      }
      node = node.parentElement
    }
  }
  return false
}

function preparePhone() {
  const field = document.querySelector('[aria-label="Camera name"]')
  if (field != null && field.scrollIntoView) field.scrollIntoView()
  const node = [...document.querySelectorAll('[role="button"]')].find(
    function (item) {
      return item.textContent === 'Create a stream URL'
    }
  )
  if (node) node.click()
}

module.exports = {
  bodyHas,
  bodyText,
  buttonEnabled,
  clickCreate,
  clickLabel,
  endOnCard,
  preparePhone
}
