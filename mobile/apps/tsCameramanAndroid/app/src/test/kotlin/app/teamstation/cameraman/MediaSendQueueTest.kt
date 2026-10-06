package app.teamstation.cameraman

import app.teamstation.cameraman.rtsp.CongestionMeter
import app.teamstation.cameraman.rtsp.MediaSendQueue
import app.teamstation.cameraman.rtsp.TransportGate
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Nothing waits on the phone longer than a receiver's live delay: a link that falls behind makes the
 * stream skip ahead, never fall behind. The iOS build's `MediaSendQueueTests` are the same cases,
 * with a half-second bound.
 */
class MediaSendQueueTest {
    private val video = 0
    private val audio = 2

    /** An interleaved RTP packet on [channel] whose sequence number reads 0 and whose payload is [tag]. */
    private fun packet(channel: Int, tag: Int, size: Int = 20): ByteArray {
        val rtp = ByteArray(12).also { it[0] = 0x80.toByte() } + ByteArray(maxOf(1, size - 16)) { tag.toByte() }
        return byteArrayOf(0x24, channel.toByte(), (rtp.size shr 8).toByte(), (rtp.size and 0xFF).toByte()) + rtp
    }

    private fun picture(tag: Int, packets: Int = 1) = List(packets) { packet(video, tag) }

    private fun sequence(data: ByteArray) = ((data[6].toInt() and 0xFF) shl 8) or (data[7].toInt() and 0xFF)

    private fun tag(data: ByteArray) = data.last().toInt()

    private fun drain(queue: MediaSendQueue, hasRoom: Boolean = true): List<ByteArray> {
        val out = mutableListOf<ByteArray>()
        while (true) out.add(queue.next(hasRoom)?.bytes ?: return out)
    }

    @Test
    fun `young media goes out with sound ahead and sequence numbers counted`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        assertFalse(queue.enqueuePicture(picture(1, 2), 0.0, true, 0.02))
        queue.enqueueSound(packet(audio, 9), 0.01, 0.021, 0.03)
        assertFalse(queue.enqueuePicture(picture(2), 0.017, false, 0.04))
        assertEquals(4 * 20, queue.pendingBytes)
        assertEquals(0.03, queue.oldestWait(0.05), 1e-9)
        assertFalse(queue.prune(0.05))

        val out = drain(queue)
        assertEquals(listOf(9, 1, 1, 2), out.map(::tag))
        assertEquals("each channel counts its own", listOf(0, 0, 1, 2), out.map(::sequence))
        assertEquals(3, queue.nextSequence(video))
        assertEquals(1, queue.nextSequence(audio))
        assertTrue(queue.isEmpty)
        assertEquals(0.0, queue.oldestWait(1.0), 0.0)
        assertEquals(0, queue.droppedFrames + queue.flushes)
    }

    @Test
    fun `sound goes between the packets of a large picture`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        queue.enqueuePicture(picture(1, 3), 0.0, true, 0.0)
        assertEquals(1, tag(queue.next(true)!!.bytes))
        queue.enqueueSound(packet(audio, 9), 0.01, 0.021, 0.01)
        assertEquals(listOf(9, 1, 1), drain(queue).map(::tag))
    }

    @Test
    fun `a picture too old drops everything up to the next keyframe`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        for (index in 0 until 4) queue.enqueuePicture(picture(index), index * 0.1, index == 0, index * 0.1)
        queue.enqueuePicture(picture(7), 0.45, false, 0.45)
        queue.enqueuePicture(picture(8), 0.5, true, 0.5)
        queue.enqueuePicture(picture(9), 0.55, false, 0.55)

        assertFalse("a keyframe is already waiting, so none is asked for", queue.prune(0.65))
        assertEquals(5, queue.droppedFrames)
        assertEquals(1, queue.flushes)
        assertFalse(queue.isDropping)
        val out = drain(queue)
        assertEquals(listOf(8, 9), out.map(::tag))
        assertEquals("no hole for a receiver to read as loss", listOf(0, 1), out.map(::sequence))
    }

    @Test
    fun `with no keyframe waiting a drop asks for one and drops what follows`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        queue.enqueuePicture(picture(1), 0.0, true, 0.0)
        queue.enqueuePicture(picture(2), 0.1, false, 0.1)
        assertTrue("the transport is full", drain(queue, hasRoom = false).isEmpty())

        assertTrue(queue.prune(0.7))
        assertTrue(queue.isDropping)
        assertEquals(2, queue.droppedFrames)
        assertEquals(1, queue.keyframeRequests)
        assertFalse(queue.enqueuePicture(picture(3), 0.69, false, 0.7))
        assertFalse(queue.prune(0.8))
        assertTrue(queue.enqueuePicture(picture(4), 1.19, false, 1.2))
        assertEquals(2, queue.keyframeRequests)
        assertEquals(4, queue.droppedFrames)
        assertTrue(queue.isEmpty)
        assertEquals("one drop, however many pictures", 1, queue.flushes)

        assertFalse(queue.enqueuePicture(picture(5), 1.25, true, 1.26))
        assertFalse(queue.isDropping)
        queue.enqueuePicture(picture(6), 1.27, false, 1.28)
        val out = drain(queue)
        assertEquals(listOf(5, 6), out.map(::tag))
        assertEquals(listOf(0, 1), out.map(::sequence))
    }

    @Test
    fun `a stale keyframe is dropped too and the next one ends the drop`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        queue.enqueuePicture(picture(1), 0.0, true, 0.0)
        assertTrue(queue.prune(0.6))
        assertTrue(queue.isDropping)
        queue.enqueuePicture(picture(2), 0.6, true, 0.6)
        assertEquals(listOf(2), drain(queue).map(::tag))
    }

    @Test
    fun `a picture part-sent finishes however old it gets`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        queue.enqueuePicture(picture(1, 3), 0.0, true, 0.0)
        queue.enqueuePicture(picture(2), 0.02, false, 0.02)
        assertEquals(1, tag(queue.next(true)!!.bytes))
        assertTrue(queue.prune(0.9))
        assertEquals("only the picture not yet begun", 1, queue.droppedFrames)
        assertEquals(listOf(1, 1), drain(queue).map(::tag))
    }

    @Test
    fun `sound too old is dropped and counted`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        queue.enqueueSound(packet(audio, 1), 0.0, 0.021, 0.0)
        queue.enqueueSound(packet(audio, 2), 0.021, 0.021, 0.03)
        queue.enqueueSound(packet(audio, 3), 0.3, 0.021, 0.3)
        val response = "RTSP/1.0 200 OK\r\n\r\n".toByteArray()
        queue.enqueueControl(response, 0.0)
        assertFalse(queue.prune(0.55))
        assertEquals(2, queue.droppedSoundPackets)
        assertEquals(0.042, queue.droppedSoundSeconds, 1e-9)
        val first = queue.next(true)!!
        assertTrue(first.isMedia)
        assertEquals("the receiver sees a skip in the stamps, not a lost packet", 0, sequence(first.bytes))
        val second = queue.next(true)!!
        assertFalse(second.isMedia)
        assertArrayEquals("control is never dropped or renumbered", response, second.bytes)
    }

    @Test
    fun `without room control still goes but media waits`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        val report = packet(1, 5)
        queue.enqueueControl(report, 0.0)
        queue.enqueueSound(packet(audio, 9), 0.0, 0.021, 0.0)
        queue.enqueuePicture(picture(1), 0.0, true, 0.0)
        assertArrayEquals(report, queue.next(false)!!.bytes)
        assertNull(queue.next(false))
        assertEquals(9, tag(queue.next(true)!!.bytes))
        assertNull(queue.next(false))
        assertEquals(1, tag(queue.next(true)!!.bytes))
    }

    @Test
    fun `an empty picture and odd bytes are left alone`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        assertFalse(queue.enqueuePicture(emptyList(), 0.0, true, 0.0))
        assertTrue(queue.isEmpty)
        val short = byteArrayOf(0x24, 0, 0, 1)
        queue.enqueueSound(short, 0.0, 0.0, 0.0)
        assertArrayEquals(short, queue.next(true)!!.bytes)
        val unframed = ByteArray(12) { 7 }
        queue.enqueueSound(unframed, 0.0, 0.0, 0.0)
        assertArrayEquals(unframed, queue.next(true)!!.bytes)
    }

    @Test
    fun `a new session forgets what waited but keeps counting`() {
        val queue = MediaSendQueue(maximumAge = 0.5)
        queue.enqueuePicture(picture(1), 0.0, true, 0.0)
        drain(queue)
        queue.enqueuePicture(picture(2), 0.1, false, 0.1)
        assertTrue(queue.prune(1.0))
        queue.enqueueSound(packet(audio, 9), 1.0, 0.021, 1.0)
        queue.reset()
        assertTrue(queue.isEmpty)
        assertFalse(queue.isDropping)
        assertEquals(1, queue.droppedFrames)
        queue.enqueuePicture(picture(3), 2.0, true, 2.0)
        assertEquals(1, sequence(queue.next(true)!!.bytes))
        val snapshot = queue.snapshot()
        assertEquals(MediaSendQueue.Snapshot(0, 1, 1, false, 0.0), snapshot)
    }

    @Test
    fun `the bound is the receiver's live delay`() {
        assertEquals(1.0, MediaSendQueue.maximumAgeSeconds, 0.0)
        assertEquals(1.0, MediaSendQueue().maximumAge, 0.0)
        assertEquals(1.0, MediaSendQueue(maximumAge = 1.0).maximumAge, 0.0)
    }
}

class TransportGateTest {
    @Test
    fun `until a rate is measured the transport takes sixty-four kilobytes`() {
        val gate = TransportGate()
        assertNull(gate.drainRate)
        assertEquals(64 * 1024, gate.budgetBytes)
        gate.handed(60_000)
        assertTrue(gate.hasRoom(0))
        assertFalse(gate.hasRoom(10_000))
        gate.processed(60_000)
        assertEquals(10_000L, gate.inTransport(10_000))
        assertEquals(60_000L, gate.handedBytes)
        assertEquals(60_000L, gate.processedBytes)
    }

    @Test
    fun `the budget is a quarter second of what the link drains`() {
        val gate = TransportGate()
        for (step in 0..20) {
            gate.handed(40_000)
            gate.processed(40_000)
            gate.observe(step * 0.1, 20_000)
        }
        assertEquals(400_000.0, gate.drainRate!!, 1.0)
        assertEquals(100_000.0, gate.budgetBytes.toDouble(), 1.0)
        val slow = TransportGate()
        for (step in 0..20) {
            slow.processed(2_000)
            slow.observe(step * 0.1, 0)
        }
        assertEquals(32 * 1024, slow.budgetBytes)
    }

    @Test
    fun `bytes still in the kernel have not left`() {
        val gate = TransportGate()
        gate.processed(100_000)
        gate.observe(0.0, 100_000)
        gate.observe(0.0, 0)
        gate.observe(1.0, 50_000)
        assertEquals(50_000.0, gate.drainRate!!, 0.0)
        assertEquals(0L, gate.inTransport(-5))
    }

    @Test
    fun `media waiting on the phone counts as delay`() {
        val meter = CongestionMeter()
        meter.sent(100, 0.0)
        assertEquals(0.4, meter.sample(0.1, 0, 0, waitingHere = 0.4).queueDelay, 1e-9)
        assertEquals(0.5, meter.sample(0.5, 0, 0, waitingHere = 0.1).queueDelay, 1e-9)
    }
}
