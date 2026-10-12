package app.teamstation.streamcore.gl

/**
 * The encoder destinations a [CaptureRenderer] draws every frame to, by key.
 *
 * Cameraman attaches one, its RTSP encoder. A phone streaming and recording attaches two, the stream
 * encoder and the recording encoder, and each gets every frame. Each is built on its codec's input
 * window and replaced whenever the codec hands out a new one, so the bookkeeping is by key rather
 * than by window.
 *
 * Generic over the window and the surface built on it so it can be tested without EGL; the renderer
 * passes `Surface` and `EGLSurface`. Not thread-safe: the renderer only touches it on its own thread.
 */
internal class EncoderTargets<Window, Target>(
    /** Builds a target on a window, or null when the window cannot take one. */
    private val create: (Window) -> Target?,
    private val release: (Target) -> Unit
) {
    private val targets = LinkedHashMap<String, Target>()

    val keys: Set<String> get() = targets.keys

    /** The first attached target, which is the one the renderer makes current to read a frame. */
    fun first(): Target? = targets.values.firstOrNull()

    /**
     * Points [key] at [window], releasing whatever target the key held first: a codec's old input
     * window is dead the moment the codec is released. A null window, or one no target can be built
     * on, leaves the key detached.
     */
    fun attach(key: String, window: Window?) {
        detach(key)
        val target = window?.let(create) ?: return
        targets[key] = target
    }

    fun detach(key: String) {
        targets.remove(key)?.let(release)
    }

    /**
     * Draws to every target in attachment order, releasing and dropping each one [draw] reports lost
     * so the next frame does not try it again. Returns how many were drawn.
     */
    fun drawEach(draw: (Target) -> Boolean): Int {
        var drawn = 0
        val entries = targets.entries.iterator()
        while (entries.hasNext()) {
            val target = entries.next().value
            if (draw(target)) {
                drawn += 1
            } else {
                release(target)
                entries.remove()
            }
        }
        return drawn
    }

    fun releaseAll() {
        targets.values.forEach(release)
        targets.clear()
    }
}
