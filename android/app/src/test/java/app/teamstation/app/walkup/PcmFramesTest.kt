package app.teamstation.app.walkup

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Whole 3200-byte frames, with a leftover that waits for the next read. */
class PcmFramesTest {
  @Test
  fun frameIsATenthOfASecond() {
    assertEquals(3200, PcmFrames.BYTES)
  }

  @Test
  fun emptyReadKeepsWhatWasWaiting() {
    val pending = byteArrayOf(1, 2)
    val (frames, rest) = PcmFrames.append(pending, ByteArray(0), frameBytes = 4)
    assertTrue(frames.isEmpty())
    assertArrayEquals(pending, rest)
  }

  @Test
  fun exactFrameEmitsOnceAndKeepsNothing() {
    val (frames, rest) = PcmFrames.append(ByteArray(0), byteArrayOf(1, 2, 3, 4), frameBytes = 4)
    assertEquals(1, frames.size)
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), frames[0])
    assertEquals(0, rest.size)
  }

  @Test
  fun leftoverJoinsTheNextRead() {
    val (first, pending) = PcmFrames.append(ByteArray(0), byteArrayOf(1, 2, 3), frameBytes = 4)
    assertTrue(first.isEmpty())
    val (frames, rest) = PcmFrames.append(pending, byteArrayOf(4, 5, 6, 7, 8), frameBytes = 4)
    assertEquals(2, frames.size)
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), frames[0])
    assertArrayEquals(byteArrayOf(5, 6, 7, 8), frames[1])
    assertEquals(0, rest.size)
  }

  @Test
  fun severalFramesLeaveTheTail() {
    val (frames, rest) =
        PcmFrames.append(ByteArray(0), byteArrayOf(1, 2, 3, 4, 5, 6, 7), frameBytes = 4)
    assertEquals(1, frames.size)
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), frames[0])
    assertArrayEquals(byteArrayOf(5, 6, 7), rest)
  }
}
