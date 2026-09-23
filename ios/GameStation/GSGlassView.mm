#import <React/RCTViewManager.h>
#import <UIKit/UIKit.h>

/**
 * A pane of glass, drawn by the system.
 *
 * The web app blurs what is behind its header and its tab capsule with a CSS
 * `backdrop-filter`. iOS 26 has a far better answer — `UIGlassEffect`, the
 * material the system's own bars are made of, which refracts and specularly
 * highlights what passes under it rather than merely blurring it — and iOS 25
 * and earlier have `systemThinMaterial`, which is what the CSS was imitating
 * in the first place.
 *
 * It draws **only** the background. React Native's children are not put inside
 * it: the JavaScript side lays this out behind them with
 * `StyleSheet.absoluteFill`, so this view never has to take part in React's
 * child ordering, and there is no way for a subview to end up underneath the
 * material by accident.
 *
 * A legacy view manager rather than a codegen Fabric component. React Native
 * 0.87 still ships `RCTLegacyViewManagerInteropComponentView`, which mounts
 * one under Fabric and finds it by name — `GSGlassViewManager` minus the
 * `Manager` — so this is forty lines and a build phase instead of a spec file,
 * a generated interface and a second place to keep in step.
 */
@interface GSGlassView : UIView
@property (nonatomic, assign) BOOL glassInteractive;
@property (nonatomic, assign) BOOL glassClear;
@property (nonatomic, assign) CGFloat glassRadius;
@property (nonatomic, assign) BOOL glassDark;
@end

@implementation GSGlassView {
  UIVisualEffectView *_effectView;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    _effectView = [[UIVisualEffectView alloc] initWithEffect:nil];
    _effectView.clipsToBounds = YES;
    self.clipsToBounds = YES;
    self.userInteractionEnabled = NO;
    [self addSubview:_effectView];
  }
  return self;
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  _effectView.frame = self.bounds;
  [self applyShape];
}

/**
 * A capsule, when a capsule is what was asked for.
 *
 * Two things were wrong here and they looked like one. The radius came
 * straight from JavaScript — 40 points for the tab capsule — and was applied
 * without reference to the view's own height; and the curve was
 * `kCACornerCurveContinuous`, Apple's squircle, which is right for a rounded
 * *rectangle* and wrong for a capsule. A continuous curve at a radius larger
 * than half the height does not clamp to a semicircle, it draws a corner that
 * runs out of room, and the ends come to a slight point.
 *
 * Worse, it made the glass a different shape from the rounded border the
 * JavaScript side was drawing on the same view, so the two did not coincide
 * and the pill appeared to have a second, slightly larger pill behind it.
 *
 * So: clamp to half the shorter side, and where that clamp bites — which is
 * exactly when the shape is a capsule — use a circular curve, which is what
 * makes a true semicircular end. A smaller radius is still a rounded
 * rectangle and still gets the squircle.
 */
- (void)applyShape
{
  CGFloat half = MIN(CGRectGetWidth(self.bounds), CGRectGetHeight(self.bounds)) / 2.0;
  CGFloat radius = MIN(_glassRadius, half);
  CALayerCornerCurve curve =
      (radius >= half - 0.5) ? kCACornerCurveCircular : kCACornerCurveContinuous;

  self.layer.cornerRadius = radius;
  self.layer.cornerCurve = curve;
  _effectView.layer.cornerRadius = radius;
  _effectView.layer.cornerCurve = curve;
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  [self applyEffect];
}

/**
 * No tint.
 *
 * The web app tints its glass because a CSS `backdrop-filter` is a plain blur
 * and needs help to stay legible; `UIGlassEffect` already adapts to what is
 * behind it, which is the whole point of it, and a tint on top of that is a
 * pane of coloured plastic. Where the reader has asked for less transparency
 * the JavaScript side draws a plain filled `View` and never mounts this at
 * all, so a colour never has to cross the bridge — which is just as well,
 * since a colour crossing the legacy interop arrives as a number whose alpha
 * channel is anybody's guess.
 */
- (void)applyEffect
{
  [self applyShape];
  _effectView.backgroundColor = UIColor.clearColor;

  if (@available(iOS 26.0, *)) {
    // `clear` is the more transparent of the two styles and refracts far more
    // obviously — which is the point of asking for glass at all. `regular` is
    // the safer one where text sits directly on the material.
    UIGlassEffect *glass = [UIGlassEffect
        effectWithStyle:(_glassClear ? UIGlassEffectStyleClear
                                     : UIGlassEffectStyleRegular)];
    glass.interactive = _glassInteractive;
    _effectView.effect = glass;
    return;
  }
  // What the CSS was imitating.
  _effectView.effect = [UIBlurEffect effectWithStyle:UIBlurEffectStyleSystemThinMaterial];
}

- (void)setGlassInteractive:(BOOL)value
{
  _glassInteractive = value;
  [self applyEffect];
}

- (void)setGlassClear:(BOOL)value
{
  _glassClear = value;
  [self applyEffect];
}

- (void)setGlassRadius:(CGFloat)value
{
  _glassRadius = value;
  [self applyShape];
}

/**
 * The app's appearance, not the phone's.
 *
 * The app draws one theme whatever the phone is set to, but the glass follows
 * the phone: with the phone in Dark Mode, `UIGlassEffect` goes dark under the
 * light theme's dark text, and the scoring menu button's ☰ all but vanishes
 * into it. So the glass is told which theme it sits in.
 */
- (void)setGlassDark:(BOOL)value
{
  _glassDark = value;
  self.overrideUserInterfaceStyle =
      value ? UIUserInterfaceStyleDark : UIUserInterfaceStyleLight;
}

@end

@interface GSGlassViewManager : RCTViewManager
@end

@implementation GSGlassViewManager

RCT_EXPORT_MODULE(GSGlassView)

- (UIView *)view
{
  return [GSGlassView new];
}

RCT_EXPORT_VIEW_PROPERTY(glassInteractive, BOOL)
RCT_EXPORT_VIEW_PROPERTY(glassClear, BOOL)
RCT_EXPORT_VIEW_PROPERTY(glassRadius, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(glassDark, BOOL)

@end
