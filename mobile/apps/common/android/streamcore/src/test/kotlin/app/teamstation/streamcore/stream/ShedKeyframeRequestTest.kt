package app.teamstation.streamcore.stream

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShedKeyframeRequestTest {
    @Test
    fun `the first drop of a wait asks for a keyframe`() {
        assertTrue(ShedKeyframeRequest().shouldRequest(100.0))
    }

    @Test
    fun `a picture-rate run of drops asks once a second, not once a picture`() {
        val requests = ShedKeyframeRequest()
        // Ten seconds of 60 fps pictures, every one dropped while the link is stuck.
        val asked = (0 until 600).count { requests.shouldRequest(100.0 + it / 60.0) }
        assertEquals(10, asked)
    }

    @Test
    fun `a drop a second or more after the last request asks again`() {
        val requests = ShedKeyframeRequest()
        assertTrue(requests.shouldRequest(100.0))
        assertFalse(requests.shouldRequest(100.999))
        assertTrue(requests.shouldRequest(100.0 + ShedKeyframeRequest.MINIMUM_INTERVAL))
    }

    @Test
    fun `a clock that stepped back does not hold requests off`() {
        val requests = ShedKeyframeRequest()
        assertTrue(requests.shouldRequest(100.0))
        assertTrue(requests.shouldRequest(40.0))
        assertFalse(requests.shouldRequest(40.5))
    }
}
