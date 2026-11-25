#import "../TeamStation/ChatKeyboard/ChatKeyboardGuide.h"
#import <React/UIView+React.h>

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

@protocol TSChatComposerDockManagerChecks
+ (NSString *)moduleName;
+ (NSArray<NSString *> *)propConfig_dockClearance;
- (TSChatComposerDockView *)view;
@end

static void TSCheckChatComposerDock(void (^check)(BOOL, NSString *))
{
  Class<TSChatComposerDockManagerChecks> manager = (Class<TSChatComposerDockManagerChecks>)NSClassFromString(@"TSChatComposerDockManager");
  check([[manager moduleName] isEqual:@"TSChatComposerDock"] &&
        [[manager propConfig_dockClearance] isEqual:@[@"NSNumber"]], @"The phone dock exports its resting clearance");
  TSChatComposerDockView *dock = [(id<TSChatComposerDockManagerChecks>)[(Class)manager new] view];
  UIView *host = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  dock.frame = host.bounds;
  [host addSubview:dock];
  UIView *band = [[UIView alloc] initWithFrame:CGRectMake(16, 740, 358, 52)];
  [dock insertReactSubview:band atIndex:0];
  [dock didUpdateReactSubviews];
  UIView *canvas = band.superview;
  check(canvas != nil && canvas.superview == dock, @"The mounted composer stays inside the keyboard canvas");
  check(!dock.keyboardLayoutGuide.followsUndockedKeyboard && !dock.keyboardLayoutGuide.usesBottomSafeArea,
        @"A floating or hardware keyboard leaves the phone dock at rest");
  [dock layoutIfNeeded];
  check(CGRectEqualToRect(canvas.frame, dock.bounds), @"Handoff leaves Yoga in control of the band");
  dock.dockClearance = @44;
  NSLayoutConstraint *guide = nil;
  for (NSLayoutConstraint *constraint in dock.constraints) {
    if (constraint.firstItem == canvas && constraint.secondItem == dock.keyboardLayoutGuide) guide = constraint;
  }
  check(guide != nil && guide.active && guide.relation == NSLayoutRelationLessThanOrEqual &&
        guide.firstAttribute == NSLayoutAttributeBottom && guide.secondAttribute == NSLayoutAttributeTop &&
        guide.constant == 44, @"UIKit owns the moving boundary rather than a sampled frame");
  // Supply the keyboard top an unattached UIKit host normally gets from its window.
  NSLayoutConstraint *keyboardTop = [dock.keyboardLayoutGuide.topAnchor constraintEqualToAnchor:dock.topAnchor];
  keyboardTop.active = YES;
  for (NSNumber *travel in @[@0, @18, @76, @51, @8, @0]) {
    keyboardTop.constant = CGRectGetHeight(dock.bounds) - 44 - travel.doubleValue;
    [dock setNeedsLayout];
    [dock layoutIfNeeded];
    CGPoint point = [band convertPoint:CGPointMake(5, 5) toView:dock];
    check(fabs(CGRectGetMinY(canvas.frame) + travel.doubleValue) < 0.01 &&
          [dock hitTest:point withEvent:nil] == band, @"The moving composer and its touch target stay together");
  }
  check([dock hitTest:CGPointMake(5, 50) withEvent:nil] == nil, @"Background touches pass to the conversation");
  dock.dockClearance = nil;
  [dock layoutIfNeeded];
  check(!guide.active && CGRectEqualToRect(canvas.frame, dock.bounds), @"The attachment handoff releases the guide");
  [dock removeReactSubview:band];
  check(band.superview == nil, @"Removing the composer releases its native child");
}

// Exercise the UIKit view at the same point dimensions as a landscape iPad Pro.
// The physical scenario supplies real keyboard animations, including the toolbar.
static void TSCheckChatKeyboardGuide(UIWindow *window, void (^check)(BOOL, NSString *))
{
  TSCheckChatComposerDock(check);
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
