#import <React/RCTEventEmitter.h>
#import <GameController/GameController.h>

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
