/**
 * The DOM members the field's pointer handlers read, as React Three Fiber's
 * native `Canvas` provides them.
 *
 * `tsconfig.native.json` has no `dom` library, and `@types/react` leaves
 * `Event`, `PointerEvent` and `Element` empty there. Fiber's native Canvas
 * turns each touch into the same pointer event the browser sends — the touch's
 * identifier as `pointerId`, `pointerType` 'touch', a `target` whose capture
 * methods Fiber's own event system implements — so `FieldScene` reads these
 * on both ends. Every declaration here matches the DOM's, so in the browser
 * program it merges into the real one and changes nothing.
 */
interface Event {
  readonly target: EventTarget | null
}
interface PointerEvent {
  readonly pointerId: number
  readonly pointerType: string
}
// Methods, as the DOM declares them: a function property of the same name
// would not merge with the browser's declaration.
/* eslint-disable @typescript-eslint/method-signature-style */
interface Element {
  setAttribute(qualifiedName: string, value: string): void
  setPointerCapture(pointerId: number): void
  releasePointerCapture(pointerId: number): void
}
/* eslint-enable @typescript-eslint/method-signature-style */
