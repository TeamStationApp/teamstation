import type { Insets } from '../app/platform/insets'

/**
 * Gives the web's inset probe (`useFieldInsets`) a phone browser's safe area,
 * which jsdom has none of. Returns the restore. Null insets: none.
 */
export function stubFieldInsets(insets: () => Insets | null): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'getComputedStyle')
  const computed = window.getComputedStyle.bind(window)
  window.getComputedStyle = (element, pseudo) => {
    const style = computed(element, pseudo)
    const area = insets()
    if (area == null || !element.hasAttribute('data-field-insets')) return style
    const sides: Record<string, string> = {
      paddingTop: `${area.top}px`,
      paddingBottom: `${area.bottom}px`,
      paddingLeft: `${area.left}px`,
      paddingRight: `${area.right}px`
    }
    return new Proxy(style, {
      get: (target, key) =>
        typeof key === 'string' && key in sides
          ? sides[key]
          : (Reflect.get(target, key) as unknown)
    })
  }
  return () => {
    if (descriptor == null) Reflect.deleteProperty(window, 'getComputedStyle')
    else Object.defineProperty(window, 'getComputedStyle', descriptor)
  }
}
