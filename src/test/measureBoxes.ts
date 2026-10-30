/**
 * LegendList draws once it has measured itself, and jsdom measures every
 * element as nothing: the scroll box is a phone's height and every other
 * box a row's.
 */
export function measureBoxes(): () => void {
  const prototype = window.HTMLElement.prototype
  const own = Object.getOwnPropertyDescriptor(
    prototype,
    'getBoundingClientRect'
  )
  Object.defineProperty(prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement) {
      const height = this.style.overflowY === 'auto' ? 800 : 60
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 390,
        height,
        right: 390,
        bottom: height,
        toJSON: () => ({})
      }
    }
  })
  return () => {
    if (own == null)
      delete (prototype as Partial<HTMLElement>).getBoundingClientRect
    else Object.defineProperty(prototype, 'getBoundingClientRect', own)
  }
}
