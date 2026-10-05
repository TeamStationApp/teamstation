import AudioToolbox
import AVFoundation
import Foundation

/// A file's sound as the packets it holds, before any decoding.
///
/// Read so that a camera's sound, which TS Director's segment writer cuts into one file per archive
/// segment, can be decoded as the one stream the camera sent. Decoded file by file, each segment
/// starts a fresh decoder, which plays its first ~21 ms wrongly: the decoder needs the packet before
/// to rebuild a packet's sound, and a segment has only copies of its own first packet in front.
struct SoundPackets {
  /// One packet, or for a format with fixed-size packets such as linear PCM, a run of them.
  struct Packet {
    var data: Data
    /// How many sample frames it decodes to.
    var frames: Int
    /// Whether the data is variable-size packets, which the decoder needs described.
    var described: Bool
  }

  var format: CMAudioFormatDescription
  var packets: [Packet]
  /// Sample frames decoded from the start of `packets` that do not play: an encoder's priming, or the
  /// copies `AVAssetWriter` puts in front of sound it was handed already encoded.
  var trimStart: Int
  /// Sample frames at the end of `packets` that do not play.
  var trimEnd: Int
  /// How many leading packets are copies of the first packet that plays, put there only to warm a
  /// decoder and wholly trimmed. Such a file holds sound cut from a longer stream, and a decoder
  /// carried over from the file before needs none of them. Zero for sound that was encoded into the
  /// file, whose leading packets are the encoder's own priming and belong to it.
  var preRoll: Int

  /// The sample frames the packets decode to, trims included.
  var decodedFrames: Int { packets.reduce(0) { $0 + $1.frames } }

  /// Every packet of `track`, or nil when it cannot be read.
  static func read(_ track: AVAssetTrack, of asset: AVAsset) -> SoundPackets? {
    guard let reader = try? AVAssetReader(asset: asset) else { return nil }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }
    var format: CMAudioFormatDescription?
    var packets: [Packet] = []
    var trimStart = 0
    var trimEnd = 0
    while let buffer = output.copyNextSampleBuffer() {
      let count = CMSampleBufferGetNumSamples(buffer)
      guard count > 0,
            let description = CMSampleBufferGetFormatDescription(buffer),
            let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
            basic.mSampleRate > 0,
            let block = CMSampleBufferGetDataBuffer(buffer)
      else { continue }
      if format == nil {
        format = description
        trimStart = frames(of: CMGetAttachment(
          buffer, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart, attachmentModeOut: nil
        ), rate: basic.mSampleRate)
      } else if let format, !CMFormatDescriptionEqual(format, otherFormatDescription: description) {
        // A file whose sound changes format part way through is not one stream; decode what came
        // first.
        break
      }
      trimEnd = frames(of: CMGetAttachment(
        buffer, key: kCMSampleBufferAttachmentKey_TrimDurationAtEnd, attachmentModeOut: nil
      ), rate: basic.mSampleRate)
      var descriptions: UnsafePointer<AudioStreamPacketDescription>?
      var size = 0
      CMSampleBufferGetAudioStreamPacketDescriptionsPtr(
        buffer, packetDescriptionsPointerOut: &descriptions, sizeOut: &size
      )
      let described = size / MemoryLayout<AudioStreamPacketDescription>.size
      if let descriptions, described > 0 {
        for index in 0..<described {
          let packet = descriptions[index]
          var data = Data(count: Int(packet.mDataByteSize))
          let copied = data.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return packet.mDataByteSize == 0 }
            return CMBlockBufferCopyDataBytes(
              block, atOffset: Int(packet.mStartOffset), dataLength: raw.count, destination: base
            ) == noErr
          }
          guard copied else { return nil }
          let frames = packet.mVariableFramesInPacket > 0
            ? Int(packet.mVariableFramesInPacket)
            : Int(basic.mFramesPerPacket)
          packets.append(Packet(data: data, frames: frames, described: true))
        }
      } else {
        let length = CMBlockBufferGetDataLength(block)
        var data = Data(count: length)
        let copied = data.withUnsafeMutableBytes { raw -> Bool in
          guard let base = raw.baseAddress else { return length == 0 }
          return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base) == noErr
        }
        guard copied else { return nil }
        packets.append(Packet(data: data, frames: count * Int(max(1, basic.mFramesPerPacket)), described: false))
      }
    }
    guard reader.status == .completed, let format, !packets.isEmpty else { return nil }
    return SoundPackets(
      format: format,
      packets: packets,
      trimStart: trimStart,
      trimEnd: trimEnd,
      preRoll: preRoll(packets, trimStart: trimStart)
    )
  }

  /// How many leading packets are copies of the first one that plays and wholly trimmed.
  static func preRoll(_ packets: [Packet], trimStart: Int) -> Int {
    var trimmed = 0
    var count = 0
    while count < packets.count, trimmed + packets[count].frames <= trimStart {
      trimmed += packets[count].frames
      count += 1
    }
    // Only whole packets trimmed, all of them the packet that follows: anything else is priming.
    guard count > 0, count < packets.count, trimmed == trimStart, packets[count].described else { return 0 }
    let first = packets[count].data
    return packets[0..<count].allSatisfy { $0.data == first } ? count : 0
  }

  private static func frames(of attachment: CFTypeRef?, rate: Double) -> Int {
    guard let attachment, CFGetTypeID(attachment) == CFDictionaryGetTypeID() else { return 0 }
    // swiftlint:disable:next force_cast
    let time = CMTimeMakeFromDictionary((attachment as! CFDictionary))
    guard time.isNumeric else { return 0 }
    return max(0, Int((time.seconds * rate).rounded()))
  }
}

/// Decodes packets to interleaved 16-bit sound, carrying its state from one call to the next so a
/// stream fed in pieces decodes as if it came whole.
final class SoundDecoder {
  let channels: Int
  let rate: Double
  private let converter: AudioConverterRef
  private let input: AudioStreamBasicDescription

  /// Nil when the format cannot be decoded to `rate` and `channels`.
  init?(_ format: CMAudioFormatDescription, rate: Double, channels: Int) {
    guard var source = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { return nil }
    var output = AudioStreamBasicDescription(
      mSampleRate: rate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: UInt32(2 * channels),
      mFramesPerPacket: 1,
      mBytesPerFrame: UInt32(2 * channels),
      mChannelsPerFrame: UInt32(channels),
      mBitsPerChannel: 16,
      mReserved: 0
    )
    var made: AudioConverterRef?
    guard AudioConverterNew(&source, &output, &made) == noErr, let made else { return nil }
    var cookieSize = 0
    if let cookie = CMAudioFormatDescriptionGetMagicCookie(format, sizeOut: &cookieSize), cookieSize > 0 {
      AudioConverterSetProperty(made, kAudioConverterDecompressionMagicCookie, UInt32(cookieSize), cookie)
    }
    converter = made
    input = source
    self.rate = rate
    self.channels = channels
  }

  deinit { AudioConverterDispose(converter) }

  /// What `packet` decodes to, as interleaved samples. Usually its frames' worth; a decoder that
  /// resamples may hold some back for the next call.
  func decode(_ packet: SoundPackets.Packet) throws -> [Int16] {
    /// The packet as the decoder reads it, in memory that stays put while the decoder holds it.
    final class Feed {
      let bytes: UnsafeMutableRawPointer
      let size: Int
      let packets: UInt32
      let description: UnsafeMutablePointer<AudioStreamPacketDescription>?
      var given = false
      init(_ packet: SoundPackets.Packet, bytesPerPacket: UInt32) {
        size = packet.data.count
        bytes = UnsafeMutableRawPointer.allocate(byteCount: max(1, size), alignment: 16)
        packet.data.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: size)
        packets = packet.described || bytesPerPacket == 0 ? 1 : UInt32(size) / bytesPerPacket
        if packet.described {
          description = .allocate(capacity: 1)
          description?.initialize(to: AudioStreamPacketDescription(
            mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(size)
          ))
        } else {
          description = nil
        }
      }
      deinit {
        bytes.deallocate()
        description?.deallocate()
      }
    }
    let feed = Feed(packet, bytesPerPacket: input.mBytesPerPacket)
    let space = max(4_096, packet.frames * 2)
    var result: [Int16] = []
    while true {
      var chunk = [Int16](repeating: 0, count: space * channels)
      var frames = UInt32(space)
      let status = chunk.withUnsafeMutableBytes { raw -> OSStatus in
        var list = AudioBufferList(
          mNumberBuffers: 1,
          mBuffers: AudioBuffer(
            mNumberChannels: UInt32(channels), mDataByteSize: UInt32(raw.count), mData: raw.baseAddress
          )
        )
        return AudioConverterFillComplexBuffer(
          converter,
          { _, count, data, descriptions, user in
            let feed = Unmanaged<Feed>.fromOpaque(user!).takeUnretainedValue()
            guard !feed.given else {
              count.pointee = 0
              return SoundDecoder.waitingForMore
            }
            feed.given = true
            data.pointee.mNumberBuffers = 1
            data.pointee.mBuffers.mData = feed.bytes
            data.pointee.mBuffers.mDataByteSize = UInt32(feed.size)
            if let description = feed.description, let descriptions {
              descriptions.pointee = description
            }
            count.pointee = feed.packets
            return noErr
          },
          Unmanaged.passUnretained(feed).toOpaque(),
          &frames,
          &list,
          nil
        )
      }
      guard status == noErr || status == Self.waitingForMore else {
        throw ArchiveRemux.Error.exportFailed("sound decode \(status)")
      }
      result += chunk.prefix(Int(frames) * channels)
      // The packet is used up and the decoder has given all it will for now.
      if status == Self.waitingForMore || frames == 0 { break }
    }
    return result
  }

  /// What the input callback says when it has given its packet: not the end of the stream, only of
  /// what there is now, so the decoder keeps its state for the next packet.
  static let waitingForMore: OSStatus = 0x6D6F_7265 // 'more'
}
