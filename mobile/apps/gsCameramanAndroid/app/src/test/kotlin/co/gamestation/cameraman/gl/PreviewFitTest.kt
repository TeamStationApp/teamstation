package co.gamestation.cameraman.gl

import org.junit.Assert.assertEquals
import org.junit.Test

class PreviewFitTest {
    @Test
    fun `a 16 by 9 picture on a wider screen keeps side bars`() {
        val height = 1080
        val width = 2424
        val pictureWidth = height * 16f / 9f
        val frame = fittedFrame(width, height, pictureWidth / width, 1f)
        assertEquals(1920, frame.width)
        assertEquals(1080, frame.height)
        assertEquals((width - 1920) / 2, frame.x)
        assertEquals(0, frame.y)
    }

    @Test
    fun `a 16 by 9 picture on a taller screen keeps bars above and below`() {
        val width = 1920
        val height = 1920
        val pictureHeight = width * 9f / 16f
        val frame = fittedFrame(width, height, 1f, pictureHeight / height)
        assertEquals(1920, frame.width)
        assertEquals(1080, frame.height)
        assertEquals(0, frame.x)
        assertEquals((height - 1080) / 2, frame.y)
    }

    @Test
    fun `a matching destination is the whole surface`() {
        val frame = fittedFrame(1920, 1080, 1f, 1f)
        assertEquals(FittedFrame(0, 0, 1920, 1080), frame)
    }
}
