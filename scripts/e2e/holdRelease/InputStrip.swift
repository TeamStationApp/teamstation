// A transparent, non-key window keeps the clock above the presented player.
private final class HoldClockWindow: UIWindow {
  override var canBecomeKey: Bool { false }
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
}

private extension UIApplication {
  @objc func holdProbeSendEvent(_ event: UIEvent) {
    for touch in event.allTouches ?? [] {
      guard touch.timestamp == event.timestamp else { continue }
      if touch.phase == .began || touch.phase == .ended {
        HoldInputStrip.active?.record(touch, up: touch.phase == .ended)
      }
    }
    holdProbeSendEvent(event)
  }
}

private final class HoldInputStrip: UIView {
  private var clock: CADisplayLink?
  private var words = Array(repeating: 0, count: 10)
  private var sequence = 0
  fileprivate static weak var active: HoldInputStrip?
  private static var overlay: HoldClockWindow?
  private static let observe: Void = {
    let original = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.sendEvent(_:)))!
    let probe = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.holdProbeSendEvent(_:)))!
    method_exchangeImplementations(original, probe)
  }()

  static func install(_ window: UIWindow) {
    guard let scene = window.windowScene else { return }
    if overlay?.windowScene === scene { return }
    _ = observe
    let display = HoldClockWindow(windowScene: scene)
    let controller = UIViewController()
    controller.view.backgroundColor = .clear
    display.backgroundColor = .clear
    display.rootViewController = controller
    display.windowLevel = .alert + 1
    display.isUserInteractionEnabled = false
    display.accessibilityElementsHidden = true
    let strip = HoldInputStrip(frame: .zero)
    strip.translatesAutoresizingMaskIntoConstraints = false
    controller.view.addSubview(strip)
    NSLayoutConstraint.activate([
      strip.leadingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.leadingAnchor, constant: 2),
      strip.topAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.topAnchor, constant: 2),
      strip.widthAnchor.constraint(equalToConstant: 104),
      strip.heightAnchor.constraint(equalToConstant: 40)
    ])
    overlay = display
    active = strip
    display.isHidden = false
    let clock = CADisplayLink(target: strip, selector: #selector(frame(_:)))
    clock.add(to: .main, forMode: .common)
    strip.clock = clock
  }
  override func willMove(toWindow newWindow: UIWindow?) {
    if newWindow == nil { clock?.invalidate() }
    super.willMove(toWindow: newWindow)
  }
  fileprivate func record(_ touch: UITouch, up: Bool) {
    guard let window else { return }
    let point = touch.location(in: window)
    let x = min(2047, max(0, Int(point.x / window.bounds.width * 2047)))
    let y = min(2047, max(0, Int(point.y / window.bounds.height * 2047)))
    let slot = 2 + 2 * (sequence % 4)
    words[slot] = Int(touch.timestamp * 1000)
    words[slot + 1] = (up ? 1 << 22 : 0) | (y << 11) | x
    sequence += 1
    words[1] = sequence
  }
  @objc private func frame(_ link: CADisplayLink) {
    setNeedsDisplay()
  }
  override func draw(_ rect: CGRect) {
    words[0] = Int(CACurrentMediaTime() * 1000)
    UIColor.black.setFill()
    UIRectFill(bounds)
    for (row, value) in words.enumerated() {
      for column in 0..<26 {
        if column == 0 { UIColor.magenta.setFill() }
        else if column == 25 { UIColor.cyan.setFill() }
        else if value & (1 << (column - 1)) != 0 { UIColor.white.setFill() }
        else { continue }
        UIRectFill(CGRect(x: column * 4, y: row * 4, width: 4, height: 4))
      }
    }
  }
}
