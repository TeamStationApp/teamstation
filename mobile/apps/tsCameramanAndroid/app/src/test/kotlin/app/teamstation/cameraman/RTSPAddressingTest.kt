package app.teamstation.cameraman

import app.teamstation.cameraman.rtsp.RTPTimestampSequencer
import app.teamstation.cameraman.rtsp.RTSPServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RTPTimestampSequencerTest {
    private val sequencer = RTPTimestampSequencer()

    @Test
    fun `an advancing clock passes straight through`() {
        assertEquals(0L, sequencer.next(0))
        assertEquals(3000L, sequencer.next(3000))
        assertEquals(6000L, sequencer.next(6000))
    }

    @Test
    fun `a repeated timestamp is nudged forward`() {
        // Two frames sharing a timestamp are merged by the receiver into one malformed access unit.
        sequencer.next(3000)
        assertEquals(3001L, sequencer.next(3000))
        assertEquals(3002L, sequencer.next(3000))
    }

    @Test
    fun `a step backwards is nudged rather than obeyed`() {
        sequencer.next(6000)
        assertEquals(6001L, sequencer.next(3000))
    }

    @Test
    fun `the 32-bit rollover is a forward step, not a repeat`() {
        // The whole reason this type exists. A plain comparison sees the wrapped value as tiny and
        // nudges every later frame by one tick, which collapses the timeline the receiver records
        // against — and it only shows up 13.3 hours in.
        val justBefore = 0xFFFFFF00L
        assertEquals(justBefore, sequencer.next(justBefore))
        val wrapped = 0x00000100L
        assertEquals(wrapped, sequencer.next(wrapped))
        assertEquals(wrapped + 3000, sequencer.next(wrapped + 3000))
    }

    @Test
    fun `reset forgets the previous frame`() {
        sequencer.next(6000)
        sequencer.reset()
        assertNull(sequencer.lastSent)
        assertEquals(10L, sequencer.next(10))
    }
}

class PreferredAddressTest {

    @Test
    fun `Wi-Fi wins`() {
        assertEquals(
            "192.168.7.157",
            RTSPServer.preferredLANIPv4(
                listOf("rndis0" to "192.168.42.129", "wlan0" to "192.168.7.157")
            )
        )
    }

    @Test
    fun `loopback and link-local never win`() {
        // Handing Director an address it cannot reach is worse than handing it none: it looks like a
        // camera that is up and refusing connections.
        assertNull(
            RTSPServer.preferredLANIPv4(listOf("lo" to "127.0.0.1", "wlan0" to "169.254.10.1"))
        )
    }

    @Test
    fun `a hotspot ranks below the real network`() {
        assertEquals(
            "192.168.7.157",
            RTSPServer.preferredLANIPv4(
                listOf("ap0" to "192.168.43.1", "wlan0" to "192.168.7.157")
            )
        )
    }

    @Test
    fun `something is better than nothing when there is no Wi-Fi`() {
        assertEquals(
            "192.168.42.129",
            RTSPServer.preferredLANIPv4(listOf("rndis0" to "192.168.42.129"))
        )
    }
}
