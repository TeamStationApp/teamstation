/** Native registration stand-in; do not use it to assert UIKit rendering. */
export const Platform = { OS: 'ios', isTV: true }
export const StyleSheet = { absoluteFill: { position: 'absolute' } }
export const Image = 'WebImage'
export const View = 'WebView'
export function requireNativeComponent(name: string): string {
  return name
}
