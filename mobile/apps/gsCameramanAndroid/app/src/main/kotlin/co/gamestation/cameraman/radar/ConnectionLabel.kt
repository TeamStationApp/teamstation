package co.gamestation.cameraman.radar

internal object ConnectionLabel {
    fun connecting(step: Int): String {
        val dots = (step % 3) + 1
        return "connecting" + ".".repeat(dots)
    }
}
