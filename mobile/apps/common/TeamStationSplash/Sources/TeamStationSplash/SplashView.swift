#if canImport(UIKit)
  import ImageIO
  import TeamStationSplashCore
  import UIKit

  /// The splash, drawn with Core Animation: one layer per layer of the
  /// timeline, animated by keyframe animations with the timeline's per-segment
  /// curves, so it runs in the render server while the main thread starts
  /// React Native. It lays itself out again when its size changes, and picks
  /// the animation up where it was.
  @MainActor
  public final class SplashView: UIView {
    /// The moment it draws and holds instead of playing (the test hook).
    public let frozenMs: Double?

    let base = CAGradientLayer()
    /// Frame 0 as the launch storyboard draws it, until the 4K stadium has decoded.
    let placeholder = CALayer()
    let stadium = CALayer()
    let stadiumSharp = CALayer()
    let stadiumBlurred = CALayer()
    let dimming = CALayer()
    let dark = CAGradientLayer()
    let vignette = CAGradientLayer()
    let glow = CAGradientLayer()
    let brand = CALayer()
    let markSharp = CALayer()
    let markBlurred = CALayer()
    let wordmarkMove = CALayer()
    let wordmark = CALayer()
    let wordmarkSharp = CALayer()
    let wordmarkBlurred = CALayer()

    /// When the timeline started, in media time; nil until the stadium has decoded.
    private(set) var startedAt: CFTimeInterval?
    private var laidOutFor: CGSize = .zero
    private var contentReady = false

    public init(frame: CGRect, frozenMs: Double?) {
      self.frozenMs = frozenMs
      super.init(frame: frame)
      backgroundColor = .black
      isAccessibilityElement = true
      accessibilityLabel = "TeamStation"
      accessibilityIdentifier = "tsSplash"
      accessibilityViewIsModal = true
      accessibilityTraits = .image
      for sublayer in [base, stadium, dark, placeholder, vignette, glow, brand] { layer.addSublayer(sublayer) }
      for sublayer in [stadiumSharp, stadiumBlurred, dimming] { stadium.addSublayer(sublayer) }
      for sublayer in [markSharp, markBlurred, wordmarkMove] { brand.addSublayer(sublayer) }
      wordmarkMove.addSublayer(wordmark)
      for sublayer in [wordmarkSharp, wordmarkBlurred] { wordmark.addSublayer(sublayer) }
      dimming.backgroundColor = UIColor.black.cgColor
      stadium.anchorPoint = CGPoint(x: SplashTimeline.focusX, y: SplashTimeline.focusY)
      for gradient in [base, dark, vignette, glow] { gradient.type = .radial }
      paint(base, SplashTimeline.base)
      paint(dark, SplashTimeline.dark)
      paint(vignette, SplashTimeline.vignette)
      paint(glow, SplashTimeline.glow)
      // Frame 0 is on screen as soon as the view is: the one image decoded here.
      placeholder.contents = Self.image("splashLaunchFrame", "jpg")
      placeholder.contentsGravity = .resizeAspectFill
      placeholder.masksToBounds = true
      for image in [stadiumSharp, stadiumBlurred, markSharp, markBlurred, wordmarkSharp, wordmarkBlurred] {
        image.contentsGravity = .resize
      }
      // The brand's blur is a cross-fade whose weights sum to one: the blurred image is added to
      // the sharp one rather than laid over it, so an opaque glyph stays opaque all through the
      // blur, as CSS's blur() keeps it. Whenever the blur is above 0 the brand's and wordmark's
      // opacity is below 1, so each is drawn as a group of its own and the sum is of the pair alone.
      for image in [markBlurred, wordmarkBlurred] { image.compositingFilter = "plusL" }
      updateValue()
      apply(SplashSampler.frame(ms: frozenMs ?? 0))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// Decodes the brand and the 4K stadium off the main thread, then starts
    /// the timeline. Until then the view shows frame 0 from the small launch
    /// frame, as the launch storyboard does; the brand is not yet visible in
    /// it. `decoded` runs once the timeline has started.
    public func start(decoded: (@MainActor () -> Void)? = nil) {
      DispatchQueue.global(qos: .userInitiated).async {
        let images = SplashImages.decode()
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            self.begin(with: images)
            decoded?()
          }
        }
      }
    }

    /// Shows `images` and starts the timeline from its first frame, when the
    /// animations reach the screen.
    func begin(with images: SplashImages?) {
      // Without the stadium, frame 0 stays the small launch frame under the brand.
      stadiumSharp.contents = images?.stadium
      stadiumBlurred.contents = images?.stadiumBlurred
      markSharp.contents = images?.mark
      markBlurred.contents = images?.markBlurred
      wordmarkSharp.contents = images?.wordmark
      wordmarkBlurred.contents = images?.wordmarkBlurred
      if images?.stadium != nil { placeholder.removeFromSuperlayer() }
      startedAt = CACurrentMediaTime()
      layoutLayers(force: true, fromMs: 0)
      // Commit now, and count from the commit, so the animations begin at the moment the dismissal
      // timers count from, however long the rest of this turn of the main thread takes.
      CATransaction.flush()
      startedAt = CACurrentMediaTime()
    }

    /// Milliseconds since the timeline started.
    public func elapsedMs(now: CFTimeInterval = CACurrentMediaTime()) -> Double {
      guard let startedAt else { return 0 }
      return (now - startedAt) * 1000
    }

    /// React Native has drawn: the accessibility value says so.
    public func contentDidAppear() {
      contentReady = true
      updateValue()
    }

    private func updateValue() {
      let size = bounds.size
      let scale = window?.screen.scale ?? traitCollection.displayScale
      accessibilityValue =
        "\(contentReady ? "ready" : "loading") \(Self.format(size.width))x\(Self.format(size.height))@\(Self.format(scale))"
    }

    override public func layoutSubviews() {
      super.layoutSubviews()
      layoutLayers(force: false)
    }

    override public func didMoveToWindow() {
      super.didMoveToWindow()
      updateValue()
    }

    /// Lays the layers out for the view's size and plays on from `fromMs`, or
    /// from where the timeline has got to.
    private func layoutLayers(force: Bool, fromMs: Double? = nil) {
      let size = bounds.size
      guard force || size != laidOutFor, size.width > 0, size.height > 0 else { return }
      laidOutFor = size
      let g = SplashGeometry(width: size.width, height: size.height)
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      base.frame = bounds
      dark.frame = bounds
      vignette.frame = bounds
      for (gradient, spec) in [(base, SplashTimeline.base), (dark, SplashTimeline.dark), (vignette, SplashTimeline.vignette)] {
        aim(gradient, spec, width: size.width, height: size.height)
      }
      placeholder.frame = rect(g.element)
      stadium.transform = CATransform3DIdentity
      stadium.frame = rect(g.element)
      let cover = CGRect(
        x: g.cover.x - g.element.x, y: g.cover.y - g.element.y, width: g.cover.width, height: g.cover.height)
      stadiumSharp.frame = cover
      stadiumBlurred.frame = cover
      dimming.frame = stadium.bounds
      let center = CGPoint(x: g.markCenter.x, y: g.markCenter.y)
      let glowSide = SplashTimeline.glowSize * g.k
      glow.transform = CATransform3DIdentity
      glow.frame = CGRect(x: center.x - glowSide / 2, y: center.y - glowSide / 2, width: glowSide, height: glowSide)
      aim(glow, SplashTimeline.glow, width: glowSide, height: glowSide)
      brand.transform = CATransform3DIdentity
      brand.frame = CGRect(x: center.x - g.side / 2, y: center.y - g.side / 2, width: g.side, height: g.side)
      let half = g.side / 2
      for image in [markSharp, markBlurred] { image.frame = rect(g.brand(SplashTimeline.markImage), dx: half, dy: half) }
      let box = g.brand(SplashTimeline.wordmarkBox)
      wordmarkMove.transform = CATransform3DIdentity
      wordmarkMove.frame = rect(box, dx: half, dy: half)
      wordmark.transform = CATransform3DIdentity
      wordmark.frame = wordmarkMove.bounds
      let picture = g.brand(SplashTimeline.wordmarkImage)
      for image in [wordmarkSharp, wordmarkBlurred] {
        image.frame = CGRect(x: picture.x - box.x, y: picture.y - box.y, width: picture.width, height: picture.height)
      }
      CATransaction.commit()
      updateValue()
      if startedAt != nil { animate(fromMs: frozenMs ?? fromMs ?? elapsedMs()) } else { apply(SplashSampler.frame(ms: frozenMs ?? 0)) }
    }

    /// The model values at `frame`, which a frozen view holds and an animation ends on.
    private func apply(_ frame: SplashFrame) {
      let k = SplashGeometry(width: bounds.width, height: bounds.height).k
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      stadium.transform = CATransform3DMakeScale(frame.stadiumScale, frame.stadiumScale, 1)
      stadium.opacity = Float(frame.stadiumOpacity)
      dimming.opacity = Float(Self.dimming(frame.stadiumBrightness))
      stadiumBlurred.opacity = Float(Self.stadiumBlurMix(frame.stadiumBlur))
      dark.opacity = Float(frame.darkOpacity)
      glow.opacity = Float(frame.glowOpacity)
      glow.transform = CATransform3DMakeScale(frame.glowScale, frame.glowScale, 1)
      brand.opacity = Float(frame.markOpacity)
      brand.transform = CATransform3DMakeScale(frame.markScale, frame.markScale, 1)
      let blur = Float(Self.brandBlurMix(frame.markBlur))
      markBlurred.opacity = blur
      wordmarkBlurred.opacity = blur
      markSharp.opacity = 1 - blur
      wordmarkSharp.opacity = 1 - blur
      wordmarkMove.transform = CATransform3DMakeTranslation(0, (frame.wordmarkTranslateY - SplashTimeline.wordmarkRestY) * k, 0)
      wordmark.opacity = Float(frame.wordmarkOpacity)
      wordmark.transform = CATransform3DMakeScale(frame.wordmarkScale, frame.wordmarkScale, 1)
      CATransaction.commit()
    }

    /// Plays the timeline from `ms`, or holds it there when frozen.
    private func animate(fromMs ms: Double) {
      for animated in [stadium, dimming, stadiumBlurred, dark, glow, brand, markSharp, markBlurred, wordmarkSharp, wordmarkBlurred, wordmarkMove, wordmark] {
        animated.removeAllAnimations()
      }
      if let frozenMs {
        apply(SplashSampler.frame(ms: frozenMs))
        return
      }
      apply(SplashSampler.frame(ms: SplashTimeline.durationMs))
      guard ms < SplashTimeline.durationMs else { return }
      let k = SplashGeometry(width: bounds.width, height: bounds.height).k
      // From the start, the animations begin when they reach the screen, so a
      // busy main thread delays the timeline rather than skipping into it.
      let begin: CFTimeInterval? = ms > 0 ? CACurrentMediaTime() - ms / 1000 : nil
      let s = SplashTimeline.stadiumTracks
      add(stadium, "transform.scale", s, "scale", begin)
      add(stadium, "opacity", s, "opacity", begin)
      add(dimming, "opacity", s, "brightness", begin, Self.dimming)
      add(stadiumBlurred, "opacity", s, "blur", begin, Self.stadiumBlurMix)
      add(dark, "opacity", SplashTimeline.darkTracks, "opacity", begin)
      add(glow, "opacity", SplashTimeline.glowTracks, "opacity", begin)
      add(glow, "transform.scale", SplashTimeline.glowTracks, "scale", begin)
      let m = SplashTimeline.markTracks
      add(brand, "opacity", m, "opacity", begin)
      add(brand, "transform.scale", m, "scale", begin)
      for image in [markBlurred, wordmarkBlurred] { add(image, "opacity", m, "blur", begin, Self.brandBlurMix) }
      for image in [markSharp, wordmarkSharp] { add(image, "opacity", m, "blur", begin) { 1 - Self.brandBlurMix($0) } }
      let w = SplashTimeline.wordmarkTracks
      add(wordmarkMove, "transform.translation.y", w, "translateY", begin) { ($0 - SplashTimeline.wordmarkRestY) * k }
      add(wordmark, "opacity", w, "opacity", begin)
      add(wordmark, "transform.scale", w, "scale", begin)
    }

    /// One keyframe animation for `track`, mapped through `map`, eased per segment.
    private func add(
      _ target: CALayer,
      _ keyPath: String,
      _ layer: SplashLayerTracks,
      _ track: String,
      _ begin: CFTimeInterval?,
      _ map: (Double) -> Double = { $0 }
    ) {
      let animation = CAKeyframeAnimation(keyPath: keyPath)
      let keys = layer[track]
      animation.values = keys.values.map { NSNumber(value: map($0)) }
      animation.keyTimes = keys.offsets.map { NSNumber(value: $0) }
      let e = layer.easing
      let curve = CAMediaTimingFunction(controlPoints: Float(e[0]), Float(e[1]), Float(e[2]), Float(e[3]))
      animation.timingFunctions = Array(repeating: curve, count: keys.keys.count - 1)
      animation.duration = SplashTimeline.durationMs / 1000
      if let begin { animation.beginTime = target.convertTime(begin, from: nil) }
      animation.fillMode = .backwards
      animation.calculationMode = .linear
      target.add(animation, forKey: keyPath)
    }

    /// The black layer's opacity for `brightness`, with 1.05 baked into the image.
    static func dimming(_ brightness: Double) -> Double {
      max(0, 1 - brightness / SplashTimeline.bakedBrightness)
    }

    /// How much of the pre-blurred stadium shows for a blur of `blur` design points.
    static func stadiumBlurMix(_ blur: Double) -> Double {
      let maximum = SplashTimeline.stadiumTracks["blur"].values.max() ?? 1
      return min(1, max(0, blur / maximum))
    }

    /// How much of the pre-blurred brand images shows for the mark's blur.
    static func brandBlurMix(_ blur: Double) -> Double {
      min(1, max(0, blur / SplashTimeline.markBlurMax))
    }

    private func paint(_ gradient: CAGradientLayer, _ spec: SplashGradient) {
      gradient.colors = spec.stops.map {
        UIColor(red: $0.red, green: $0.green, blue: $0.blue, alpha: $0.alpha).cgColor
      }
      gradient.locations = spec.stops.map { NSNumber(value: $0.at) }
    }

    /// Points a radial gradient's circle at the farthest corner of a `width`×`height` box.
    private func aim(_ gradient: CAGradientLayer, _ spec: SplashGradient, width: Double, height: Double) {
      let radius = spec.radius(width: width, height: height)
      gradient.startPoint = CGPoint(x: spec.centerX, y: spec.centerY)
      gradient.endPoint = CGPoint(x: spec.centerX + radius / width, y: spec.centerY + radius / height)
    }

    private func rect(_ box: SplashBox, dx: Double = 0, dy: Double = 0) -> CGRect {
      CGRect(x: box.x + dx, y: box.y + dy, width: box.width, height: box.height)
    }

    private static func format(_ value: CGFloat) -> String {
      value == value.rounded() ? String(Int(value)) : String(format: "%g", Double(value))
    }

    nonisolated static func url(_ name: String, _ ext: String) -> URL? {
      Bundle.module.url(forResource: name, withExtension: ext)
    }

    nonisolated static func image(_ name: String, _ ext: String) -> CGImage? {
      url(name, ext).flatMap(decode)
    }

    /// Decodes `url` now, so drawing it later does not.
    nonisolated static func decode(_ url: URL) -> CGImage? {
      guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
      let options = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
      return CGImageSourceCreateImageAtIndex(source, 0, options)
    }
  }

  /// The timeline's images, decoded on a background queue and handed to the
  /// main thread, which alone touches them afterwards.
  struct SplashImages: @unchecked Sendable {
    let stadium: CGImage?
    let stadiumBlurred: CGImage?
    let mark: CGImage?
    let markBlurred: CGImage?
    let wordmark: CGImage?
    let wordmarkBlurred: CGImage?

    static func decode() -> SplashImages {
      SplashImages(
        stadium: SplashView.image("splashStadium", "heic"),
        stadiumBlurred: SplashView.image("splashStadiumBlurred", "jpg"),
        mark: SplashView.image("splashMark", "png"),
        markBlurred: SplashView.image("splashMarkBlurred", "png"),
        wordmark: SplashView.image("splashWordmark", "png"),
        wordmarkBlurred: SplashView.image("splashWordmarkBlurred", "png"))
    }
  }
#endif
