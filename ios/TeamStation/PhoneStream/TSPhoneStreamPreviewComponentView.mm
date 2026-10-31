#import <AVFoundation/AVFoundation.h>
#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

#import <react/renderer/components/TeamStationWalkUpMusicSpec/ComponentDescriptors.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/Props.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

NS_ASSUME_NONNULL_BEGIN

/** `PhoneStreamBridge.swift`'s preview half, declared by hand as `RCTPhoneStream.mm` does. */
@interface TSPhoneStreamPreviewLink : NSObject
- (instancetype)initWithLayer:(AVCaptureVideoPreviewLayer *)layer;
- (void)refresh;
- (void)turn:(CGFloat)rotationAngle mirrored:(BOOL)mirrored;
- (void)detach;
- (void)park;
- (void)unpark;
@end

NS_ASSUME_NONNULL_END

/** Posted by the bridge after the engine opens or closes. */
static NSString *const TSPhoneStreamPreviewSessionChanged = @"TSPhoneStreamPreviewSessionChanged";
/** `Notification.Name.tsWindowSceneChanged` in `AppDelegate.swift`. */
static NSString *const TSWindowSceneChanged = @"TSWindowSceneChanged";

/**
 * `TSPhoneStreamPreview`: the camera straight from the capture session, the
 * engine's own preview, without the programme's picture delay. It hosts an
 * `AVCaptureVideoPreviewLayer` on the engine's camera, taken again whenever
 * the engine opens or closes, and turned to the screen so the field stays
 * upright in either landscape. The layer is attached, turned and detached
 * through `TSPhoneStreamPreviewLink`, which hands each change to the camera's
 * capture queue: made here on the main thread, a change opens a configuration
 * on the session that the camera's `stopRunning` on Close can land inside,
 * and AVFoundation raises an exception for that. A simulator Debug build has
 * no camera: its synthetic source feeds the programme only, and this view
 * stays black.
 * `codegenConfig.ios.componentProvider` maps the name to this class.
 */
@interface TSPhoneStreamPreviewComponentView : RCTViewComponentView <RCTTSPhoneStreamPreviewViewProtocol>
@end

/** The scene's geometry, watched so the picture turns when the interface does. */
static void *TSPhoneStreamPreviewGeometryContext = &TSPhoneStreamPreviewGeometryContext;

@implementation TSPhoneStreamPreviewComponentView {
  AVCaptureVideoPreviewLayer *_previewLayer;
  TSPhoneStreamPreviewLink *_link;
  BOOL _mirrored;
  /** The scene whose `effectiveGeometry` this view observes, while it is in a window. */
  UIWindowScene *_observedScene;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<TSPhoneStreamPreviewComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const TSPhoneStreamPreviewProps>();
    _props = defaultProps;
    self.backgroundColor = UIColor.blackColor;
    self.clipsToBounds = YES;
    _previewLayer = [AVCaptureVideoPreviewLayer new];
    _previewLayer.videoGravity = AVLayerVideoGravityResizeAspectFill;
    [self.layer addSublayer:_previewLayer];
    _link = [[TSPhoneStreamPreviewLink alloc] initWithLayer:_previewLayer];
    [NSNotificationCenter.defaultCenter addObserver:self
                                           selector:@selector(sessionChanged)
                                               name:TSPhoneStreamPreviewSessionChanged
                                             object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self
                                           selector:@selector(observeScene)
                                               name:TSWindowSceneChanged
                                             object:nil];
    [self sessionChanged];
  }
  return self;
}

- (void)dealloc
{
  [self stopObservingScene];
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [_link detach];
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &newProps = *std::static_pointer_cast<TSPhoneStreamPreviewProps const>(props);
  _mirrored = newProps.mirrored;
  // Fabric hands a view its props first whenever it is put to use, a pooled one included.
  [_link unpark];
  [self applyConnection];
  [super updateProps:props oldProps:oldProps];
}

- (void)sessionChanged
{
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self sessionChanged];
    });
    return;
  }
  [self applyConnection];
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  _previewLayer.frame = self.bounds;
  [CATransaction commit];
  [self applyConnection];
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  [self observeScene];
}

/**
 * A modal that only turns sideways is presented before its scene has turned: the preview is laid
 * out once, while the interface still reads upright. Watching the scene's geometry turns the
 * picture when the interface itself turns. Run again when iOS moves the window to a new scene,
 * which no view hears as a move to a window.
 */
- (void)observeScene
{
  [self stopObservingScene];
  UIWindowScene *scene = self.window.windowScene;
  if (scene != nil) {
    [scene addObserver:self
            forKeyPath:@"effectiveGeometry"
               options:NSKeyValueObservingOptionNew
               context:TSPhoneStreamPreviewGeometryContext];
    _observedScene = scene;
  }
  [self applyConnection];
}

- (void)stopObservingScene
{
  UIWindowScene *scene = _observedScene;
  if (scene != nil) {
    [scene removeObserver:self forKeyPath:@"effectiveGeometry" context:TSPhoneStreamPreviewGeometryContext];
  }
  _observedScene = nil;
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context
{
  if (context != TSPhoneStreamPreviewGeometryContext) {
    [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [self applyConnection];
  });
}

/**
 * Draws the engine's camera, turned to the interface and mirrored when asked.
 * The link changes nothing when nothing has changed, so this runs on every
 * layout pass and geometry report.
 */
- (void)applyConnection
{
  CGFloat angle = 90;
  switch (self.window.windowScene.effectiveGeometry.interfaceOrientation) {
    case UIInterfaceOrientationLandscapeRight:
      angle = 0;
      break;
    case UIInterfaceOrientationLandscapeLeft:
      angle = 180;
      break;
    case UIInterfaceOrientationPortraitUpsideDown:
      angle = 270;
      break;
    default:
      angle = 90;
      break;
  }
  [_link turn:angle mirrored:_mirrored];
  [_link refresh];
}

- (void)prepareForRecycle
{
  [super prepareForRecycle];
  _mirrored = NO;
  // A recycled view waits in the pool still holding its layer, and still hears the engine open; the
  // camera must not draw into it until the view is used again.
  [_link park];
}

@end
