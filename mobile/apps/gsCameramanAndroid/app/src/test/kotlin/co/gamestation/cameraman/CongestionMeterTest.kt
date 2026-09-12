package co.gamestation.cameraman

import co.gamestation.cameraman.rtsp.CongestionMeter
import co.gamestation.cameraman.rtsp.CongestionSample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The ledger the bitrate controller reads a link from. */
class CongestionMeterTest {
    @Test
    fun `the queue delay is the age of the oldest unfinished send`() {
        val meter = CongestionMeter()
        // Nothing waiting is no delay.
        assertEquals(0.0, meter.queueDelay(5.0), 0.0)

        meter.sent(100, 1.0)
        meter.sent(200, 2.0)
        assertEquals(2.0, meter.queueDelay(3.0), 0.0)
        assertEquals(300, meter.pendingBytes)

        meter.delivered()
        assertEquals(1.0, meter.queueDelay(3.0), 0.0)
        meter.delivered()
        assertEquals(0.0, meter.queueDelay(3.0), 0.0)
    }

    @Test
    fun `a sample covers only what happened since the previous one`() {
        val meter = CongestionMeter()
        meter.sample(0.0, 0, 0)

        meter.offered(500)
        meter.sent(300, 0.1)
        meter.delivered()
        val first = meter.sample(0.25, 3, 1)
        assertEquals(0.25, first.interval, 0.0)
        assertEquals(500, first.offeredBytes)
        assertEquals(300, first.deliveredBytes)
        assertEquals(3, first.droppedFrames)
        assertEquals(1, first.flushes)

        val second = meter.sample(0.5, 5, 1)
        assertEquals(0, second.offeredBytes)
        assertEquals(0, second.deliveredBytes)
        // The send queue's totals become per-interval counts.
        assertEquals(2, second.droppedFrames)
        assertEquals(0, second.flushes)
    }

    @Test
    fun `bytes that only moved into the transport backlog have not drained`() {
        val meter = CongestionMeter()
        meter.sample(0.0, 0, 0, transportBacklogBytes = 1_000)
        meter.sent(800, 0.1)
        meter.delivered()

        val sample = meter.sample(0.25, 0, 0, transportBacklogBytes = 1_500)
        assertEquals(800, sample.deliveredBytes)
        assertEquals(300, sample.drainedBytes)
    }

    @Test
    fun `abandoned sends are forgotten from the newest end`() {
        val meter = CongestionMeter()
        meter.sent(100, 1.0)
        meter.sent(200, 2.0)
        meter.sent(300, 3.0)
        meter.discardNewest(2)

        assertEquals(100, meter.pendingBytes)
        meter.delivered()
        assertEquals(100, meter.sample(4.0, 0, 0).deliveredBytes)
        assertEquals(0.0, meter.queueDelay(4.0), 0.0)
    }

    @Test
    fun `the worst client is the one losing frames then the one waiting longest`() {
        val slow = CongestionSample(interval = 0.25, queueDelay = 0.3)
        val dropping = CongestionSample(interval = 0.25, queueDelay = 0.1, droppedFrames = 1)
        val fine = CongestionSample(interval = 0.25, queueDelay = 0.01)

        assertEquals(dropping, CongestionSample.worst(listOf(slow, dropping, fine)))
        assertEquals(slow, CongestionSample.worst(listOf(fine, slow)))
        assertNull(CongestionSample.worst(emptyList()))
    }
}
