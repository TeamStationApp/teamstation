require 'json'
require 'fileutils'
require 'digest'
require 'shellwords'
require 'base64'

# The TypeScript caller validates configuration and confines all generated files.
# This bridge uses the pinned Ruby libraries already required by Fastlane/Pods.
command, request_file = ARGV
config = JSON.parse(File.read(request_file))
case command
when 'match', 'import'
  # Ad-hoc and App Store profiles for iOS, a Developer ID certificate for macOS.
  raise 'Unsupported signing type' unless %w[adhoc appstore developer_id].include?(config.fetch('type'))
  require 'fastlane'
  require 'match'
  require 'open3'
  if ENV['TS_MATCH_P12_PASSWORD'] && !ENV['TS_MATCH_P12_PASSWORD'].empty?
    p12_password = ENV.fetch('TS_MATCH_P12_PASSWORD')
    protected_import = Module.new do
      define_method(:import_file) do |file, keychain, **arguments|
        arguments[:certificate_password] = p12_password if File.extname(file) == '.p12'
        super(file, keychain, **arguments)
      end
    end
    FastlaneCore::KeychainImporter.singleton_class.prepend(protected_import)
  end
  # Apple requests can include credentials and session cookies; never write the HTTP trace.
  Spaceship::Client.class_eval do
    def logger
      @private_logger ||= Logger.new(File::NULL)
    end
  end
  FastlaneCore::ProvisioningProfile.define_singleton_method(:profiles_path) { config.fetch('profilesDirectory') }
  FileUtils.mkdir_p(config.fetch('profilesDirectory'))
  # The build reads this directory after Match returns. Keep exactly the
  # profiles Match installed, including when install writes them somewhere else.
  installed_for_build = []
  installed_bytes = []
  if command == 'match'
    keep_installed = lambda do
      directory = config.fetch('profilesDirectory')
      FileUtils.mkdir_p(directory)
      installed_bytes.each do |name, bytes|
        File.binwrite(File.join(directory, name), bytes)
        installed_for_build << name unless installed_for_build.include?(name)
      end
      Dir[File.join(directory, '*.{mobileprovision,provisionprofile}')].each do |other|
        next if installed_for_build.include?(File.basename(other))
        stat = File.lstat(other)
        raise 'Unexpected provisioning file' unless stat.file? && !stat.symlink?
        File.unlink(other)
      end
    end
    FastlaneCore::ProvisioningProfile.singleton_class.class_eval do
      alias_method :teamstation_install, :install unless method_defined?(:teamstation_install)
      define_method(:install) do |path, keychain_path = nil|
        destination = teamstation_install(path, keychain_path)
        stat = File.lstat(destination)
        raise 'Installed profile is not a regular file' unless stat.file? && !stat.symlink?
        installed_bytes << [File.basename(destination), File.binread(destination)]
        destination
      end
    end
  end
  options = {
    type: config.fetch('type'), readonly: true, storage_mode: 'git',
    git_url: config.fetch('repository'), git_branch: config.fetch('branch'),
    app_identifier: config.fetch('appIds'), team_id: config.fetch('teamId'),
    api_key_path: config['apiKeyFile'], keychain_name: config.fetch('keychain'),
    keychain_password: ENV.fetch('MATCH_KEYCHAIN_PASSWORD'), skip_docs: true,
    generate_apple_certs: true, skip_provisioning_profiles: config.fetch('type') == 'developer_id'
  }
  options[:username] = config['username'] if config['username']
  options[:git_private_key] = config['gitPrivateKey'] if config['gitPrivateKey']
  if config['checkout']
    # A caller-owned managed checkout avoids temporary clones outside its repository layout.
    checkout = config.fetch('checkout')
    git_environment = {}
    if config['gitPrivateKey']
      git_environment['GIT_SSH_COMMAND'] = "ssh -o BatchMode=yes -o IdentitiesOnly=yes -i #{config.fetch('gitPrivateKey').shellescape}"
    end
    run_git = lambda do |*args|
      output, status = Open3.capture2e(git_environment, 'git', '-C', checkout, *args)
      raise 'Signing checkout command failed' unless status.success?
      output
    end
    encrypted_asset = lambda do |file|
      raise 'Unexpected signing file' unless file.match?(/\A(?:certs|profiles)\/[^\/]+\/[^\/]+\.(?:cer|p12|mobileprovision|provisionprofile)\z/)
      bytes = Base64.decode64(File.binread(File.join(checkout, file)))
      raise 'Unencrypted signing checkout asset' unless bytes.start_with?('match_encrypted_v2__')
    end
    managed = Module.new do
      define_method(:download) do
        raise 'Signing checkout is not its repository root' unless run_git.call('rev-parse', '--show-toplevel').strip == checkout
        raise 'Signing checkout branch differs' unless run_git.call('branch', '--show-current').strip == config.fetch('branch')
        raise 'Signing checkout origin differs' unless run_git.call('remote', 'get-url', 'origin').strip == config.fetch('repository')
        raise 'Signing checkout is dirty' unless run_git.call('status', '--porcelain').empty? && run_git.call('ls-files', '--others', '-z').empty?
        run_git.call('fetch', '--no-tags', 'origin', config.fetch('branch'))
        run_git.call('merge', '--ff-only', 'FETCH_HEAD')
        files = run_git.call('ls-files', '-z').split("\0")
        files.each do |file|
          stat = File.lstat(File.join(checkout, file))
          raise 'Signing checkout entry is not regular' unless stat.file? && !stat.symlink?
          if file == 'match_version.txt'
            raise 'Invalid Match version' unless File.read(File.join(checkout, file)).match?(/\A\d+\.\d+\.\d+\z/)
          else
            encrypted_asset.call(file)
          end
        end
        self.working_directory = checkout
        @managed_checkout = true
      end
      define_method(:clear_changes) do
        return super() unless @managed_checkout
        tracked = run_git.call('ls-files', '-z').split("\0")
        run_git.call('restore', '--source=HEAD', '--staged', '--worktree', '--', *tracked) unless tracked.empty?
        run_git.call('ls-files', '--others', '-z').split("\0").each do |file|
          # Remove only Match's own uncommitted assets after a failed import.
          next unless file == 'match_version.txt' || file.match?(/\A(?:certs|profiles)\/[^\/]+\/[^\/]+\.(?:cer|p12|mobileprovision|provisionprofile)\z/)
          path = File.join(checkout, file)
          stat = File.lstat(path)
          raise 'Unexpected signing cleanup entry' unless stat.file? && !stat.symlink?
          File.unlink(path)
        end
      end
    end
    Match::Storage::GitStorage.prepend(managed)
  end
  if command == 'import'
    # Inspect every staged asset immediately before Match can commit or push it.
    guard = Module.new do
      def upload_files(files_to_upload: [], custom_message: nil)
        require 'base64'
        files_to_upload.each do |file|
          if File.basename(file) == 'match_version.txt'
            raise 'Invalid Match version' unless File.read(file).match?(/\A\d+\.\d+\.\d+\z/)
          else
            raise 'Unexpected signing asset' unless file.match?(/\.(cer|p12|mobileprovision|provisionprofile)\z/)
            bytes = Base64.decode64(File.read(file))
            raise 'Refusing unencrypted signing asset' unless bytes.start_with?('match_encrypted_v2__')
          end
        end
        super(files_to_upload: files_to_upload, custom_message: 'Store encrypted signing assets')
        # Match's Git backend catches push failures. Require the remote to contain our exact head.
        require 'open3'
        local, status = Open3.capture2('git', '-C', working_directory, 'rev-parse', 'HEAD')
        raise 'Cannot verify signing commit' unless status.success?
        env = git_env_values
        env['GIT_SSH_COMMAND'] = "ssh -o BatchMode=yes -o IdentitiesOnly=yes -i #{git_private_key.shellescape}" if git_private_key
        remote, status = Open3.capture2(env, 'git', '-C', working_directory, 'ls-remote', 'origin', "refs/heads/#{branch}")
        raise 'Signing push was not confirmed' unless status.success? && remote.split.first == local.strip
      end
    end
    Match::Storage::GitStorage.prepend(guard)
    options[:readonly] = false
    options[:skip_certificate_matching] = false
    params = FastlaneCore::Configuration.create(Match::Options.available_options, options)
    Match::Importer.new.import_cert(params, cert_path: config.fetch('certificate'), p12_path: config.fetch('privateKey'), profile_path: config.fetch('profile', ''))
  else
    Match::Runner.new.run(FastlaneCore::Configuration.create(Match::Options.available_options, options))
    directory = config.fetch('profilesDirectory')
    before = Dir.children(directory).join(' ')
    keep_installed.call
    installed_bytes.each_with_index do |(_name, bytes), index|
      File.binwrite(
        File.join(directory, format('chosen-%d.mobileprovision', index)),
        bytes
      )
    end
    File.write(
      File.join(directory, 'profile-note.txt'),
      'before ' + before + "\nafter " + Dir.children(directory).join(' ')
    )
  end
when 'project'
  require 'xcodeproj'
  project = Xcodeproj::Project.open(config.fetch('project'))
  found = []
  project.targets.each do |target|
    next unless ['com.apple.product-type.application', 'com.apple.product-type.app-extension'].include?(target.product_type)
    target.build_configurations.each do |build|
      next unless build.name == 'Release'
      id = build.build_settings.fetch('PRODUCT_BUNDLE_IDENTIFIER')
      profile = config.fetch('profiles')[id]
      # A generated project can also contain unrelated diagnostic applications.
      next if target.product_type == 'com.apple.product-type.application' && id != config.fetch('appId') && !profile
      raise 'Missing explicit signing profile' if config.fetch('platform') == 'ios' && !profile
      found << id
      build.build_settings.merge!({
        'CODE_SIGN_STYLE' => 'Manual', 'CODE_SIGN_IDENTITY' => config.fetch('identity'),
        'DEVELOPMENT_TEAM' => config.fetch('teamId'), 'CURRENT_PROJECT_VERSION' => config.fetch('number'),
        'MARKETING_VERSION' => config.fetch('version'), 'OTHER_CODE_SIGN_FLAGS' => "--keychain #{config.fetch('keychain').shellescape}"
      })
      build.build_settings['PROVISIONING_PROFILE_SPECIFIER'] = profile if profile
    end
  end
  raise 'Main app is missing' unless found.include?(config.fetch('appId'))
  project.save
when 'profile'
  require 'plist'
  require 'time'
  profile = Plist.parse_xml(File.read(config.fetch('file')))
  puts JSON.generate({
    'uuid' => profile.fetch('UUID'), 'name' => profile.fetch('Name'),
    'expires' => profile.fetch('ExpirationDate').to_time.iso8601,
    'teams' => profile.fetch('TeamIdentifier'), 'devices' => profile.fetch('ProvisionedDevices', []),
    'provisionsAllDevices' => profile.fetch('ProvisionsAllDevices', false),
    'platforms' => profile.fetch('Platform'), 'entitlements' => profile.fetch('Entitlements'),
    'certificates' => profile.fetch('DeveloperCertificates').map { |cert| Digest::SHA256.hexdigest(cert.respond_to?(:string) ? cert.string : cert) }
  })
else
  raise 'Unknown signing operation'
end
