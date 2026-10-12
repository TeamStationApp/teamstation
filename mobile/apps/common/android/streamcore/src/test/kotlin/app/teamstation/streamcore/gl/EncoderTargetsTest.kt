package app.teamstation.streamcore.gl

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The encoder fan-out [CaptureRenderer] draws through, with windows and targets standing in for
 * `Surface` and `EGLSurface`. A frame here is one [EncoderTargets.drawEach] pass.
 */
class EncoderTargetsTest {
    private data class Window(val name: String, val valid: Boolean = true)
    private data class Target(val name: String, var alive: Boolean = true)

    private val released = mutableListOf<String>()
    private val frames = mutableMapOf<String, Int>()
    private val targets = EncoderTargets<Window, Target>(
        create = { window -> if (window.valid) Target(window.name) else null },
        release = { released += it.name }
    )

    private fun frame(): Int = targets.drawEach { target ->
        if (!target.alive) return@drawEach false
        frames[target.name] = (frames[target.name] ?: 0) + 1
        true
    }

    @Test
    fun `two attached surfaces both receive every frame`() {
        targets.attach("stream", Window("stream-1"))
        targets.attach("record", Window("record-1"))

        assertEquals(2, frame())
        assertEquals(2, frame())

        assertEquals(mapOf("stream-1" to 2, "record-1" to 2), frames)
        assertEquals(setOf("stream", "record"), targets.keys)
    }

    @Test
    fun `detaching one leaves the other receiving frames`() {
        targets.attach("stream", Window("stream-1"))
        targets.attach("record", Window("record-1"))
        frame()

        targets.detach("record")
        assertEquals(1, frame())
        assertEquals(1, frame())

        assertEquals(mapOf("stream-1" to 3, "record-1" to 1), frames)
        assertEquals(listOf("record-1"), released)
        assertEquals(setOf("stream"), targets.keys)
    }

    @Test
    fun `reattaching a key releases its old surface first`() {
        targets.attach("stream", Window("stream-1"))
        targets.attach("stream", Window("stream-2"))
        frame()

        assertEquals(listOf("stream-1"), released)
        assertEquals(mapOf("stream-2" to 1), frames)
    }

    @Test
    fun `a null or unusable window leaves the key detached`() {
        targets.attach("stream", Window("stream-1"))
        targets.attach("stream", null)
        targets.attach("record", Window("record-1", valid = false))

        assertEquals(0, frame())
        assertNull(targets.first())
        assertEquals(listOf("stream-1"), released)
    }

    @Test
    fun `a lost surface is dropped and the rest keep drawing`() {
        targets.attach("stream", Window("stream-1"))
        targets.attach("record", Window("record-1"))
        targets.first()!!.alive = false

        assertEquals(1, frame())
        assertEquals(1, frame())

        assertEquals(listOf("stream-1"), released)
        assertEquals(mapOf("record-1" to 2), frames)
        assertEquals("record-1", targets.first()?.name)
    }

    @Test
    fun `detaching an unknown key does nothing`() {
        targets.attach("stream", Window("stream-1"))
        targets.detach("record")

        assertEquals(1, frame())
        assertEquals(emptyList<String>(), released)
    }

    @Test
    fun `releaseAll releases every surface in attachment order`() {
        targets.attach("stream", Window("stream-1"))
        targets.attach("record", Window("record-1"))

        targets.releaseAll()

        assertEquals(listOf("stream-1", "record-1"), released)
        assertEquals(0, frame())
    }
}
