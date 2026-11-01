#import <React/RCTEventEmitter.h>
#import <GameController/GameController.h>
#import <React/RCTView.h>
#import <React/RCTViewManager.h>
#import <UIKit/UIGestureRecognizerSubclass.h>

/** Observes presses without winning recognition against React Native's tap/hold recognizers. */
@interface TVTransportPressObserver : UIGestureRecognizer
@property(nonatomic, copy) void (^changed)(BOOL active, BOOL cancelled);
@end
@implementation TVTransportPressObserver
- (void)reset {
  [super reset];
  dispatch_async(dispatch_get_main_queue(), ^{ if (self.changed) self.changed(NO, NO); });
}
- (void)pressesBegan:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  if (self.changed) self.changed(YES, NO);
}
- (void)pressesEnded:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  // Keep the ownership flag through UIKit's synchronous focus decision.
  dispatch_async(dispatch_get_main_queue(), ^{ if (self.changed) self.changed(NO, NO); });
  self.state = UIGestureRecognizerStateFailed;
}
- (void)pressesCancelled:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  if (self.changed) self.changed(NO, YES);
  self.state = UIGestureRecognizerStateFailed;
}
@end

/** Directional presses belong to transport, while touch swipes retain UIKit focus routing. */
@interface TVPlaybackBoundaryView : RCTView <UIGestureRecognizerDelegate>
@property(nonatomic, assign) BOOL transportEnabled;
@property(nonatomic, assign) BOOL transportPress;
@property(nonatomic, assign) UIFocusHeading pressHeading;
@property(nonatomic, strong) TVTransportPressObserver *pressMonitor;
@property(nonatomic, copy) RCTDirectEventBlock onCancelTransport;
@end
@implementation TVPlaybackBoundaryView
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    _pressMonitor = [TVTransportPressObserver new];
    __weak TVPlaybackBoundaryView *weakSelf = self;
    _pressMonitor.changed = ^(BOOL active, BOOL cancelled) {
      weakSelf.transportPress = active;
      if (cancelled) [weakSelf cancelTransport];
    };
    _pressMonitor.allowedPressTypes = @[@(UIPressTypeLeftArrow), @(UIPressTypeRightArrow), @(UIPressTypeUpArrow)];
    _pressMonitor.cancelsTouchesInView = NO;
    _pressMonitor.delegate = self;
    [self addGestureRecognizer:_pressMonitor];
  }
  return self;
}
- (void)didMoveToWindow {
  [super didMoveToWindow];
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  if (self.window) {
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(cancelTransport) name:UIApplicationWillResignActiveNotification object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(cancelTransport) name:GCControllerDidDisconnectNotification object:nil];
  } else [self cancelTransport];
}
- (void)dealloc { [[NSNotificationCenter defaultCenter] removeObserver:self]; }
- (void)setTransportEnabled:(BOOL)value {
  _transportEnabled = value;
  self.pressMonitor.enabled = value;
  if (!value) self.transportPress = NO;
}
- (BOOL)gestureRecognizer:(UIGestureRecognizer *)recognizer shouldReceivePress:(UIPress *)press {
  BOOL directional = press.type == UIPressTypeLeftArrow || press.type == UIPressTypeRightArrow || press.type == UIPressTypeUpArrow;
  self.transportPress = self.transportEnabled && directional;
  self.pressHeading = press.type == UIPressTypeLeftArrow ? UIFocusHeadingLeft : press.type == UIPressTypeRightArrow ? UIFocusHeadingRight : UIFocusHeadingUp;
  return self.transportPress;
}
- (BOOL)gestureRecognizer:(UIGestureRecognizer *)recognizer shouldReceiveTouch:(UITouch *)touch { return NO; }
- (BOOL)gestureRecognizer:(UIGestureRecognizer *)recognizer shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)other { return YES; }
- (BOOL)shouldUpdateFocusInContext:(UIFocusUpdateContext *)context {
  if (self.transportEnabled && self.transportPress && (context.focusHeading & self.pressHeading) != 0 && [context.previouslyFocusedView isDescendantOfView:self]) return NO;
  return [super shouldUpdateFocusInContext:context];
}
- (void)cancelTransport {
  self.transportPress = NO;
  if (self.onCancelTransport) self.onCancelTransport(@{});
}
@end
@interface TVPlaybackBoundaryManager : RCTViewManager @end
@implementation TVPlaybackBoundaryManager
RCT_EXPORT_MODULE(TVPlaybackBoundary)
- (UIView *)view { return [TVPlaybackBoundaryView new]; }
RCT_EXPORT_VIEW_PROPERTY(transportEnabled, BOOL)
RCT_EXPORT_VIEW_PROPERTY(onCancelTransport, RCTDirectEventBlock)
@end

/** Absolute remote coordinates are separate from UIKit's relative focus pans. */
@interface TVRemote : RCTEventEmitter
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *bindings;
@property(nonatomic, strong) NSMutableDictionary<NSValue *, NSDictionary *> *starts;
@end
@implementation TVRemote
RCT_EXPORT_MODULE(TVRemote)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[@"tvEdgeSwipe"]; }
- (void)startObserving {
  self.bindings = [NSMutableArray new];
  self.starts = [NSMutableDictionary new];
  [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(connected:) name:GCControllerDidConnectNotification object:nil];
  for (GCController *controller in GCController.controllers) [self attachPad:controller.microGamepad];
}
- (void)connected:(NSNotification *)notice { [self attachPad:[notice.object microGamepad]]; }
- (void)attachPad:(GCMicroGamepad *)pad {
  if (!pad || !pad.dpad.isAnalog) return;
  for (NSDictionary *binding in self.bindings) if (binding[@"pad"] == pad) return;
  [self.bindings addObject:@{@"pad":pad, @"absolute":@(pad.reportsAbsoluteDpadValues), @"handler":(id)pad.dpad.valueChangedHandler ?: NSNull.null}];
  pad.reportsAbsoluteDpadValues = YES;
  __weak TVRemote *weakSelf = self;
  __weak GCMicroGamepad *weakPad = pad;
  pad.dpad.valueChangedHandler = ^(GCControllerDirectionPad *dpad, float x, float y) {
    [weakSelf samplePad:weakPad x:x y:y];
  };
}
- (void)samplePad:(GCMicroGamepad *)pad x:(float)x y:(float)y {
  if (!pad) return;
  NSValue *key = [NSValue valueWithNonretainedObject:pad];
  if (pad.buttonA.isPressed || (fabsf(x) < 0.001f && fabsf(y) < 0.001f)) { [self.starts removeObjectForKey:key]; return; }
  NSDictionary *point = @{@"x":@((x + 1) / 2), @"y":@((1 - y) / 2)};
  NSDictionary *start = self.starts[key];
  if (!start) { self.starts[key] = point; return; }
  if (start[@"sent"]) return;
  if (fabs([point[@"x"] doubleValue] - [start[@"x"] doubleValue]) < 0.3 && fabs([point[@"y"] doubleValue] - [start[@"y"] doubleValue]) < 0.3) return;
  [self sendEventWithName:@"tvEdgeSwipe" body:@{@"start":start, @"end":point}];
  self.starts[key] = @{@"sent":@YES};
}
- (void)stopObserving {
  [[NSNotificationCenter defaultCenter] removeObserver:self name:GCControllerDidConnectNotification object:nil];
  for (NSDictionary *binding in self.bindings) {
    GCMicroGamepad *pad = binding[@"pad"];
    pad.reportsAbsoluteDpadValues = [binding[@"absolute"] boolValue];
    pad.dpad.valueChangedHandler = binding[@"handler"] == NSNull.null ? nil : binding[@"handler"];
  }
  [self.bindings removeAllObjects];
  [self.starts removeAllObjects];
}
@end
