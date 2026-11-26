/** Keep Three's renderer alive while the browser restores a transiently lost
 * context. A driver that never restores it gets a fresh renderer. */
export function watchFieldContext(
  canvas: HTMLCanvasElement,
  interrupt: () => void,
  redraw: () => void,
  restart: () => void
): () => void {
  let waiting: number | undefined
  const clear = (): void => {
    window.clearTimeout(waiting)
    waiting = undefined
  }
  const lost = (event: Event): void => {
    event.preventDefault()
    if (waiting != null) return
    interrupt()
    waiting = window.setTimeout(() => {
      waiting = undefined
      restart()
    }, 1500)
  }
  const restored = (): void => {
    clear()
    redraw()
  }
  canvas.addEventListener('webglcontextlost', lost)
  canvas.addEventListener('webglcontextrestored', restored)
  return () => {
    clear()
    canvas.removeEventListener('webglcontextlost', lost)
    canvas.removeEventListener('webglcontextrestored', restored)
  }
}
