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
/// service, says so. A failure Apple names only by number gets words a person
/// can act on instead, with Apple's message kept as `detail`.
@objc(TSWalkUpMusic)
public final class TSWalkUpMusic: NSObject {
  @objc public var onState: (([String: Any]) -> Void)?

  private let volume = SystemVolume()
  private var clip: Clip?
  private var poll: Timer?
  private var generation = 0
  /// The `prepareOffline` call in flight. The next waits for it, so two
  /// visits in quick succession cannot both create the playlist.
  @MainActor private var preparing: Task<Void, Never>?

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

  /// What to do about a failure Apple names only by its number. Apple's own
  /// words still go to the log, as the report's `detail`.
  ///
  /// `MPMusicPlayerControllerErrorDomain` 6, "Failed to prepare to play", is
  /// Apple Music refusing one song for a while on a phone that plays others:
  /// it is not the subscription or the song. Playing that song once in the
  /// Music app is what usually brings it back.
  private static func advice(_ error: Error) -> String? {
    var current: NSError? = error as NSError
    while let nsError = current {
      if nsError.domain == "MPMusicPlayerControllerErrorDomain", nsError.code == 6 {
        return "Apple Music couldn’t start this song. Open the Music app, play the song there for "
          + "a few seconds, then come back and try again."
      }
      current = nsError.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return nil
  }

  // MARK: Offline

  /// The playlist TeamStation keeps its walk-up songs in, by name, so a
  /// person can find them in Music.
  static let playlistName = "TeamStation walkup songs"
  static let playlistDescription =
    "Walk-up songs TeamStation plays at games. TeamStation adds songs here so Apple Music "
    + "keeps them on this phone."
  private static let playlistIdKey = "walkUpPlaylistId"

  /// Puts these catalog songs in the library and on TeamStation's playlist,
  /// so Apple Music's Automatic Downloads keeps them on the phone, and says
  /// where each one is.
  ///
  /// Automatic Downloads fetches a song when it is added to the library; a
  /// song already in the library but not on the phone stays `pending` until
  /// someone downloads it in Music. Without MusicKit and media-library access
  /// nothing is touched — MediaPlayer crashes rather than throwing without
  /// it — and without Sync Library nothing is added. Calls run one at a time.
  @objc public func prepareOffline(
    _ providerIds: [String], done: @escaping ([String: Any]) -> Void
  ) {
    Task { @MainActor in
      let previous = self.preparing
      self.preparing = Task { @MainActor in
        await previous?.value
        done(await self.prepare(providerIds))
      }
    }
  }

  @MainActor private func prepare(_ ids: [String]) async -> [String: Any] {
    var authorized = false
    if await Self.musicAuthorized(), await Self.mediaLibraryAuthorized() {
      authorized = true
    }
    var states: [String: String] = [:]
    var syncLibrary = false
    // A phone that cannot say (offline at a field) or has no Apple Music
    // subscription is not one the settings can help: `subscribed` says so,
    // and the notice stays off.
    var subscribed = false
    if authorized {
      if let subscription = try? await MusicSubscription.current {
        subscribed = subscription.canPlayCatalogContent
        syncLibrary = subscription.hasCloudLibraryEnabled
      }
      let index = await Self.libraryIndex(fresh: true)
      for id in ids {
        if let item = index[id] {
          states[id] = item.isCloudItem ? "pending" : "downloaded"
        }
      }
      if syncLibrary {
        let missing = ids.filter { states[$0] == nil }
        let catalog = await Self.catalogSongs(missing)
        for id in missing {
          guard let song = catalog[id] else { continue }
          do {
            try await MusicLibrary.shared.add(song)
            states[id] = "added"
          } catch {
            NSLog("WalkUpMusic could not add %@ to the library: %@", id, String(describing: error))
          }
        }
        await addToPlaylist(ids, catalog: catalog, index: index)
        // The adds changed the library: read it again, off the play path.
        if states.values.contains("added") { Self.refreshIndexInBackground() }
      }
    }
    let songs: [[String: Any]] = ids.map {
      ["providerId": $0, "state": states[$0] ?? "unavailable"]
    }
    let count = { (state: String) in songs.filter { $0["state"] as? String == state }.count }
    report([
      "kind": "offline",
      "authorized": authorized,
      "subscribed": subscribed,
      "syncLibrary": syncLibrary,
      "count": ids.count,
      "added": count("added"),
      "pending": count("pending"),
      "downloaded": count("downloaded"),
      "unavailable": count("unavailable"),
    ])
    for song in songs {
      report(["kind": "offlineSong", "providerId": song["providerId"]!, "state": song["state"]!])
    }
    return [
      "authorized": authorized, "subscribed": subscribed, "syncLibrary": syncLibrary,
      "songs": songs,
    ]
  }

  private static func musicAuthorized() async -> Bool {
    var status = MusicAuthorization.currentStatus
    if status == .notDetermined { status = await MusicAuthorization.request() }
    return status == .authorized
  }

  private static func mediaLibraryAuthorized() async -> Bool {
    var status = MPMediaLibrary.authorizationStatus()
    if status == .notDetermined {
      status = await withCheckedContinuation { continuation in
        MPMediaLibrary.requestAuthorization { continuation.resume(returning: $0) }
      }
    }
    return status == .authorized
  }

  /// The library's songs by catalog id, read off the main thread. `prepare`
  /// reads it fresh on the way into a game, and again in the background once
  /// it has added songs.
  private static func libraryIndex(fresh: Bool = false) async -> [String: MPMediaItem] {
    if !fresh, let held = indexCache.held { return held }
    let modified = MPMediaLibrary.default().lastModifiedDate
    let items = await Task.detached(priority: .userInitiated) { Self.librarySongs() }.value
    indexCache.set(items, modified: modified)
    return items
  }

  /// The index a walk-up plays from: the one held, so the plate never waits
  /// on a read of the whole library. When the library has changed since
  /// (an add, a download landing), the held one still serves this play and
  /// a fresh one is read in the background for the next.
  private static func playIndex() async -> [String: MPMediaItem] {
    guard let held = indexCache.held else { return await libraryIndex(fresh: true) }
    if indexCache.isStale(MPMediaLibrary.default().lastModifiedDate) { refreshIndexInBackground() }
    return held
  }

  private static func refreshIndexInBackground() {
    guard indexCache.beginRefresh() else { return }
    Task.detached(priority: .utility) {
      let modified = MPMediaLibrary.default().lastModifiedDate
      indexCache.set(Self.librarySongs(), modified: modified)
    }
  }

  private final class IndexCache: @unchecked Sendable {
    private let lock = NSLock()
    private var modified: Date?
    private var items: [String: MPMediaItem]?
    private var refreshing = false

    var held: [String: MPMediaItem]? {
      lock.lock()
      defer { lock.unlock() }
      return items
    }

    func isStale(_ now: Date) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      return modified != now
    }

    /// Whether this caller should start a refresh: one at a time.
    func beginRefresh() -> Bool {
      lock.lock()
      defer { lock.unlock() }
      if refreshing { return false }
      refreshing = true
      return true
    }

    func set(_ new: [String: MPMediaItem], modified: Date) {
      lock.lock()
      self.modified = modified
      items = new
      refreshing = false
      lock.unlock()
    }
  }

  private static let indexCache = IndexCache()

  /// The library's songs by catalog id. `playbackStoreID` cannot be filtered
  /// on, so the songs are read once and indexed.
  private static func librarySongs() -> [String: MPMediaItem] {
    var index: [String: MPMediaItem] = [:]
    for item in MPMediaQuery.songs().items ?? [] {
      let id = item.playbackStoreID
      guard !id.isEmpty, id != "0" else { continue }
      // A copy on the phone wins over a cloud-only duplicate.
      if let held = index[id], !held.isCloudItem { continue }
      index[id] = item
    }
    return index
  }

  private static func catalogSongs(_ ids: [String]) async -> [String: Song] {
    guard !ids.isEmpty else { return [:] }
    do {
      let request = MusicCatalogResourceRequest<Song>(
        matching: \.id, memberOf: ids.map { MusicItemID($0) })
      let response = try await request.response()
      var found: [String: Song] = [:]
      for song in response.items { found[song.id.rawValue] = song }
      return found
    } catch {
      NSLog("WalkUpMusic catalog lookup failed: %@", String(describing: error))
      return [:]
    }
  }

  private static func nameKey(_ title: String?, _ artist: String?) -> String {
    "\(title ?? "")\u{1F}\(artist ?? "")"
  }

  /// TeamStation's playlist: the one whose id was saved, then one by its
  /// name, and otherwise a new one.
  @MainActor private func playlist() async throws -> Playlist {
    let defaults = UserDefaults.standard
    if let saved = defaults.string(forKey: Self.playlistIdKey) {
      var request = MusicLibraryRequest<Playlist>()
      request.filter(matching: \.id, equalTo: MusicItemID(saved))
      if let found = try await request.response().items.first { return found }
    }
    let all = try await MusicLibraryRequest<Playlist>().response().items
    if let named = all.first(where: { $0.name == Self.playlistName }) {
      defaults.set(named.id.rawValue, forKey: Self.playlistIdKey)
      return named
    }
    let created = try await MusicLibrary.shared.createPlaylist(
      name: Self.playlistName, description: Self.playlistDescription)
    defaults.set(created.id.rawValue, forKey: Self.playlistIdKey)
    return created
  }

  /// Adds each song not already on the playlist. A failure here is logged:
  /// the songs are in the library either way, which is what downloads them.
  /// A playlist whose tracks cannot be read is left alone this time, rather
  /// than filled with second copies.
  @MainActor private func addToPlaylist(
    _ ids: [String], catalog known: [String: Song], index: [String: MPMediaItem]
  ) async {
    do {
      var list = try await playlist()
      // Every batch: a season's playlist outgrows the first. A read that
      // fails throws, and leaves the playlist alone this time.
      var all: [Track] = []
      var batch = try await list.with([.tracks]).tracks
      while let current = batch {
        all.append(contentsOf: current)
        batch = current.hasNextBatch ? try await current.nextBatch() : nil
      }
      // A track is known by its catalog id, or, when its play parameters
      // carry none, by its title and artist. A wanted song with that title
      // and artist — in the library, or as the catalog has it — is on the
      // playlist already: a second version of it is not worth a duplicate.
      var presentIds = Set<String>()
      var presentNames = Set<String>()
      for track in all {
        guard case .song(let song) = track else { continue }
        if let id = Self.catalogId(of: song) {
          presentIds.insert(id)
        } else {
          presentNames.insert(Self.nameKey(song.title, song.artistName))
        }
      }
      var catalog = known
      let unnamed = ids.filter { !presentIds.contains($0) && catalog[$0] == nil }
      if !presentNames.isEmpty {
        for (id, song) in await Self.catalogSongs(unnamed) { catalog[id] = song }
      }
      let wanted = ids.filter { id in
        if presentIds.contains(id) { return false }
        if let item = index[id], presentNames.contains(Self.nameKey(item.title, item.artist)) {
          return false
        }
        if let song = catalog[id], presentNames.contains(Self.nameKey(song.title, song.artistName)) {
          return false
        }
        return true
      }
      guard !wanted.isEmpty else { return }
      let fetch = wanted.filter { catalog[$0] == nil }
      for (id, song) in await Self.catalogSongs(fetch) { catalog[id] = song }
      // One song that will not go on does not keep the rest off.
      for id in wanted {
        guard let song = catalog[id] else { continue }
        do {
          list = try await MusicLibrary.shared.add(song, to: list)
        } catch {
          NSLog("WalkUpMusic could not add %@ to the playlist: %@", id, String(describing: error))
        }
      }
    } catch {
      NSLog("WalkUpMusic playlist failed: %@", String(describing: error))
    }
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
        let detail = Self.message(error)
        let message = Self.advice(error) ?? detail
        NSLog("WalkUpMusic play failed: %@", String(describing: error))
        var state: [String: Any] = ["kind": "error", "handle": handle, "message": message]
        if message != detail { state["detail"] = detail }
        self.report(state)
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
      // Best effort: a library lookup that fails falls back to the catalog,
      // which plays it online as before.
      do {
        if let stored = try await storedCopy(of: parts[1]) { return stored }
      } catch {
        NSLog("WalkUpMusic stored copy of %@ failed: %@", parts[1], String(describing: error))
      }
      let request = MusicCatalogResourceRequest<Song>(matching: \.id, equalTo: id)
      if let song = try await request.response().items.first { return song }
    }
    throw WalkUpMusicError.notFound
  }

  /// The library copy of a catalog song when it is stored on the phone, so
  /// it plays with no network: a catalog lookup needs one. A walk-up song
  /// resolves to its catalog id when the library search does not match it,
  /// even though the library holds it, downloaded, under that id.
  private static func storedCopy(of catalogId: String) async throws -> Song? {
    guard MPMediaLibrary.authorizationStatus() == .authorized else { return nil }
    guard let item = await playIndex()[catalogId], !item.isCloudItem, let title = item.title
    else {
      NSLog("WalkUpMusic has no copy of catalog:%@ on this phone", catalogId)
      return nil
    }
    // An equality filter finds nothing for some titles (an apostrophe, a
    // "feat." in parentheses), so the filter is the title's longest word —
    // the narrowest — and the match is made here.
    let words = title.split { (character: Character) -> Bool in
      !character.isLetter && !character.isNumber
    }
    let word = words.max { $0.count < $1.count }.map(String.init) ?? title
    var request = MusicLibraryRequest<Song>()
    request.filter(matching: \.title, contains: word)
    let songs = try await request.response().items
    // A library song does not always carry its catalog id in its play
    // parameters (which is why the search missed it). Then the one song with
    // the same title, by the same artist, of the same length to the second,
    // and as explicit, is the same song. A song that names another catalog
    // id is another version — the clean and explicit cuts of a track share
    // the rest — and two that fit, or none, are left to the catalog.
    let length = item.playbackDuration
    let alike = songs.filter {
      Self.catalogId(of: $0) == nil && $0.title == title
        && $0.artistName == item.artist
        && abs(($0.duration ?? -10) - length) < 1
        && ($0.contentRating == .explicit) == item.isExplicitItem
    }
    let found =
      songs.first { Self.catalogId(of: $0) == catalogId }
      ?? (alike.count == 1 ? alike.first : nil)
    if found != nil {
      NSLog("WalkUpMusic plays catalog:%@ from its copy on this phone", catalogId)
    } else {
      NSLog("WalkUpMusic found no library song for stored catalog:%@ (%d by title)", catalogId, songs.count)
    }
    return found
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
