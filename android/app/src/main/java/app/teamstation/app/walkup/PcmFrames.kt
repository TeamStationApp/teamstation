package app.teamstation.app.walkup

/**
 * Cuts a stream of 16-bit PCM into whole frames of a tenth of a second at
 * 16 kHz mono (3200 bytes). Leftover bytes wait for the next read. The
 * iPhone module emits frames of this size; Android reads whatever the
 * hardware returns and cuts the same frames here, before Base64.
 */
object PcmFrames {
  const val BYTES = 3200

  fun append(
      pending: ByteArray,
      next: ByteArray,
      frameBytes: Int = BYTES
  ): Pair<List<ByteArray>, ByteArray> {
    if (next.isEmpty()) return emptyList<ByteArray>() to pending
    val combined = ByteArray(pending.size + next.size)
    pending.copyInto(combined)
    next.copyInto(combined, pending.size)
    val frames = ArrayList<ByteArray>(combined.size / frameBytes)
    var offset = 0
    while (combined.size - offset >= frameBytes) {
      frames.add(combined.copyOfRange(offset, offset + frameBytes))
      offset += frameBytes
    }
    return frames to combined.copyOfRange(offset, combined.size)
  }
}
