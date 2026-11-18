# Each player observes its own item's stalls and failures. react-native-video
# registers both notifications for every item (`object: nil`), so on a screen
# of several players one camera's failed item raised an error, and its stall
# a stall, in every player.
def patch_video_item_notifications(root)
  observers = {
    'handlePlaybackStalled' => 'AVPlayerItemPlaybackStalled',
    'handleDidFailToFinishPlaying' => 'AVPlayerItemFailedToPlayToEndTime'
  }
  path = File.join(root, 'ios/Video/Features/RCTPlayerObserver.swift')
  original = File.read(path)
  source = observers.reduce(original) do |text, (handler, name)|
    head = "selector: #selector(RCTPlayerObserverHandler.#{handler}(notification:)),\n" \
           "                                               name: NSNotification.Name.#{name},\n" \
           '                                               object: '
    after = "#{head}player?.currentItem)"
    next text if text.include?(after)
    before = "#{head}nil)"
    raise 'react-native-video item notifications changed; review the observers' unless text.scan(before).length == 1
    text.sub(before, after)
  end
  # Unchanged bytes keep their mtime, so a repeat install recompiles nothing.
  File.write(path, source) unless source == original
end

patch_video_item_notifications(ARGV.fetch(0)) if $PROGRAM_NAME == __FILE__
