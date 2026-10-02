package app.teamstation.cameraman

import app.teamstation.cameraman.rtsp.StreamSendQueue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Backpressure is the difference between a slow client and a killed app. */
class StreamSendQueueTest {

    @Test
    fun `sends while under the water mark`() {
        val queue = StreamSendQueue(highWaterMark = 1_000)
        assertEquals(StreamSendQueue.Decision.SEND, queue.decide(400, false))
        assertEquals(StreamSendQueue.Decision.SEND, queue.decide(400, false))
        assertEquals(0, queue.droppedFrames)
    }

    @Test
    fun `drops non-keyframes once over budget`() {
        val queue = StreamSendQueue(highWaterMark = 1_000)
        assertEquals(StreamSendQueue.Decision.SEND, queue.decide(1_500, true))

        // Nothing has completed, so the queue is still over budget.
        assertEquals(StreamSendQueue.Decision.DROP, queue.decide(100, false))
        assertEquals(StreamSendQueue.Decision.DROP, queue.decide(100, false))
        assertEquals(2, queue.droppedFrames)
        assertTrue(queue.isDropping)
    }

    @Test
    fun `a keyframe flushes the backlog and becomes the new start`() {
        val queue = StreamSendQueue(highWaterMark = 1_000)
        queue.decide(5_000, true)
        queue.decide(100, false)

        // A keyframe is the one place a decoder can resynchronise, so the stale backlog is abandoned
        // rather than delivered late.
        assertEquals(StreamSendQueue.Decision.FLUSH_THEN_SEND, queue.decide(800, true))
        assertEquals(800, queue.pendingBytes)
        assertEquals(1, queue.flushes)
        assertFalse(queue.isDropping)
    }

    @Test
    fun `a stale completion after a flush does not debit the new keyframe`() {
        val queue = StreamSendQueue(highWaterMark = 1_000)
        assertEquals(StreamSendQueue.Decision.SEND, queue.decide(5_000, true))
        val staleGeneration = queue.generation
        assertEquals(StreamSendQueue.Decision.FLUSH_THEN_SEND, queue.decide(800, true))

        // The transport still reports the abandoned send later. That completion belongs to the old
        // generation and must not subtract from the keyframe that replaced it.
        queue.complete(5_000, staleGeneration)
        assertEquals(800, queue.pendingBytes)
    }

    @Test
    fun `completion credits the queue and sending resumes at the next keyframe`() {
        val queue = StreamSendQueue(highWaterMark = 1_000)
        queue.decide(1_200, true)
        assertEquals(StreamSendQueue.Decision.DROP, queue.decide(100, false))

        queue.complete(1_200)
        assertEquals(0, queue.pendingBytes)
        // Room again, but this picture predicts from the one just dropped, so it would not decode.
        assertEquals(StreamSendQueue.Decision.DROP, queue.decide(100, false))
        assertTrue(queue.isDropping)
        assertEquals(StreamSendQueue.Decision.SEND, queue.decide(100, true))
        assertFalse(queue.isDropping)
        assertEquals(StreamSendQueue.Decision.SEND, queue.decide(100, false))
    }

    @Test
    fun `completion cannot drive the queue negative`() {
        // A double completion, or one for a frame that was dropped, must not leave a credit that
        // hides real backpressure later.
        val queue = StreamSendQueue(highWaterMark = 1_000)
        queue.decide(500, true)
        queue.complete(5_000)
        assertEquals(0, queue.pendingBytes)
    }

    @Test
    fun `audio is never dropped`() {
        val queue = StreamSendQueue(highWaterMark = 100)
        queue.decide(5_000, true)

        // A gap in audio is far more noticeable than a dropped picture, and audio is a few percent
        // of the bitrate, so it is always enqueued.
        queue.enqueueAudio(400)
        assertEquals(5_400, queue.pendingBytes)
        assertEquals(0, queue.droppedFrames)
    }

    @Test
    fun `a sustained stall drops to the next keyframe rather than growing`() {
        val queue = StreamSendQueue(highWaterMark = 10_000)
        // A client that has taken nothing at all: the first frame goes out, then 120 frames arrive
        // with one keyframe every 30.
        queue.decide(60_000, true)

        var sent = 0
        for (index in 1..120) {
            val decision = queue.decide(20_000, index % 30 == 0)
            if (decision != StreamSendQueue.Decision.DROP) sent += 1
        }

        assertEquals(4, sent)
        assertEquals(116, queue.droppedFrames)
        // The decisive property: memory does not grow with the length of the stall.
        assertEquals(20_000, queue.pendingBytes)
    }
}
