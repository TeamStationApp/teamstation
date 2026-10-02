import Foundation
import MediaPlayer
import MusicKit
import UIKit

/// Walk-up songs on an iPhone: Apple Music and the person's library, through
/// MusicKit. `RCTWalkUpMusic.mm` is the TurboModule; this is what it calls.
///
/// - **Access** is `MusicAuthorization`, asked for the first time it is
///   needed.
/// - **Search** is the library first, then the catalog, 25 of each, with a
///   library song that is also in the catalog listed once, under its catalog
///   id. The handle is `library:<id>` or `catalog:<id>`.
/// - **Play** queues the one song on `ApplicationMusicPlayer`, prepares it,
///   sets `playbackTime` to the clip's start and plays. A 100 ms poll stops it
///   at the end. With a fade, `SystemVolume` takes the phone's volume down
///   over the last part of the clip and brings it back at that same rate.
///   A clip that starts after 0 s also fades in over that long. A clip that
///   starts at 0 s does not: it plays at the person's own level.
///
/// Reports go to `onState`: `playing` at most every 250 ms, then `idle` with
/// the fade's levels, or `error` with Apple's own message — which is also how
/// a phone without an Apple Music subscription, or an app without the MusicKit
/// service, says so.
@objc(TSWalkUpMusic)
public final class TSWalkUpMusic: NSObject {
  @objc public var onState: (([String: Any]) -> Void)?

  private let volume = SystemVolume()
  private var clip: Clip?
  private var poll: Timer?
  private var generation = 0

  private final class Clip {
    let handle: String
    let startMs: Double
    let endMs: Double
    let inMs: Double
    let outMs: Double
    var fades: Bool { inMs > 0 || outMs > 0 }
    var fadingOut = false
    var ended = false
    /// The fade has reached silence and the player has been stopped. The
    /// person's volume waits, so it does not climb while a tail is still
    /// coming out of the player.
    var silenced = false
    var lastReport: TimeInterval = 0
    var startLevel: Float = 1

    init(handle: String, startMs: Double, endMs: Double, inMs: Double, outMs: Double) {
      self.handle = handle
      self.startMs = startMs
      self.endMs = endMs
      self.inMs = inMs
      self.outMs = outMs
    }
  }

  @objc public override init() {
    super.init()
    volume.onTakeover = { [weak self] in
      guard let self else { return }
      self.report(["kind": "volume", "fade": "released", "volume": Double(self.volume.level)])
    }
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(becameActive),
      name: UIApplication.didBecomeActiveNotification,
      object: nil)
    // A clip killed mid-fade left its saved level behind. The report waits a
    // moment, so JavaScript is listening when it arrives.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
      self?.restoreInterrupted()
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc private func becameActive() {
    guard clip == nil else { return }
    restoreInterrupted()
  }

  private func restoreInterrupted() {
    guard clip == nil, let restored = volume.restoreInterrupted() else { return }
    NSLog("WalkUpMusic restored the volume to %.3f after an interrupted clip", restored)
    report(["kind": "restored", "fade": "system", "restoredLevel": Double(restored)])
  }

  // MARK: Access

  @objc public func access(_ done: @escaping (String) -> Void) {
    Task {
      var status = MusicAuthorization.currentStatus
      if status == .notDetermined {
        status = await MusicAuthorization.request()
      }
      switch status {
      case .authorized: done("authorized")
      case .denied: done("denied")
      case .restricted: done("restricted")
      default: done("unavailable")
      }
    }
  }

  // MARK: Search

  @objc public func search(_ term: String, done: @escaping ([[String: Any]]?, String?) -> Void) {
    Task {
      var results: [[String: Any]] = []
      var seen = Set<String>()
      var failure: Error?
      // The library search is MediaPlayer underneath, and without access it
      // crashes the app rather than throwing, so it is asked only with it.
      if MusicAuthorization.currentStatus == .authorized,
        MPMediaLibrary.authorizationStatus() == .authorized
      {
        do {
          var request = MusicLibrarySearchRequest(term: term, types: [Song.self])
          request.limit = 25
          let response = try await request.response()
          for song in response.songs {
            let providerId = Self.catalogId(of: song) ?? song.id.rawValue
            guard seen.insert(providerId).inserted else { continue }
            results.append(Self.candidate(song, providerId: providerId, source: "library"))
          }
        } catch {
          failure = error
        }
      }
      do {
        var request = MusicCatalogSearchRequest(term: term, types: [Song.self])
        request.limit = 25
        let response = try await request.response()
        for song in response.songs {
          let providerId = song.id.rawValue
          guard seen.insert(providerId).inserted else { continue }
          results.append(Self.candidate(song, providerId: providerId, source: "catalog"))
        }
      } catch {
        failure = error
      }
      if results.isEmpty, let failure {
        NSLog("WalkUpMusic search failed: %@", String(describing: failure))
        done(nil, Self.message(failure))
      } else {
        done(results, nil)
      }
    }
  }

  private static func candidate(_ song: Song, providerId: String, source: String) -> [String: Any] {
    let artwork = song.artwork?.url(width: 600, height: 600)?.absoluteString
    return [
      "provider": "appleMusic",
      "providerId": providerId,
      "isrc": song.isrc ?? NSNull(),
      "title": song.title,
      "artist": song.artistName,
      "album": song.albumTitle ?? NSNull(),
      // A library picture can be a `musickit:` address that means nothing
      // anywhere else, so only a web one is kept.
      "artworkUrl": (artwork?.hasPrefix("http") == true ? artwork : nil) ?? NSNull(),
      "durationMs": ((song.duration ?? 0) * 1000).rounded(),
      "source": source,
      "handle": "\(source):\(song.id.rawValue)",
    ]
  }

  /// A library song's catalog id, when it came from Apple Music.
  private static func catalogId(of song: Song) -> String? {
    guard
      let parameters = song.playParameters,
      let data = try? JSONEncoder().encode(parameters),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    if let id = object["catalogId"] as? String { return id }
    if let id = object["purchasedId"] as? String { return id }
    return nil
  }

  /// Apple's own words for a failure. MusicKit's description is often only
  /// "Unknown error" — which is what a missing MusicKit service or a phone
  /// with no Apple Music subscription gives — so the error itself is added,
  /// which names the case (`developerTokenRequestFailed`, a status code).
  private static func message(_ error: Error) -> String {
    var text = error.localizedDescription
    if let described = (error as? LocalizedError)?.errorDescription, !described.isEmpty {
      text = described
      if let reason = (error as? LocalizedError)?.failureReason, !reason.isEmpty {
        text += " \(reason)"
      }
    }
    let detail = String(describing: error)
    if !(error is WalkUpMusicError), !detail.isEmpty, !text.contains(detail) {
      text += " (\(detail))"
    }
    return text
  }

  // MARK: Play

  @objc public func play(
    _ handle: String,
    startMs: Double,
    endMs: Double,
    fadeInMs: Double,
    fadeOutMs: Double,
    done: @escaping (String?) -> Void
  ) {
    Task { @MainActor in
      self.finish(report: false)
      self.generation += 1
      let generation = self.generation
      // The fade in is the fade out's length, so the same rate, and only when
      // the clip starts after the beginning of the song.
      let fades = fadeInMs > 0 || fadeOutMs > 0
      let riseMs = startMs > 0 && fades ? (fadeOutMs > 0 ? fadeOutMs : fadeInMs) : 0
      let next = Clip(handle: handle, startMs: startMs, endMs: endMs, inMs: riseMs, outMs: fadeOutMs)
      do {
        let song = try await Self.lookup(handle)
        guard generation == self.generation else { return done(nil) }
        let player = ApplicationMusicPlayer.shared
        player.queue = ApplicationMusicPlayer.Queue(for: [song])
        try await player.prepareToPlay()
        guard generation == self.generation else { return done(nil) }
        player.playbackTime = startMs / 1000
        if next.fades {
          next.startLevel = self.volume.begin()
          if riseMs > 0 {
            self.volume.cancelRamp()
            self.volume.set(0)
          }
        }
        try await player.play()
        self.clip = next
        if riseMs > 0 {
          self.volume.ramp(to: next.startLevel, over: riseMs)
        } else if next.fades, !self.volume.isRamping,
          abs(self.volume.level - next.startLevel) > 0.08
        {
          // The last clip's return to the person's level has not landed.
          // Climb from where the speaker is, without first ducking.
          self.volume.ramp(
            to: next.startLevel, over: max(next.outMs, 1500), from: self.volume.level)
        }
        self.startPoll()
        done(nil)
      } catch {
        if next.fades { self.volume.end(restoreOver: max(next.outMs, riseMs)) }
        let message = Self.message(error)
        NSLog("WalkUpMusic play failed: %@", String(describing: error))
        self.report(["kind": "error", "handle": handle, "message": message])
        done(message)
      }
    }
  }

  @objc public func stop(_ fadeMs: Double, done: @escaping () -> Void) {
    DispatchQueue.main.async {
      guard let current = self.clip else { return done() }
      if fadeMs <= 0 || !current.fades || self.volume.released {
        self.finish(report: true)
      } else if !current.fadingOut {
        current.fadingOut = true
        self.volume.ramp(to: 0, over: fadeMs) { [weak self] in
          guard self?.clip === current else { return }
          self?.silenceThenRestore(current)
        }
      }
      done()
    }
  }

  private static func lookup(_ handle: String) async throws -> Song {
    let parts = handle.split(separator: ":", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { throw WalkUpMusicError.handle }
    let id = MusicItemID(parts[1])
    if parts[0] == "library" {
      guard MPMediaLibrary.authorizationStatus() == .authorized else { throw WalkUpMusicError.notFound }
      var request = MusicLibraryRequest<Song>()
      request.filter(matching: \.id, equalTo: id)
      if let song = try await request.response().items.first { return song }
    } else {
      let request = MusicCatalogResourceRequest<Song>(matching: \.id, equalTo: id)
      if let song = try await request.response().items.first { return song }
    }
    throw WalkUpMusicError.notFound
  }

  private func startPoll() {
    poll?.invalidate()
    let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
      self?.tick()
    }
    RunLoop.main.add(timer, forMode: .common)
    poll = timer
  }

  private func tick() {
    guard let current = clip else { return }
    let position = ApplicationMusicPlayer.shared.playbackTime * 1000
    if current.silenced { return }
    if position >= current.endMs {
      current.ended = true
      // The fade is still on its way to silence. Cutting the player here
      // leaves a tail, and bringing the volume back over that tail is the
      // scrap of music at the end.
      if current.fadingOut, volume.isRamping { return }
      if current.fadingOut, !volume.released {
        silenceThenRestore(current)
        return
      }
      finish(report: true)
      return
    }
    if current.outMs > 0, !current.fadingOut, !volume.released,
      position >= current.endMs - current.outMs
    {
      current.fadingOut = true
      volume.ramp(to: 0, over: current.endMs - position) { [weak self] in
        guard let self, self.clip === current else { return }
        self.silenceThenRestore(current)
      }
    }
    let now = Date().timeIntervalSince1970
    if now - current.lastReport >= 0.25 {
      current.lastReport = now
      report([
        "kind": "playing",
        "handle": current.handle,
        "positionMs": position.rounded(),
        "volume": Double(volume.level),
      ])
    }
  }

  /// Stops the player at silence, tells the screen the clip is over, and
  /// only then brings the volume back. `stop` does not end the audio on
  /// the spot, so the climb waits until that tail is gone.
  private func silenceThenRestore(_ current: Clip) {
    guard clip === current, !current.silenced else { return }
    current.silenced = true
    ApplicationMusicPlayer.shared.stop()
    poll?.invalidate()
    poll = nil
    clip = nil
    let generation = self.generation
    let outMs = current.outMs > 0 ? current.outMs : 1500
    let state: [String: Any] = [
      "kind": "idle",
      "handle": current.handle,
      "fade": "system",
      "startLevel": Double(current.startLevel),
      "lowestLevel": Double(volume.lowest),
      "volume": Double(volume.level),
    ]
    report(state)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      guard let self, self.generation == generation, self.clip == nil else { return }
      self.volume.end(restoreOver: outMs)
    }
  }

  /// Stops the clip, puts the person's volume back and, if asked, reports.
  private func finish(report shouldReport: Bool) {
    poll?.invalidate()
    poll = nil
    guard let current = clip else { return }
    clip = nil
    ApplicationMusicPlayer.shared.stop()
    var state: [String: Any] = ["kind": "idle", "handle": current.handle]
    if current.fades {
      let lowest = volume.lowest
      let restored = volume.end(restoreOver: current.outMs > 0 ? current.outMs : 1500)
      state["fade"] = "system"
      state["startLevel"] = Double(current.startLevel)
      state["lowestLevel"] = Double(lowest)
      if let restored { state["restoredLevel"] = Double(restored) }
    }
    state["volume"] = Double(volume.level)
    if shouldReport { report(state) }
  }

  private func report(_ state: [String: Any]) {
    NSLog("WalkUpMusicState %@", state.description)
    let deliver = onState
    DispatchQueue.main.async { deliver?(state) }
  }
}

enum WalkUpMusicError: LocalizedError {
  case handle
  case notFound

  var errorDescription: String? {
    switch self {
    case .handle: return "That song cannot be played here."
    case .notFound: return "That song is not in Apple Music or your library."
    }
  }
}
