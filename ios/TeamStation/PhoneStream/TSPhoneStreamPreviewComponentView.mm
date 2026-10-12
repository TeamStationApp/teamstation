#import <AVFoundation/AVFoundation.h>
#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

#import <react/renderer/components/TeamStationWalkUpMusicSpec/ComponentDescriptors.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/Props.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

NS_ASSUME_NONNULL_BEGIN

/** `PhoneStreamBridge.swift`'s preview half, declared by hand as `RCTPhoneStream.mm` does. */
@interface TSPhoneStreamBridge : NSObject
+ (nullable AVCaptureSession *)previewSession;
@end

NS_ASSUME_NONNULL_END

/** Posted by the bridge after the engine opens or closes. */
static NSString *const TSPhoneStreamPreviewSessionChanged = @"TSPhoneStreamPreviewSessionChanged";

/**
 * `TSPhoneStreamPreview`: the camera straight from the capture session, the
 * engine's own preview, without the programme's picture delay. It hosts an
 * `AVCaptureVideoPreviewLayer` on the engine's session, taken again whenever
 * the engine opens or closes, and turned to the screen so the field stays
 * upright in either landscape. A simulator has no session: its synthetic
 * source feeds the programme only, and this view stays black.
 * `codegenConfig.ios.componentProvider` maps the name to this class.
 */
@interface TSPhoneStreamPreviewComponentView : RCTViewComponentView <RCTTSPhoneStreamPreviewViewProtocol>
@end

@implementation TSPhoneStreamPreviewComponentView {
  AVCaptureVideoPreviewLayer *_previewLayer;
  BOOL _mirrored;
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
    [NSNotificationCenter.defaultCenter addObserver:self
                                           selector:@selector(sessionChanged)
                                               name:TSPhoneStreamPreviewSessionChanged
                                             object:nil];
    [self sessionChanged];
  }
  return self;
}

- (void)dealloc
{
  [NSNotificationCenter.defaultCenter removeObserver:self];
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &newProps = *std::static_pointer_cast<TSPhoneStreamPreviewProps const>(props);
  _mirrored = newProps.mirrored;
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
  AVCaptureSession *session = [TSPhoneStreamBridge previewSession];
  if (_previewLayer.session != session) {
    _previewLayer.session = session;
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
  [self applyConnection];
}

/** Turns the picture to the interface, and mirrors it when asked. */
- (void)applyConnection
{
  AVCaptureConnection *connection = _previewLayer.connection;
  if (connection == nil) {
    return;
  }
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
  if ([connection isVideoRotationAngleSupported:angle]) {
    connection.videoRotationAngle = angle;
  }
  if (connection.isVideoMirroringSupported) {
    connection.automaticallyAdjustsVideoMirroring = NO;
    connection.videoMirrored = _mirrored;
  }
}

- (void)prepareForRecycle
{
  [super prepareForRecycle];
  _mirrored = NO;
}

@end
