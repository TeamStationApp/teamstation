#import "../TeamStation/ChatKeyboard/ChatKeyboardGuide.h"

@interface TSChatKeyboardGuideView (TestSamples)
- (void)startSampling;
- (void)sampleEdge:(CADisplayLink *)clock;
- (void)sampleTop:(CGFloat)top atTarget:(BOOL)atTarget clock:(CADisplayLink *)clock;
@end

@protocol TSChatGuideManager
+ (NSString *)moduleName;
+ (NSArray<NSString *> *)propConfig_onChatKeyboardInset;
+ (NSArray<NSString *> *)propConfig_onChatKeyboardRest;
- (TSChatKeyboardGuideView *)view;
@end

// Exercise the UIKit view at the same point dimensions as a landscape iPad Pro.
// The physical scenario supplies real keyboard animations, including the toolbar.
static void TSCheckChatKeyboardGuide(UIWindow *window, void (^check)(BOOL, NSString *))
{
  Class<TSChatGuideManager> manager = (Class<TSChatGuideManager>)NSClassFromString(@"TSChatKeyboardGuideManager");
  check([[manager moduleName] isEqual:@"TSChatKeyboardGuide"], @"The view registers under the native component name");
  check([[manager propConfig_onChatKeyboardInset] isEqual:@[@"RCTDirectEventBlock"]] &&
        [[manager propConfig_onChatKeyboardRest] isEqual:@[@"RCTDirectEventBlock"]], @"Both keyboard events are exported");
  TSChatKeyboardGuideView *view = [(id<TSChatGuideManager>)[(Class)manager new] view];
  view.frame = CGRectMake(0, 0, 1210, 834);
  [view layoutSubviews];
  check([view valueForKey:@"clock"] == nil, @"A detached guide has no display link");
  check(!view.userInteractionEnabled && view.accessibilityElementsHidden, @"The guide does not intercept history touches");
  check(!view.keyboardLayoutGuide.followsUndockedKeyboard && !view.keyboardLayoutGuide.usesBottomSafeArea,
        @"Floating keyboards and the home indicator reserve no space");
  if (window) {
    [window addSubview:view];
    [view layoutSubviews];
  } else {
    [view startSampling];
  }
  CADisplayLink *clock = [view valueForKey:@"clock"];
  check(clock != nil, @"An attached guide tracks its presentation");
  [view sampleEdge:clock];
  NSMutableArray<NSNumber *> *heights = [NSMutableArray new];
  NSMutableArray<NSNumber *> *rests = [NSMutableArray new];
  view.onChatKeyboardInset = ^(NSDictionary *event) { [heights addObject:event[@"height"]]; };
  view.onChatKeyboardRest = ^(NSDictionary *event) { [rests addObject:event[@"height"]]; };
  [view sampleTop:900 atTarget:NO clock:clock];
  [view sampleTop:680 atTarget:NO clock:clock];
  [view sampleTop:407 atTarget:YES clock:clock];
  [view sampleTop:407 atTarget:YES clock:clock];
  [view sampleTop:407 atTarget:YES clock:clock];
  check([heights isEqual:@[@0, @154, @427]], @"Opening publishes distinct window-local heights");
  check([rests isEqual:@[@427]] && [view valueForKey:@"clock"] == nil, @"Settled keyboard stops sampling");
  [view startSampling];
  clock = [view valueForKey:@"clock"];
  [view sampleTop:-10 atTarget:NO clock:clock];
  [view sampleTop:600 atTarget:NO clock:clock];
  [view sampleTop:500 atTarget:NO clock:clock];
  [view sampleTop:834 atTarget:YES clock:clock];
  [view sampleTop:834 atTarget:YES clock:clock];
  [view sampleTop:834 atTarget:YES clock:clock];
  check([heights isEqual:@[@0, @154, @427, @834, @234, @334, @0]],
        @"Bounded changing and reversing heights settle at zero when dismissed");
  check([rests isEqual:@[@427, @0]], @"Dismissal releases the keyboard inset");
  [view startSampling];
  if (window) [view removeFromSuperview];
  else [view didMoveToWindow];
  check([view valueForKey:@"clock"] == nil, @"Removing a moving guide releases its clock");
}
