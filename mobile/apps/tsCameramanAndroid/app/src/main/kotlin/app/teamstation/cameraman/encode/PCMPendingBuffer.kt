package app.teamstation.cameraman.encode

/**
 * PCM waiting for a whole AAC frame.
 *
 * Concatenating and re-slicing a `ByteArray` per capture callback keeps the discarded prefix alive
 * until the next copy, so a 48 kHz 16-bit mono microphone (96 KB/s) drained as fast as it arrives
 * still climbs several MB a minute. A read cursor plus an occasional copy of the remainder gives
 * that prefix back to the allocator.
 */
class PCMPendingBuffer {
    private var storage = ByteArray(0)
    private var readOffset = 0

    val readableCount: Int get() = storage.size - readOffset

    /**
     * Allocated bytes including the consumed prefix. Tests use this to prove compact actually
     * shrinks storage rather than only sliding the cursor.
     */
    val storedCount: Int get() = storage.size

    fun append(data: ByteArray, count: Int = data.size) {
        if (count <= 0) return
        val grown = ByteArray(storage.size + count)
        System.arraycopy(storage, 0, grown, 0, storage.size)
        System.arraycopy(data, 0, grown, storage.size, count)
        storage = grown
    }

    fun take(byteCount: Int): ByteArray? {
        if (byteCount <= 0 || readableCount < byteCount) return null
        val chunk = storage.copyOfRange(readOffset, readOffset + byteCount)
        readOffset += byteCount
        return chunk
    }

    /**
     * Puts back bytes that [take] just handed out.
     *
     * Rewinding the cursor rather than re-appending is exact and free, because the bytes are still
     * in `storage` until the next compaction. Used when the encoder had a whole frame ready but no
     * input buffer to put it in: a hole in audio is far more audible than a frame of latency.
     */
    fun unread(byteCount: Int) {
        if (byteCount <= 0) return
        readOffset -= minOf(byteCount, readOffset)
    }

    fun skip(byteCount: Int) {
        if (byteCount <= 0) return
        readOffset += minOf(byteCount, readableCount)
    }

    fun reset() {
        storage = ByteArray(0)
        readOffset = 0
    }

    fun compactIfNeeded() {
        if (readOffset <= 0) return
        if (readOffset >= storage.size) {
            storage = ByteArray(0)
            readOffset = 0
            return
        }
        if (readOffset >= compactThreshold || readOffset * 2 >= storage.size) {
            storage = storage.copyOfRange(readOffset, storage.size)
            readOffset = 0
        }
    }

    companion object {
        const val compactThreshold = 32 * 1024
    }
}
