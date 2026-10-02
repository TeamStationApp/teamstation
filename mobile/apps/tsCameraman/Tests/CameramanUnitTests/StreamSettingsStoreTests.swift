import CameramanCore
import Foundation
import Testing

/// Settings have to survive the app being killed, which is how it is always ended — the operator
/// swipes it away or iOS reclaims it in the background, and neither offers a chance to save on exit.
@Suite("Stream settings store")
struct StreamSettingsStoreTests {
  private func store() -> (StreamSettingsStore, InMemorySettingsStore) {
    let backing = InMemorySettingsStore()
    return (StreamSettingsStore(store: backing, legacyDefaults: nil), backing)
  }

  @Test("A camera that has never been configured has nothing saved")
  func loadsNothingWhenNeverSaved() {
    let (settings, _) = store()
    #expect(settings.load() == nil)
  }

  @Test("Every field survives a save and load")
  func roundTripsEveryField() throws {
    let (persistence, _) = store()
    var written = StreamSettings()
    written.codec = .h264
    written.bitrate = 9_000_000
    written.width = 1280
    written.height = 720
    written.frameRate = 60
    written.audioEnabled = false
    written.port = 9554
    written.path = "/live/other"
    written.disabledLensIDs = [ "uw", "tele" ]
    written.cleanHDMIEnabled = false

    persistence.save(written)
    let read = try #require(persistence.load())
    #expect(read == written)
  }

  @Test("Settings saved before the clean HDMI toggle existed come back with it on")
  func legacyBlobWithoutCleanHDMIDecodesToOn() throws {
    // The store treats a decode failure as "never configured", so a missing key must decode
    // rather than throw, and it must decode to the default the operator never chose against.
    let backing = InMemorySettingsStore(
      values: [ StreamSettingsStore.settingsKey: #"{"codec":"h264","bitrate":6000000}"# ]
    )
    let persistence = StreamSettingsStore(store: backing, legacyDefaults: nil)
    let read = try #require(persistence.load())
    #expect(read.codec == .h264)
    #expect(read.cleanHDMIEnabled)
  }

  @Test("A port saved as 554 by an older build loads as the shared 8554")
  func retiredPortLoadsAsTheSharedPort() throws {
    // Director sweeps one Cameraman port. An iPhone that kept its saved 554 after the update would
    // be the one camera the sweep never finds.
    let backing = InMemorySettingsStore(
      values: [ StreamSettingsStore.settingsKey: #"{"codec":"h264","port":554}"# ]
    )
    let read = try #require(StreamSettingsStore(store: backing, legacyDefaults: nil).load())
    #expect(read.port == 8554)
    #expect(read.codec == .h264)
  }

  @Test("A later save replaces the previous one")
  func lastWriteWins() throws {
    let (persistence, _) = store()
    var first = StreamSettings()
    first.codec = .h264
    persistence.save(first)
    var second = StreamSettings()
    second.codec = .hevc
    persistence.save(second)
    #expect(try #require(persistence.load()).codec == .hevc)
  }

  @Test("Unreadable stored text is ignored rather than crashing the launch")
  func corruptValueIsIgnored() {
    let backing = InMemorySettingsStore(
      values: [ StreamSettingsStore.settingsKey: "{not json" ]
    )
    let persistence = StreamSettingsStore(store: backing, legacyDefaults: nil)
    #expect(persistence.load() == nil)
  }

  @Test("Lens choices saved by the older build are still honoured")
  func legacyLensChoicesAreRead() throws {
    let suite = "app.teamstation.cameraman.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    defaults.set([ "uw", "tele" ], forKey: StreamSettingsStore.legacyDisabledLensesKey)
    defer { defaults.removePersistentDomain(forName: suite) }

    let persistence = StreamSettingsStore(
      store: InMemorySettingsStore(),
      legacyDefaults: defaults
    )
    #expect(try #require(persistence.load()).disabledLensIDs == Set([ "uw", "tele" ]))
  }

  @Test("A full saved set takes precedence over the older lens key")
  func savedSetWinsOverLegacy() throws {
    let suite = "app.teamstation.cameraman.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    defaults.set([ "uw" ], forKey: StreamSettingsStore.legacyDisabledLensesKey)
    defer { defaults.removePersistentDomain(forName: suite) }

    let persistence = StreamSettingsStore(
      store: InMemorySettingsStore(),
      legacyDefaults: defaults
    )
    var written = StreamSettings()
    written.disabledLensIDs = [ "tele" ]
    persistence.save(written)
    #expect(try #require(persistence.load()).disabledLensIDs == Set([ "tele" ]))
  }
}

@Suite("Stream settings merge")
struct StreamSettingsMergeTests {
  @Test("HEVC is the default codec, at its own default rate")
  func hevcIsTheDefault() {
    #expect(StreamSettings.default.codec == .hevc)
    #expect(StreamSettings.default.bitrate == StreamCodec.hevc.defaultBitrate)
    #expect(StreamSettings.default.bitrate == 4_000_000)
  }

  @Test("A saved codec replaces the default when no launch argument named it")
  func savedCodecWins() {
    var saved = StreamSettings()
    saved.codec = .h264
    saved.bitrate = 6_000_000
    let merged = StreamSettings.default.merging(saved: saved, keeping: [])
    #expect(merged.codec == .h264)
    #expect(merged.bitrate == 6_000_000)
  }

  @Test("An explicit launch argument beats what was saved")
  func explicitLaunchArgumentWins() {
    var launched = StreamSettings()
    launched.codec = .h264
    var saved = StreamSettings()
    saved.codec = .hevc
    let merged = launched.merging(saved: saved, keeping: [ .codec ])
    #expect(merged.codec == .h264)
  }

  @Test("Only the pinned field is held; the rest still comes back from disk")
  func unpinnedFieldsStillMerge() {
    var saved = StreamSettings()
    saved.width = 1280
    saved.height = 720
    saved.frameRate = 60
    saved.audioEnabled = false
    saved.disabledLensIDs = [ "uw" ]
    saved.cleanHDMIEnabled = false
    let merged = StreamSettings.default.merging(saved: saved, keeping: [ .codec ])
    #expect(merged.width == 1280)
    #expect(merged.height == 720)
    #expect(merged.frameRate == 60)
    #expect(merged.audioEnabled == false)
    #expect(merged.disabledLensIDs == Set([ "uw" ]))
    #expect(merged.cleanHDMIEnabled == false)
    #expect(merged.codec == StreamSettings.default.codec)
  }

  @Test("Clean HDMI is on by default and a launch that pins it beats the saved value")
  func cleanHDMIDefaultsOnAndCanBePinned() {
    #expect(StreamSettings.default.cleanHDMIEnabled)
    var saved = StreamSettings()
    saved.cleanHDMIEnabled = false
    #expect(StreamSettings.default.merging(saved: saved, keeping: [ .cleanHDMI ]).cleanHDMIEnabled)
    #expect(StreamSettings.default.merging(saved: saved, keeping: []).cleanHDMIEnabled == false)
  }

  @Test("A blanked camera comes back showing a picture")
  func videoEnabledIsNeverRestored() {
    var saved = StreamSettings()
    saved.videoEnabled = false
    let merged = StreamSettings.default.merging(saved: saved, keeping: [])
    #expect(merged.videoEnabled)
  }

  @Test("Changing codec carries that codec's default rate across")
  func codecChangeCarriesItsDefaultRate() {
    var settings = StreamSettings()
    #expect(settings.bitrate == StreamCodec.hevc.defaultBitrate)
    settings.setCodec(.h264)
    #expect(settings.bitrate == StreamCodec.h264.defaultBitrate)
    settings.setCodec(.hevc)
    #expect(settings.bitrate == StreamCodec.hevc.defaultBitrate)
  }

  @Test("A rate the operator chose themselves is left alone across a codec change")
  func chosenRateSurvivesACodecChange() {
    var settings = StreamSettings()
    settings.bitrate = 9_000_000
    settings.setCodec(.h264)
    #expect(settings.bitrate == 9_000_000)
  }

  @Test("Adaptive bitrate is on by default, survives a save, and older saves come back with it on")
  func adaptiveBitrateDefaultsOn() {
    #expect(StreamSettings.default.adaptiveBitrate)

    let store = StreamSettingsStore(store: InMemorySettingsStore(), legacyDefaults: nil)
    var written = StreamSettings()
    written.adaptiveBitrate = false
    store.save(written)
    #expect(store.load()?.adaptiveBitrate == false)

    let older = StreamSettingsStore(
      store: InMemorySettingsStore(values: [ StreamSettingsStore.settingsKey: #"{"codec":"h264","bitrate":6000000}"# ]),
      legacyDefaults: nil
    )
    #expect(older.load()?.adaptiveBitrate == true)
  }

  @Test("The floor survives a save, and settings saved before it existed come back at half the rate")
  func bitrateFloorPersists() {
    let persistence = StreamSettingsStore(store: InMemorySettingsStore(), legacyDefaults: nil)
    var written = StreamSettings()
    written.bitrateFloor = 1_500_000
    persistence.save(written)
    #expect(persistence.load()?.bitrateFloor == 1_500_000)

    let older = StreamSettingsStore(
      store: InMemorySettingsStore(values: [ StreamSettingsStore.settingsKey: #"{"codec":"h264","bitrate":6000000}"# ]),
      legacyDefaults: nil
    )
    #expect(older.load()?.bitrateFloor == 3_000_000)

    let inverted = StreamSettingsStore(
      store: InMemorySettingsStore(values: [ StreamSettingsStore.settingsKey: #"{"bitrate":4000000,"bitrateFloor":9000000}"# ]),
      legacyDefaults: nil
    )
    #expect(inverted.load()?.bitrateFloor == 4_000_000, "never above the rate")
  }

  @Test("A codec change moves a default floor with the default rate, and leaves a chosen one alone")
  func codecChangeCarriesTheDefaultFloor() {
    var settings = StreamSettings()
    #expect(settings.bitrateFloor == 2_000_000)
    settings.setCodec(.h264)
    #expect(settings.bitrateFloor == 3_000_000)
    settings.bitrateFloor = 1_500_000
    settings.setCodec(.hevc)
    #expect(settings.bitrate == 4_000_000)
    #expect(settings.bitrateFloor == 1_500_000)
  }

  @Test("A new rate carries a default floor at half, keeps a chosen one, and never leaves it above")
  func newRateAndTheFloor() {
    var settings = StreamSettings()
    settings.setBitrate(10_000_000)
    #expect(settings.bitrateFloor == 5_000_000)
    settings.bitrateFloor = 3_000_000
    settings.setBitrate(12_000_000)
    #expect(settings.bitrateFloor == 3_000_000)
    settings.setBitrate(2_000_000)
    #expect(settings.bitrateFloor == 2_000_000)

    #expect(StreamSettings(bitrate: 1_500_000).bitrateFloor == 1_000_000, "the default is not below 1 Mbps")
    #expect(StreamSettings(bitrate: 4_000_000, bitrateFloor: 6_000_000).bitrateFloor == 4_000_000)
  }

  @Test("A pinned rate brings its own floor; otherwise the saved floor comes back under the rate")
  func mergingTheFloor() {
    var saved = StreamSettings()
    saved.setBitrate(10_000_000)
    saved.bitrateFloor = 7_000_000

    var pinnedRate = StreamSettings()
    pinnedRate.setBitrate(6_000_000)
    let merged = pinnedRate.merging(saved: saved, keeping: [ .bitrateMbps ])
    #expect(merged.bitrate == 6_000_000)
    #expect(merged.bitrateFloor == 3_000_000)

    #expect(StreamSettings.default.merging(saved: saved, keeping: []).bitrateFloor == 7_000_000)

    var pinnedFloor = StreamSettings()
    pinnedFloor.bitrateFloor = 1_500_000
    let floorKept = pinnedFloor.merging(saved: saved, keeping: [ .bitrateFloorMbps ])
    #expect(floorKept.bitrate == 10_000_000)
    #expect(floorKept.bitrateFloor == 1_500_000)
  }

  @Test("Every persisted field has a launch-argument name")
  func fieldNamesMatchLaunchArguments() {
    #expect(
      Set(StreamSettings.Field.allCases.map(\.rawValue)) == Set([
        "codec", "bitrateMbps", "bitrateFloorMbps", "adaptiveBitrate", "width", "height", "frameRate",
        "audioEnabled", "rtspPort", "rtspPath", "disabledLenses", "cleanHdmi"
      ])
    )
  }
}
