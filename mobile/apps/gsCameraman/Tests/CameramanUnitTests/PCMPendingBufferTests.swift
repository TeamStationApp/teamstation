import CameramanEncode
import Foundation
import Testing

@Suite("PCM pending buffer")
struct PCMPendingBufferTests {
  @Test("compact copies the remainder so storedCount matches readableCount")
  func compactReleasesConsumedPrefix() {
    var buffer = PCMPendingBuffer()
    buffer.append(Data(count: 40_000))
    #expect(buffer.take(PCMPendingBuffer.compactThreshold) != nil)
    #expect(buffer.storedCount == 40_000, "without compact the unique buffer still holds the prefix")
    buffer.compactIfNeeded()
    #expect(buffer.storedCount == buffer.readableCount)
    #expect(buffer.storedCount == 40_000 - PCMPendingBuffer.compactThreshold)
  }

  @Test("a fully drained buffer drops storage rather than keepingCapacity forever")
  func fullDrainReleasesStorage() {
    var buffer = PCMPendingBuffer()
    buffer.append(Data(count: 40_000))
    #expect(buffer.take(40_000) != nil)
    buffer.compactIfNeeded()
    #expect(buffer.storedCount == 0)
    #expect(buffer.readableCount == 0)
  }

  @Test("skip drops overflow so readable PCM cannot grow at the microphone rate")
  func skipCapsReadableBytes() {
    var buffer = PCMPendingBuffer()
    let frame = 1024 * 2
    buffer.append(Data(count: frame * 20))
    let extra = buffer.readableCount - frame * 8
    buffer.skip(extra - (extra % frame))
    buffer.compactIfNeeded()
    #expect(buffer.readableCount == frame * 8)
    #expect(buffer.storedCount == buffer.readableCount)
  }

  @Test("replaceReadableWithZeros keeps the sample count and clears leftover live PCM")
  func replaceReadableWithZerosKeepsCadence() {
    var buffer = PCMPendingBuffer()
    buffer.append(Data(repeating: 7, count: 100))
    _ = buffer.take(20)
    buffer.replaceReadableWithZeros()
    #expect(buffer.readableCount == 80)
    #expect(buffer.take(80) == Data(count: 80))
  }

  @Test("append and take at 48 kHz for a simulated minute stays bounded")
  func simulatedMinuteStaysBounded() {
    var buffer = PCMPendingBuffer()
    let chunk = 4096
    let frame = 2048
    // 48 kHz 16-bit mono is 96 KB/s. One simulated minute is 5.76 MB ingested.
    let iterations = (96_000 * 60) / chunk
    for _ in 0..<iterations {
      buffer.append(Data(count: chunk))
      while buffer.readableCount >= frame {
        _ = buffer.take(frame)
      }
      buffer.compactIfNeeded()
    }
    #expect(buffer.storedCount < PCMPendingBuffer.compactThreshold + chunk)
    #expect(buffer.readableCount < frame)
  }
}
