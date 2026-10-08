import { fonts } from '../theme/fonts'
import { nameplateColor } from './nameplateOverlay'
import {
  NAMEPLATE_FONT,
  NAMEPLATE_LINE_GAP,
  NAMEPLATE_NUMBER_FONT,
  NAMEPLATE_PAD,
  type NameplatePlacement
} from './playerPresentation'
export { nameplateColor } from './nameplateOverlay'

function plateLine(
  node: HTMLElement,
  kind: 'name' | 'number',
  fontPx: number
): HTMLElement {
  const found = node.querySelector(`[data-line="${kind}"]`)
  let line: HTMLElement
  if (found instanceof HTMLElement) {
    line = found
  } else {
    line = document.createElement('span')
    line.setAttribute('data-line', kind)
    line.style.display = 'block'
    line.style.whiteSpace = 'nowrap'
    line.style.textAlign = 'center'
    node.appendChild(line)
  }
  line.style.fontSize = `${fontPx}px`
  line.style.lineHeight = `${fontPx}px`
  line.style.fontWeight = '400'
  return line
}
/** DOM nameplates sit over the canvas in CSS pixels, so the type is the display's own. */
export function syncFieldNameplates(
  host: HTMLElement,
  plates: NameplatePlacement[]
): void {
  const live = new Set(plates.map(plate => plate.id))
  for (const child of Array.from(host.children)) {
    const id = child.getAttribute('data-nameplate')
    if (id == null || !live.has(id)) child.remove()
  }
  for (const plate of plates) {
    let node: HTMLElement | null = null
    for (const child of Array.from(host.children)) {
      if (child.getAttribute('data-nameplate') === plate.id) {
        node = child as HTMLElement
        break
      }
    }
    if (node == null) {
      node = document.createElement('div')
      node.setAttribute('data-nameplate', plate.id)
      node.style.position = 'absolute'
      node.style.pointerEvents = 'none'
      node.style.boxSizing = 'border-box'
      node.style.display = 'flex'
      node.style.flexDirection = 'column'
      node.style.alignItems = 'center'
      node.style.justifyContent = 'center'
      node.style.whiteSpace = 'nowrap'
      node.style.borderRadius = '8px'
      node.style.color = '#ffffff'
      node.style.fontFamily = fonts.spaceGrotesk
      node.style.fontWeight = '400'
      host.appendChild(node)
    }
    const name = plateLine(node, 'name', NAMEPLATE_FONT)
    if (name.textContent !== plate.name) name.textContent = plate.name
    const existingNumber = node.querySelector('[data-line="number"]')
    if (plate.number === '') existingNumber?.remove()
    else {
      const number = plateLine(node, 'number', NAMEPLATE_NUMBER_FONT)
      if (number.textContent !== plate.number) number.textContent = plate.number
    }
    node.style.padding = `${NAMEPLATE_PAD}px`
    node.style.gap = plate.number === '' ? '0' : `${NAMEPLATE_LINE_GAP}px`
    node.style.left = `${plate.x}px`
    node.style.top = `${plate.y}px`
    node.style.width = `${plate.width}px`
    node.style.height = `${plate.height}px`
    node.style.transform = `translate(${-plate.anchorX * 100}%, ${-plate.anchorY * 100}%)`
    node.style.visibility = plate.visible ? 'visible' : 'hidden'
    node.style.backgroundColor = nameplateColor(plate)
    node.style.border = plate.emptyPosition === true ? '2px dashed #d65454' : ''
    node.style.borderRadius = plate.emptyPosition === true ? '2px' : '8px'
    node.style.backgroundColor =
      plate.emptyPosition === true
        ? 'rgba(255, 190, 190, 0.22)'
        : nameplateColor(plate)
    node.style.color = plate.emptyPosition === true ? '#ffb6b6' : '#ffffff'
    node.setAttribute(
      'aria-label',
      plate.emptyPosition === true ? `Assign ${plate.name}` : plate.name
    )
  }
}
