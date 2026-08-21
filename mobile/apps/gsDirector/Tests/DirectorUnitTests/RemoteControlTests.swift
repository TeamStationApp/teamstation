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
      RemoteBinding(action: .cutLive(1), chord: RemoteChord(controls: [ .l1, .a ]))
    ]
    #expect(RemoteChordRules.match(pressed: [ .a ], bindings: bindings) == .cutLive(0))
    #expect(RemoteChordRules.match(pressed: [ .l1, .a ], bindings: bindings) == .cutLive(1))
    #expect(RemoteChordRules.match(pressed: [ .l1 ], bindings: bindings) == nil)
    #expect(RemoteChordRules.match(pressed: [ .b ], bindings: bindings) == nil)
  }

  @Test("Empty chords never match")
  func emptyChordsNeverMatch() {
    let bindings = [ RemoteBinding(action: .cutLive(0), chord: RemoteChord()) ]
    #expect(RemoteChordRules.match(pressed: [ .a ], bindings: bindings) == nil)
  }

  @Test("Recording a chord on one action clears the same set on another")
  func duplicateChordIsUnique() {
    var bindings = [
      RemoteBinding(action: .cutLive(0), chord: RemoteChord(controls: [ .a ]))
    ]
    RemoteChordRules.append(.a, to: .cutLive(1), in: &bindings)
    #expect(bindings.contains { $0.action == .cutLive(0) } == false)
    #expect(bindings.first { $0.action == .cutLive(1) }?.chord.controls == [ .a ])
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
    #expect(xbox.kept.first { $0.action == .cutLive(0) }?.chord.controls == [ .a, .paddle1 ])
    #expect(xbox.kept.contains { $0.action == .cutLive(1) } == false)

    let dualShock = RemoteChordRules.bestFit(bindings: bindings, to: .dualShock)
    #expect(dualShock.kept.first { $0.action == .cutLive(0) }?.chord.controls == [ .a ])
    #expect(dualShock.kept.first { $0.action == .cutLive(1) }?.chord.controls == [ .touchpadButton ])
  }

  @Test("Catalog always lists 35 actions")
  func catalogHasThirtyFiveActions() {
    #expect(RemoteActionCatalog.all.count == 35)
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

  @Test("Assign-source uses 1-based index and slot")
  func assignSourceCommand() {
    let command = ControlChannel.command(
      from: URL(string: "gsdirector://test/assign-source?index=1&slot=3")!
    )
    #expect(command == .assignSource(index: 0, slot: 2))
  }
}
