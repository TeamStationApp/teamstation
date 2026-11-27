#import <React/RCTConversions.h>
#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

#import <react/renderer/components/TeamStationWalkUpMusicSpec/ComponentDescriptors.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/EventEmitters.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/Props.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

// The floating bar draws regular and magnified copies of each control. On a
// fresh mount UIKit can expose either copy to accessibility, but only one
// inherits the item's identifier. Match by the public control label so both
// report the same tab without exposing UIKit's implementation classes.
static void SetTabIdentifiers(UIView *container, NSDictionary<NSString *, NSString *> *identifiers)
{
  for (UIView *view in container.subviews) {
    if ([view isKindOfClass:UIControl.class] && view.accessibilityLabel) {
      NSString *identifier = identifiers[view.accessibilityLabel];
      if (identifier && ![identifier isEqualToString:view.accessibilityIdentifier]) {
        view.accessibilityIdentifier = identifier;
      }
    }
    SetTabIdentifiers(view, identifiers);
  }
}

@interface TSAccessibleTabBar : UITabBar
@end
@implementation TSAccessibleTabBar
- (void)layoutSubviews
{
  [super layoutSubviews];
  NSMutableDictionary *identifiers = [NSMutableDictionary dictionaryWithCapacity:self.items.count];
  for (UITabBarItem *item in self.items) {
    if (item.accessibilityLabel && item.accessibilityIdentifier)
      identifiers[item.accessibilityLabel] = item.accessibilityIdentifier;
  }
  SetTabIdentifiers(self, identifiers);
}
@end

// UIKit's reduced-transparency platter can override the tint of template
// symbols. Preserve the app colors in the artwork for that appearance.
static UIImage *TabSymbol(const std::string &name, UIColor *ink)
{
  UIImage *image = [UIImage systemImageNamed:@(name.c_str())];
  return ink ? [image imageWithTintColor:ink renderingMode:UIImageRenderingModeAlwaysOriginal] : image;
}

@interface TSTabBarComponentView : RCTViewComponentView <RCTTSTabBarViewProtocol, UITabBarDelegate>
@end

@implementation TSTabBarComponentView {
  UITabBar *_bar;
  CGFloat _reportedHeight;
  UIViewPropertyAnimator *_resize;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<TSTabBarComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if ((self = [super initWithFrame:frame])) {
    _props = std::make_shared<const TSTabBarProps>();
    _bar = [[TSAccessibleTabBar alloc] initWithFrame:CGRectZero];
    _bar.delegate = self;
    [self addSubview:_bar];
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  auto previous = std::static_pointer_cast<const TSTabBarProps>(_props);
  const auto &next = *std::static_pointer_cast<const TSTabBarProps>(props);
  [super updateProps:props oldProps:oldProps];
  self.overrideUserInterfaceStyle = next.dark ? UIUserInterfaceStyleDark : UIUserInterfaceStyleLight;

  // Keep the same UITabBarItems through selection and unread updates so UIKit
  // can animate its lens continuously and retain accessibility focus.
  BOOL rebuild = _bar.items.count != next.items.size();
  for (NSUInteger index = 0; !rebuild && index < next.items.size(); index++) {
    const auto &before = previous->items[index];
    const auto &after = next.items[index];
    rebuild = before.id != after.id || before.symbol != after.symbol ||
        before.selectedSymbol != after.selectedSymbol || before.testID != after.testID;
  }
  NSArray<UITabBarItem *> *items = _bar.items;
  if (rebuild) {
    NSMutableArray *created = [NSMutableArray arrayWithCapacity:next.items.size()];
    for (const auto &tab : next.items) {
      UITabBarItem *item = [UITabBarItem new];
      item.accessibilityIdentifier = @(tab.testID.c_str());
      [created addObject:item];
    }
    items = created;
  }
  BOOL changingSize = previous->compact != next.compact;
  if (changingSize && !UIAccessibilityIsReduceMotionEnabled()) {
    CATransition *fade = [CATransition animation];
    fade.type = kCATransitionFade;
    fade.duration = 0.2;
    [_bar.layer addAnimation:fade forKey:@"labels"];
  }
  const BOOL updateAppearance = rebuild || previous->activeColor != next.activeColor ||
      previous->inactiveColor != next.inactiveColor ||
      previous->opaqueBackgroundColor != next.opaqueBackgroundColor;
  UIColor *active = RCTUIColorFromSharedColor(next.activeColor) ?: UIColor.systemBlueColor;
  UIColor *inactive = RCTUIColorFromSharedColor(next.inactiveColor) ?: UIColor.secondaryLabelColor;
  UIColor *opaqueBackground = RCTUIColorFromSharedColor(next.opaqueBackgroundColor);
  UITabBarItem *selection = nil;
  UIColor *badge = RCTUIColorFromSharedColor(next.badgeColor);
  for (NSUInteger index = 0; index < next.items.size(); index++) {
    const auto &tab = next.items[index];
    UITabBarItem *item = items[index];
    if (updateAppearance) {
      item.image = TabSymbol(tab.symbol, opaqueBackground ? inactive : nil);
      item.selectedImage = TabSymbol(tab.selectedSymbol, opaqueBackground ? active : nil);
    }
    NSString *label = @(tab.title.c_str());
    item.title = next.compact ? nil : label;
    item.accessibilityLabel = label;
    item.badgeValue = tab.badge ? @"" : nil;
    item.badgeColor = badge;
    if (tab.id == next.selectedId) selection = item;
  }
  // UIKit creates the accessible controls from the items' current metadata.
  // Install fully configured items together, then select the controlled item.
  if (rebuild) [_bar setItems:items animated:NO];
  if (selection && _bar.selectedItem != selection) _bar.selectedItem = selection;
  if (updateAppearance) {
    UITabBarAppearance *appearance = [UITabBarAppearance new];
    if (opaqueBackground) {
      [appearance configureWithOpaqueBackground];
      appearance.backgroundColor = opaqueBackground;
    }
    for (UITabBarItemAppearance *layout in @[appearance.stackedLayoutAppearance,
             appearance.inlineLayoutAppearance, appearance.compactInlineLayoutAppearance]) {
      layout.normal.iconColor = inactive;
      layout.normal.titleTextAttributes = @{NSForegroundColorAttributeName: inactive};
      layout.selected.iconColor = active;
      layout.selected.titleTextAttributes = @{NSForegroundColorAttributeName: active};
    }
    _bar.standardAppearance = appearance;
    _bar.scrollEdgeAppearance = appearance;
    _bar.tintColor = active;
    _bar.unselectedItemTintColor = inactive;
  }
  [self setNeedsLayout];
  if (changingSize) {
    [_resize stopAnimation:YES];
    _resize = nil;
    if (self.window && !UIAccessibilityIsReduceMotionEnabled()) {
      _resize = [[UIViewPropertyAnimator alloc] initWithDuration:0.38 dampingRatio:1 animations:^{
        [self layoutIfNeeded];
      }];
      [_resize startAnimation];
    } else {
      [self layoutIfNeeded];
    }
  }
}

- (void)tabBar:(UITabBar *)bar didSelectItem:(UITabBarItem *)item
{
  const auto &props = *std::static_pointer_cast<const TSTabBarProps>(_props);
  NSUInteger requested = [bar.items indexOfObjectIdenticalTo:item];
  if (requested >= props.items.size()) return;
  // A leave guard can decline without sending any new props.
  for (NSUInteger index = 0; index < props.items.size(); index++) {
    if (props.items[index].id == props.selectedId) {
      bar.selectedItem = bar.items[index];
      break;
    }
  }
  if (_eventEmitter) {
    std::static_pointer_cast<const TSTabBarEventEmitter>(_eventEmitter)
        ->onSelectTab({.id = props.items[requested].id});
  }
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  CGFloat width = CGRectGetWidth(self.bounds);
  CGFloat height = [_bar sizeThatFits:CGSizeMake(width, CGFLOAT_MAX)].height;
  const auto &props = *std::static_pointer_cast<const TSTabBarProps>(_props);
  // UIKit supplies 21 points of horizontal glass margin on each end. A
  // 270-point host leaves five targets wider than 44 points on the compact bar.
  CGFloat barWidth = props.compact ? MIN(width, 270) : width;
  CGFloat barHeight = props.compact ? MAX(44, height - 10) : height;
  _bar.frame = CGRectMake((width - barWidth) / 2, CGRectGetHeight(self.bounds) - barHeight, barWidth, barHeight);
  if (_eventEmitter && height > 0 && height != _reportedHeight) {
    _reportedHeight = height;
    std::static_pointer_cast<const TSTabBarEventEmitter>(_eventEmitter)
        ->onBarHeight({.height = height});
  }
}

- (void)updateEventEmitter:(EventEmitter::Shared const &)emitter
{
  [super updateEventEmitter:emitter];
  _reportedHeight = 0;
  [self setNeedsLayout];
}

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event
{
  UIView *target = [super hitTest:point withEvent:event];
  return target == self || target == _bar ? nil : target;
}

- (void)prepareForRecycle
{
  [_resize stopAnimation:YES];
  _resize = nil;
  [super prepareForRecycle];
  _bar.items = nil;
  _reportedHeight = 0;
}

@end
