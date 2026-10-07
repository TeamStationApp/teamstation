require 'json'
require 'fileutils'
require 'digest'
require 'shellwords'

# The TypeScript caller validates configuration and confines all generated files.
# This bridge uses the pinned Ruby libraries already required by Fastlane/Pods.
command, request_file = ARGV
config = JSON.parse(File.read(request_file))
case command
when 'match', 'import'
  require 'match'
  FastlaneCore::ProvisioningProfile.define_singleton_method(:profiles_path) { config.fetch('profilesDirectory') }
  FileUtils.mkdir_p(config.fetch('profilesDirectory'))
  options = {
    type: config.fetch('type'), readonly: true, storage_mode: 'git',
    git_url: config.fetch('repository'), git_branch: config.fetch('branch'),
    app_identifier: config.fetch('appIds'), team_id: config.fetch('teamId'),
    api_key_path: config.fetch('apiKeyFile'), keychain_name: config.fetch('keychain'),
    keychain_password: ENV.fetch('MATCH_KEYCHAIN_PASSWORD'), skip_docs: true,
    generate_apple_certs: true, skip_provisioning_profiles: config.fetch('type') == 'developer_id'
  }
  options[:git_private_key] = config['gitPrivateKey'] if config['gitPrivateKey']
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
    'platforms' => profile.fetch('Platform'), 'entitlements' => profile.fetch('Entitlements'),
    'certificates' => profile.fetch('DeveloperCertificates').map { |cert| Digest::SHA256.hexdigest(cert.respond_to?(:string) ? cert.string : cert) }
  })
else
  raise 'Unknown signing operation'
end
