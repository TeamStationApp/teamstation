import Foundation
import DirectorCore
import DirectorSources
import DirectorTestHarness
import DirectorUI
import Testing

@Suite("Remote control chords")
struct RemoteControlTests {
  @Test("Most-specific subset wins")
  func mostSpecificSubsetWins() {
    let bindings = [
      RemoteBinding(action: .cutLive(0), chord: RemoteChord(controls: [ .a ])),
      RemoteBinding(
        action: .instantReplay(source: 0, seconds: 5, speed: .full),
        chord: RemoteChord(controls: [ .a, .l1 ])
      )
    ]
    #expect(RemoteChordRules.match(pressed: [ .a ], bindings: bindings) == .cutLive(0))
    #expect(
      RemoteChordRules.match(pressed: [ .l1, .a ], bindings: bindings)
        == .instantReplay(source: 0, seconds: 5, speed: .full)
    )
    #expect(RemoteChordRules.match(pressed: [ .l1 ], bindings: bindings) == nil)
    #expect(RemoteChordRules.match(pressed: [ .b ], bindings: bindings) == nil)
  }

  @Test("Empty chords never match")
  func emptyChordsNeverMatch() {
    let bindings = [ RemoteBinding(action: .cutLive(0), chord: RemoteChord()) ]
    #expect(RemoteChordRules.match(pressed: [ .a ], bindings: bindings) == nil)
  }

  @Test("A primary cannot be used by two sources")
  func duplicatePrimaryIsStolen() {
    var bindings = [
      RemoteBinding(action: .cutLive(0), chord: RemoteChord(controls: [ .a ]))
    ]
    RemoteChordRules.setPrimary(.a, source: 1, in: &bindings)
    #expect(RemoteChordRules.primary(source: 0, in: bindings) == nil)
    #expect(RemoteChordRules.primary(source: 1, in: bindings) == .a)
  }

  @Test("Setting a primary rewrites that source's rewind chords")
  func primaryRewritesRewind() {
    var bindings: [RemoteBinding] = []
    RemoteChordRules.setPrimary(.dpadLeft, source: 0, in: &bindings)
    RemoteChordRules.setModifier(
      .l1,
      for: .instantReplay(source: 0, seconds: 5, speed: .full),
      in: &bindings
    )
    RemoteChordRules.setPrimary(.dpadRight, source: 0, in: &bindings)
    #expect(RemoteChordRules.primary(source: 0, in: bindings) == .dpadRight)
    #expect(
      bindings.first {
        $0.action == .instantReplay(source: 0, seconds: 5, speed: .full)
      }?.chord.controls == [ .dpadRight, .l1 ]
    )
  }

  @Test("A modifier equal to any primary is ignored")
  func modifierMatchingPrimaryIsIgnored() {
    var bindings: [RemoteBinding] = []
    RemoteChordRules.setPrimary(.a, source: 0, in: &bindings)
    RemoteChordRules.setModifier(
      .a,
      for: .instantReplay(source: 0, seconds: 5, speed: .full),
      in: &bindings
    )
    #expect(
      RemoteChordRules.globalModifier(seconds: 5, speed: .full, in: bindings) == nil
    )
  }

  @Test("Two rewind kinds cannot share a modifier")
  func duplicateModifierIsStolen() {
    var bindings: [RemoteBinding] = []
    RemoteChordRules.setPrimary(.a, source: 0, in: &bindings)
    let five = RemoteAction.instantReplay(source: 0, seconds: 5, speed: .full)
    let ten = RemoteAction.instantReplay(source: 0, seconds: 10, speed: .full)
    RemoteChordRules.setModifier(.l1, for: five, in: &bindings)
    RemoteChordRules.setModifier(.l1, for: ten, in: &bindings)
    #expect(RemoteChordRules.globalModifier(seconds: 5, speed: .full, in: bindings) == nil)
    #expect(RemoteChordRules.globalModifier(seconds: 10, speed: .full, in: bindings) == .l1)
  }

  @Test("A rewind modifier applies to every source")
  func modifierIsSharedAcrossSources() {
    var bindings: [RemoteBinding] = []
    RemoteChordRules.setPrimary(.dpadLeft, source: 0, in: &bindings)
    RemoteChordRules.setPrimary(.dpadRight, source: 1, in: &bindings)
    RemoteChordRules.setModifier(
      .l1,
      for: .instantReplay(source: 0, seconds: 5, speed: .full),
      in: &bindings
    )
    #expect(
      bindings.first {
        $0.action == .instantReplay(source: 0, seconds: 5, speed: .full)
      }?.chord.controls == [ .dpadLeft, .l1 ]
    )
    #expect(
      bindings.first {
        $0.action == .instantReplay(source: 1, seconds: 5, speed: .full)
      }?.chord.controls == [ .dpadRight, .l1 ]
    )
    #expect(
      RemoteChordRules.match(
        pressed: [ .dpadRight, .l1 ],
        bindings: bindings
      ) == .instantReplay(source: 1, seconds: 5, speed: .full)
    )
  }

  @Test("Editor labels are sourceN:live and rewind amounts")
  func editorLabels() {
    #expect(RemoteAction.cutLive(0).editorTargetLabel(slowMotionPercent: 0.5) == "source1:live")
    #expect(RemoteAction.cutLive(1).editorRoleLabel == "primary")
    #expect(
      RemoteAction.instantReplay(source: 0, seconds: 5, speed: .full)
        .editorTargetLabel(slowMotionPercent: 0.5) == "rewind 5 seconds"
    )
    #expect(
      RemoteAction.instantReplay(source: 0, seconds: 7.5, speed: .slow)
        .editorTargetLabel(slowMotionPercent: 0.5) == "rewind 7.5 seconds ×50%"
    )
    #expect(
      RemoteAction.instantReplay(source: 0, seconds: 5, speed: .full).editorRoleLabel == "modifier"
    )
  }

  @Test("Analog sticks digitalize on the dominant axis past the deadzone")
  func analogDeadzoneAndDominantAxis() {
    #expect(RemoteDigitalizer.stick(x: -0.8, y: 0.1, left: true) == .leftStickLeft)
    #expect(RemoteDigitalizer.stick(x: 0.2, y: 0.9, left: false) == .rightStickUp)
    #expect(RemoteDigitalizer.stick(x: -0.3, y: 0.2, left: true) == nil)
    #expect(RemoteDigitalizer.triggerPressed(0.74) == false)
    #expect(RemoteDigitalizer.triggerPressed(0.75) == true)
  }

  @Test("Switching remote type drops controls the new type does not have")
  func typeSwitchBestFit() {
    let bindings = [
      RemoteBinding(action: .cutLive(0), chord: RemoteChord(controls: [ .a, .paddle1 ])),
      RemoteBinding(action: .cutLive(1), chord: RemoteChord(controls: [ .touchpadButton ]))
    ]
    let xbox = RemoteChordRules.bestFit(bindings: bindings, to: .xbox)
    #expect(xbox.kept.first { $0.action == .cutLive(0) }?.chord.controls == [ .a ])
    #expect(xbox.kept.contains { $0.action == .cutLive(1) } == false)

    let dualShock = RemoteChordRules.bestFit(bindings: bindings, to: .dualShock)
    #expect(dualShock.kept.first { $0.action == .cutLive(0) }?.chord.controls == [ .a ])
    #expect(dualShock.kept.first { $0.action == .cutLive(1) }?.chord.controls == [ .touchpadButton ])
  }

  @Test("Catalog always lists 35 actions")
  func catalogHasThirtyFiveActions() {
    #expect(RemoteActionCatalog.all.count == 35)
  }

  @Test("Editor lists five primaries then six shared rewind modifiers")
  func editorRowsArePrimariesThenSharedRewinds() {
    #expect(RemoteActionCatalog.editorActions.map(\.id) == [
      "live-0", "live-1", "live-2", "live-3", "live-4",
      "replay-0-5-full", "replay-0-7.5-full", "replay-0-10-full",
      "replay-0-5-slow", "replay-0-7.5-slow", "replay-0-10-slow"
    ])
  }

  @Test("Repeated presses of the same control stay one entry")
  func repeatedPressIsDeduped() {
    var chord = RemoteChord()
    chord.append(.a)
    chord.append(.a)
    chord.append(.r1)
    chord.append(.a)
    #expect(chord.controls == [ .a, .r1 ])
  }

  @Test("D-pad and each stick keep only the last direction")
  func exclusiveDirectionsLastWins() {
    var chord = RemoteChord(controls: [ .dpadUp, .a ])
    chord.append(.dpadRight)
    chord.append(.leftStickUp)
    chord.append(.leftStickLeft)
    chord.append(.rightStickDown)
    chord.append(.rightStickUp)
    #expect(chord.controls == [ .a, .dpadRight, .leftStickLeft, .rightStickUp ])
    #expect(RemoteChord(controls: [ .dpadUp, .dpadRight ]).controls == [ .dpadRight ])
  }

  @Test("Control-channel action ids are 1-based")
  func parseControlAction() {
    #expect(RemoteAction.parseControl("live-2") == .cutLive(1))
    #expect(RemoteAction.parseControl("replay-1-7.5-slow") == .instantReplay(
      source: 0,
      seconds: 7.5,
      speed: .slow
    ))
    #expect(RemoteAction.parseControl("live-6") == nil)
  }
}

@Suite("Source assignment")
struct SourceAssignmentTests {
  private func camera(_ name: String, enabled: Bool = false, slot: Int? = nil) -> SourceSelection {
    SourceSelection(
      id: SourceID(name),
      kind: .synthetic,
      advertisedName: name,
      isEnabled: enabled,
      sourceIndex: slot
    )
  }

  @Test("Disable keeps the preferred slot")
  func disableKeepsPreferredSlot() {
    var selections = [ camera("CAM1") ]
    #expect(SourceSelectionRules.setEnabled(true, for: SourceID("CAM1"), in: &selections) == .enabled(sourceIndex: 0))
    #expect(SourceSelectionRules.setEnabled(false, for: SourceID("CAM1"), in: &selections) == .disabled)
    #expect(selections[0].sourceIndex == 0)
    #expect(selections[0].isEnabled == false)
    #expect(SourceSelectionRules.setEnabled(true, for: SourceID("CAM1"), in: &selections) == .enabled(sourceIndex: 0))
  }

  @Test("Re-enable takes the first free slot when the preferred one is occupied")
  func reenableTakesFirstFreeWhenPreferredOccupied() {
    var selections = [ camera("CAM1", enabled: false, slot: 0), camera("CAM2") ]
    #expect(SourceSelectionRules.setEnabled(true, for: SourceID("CAM2"), in: &selections) == .enabled(sourceIndex: 0))
    #expect(SourceSelectionRules.setEnabled(true, for: SourceID("CAM1"), in: &selections) == .enabled(sourceIndex: 1))
    #expect(selections[0].sourceIndex == 1)
  }

  @Test("Assigning a live camera to an occupied slot swaps them")
  func assignSwapsLiveSlots() {
    var selections = [
      camera("CAM1", enabled: true, slot: 0),
      camera("CAM2", enabled: true, slot: 1)
    ]
    let result = SourceSelectionRules.assign(slot: 1, to: SourceID("CAM1"), in: &selections)
    #expect(result == .applied(reassign: .init(from: 0, to: 1)))
    #expect(selections[0].sourceIndex == 1)
    #expect(selections[1].sourceIndex == 0)
  }

  @Test("Legacy tileIndex JSON still decodes as sourceIndex")
  func legacyTileIndexDecodes() throws {
    let json = Data("""
    [{"id":{"rawValue":"CAM1"},"kind":"synthetic","advertisedName":"CAM1","isEnabled":true,"tileIndex":2,"isPresent":true}]
    """.utf8)
    let decoded = try JSONDecoder().decode([SourceSelection].self, from: json)
    #expect(decoded[0].sourceIndex == 2)
  }
}

@Suite("Control channel source query")
struct ControlChannelSourceTests {
  @Test("Accepts source= and the pre-rename tile= query")
  func sourceOrTileQuery() {
    let source = ControlChannel.command(from: URL(string: "gsdirector://test/program?source=2")!)
    let tile = ControlChannel.command(from: URL(string: "gsdirector://test/program?tile=2")!)
    #expect(source == .selectProgram(source: 1))
    #expect(tile == .selectProgram(source: 1))
  }

  @Test("Parses remote chord and bind commands")
  func remoteCommands() {
    let bind = ControlChannel.command(
      from: URL(string: "gsdirector://test/bind-remote?action=live-2&controls=l1,a")!
    )
    let chord = ControlChannel.command(
      from: URL(string: "gsdirector://test/remote-chord?controls=a")!
    )
    #expect(bind == .bindRemote(action: "live-2", controls: [ "l1", "a" ]))
    #expect(chord == .remoteChord(controls: [ "a" ]))
  }

  @Test("Parses replay command")
  func replayCommand() {
    let full = ControlChannel.command(
      from: URL(string: "gsdirector://test/replay?source=2&seconds=7.5&speed=full")!
    )
    let slow = ControlChannel.command(
      from: URL(string: "gsdirector://test/replay?source=1&seconds=5&speed=slow")!
    )
    #expect(full == .replay(source: 1, seconds: 7.5, speed: "full"))
    #expect(slow == .replay(source: 0, seconds: 5, speed: "slow"))
    #expect(
      ControlChannel.command(
        from: URL(string: "gsdirector://test/replay?source=1&seconds=5&speed=bogus")!
      ) == nil
    )
  }

  @Test("Link-source and unlink-source use 1-based row indices")
  func linkSourceCommands() {
    let link = ControlChannel.command(
      from: URL(string: "gsdirector://test/link-source?video=1&control=3")!
    )
    #expect(link == .linkSource(video: 0, control: 2))
    #expect(ControlChannel.command(from: URL(string: "gsdirector://test/link-source?video=1")!) == nil)
    let unlink = ControlChannel.command(from: URL(string: "gsdirector://test/unlink-source?index=3")!)
    #expect(unlink == .unlinkSource(index: 2))
  }

  @Test("Assign-source uses 1-based index and slot")
  func assignSourceCommand() {
    let command = ControlChannel.command(
      from: URL(string: "gsdirector://test/assign-source?index=1&slot=3")!
    )
    #expect(command == .assignSource(index: 0, slot: 2))
  }

  @Test("Source-layout uses 1-based source numbers in visual-slot order")
  func sourceLayoutCommand() {
    let command = ControlChannel.command(
      from: URL(string: "gsdirector://test/source-layout?order=5,1,2,3,4")!
    )
    #expect(command == .sourceLayout(order: [4, 0, 1, 2, 3]))
    #expect(
      ControlChannel.command(from: URL(string: "gsdirector://test/source-layout?order=1,2")!) == nil
    )
  }

  @Test("Source-gain uses 1-based index and 0...1 gain")
  func sourceGainCommand() {
    let command = ControlChannel.command(
      from: URL(string: "gsdirector://test/source-gain?index=2&gain=0.75")!
    )
    #expect(command == .sourceGain(index: 1, gain: 0.75))
  }

  @Test("Parses kill-program-writer")
  func killProgramWriterCommand() {
    let command = ControlChannel.command(
      from: URL(string: "gsdirector://test/kill-program-writer")!
    )
    #expect(command == .killProgramWriter)
  }

  @Test("Parses export-recording")
  func exportRecordingCommand() {
    let command = ControlChannel.command(
      from: URL(string: "gsdirector://test/export-recording")!
    )
    #expect(command == .exportRecording(reprocess: false))
    #expect(
      ControlChannel.command(from: URL(string: "gsdirector://test/export-recording?reprocess=1")!)
        == .exportRecording(reprocess: true)
    )
  }
}

@Suite("Subnet scan command")
struct SubnetScanCommandTests {
  @Test("subnet-scan sets the subnet to sweep and its switch; with neither it is refused")
  func parses() {
    #expect(
      ControlChannel.command(from: URL(string: "gsdirector://test/subnet-scan?subnet=192.168.6.0&on=1")!)
        == .setSubnetScan(subnet: "192.168.6.0", on: true)
    )
    #expect(
      ControlChannel.command(from: URL(string: "gsdirector://test/subnet-scan?on=0")!)
        == .setSubnetScan(subnet: nil, on: false)
    )
    #expect(
      ControlChannel.command(from: URL(string: "gsdirector://test/subnet-scan?subnet=192.168.6.0,192.168.7.0")!)
        == .setSubnetScan(subnet: "192.168.6.0,192.168.7.0", on: nil)
    )
    #expect(ControlChannel.command(from: URL(string: "gsdirector://test/subnet-scan")!) == nil)
  }
}
