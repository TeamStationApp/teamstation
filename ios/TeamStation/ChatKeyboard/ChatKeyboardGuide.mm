#import "ChatKeyboardGuide.h"
#import <React/RCTViewManager.h>

// A point on UIKit's docked keyboard guide, in the conversation's own viewport.
// Its presentation layer follows both the keyboard animation and an interactive drag.
@implementation TSChatKeyboardGuideView {
  UIView *_edge;
  CADisplayLink *_clock;
  CGFloat _lastHeight;
  NSUInteger _atRest;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if ((self = [super initWithFrame:frame])) {
    self.userInteractionEnabled = NO;
    self.accessibilityElementsHidden = YES;
    self.keyboardLayoutGuide.followsUndockedKeyboard = NO;
    self.keyboardLayoutGuide.usesBottomSafeArea = NO;
    _edge = [UIView new];
    _edge.translatesAutoresizingMaskIntoConstraints = NO;
    [self addSubview:_edge];
    [NSLayoutConstraint activateConstraints:@[
      [_edge.topAnchor constraintEqualToAnchor:self.keyboardLayoutGuide.topAnchor],
      [_edge.leadingAnchor constraintEqualToAnchor:self.leadingAnchor],
      [_edge.widthAnchor constraintEqualToConstant:1],
      [_edge.heightAnchor constraintEqualToConstant:1]
    ]];
    _lastHeight = -1;
  }
  return self;
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  if (!self.window) {
    [_clock invalidate];
    _clock = nil;
  }
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  if (self.window) [self startSampling];
}

- (void)startSampling
{
  _atRest = 0;
  if (!_clock) {
    _clock = [CADisplayLink displayLinkWithTarget:self selector:@selector(sampleEdge:)];
    [_clock addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  }
}

- (void)sampleEdge:(CADisplayLink *)clock
{
  CALayer *edge = _edge.layer.presentationLayer ?: _edge.layer;
  CGFloat top = CGRectGetMinY(edge.frame);
  BOOL atTarget = fabs(top - CGRectGetMinY(_edge.frame)) * self.traitCollection.displayScale <= 1;
  [self sampleTop:top atTarget:atTarget clock:clock];
}

- (void)sampleTop:(CGFloat)top atTarget:(BOOL)atTarget clock:(CADisplayLink *)clock
{
  CGFloat scale = MAX(1, self.traitCollection.displayScale);
  CGFloat visible = CGRectGetHeight(self.bounds);
  CGFloat height = MIN(visible, MAX(0, visible - top));
  height = round(height * scale) / scale;
  if (height != _lastHeight && self.onChatKeyboardInset) {
    _lastHeight = height;
    self.onChatKeyboardInset(@{@"height": @(height)});
  }
  // A new layout restarts sampling. Idle conversations need no display link.
  if (atTarget) {
    if (++_atRest >= 3) {
      if (self.onChatKeyboardRest) self.onChatKeyboardRest(@{@"height": @(height)});
      [clock invalidate];
      _clock = nil;
    }
  } else {
    _atRest = 0;
  }
}
@end

@interface TSChatKeyboardGuideManager : RCTViewManager
@end

@implementation TSChatKeyboardGuideManager
RCT_EXPORT_MODULE(TSChatKeyboardGuide)
RCT_EXPORT_VIEW_PROPERTY(onChatKeyboardInset, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onChatKeyboardRest, RCTDirectEventBlock)
- (UIView *)view { return [TSChatKeyboardGuideView new]; }
@end
