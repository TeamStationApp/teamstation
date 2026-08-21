import Foundation
import GameController
import DirectorCore
import Observation

/// Watches connected GameController pads and digitalizes their elements into `ControlID`s.
@MainActor
@Observable
public final class RemoteInputSession {
  public var connectedName: String?
  public var connectedType: RemoteType?
  public var pressed: Set<ControlID> = []
  public var lastDown: ControlID?

  public var onDown: ((ControlID, Set<ControlID>) -> Void)?

  private var observers: [NSObjectProtocol] = []
  private var controller: GCController?
  private var knownDown: Set<ControlID> = []

  public init() {}

  public func start() {
    stop()
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: .GCControllerDidConnect,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in
        self?.attach(GCController.current ?? GCController.controllers().last)
      }
    })
    observers.append(center.addObserver(
      forName: .GCControllerDidDisconnect,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in
        self?.attach(GCController.current ?? GCController.controllers().last)
      }
    })
    attach(GCController.current ?? GCController.controllers().first)
  }

  public func stop() {
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers = []
    controller = nil
    pressed = []
    knownDown = []
  }

  public func inject(down id: ControlID) {
    var next = pressed
    next.insert(id)
    pressed = next
    lastDown = id
    knownDown = next
    onDown?(id, next)
  }

  public func inject(up id: ControlID) {
    var next = pressed
    next.remove(id)
    pressed = next
    knownDown = next
  }

  public func inject(chord ids: [ControlID]) {
    pressed = []
    knownDown = []
    for id in ids {
      inject(down: id)
    }
    for id in ids.reversed() {
      inject(up: id)
    }
  }

  private func attach(_ incoming: GCController?) {
    controller = incoming
    connectedName = incoming?.vendorName ?? incoming?.productCategory
    connectedType = incoming.map(Self.remoteType(for:))
    bindHandlers(incoming)
    refreshPressed()
  }

  public static func remoteType(for controller: GCController) -> RemoteType {
    let category = controller.productCategory
    if category == GCProductCategoryDualSense { return .dualSense }
    if category == GCProductCategoryDualShock4 { return .dualShock }
    if category == GCProductCategoryXboxOne { return .xbox }
    if category == GCProductCategoryMFi { return .mfi }
    let vendor = (controller.vendorName ?? "").lowercased()
    if vendor.contains("nintendo") { return .switchPro }
    return .hidGeneric
  }

  private func bindHandlers(_ controller: GCController?) {
    guard let gamepad = controller?.extendedGamepad else { return }
    gamepad.valueChangedHandler = { [weak self] _, _ in
      Task { @MainActor in
        self?.refreshPressed()
      }
    }
  }

  private func handle(_ pad: GCExtendedGamepad) {
    var down = digitalize(pad)
    if let dualShock = pad as? GCDualShockGamepad, dualShock.touchpadButton.isPressed {
      down.insert(.touchpadButton)
    }
    if let dualSense = pad as? GCDualSenseGamepad, dualSense.touchpadButton.isPressed {
      down.insert(.touchpadButton)
    }
    let profile = pad.controller?.physicalInputProfile
    if profile?.buttons[GCInputButtonShare]?.isPressed == true { down.insert(.share) }
    if profile?.buttons[GCInputXboxPaddleOne]?.isPressed == true { down.insert(.paddle1) }
    if profile?.buttons[GCInputXboxPaddleTwo]?.isPressed == true { down.insert(.paddle2) }
    if profile?.buttons[GCInputXboxPaddleThree]?.isPressed == true { down.insert(.paddle3) }
    if profile?.buttons[GCInputXboxPaddleFour]?.isPressed == true { down.insert(.paddle4) }
    let added = down.subtracting(knownDown)
    knownDown = down
    pressed = down
    for id in added {
      lastDown = id
      onDown?(id, down)
    }
  }

  private func refreshPressed() {
    guard let pad = controller?.extendedGamepad else {
      pressed = []
      knownDown = []
      return
    }
    handle(pad)
  }

  private func digitalize(_ pad: GCExtendedGamepad) -> Set<ControlID> {
    var down: Set<ControlID> = []
    if pad.buttonA.isPressed { down.insert(.a) }
    if pad.buttonB.isPressed { down.insert(.b) }
    if pad.buttonX.isPressed { down.insert(.x) }
    if pad.buttonY.isPressed { down.insert(.y) }
    if pad.dpad.up.isPressed { down.insert(.dpadUp) }
    if pad.dpad.down.isPressed { down.insert(.dpadDown) }
    if pad.dpad.left.isPressed { down.insert(.dpadLeft) }
    if pad.dpad.right.isPressed { down.insert(.dpadRight) }
    if pad.leftShoulder.isPressed { down.insert(.l1) }
    if pad.rightShoulder.isPressed { down.insert(.r1) }
    if RemoteDigitalizer.triggerPressed(pad.leftTrigger.value) { down.insert(.l2) }
    if RemoteDigitalizer.triggerPressed(pad.rightTrigger.value) { down.insert(.r2) }
    if pad.leftThumbstickButton?.isPressed == true { down.insert(.l3) }
    if pad.rightThumbstickButton?.isPressed == true { down.insert(.r3) }
    if pad.buttonMenu.isPressed { down.insert(.menu) }
    if pad.buttonOptions?.isPressed == true { down.insert(.options) }
    if pad.buttonHome?.isPressed == true { down.insert(.home) }
    if let id = RemoteDigitalizer.stick(
      x: pad.leftThumbstick.xAxis.value,
      y: pad.leftThumbstick.yAxis.value,
      left: true
    ) {
      down.insert(id)
    }
    if let id = RemoteDigitalizer.stick(
      x: pad.rightThumbstick.xAxis.value,
      y: pad.rightThumbstick.yAxis.value,
      left: false
    ) {
      down.insert(id)
    }
    return down
  }
}
