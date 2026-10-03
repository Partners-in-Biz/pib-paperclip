<?php
/**
 * Plugin list, install from a checksummed https zip, backups and rollback.
 * Off by default; a person must switch the `plugins` feature on in wp-admin.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Plugins {

	const DIR_NAME     = 'pib-connector-backups';
	const INDEX_OPTION = 'pib_connector_backups';
	const SLUG_RE      = '/^[a-z0-9][a-z0-9_-]{0,99}$/';
	const BACKUP_RE    = '/^([a-z0-9][a-z0-9_-]{0,99})-([0-9]{14})$/';
	const SELF_SLUG    = 'pib-connector';
	// Connector self-update backups: pib-connector-<version>-<UTC yyyymmddHHMMss>.
	const SELF_BACKUP_RE = '/^pib-connector-([0-9A-Za-z.]{1,20})-([0-9]{14})$/';

	private static function load_admin() {
		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
	}

	public static function load_upgrader() {
		self::load_admin();
		if ( ! function_exists( 'download_url' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		if ( ! function_exists( 'show_message' ) ) {
			require_once ABSPATH . 'wp-admin/includes/misc.php';
		}
		if ( ! class_exists( 'Plugin_Upgrader' ) ) {
			require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
		}
	}

	public static function slug_of( $file ) {
		$dir = dirname( $file );
		return '.' === $dir ? basename( $file, '.php' ) : $dir;
	}

	/**
	 * @return string|null plugin file (e.g. `akismet/akismet.php`) for a folder slug.
	 */
	public static function file_for_slug( $slug ) {
		self::load_admin();
		foreach ( array_keys( get_plugins() ) as $file ) {
			if ( dirname( $file ) === $slug ) {
				return $file;
			}
		}
		return null;
	}

	public static function version_of( $file ) {
		if ( null === $file ) {
			return null;
		}
		$all = get_plugins();
		return isset( $all[ $file ]['Version'] ) ? (string) $all[ $file ]['Version'] : null;
	}

	/* Endpoints -------------------------------------------------------- */

	public static function endpoint_list( array $params ) {
		self::load_admin();
		$out = array();
		foreach ( get_plugins() as $file => $data ) {
			$out[] = array(
				'file'    => $file,
				'slug'    => self::slug_of( $file ),
				'name'    => isset( $data['Name'] ) ? $data['Name'] : $file,
				'version' => isset( $data['Version'] ) ? $data['Version'] : '',
				'active'  => is_plugin_active( $file ),
			);
		}
		return array( 'plugins' => $out );
	}

	public static function endpoint_backups( array $params ) {
		$out = array();
		foreach ( self::index() as $id => $meta ) {
			if ( isset( $meta['slug'] ) && self::SELF_SLUG === $meta['slug'] ) {
				continue; // Connector backups belong to self/rollback.
			}
			$path = self::backup_path( $id );
			if ( null === $path || ! is_file( $path ) ) {
				continue;
			}
			$out[] = array(
				'backupId'  => $id,
				'slug'      => $meta['slug'],
				'version'   => isset( $meta['version'] ) ? $meta['version'] : null,
				'createdAt' => isset( $meta['createdAt'] ) ? $meta['createdAt'] : null,
				'bytes'     => (int) filesize( $path ),
			);
		}
		usort(
			$out,
			function ( $a, $b ) {
				return strcmp( (string) $b['createdAt'], (string) $a['createdAt'] );
			}
		);
		return array( 'backups' => $out );
	}

	public static function endpoint_install( array $params ) {
		$zip_url = isset( $params['zipUrl'] ) ? $params['zipUrl'] : null;
		$sha256  = isset( $params['sha256'] ) ? $params['sha256'] : null;
		$slug    = isset( $params['slug'] ) ? $params['slug'] : null;

		if ( ! is_string( $zip_url ) || strlen( $zip_url ) > 2048 || 'https://' !== strtolower( substr( $zip_url, 0, 8 ) ) || ! wp_http_validate_url( $zip_url ) ) {
			return PIB_Connector_Util::bad_request( 'zipUrl must be a public https URL.' );
		}
		if ( ! is_string( $sha256 ) || ! preg_match( '/^[0-9a-fA-F]{64}$/', $sha256 ) ) {
			return PIB_Connector_Util::bad_request( 'sha256 must be 64 hex characters.' );
		}
		if ( ! is_string( $slug ) || ! preg_match( self::SLUG_RE, $slug ) ) {
			return PIB_Connector_Util::bad_request( 'slug must be a plugin folder name.' );
		}
		if ( self::SELF_SLUG === $slug ) {
			return PIB_Connector_Util::error( 'pib_forbidden', 'The Connector never installs over itself.', 403 );
		}
		if ( ! class_exists( 'ZipArchive' ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'PHP ZipArchive is not available on this server.', 422 );
		}

		self::load_upgrader();
		$tmp = download_url( $zip_url, 300 );
		if ( is_wp_error( $tmp ) ) {
			return PIB_Connector_Util::error( 'pib_download_failed', 'Download failed: ' . $tmp->get_error_message(), 502 );
		}

		$result = self::install_checked_zip( $tmp, strtolower( $sha256 ), $slug, isset( $params['reason'] ) ? $params['reason'] : null );
		if ( is_file( $tmp ) ) {
			wp_delete_file( $tmp ); // Our own temporary download, never site content.
		}
		return $result;
	}

	private static function install_checked_zip( $tmp, $sha256, $slug, $reason ) {
		$actual = hash_file( 'sha256', $tmp );
		if ( ! is_string( $actual ) || ! hash_equals( $sha256, $actual ) ) {
			return PIB_Connector_Util::error( 'pib_checksum', 'The downloaded zip does not match sha256.', 422 );
		}
		$check = self::check_zip_top_folder( $tmp, $slug );
		if ( is_wp_error( $check ) ) {
			return $check;
		}

		$file       = self::file_for_slug( $slug );
		$before     = null === $file ? null : array( 'version' => self::version_of( $file ) );
		$was_active = null !== $file && is_plugin_active( $file );
		$backup_id  = null;
		if ( null !== $file ) {
			$backup_id = self::backup_folder( $slug, $before['version'] );
			if ( is_wp_error( $backup_id ) ) {
				return $backup_id;
			}
		}

		$installed = self::run_upgrader( $tmp, $slug, $was_active );
		if ( is_wp_error( $installed ) ) {
			return $installed;
		}

		$change_id = PIB_Connector_Log::record(
			'plugins/install',
			'plugins',
			array( 'slug' => $slug ),
			PIB_Connector_Log::clean_reason( $reason ),
			$before,
			array( 'version' => $installed ),
			array( 'backupId' => $backup_id )
		);

		return array(
			'changeId' => $change_id,
			'slug'     => $slug,
			'before'   => $before,
			'after'    => array( 'version' => $installed ),
			'backupId' => $backup_id,
		);
	}

	public static function endpoint_rollback( array $params ) {
		$backup_id = isset( $params['backupId'] ) ? $params['backupId'] : null;
		if ( ! is_string( $backup_id ) || ! preg_match( self::BACKUP_RE, $backup_id, $m ) ) {
			return PIB_Connector_Util::bad_request( 'backupId is not valid.' );
		}
		$slug = $m[1];
		if ( self::SELF_SLUG === $slug ) {
			return PIB_Connector_Util::error( 'pib_forbidden', 'The Connector never rolls itself back.', 403 );
		}
		$index = self::index();
		$path  = self::backup_path( $backup_id );
		if ( ! isset( $index[ $backup_id ] ) || null === $path || ! is_file( $path ) ) {
			return PIB_Connector_Util::error( 'pib_not_found', 'No backup with that id.', 404 );
		}
		if ( ! class_exists( 'ZipArchive' ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'PHP ZipArchive is not available on this server.', 422 );
		}
		self::load_upgrader();
		$check = self::check_zip_top_folder( $path, $slug );
		if ( is_wp_error( $check ) ) {
			return $check;
		}

		$file       = self::file_for_slug( $slug );
		$current    = null === $file ? null : self::version_of( $file );
		$was_active = null !== $file && is_plugin_active( $file );
		$safety_id  = null;
		if ( null !== $file ) {
			$safety_id = self::backup_folder( $slug, $current );
			if ( is_wp_error( $safety_id ) ) {
				return $safety_id;
			}
		}

		$restored = self::run_upgrader( $path, $slug, $was_active );
		if ( is_wp_error( $restored ) ) {
			return $restored;
		}

		$change_id = PIB_Connector_Log::record(
			'plugins/rollback',
			'plugins',
			array(
				'slug'     => $slug,
				'backupId' => $backup_id,
			),
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			null === $current ? null : array( 'version' => $current ),
			array( 'version' => $restored ),
			array( 'backupId' => $safety_id )
		);

		return array(
			'changeId'        => $change_id,
			'slug'            => $slug,
			'restoredVersion' => $restored,
		);
	}

	/* Internals -------------------------------------------------------- */

	/**
	 * Every entry must live under `<slug>/`, with no absolute or parent paths.
	 *
	 * @return true|WP_Error
	 */
	public static function check_zip_top_folder( $zip_path, $slug ) {
		$zip = new ZipArchive();
		if ( true !== $zip->open( $zip_path ) ) {
			return PIB_Connector_Util::error( 'pib_bad_zip', 'The file is not a readable zip.', 422 );
		}
		$ok    = $zip->numFiles > 0;
		$php   = false;
		$count = $zip->numFiles;
		for ( $i = 0; $i < $count && $ok; $i++ ) {
			$name = $zip->getNameIndex( $i );
			if ( ! is_string( $name ) || false !== strpos( $name, '\\' ) || 0 !== strpos( $name, $slug . '/' ) || preg_match( '#(^|/)\.\.(/|$)#', $name ) ) {
				$ok = false;
				break;
			}
			if ( preg_match( '#^' . preg_quote( $slug, '#' ) . '/[^/]+\.php$#', $name ) ) {
				$php = true;
			}
		}
		$zip->close();
		if ( ! $ok ) {
			return PIB_Connector_Util::error( 'pib_bad_zip', sprintf( 'The zip must contain a single top folder named %s.', $slug ), 422 );
		}
		if ( ! $php ) {
			return PIB_Connector_Util::error( 'pib_bad_zip', 'The zip has no plugin PHP file in its top folder.', 422 );
		}
		return true;
	}

	/**
	 * Install a local zip over the plugin folder with Plugin_Upgrader and keep it active.
	 *
	 * @return string|WP_Error installed version
	 */
	public static function run_upgrader( $package, $slug, $was_active ) {
		if ( ! WP_Filesystem() ) {
			return PIB_Connector_Util::error( 'pib_fs_unavailable', 'WordPress cannot write plugin files directly on this server.', 500 );
		}
		$skin     = new WP_Ajax_Upgrader_Skin();
		$upgrader = new Plugin_Upgrader( $skin );
		ob_start();
		$result = $upgrader->install(
			$package,
			array(
				'overwrite_package'  => true,
				'clear_update_cache' => true,
			)
		);
		ob_end_clean();

		if ( is_wp_error( $result ) ) {
			return PIB_Connector_Util::error( 'pib_install_failed', $result->get_error_message(), 500 );
		}
		if ( method_exists( $skin, 'get_errors' ) && $skin->get_errors()->has_errors() ) {
			return PIB_Connector_Util::error( 'pib_install_failed', $skin->get_error_messages(), 500 );
		}
		if ( true !== $result ) {
			return PIB_Connector_Util::error( 'pib_install_failed', 'The plugin could not be installed.', 500 );
		}

		wp_clean_plugins_cache( true );
		$file = self::file_for_slug( $slug );
		if ( null === $file ) {
			return PIB_Connector_Util::error( 'pib_install_failed', 'The plugin folder is missing after install.', 500 );
		}
		if ( $was_active && ! is_plugin_active( $file ) ) {
			$activated = activate_plugin( $file, '', false, true );
			if ( is_wp_error( $activated ) ) {
				return PIB_Connector_Util::error( 'pib_install_failed', 'Installed, but reactivation failed: ' . $activated->get_error_message(), 500 );
			}
		}
		$version = self::version_of( $file );
		return null === $version ? '' : $version;
	}

	public static function backup_dir() {
		return trailingslashit( WP_CONTENT_DIR ) . self::DIR_NAME;
	}

	/**
	 * @return string|null absolute path for a backup id (validated), or null.
	 */
	public static function backup_path( $backup_id ) {
		if ( ! is_string( $backup_id ) || ( ! preg_match( self::BACKUP_RE, $backup_id ) && ! preg_match( self::SELF_BACKUP_RE, $backup_id ) ) ) {
			return null;
		}
		return self::backup_dir() . '/' . $backup_id . '.zip';
	}

	/**
	 * @return array backupId => { slug, version, createdAt }
	 */
	public static function index() {
		$idx = get_option( self::INDEX_OPTION, array() );
		return is_array( $idx ) ? $idx : array();
	}

	/**
	 * Create the protected backup folder.
	 *
	 * @return true|WP_Error
	 */
	private static function ensure_backup_dir() {
		$dir = self::backup_dir();
		if ( ! is_dir( $dir ) && ! wp_mkdir_p( $dir ) ) {
			return PIB_Connector_Util::error( 'pib_fs_unavailable', 'Could not create the backup folder.', 500 );
		}
		$htaccess = $dir . '/.htaccess';
		if ( ! is_file( $htaccess ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
			file_put_contents( $htaccess, "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n" );
		}
		$index = $dir . '/index.php';
		if ( ! is_file( $index ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
			file_put_contents( $index, "<?php\n// Silence is golden.\n" );
		}
		return true;
	}

	/**
	 * Zip wp-content/plugins/<slug> into the backup folder.
	 *
	 * @return string|WP_Error backupId
	 */
	public static function backup_folder( $slug, $version ) {
		return self::backup_folder_as( $slug, $version, false );
	}

	/**
	 * @param bool $self True for the Connector's own folder: the id carries the version.
	 * @return string|WP_Error backupId
	 */
	public static function backup_folder_as( $slug, $version, $self ) {
		$plugins_dir = realpath( WP_PLUGIN_DIR );
		$src         = realpath( WP_PLUGIN_DIR . '/' . $slug );
		if ( false === $plugins_dir || false === $src || ! is_dir( $src ) || dirname( $src ) !== $plugins_dir ) {
			return PIB_Connector_Util::error( 'pib_backup_failed', 'The plugin folder was not found.', 500 );
		}
		$ready = self::ensure_backup_dir();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}

		$time  = time();
		$stem  = $self ? $slug . '-' . substr( preg_replace( '/[^0-9A-Za-z.]/', '', (string) $version ), 0, 20 ) : $slug;
		$id    = $stem . '-' . gmdate( 'YmdHis', $time );
		for ( $i = 1; $i < 10 && null !== self::backup_path( $id ) && file_exists( self::backup_path( $id ) ); $i++ ) {
			$id = $stem . '-' . gmdate( 'YmdHis', $time + $i );
		}
		$dest = self::backup_path( $id );
		if ( null === $dest ) {
			return PIB_Connector_Util::error( 'pib_backup_failed', 'Could not name the backup.', 500 );
		}
		if ( file_exists( $dest ) ) {
			return PIB_Connector_Util::error( 'pib_backup_failed', 'Too many backups at once; try again.', 500 );
		}

		$zip = new ZipArchive();
		if ( true !== $zip->open( $dest, ZipArchive::CREATE | ZipArchive::EXCL ) ) {
			return PIB_Connector_Util::error( 'pib_backup_failed', 'Could not create the backup zip.', 500 );
		}
		$zip->addEmptyDir( $slug );
		$iterator = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator( $src, FilesystemIterator::SKIP_DOTS ),
			RecursiveIteratorIterator::SELF_FIRST
		);
		foreach ( $iterator as $item ) {
			if ( $item->isLink() ) {
				continue;
			}
			$relative = str_replace( '\\', '/', substr( $item->getPathname(), strlen( $src ) + 1 ) );
			if ( $item->isDir() ) {
				$zip->addEmptyDir( $slug . '/' . $relative );
			} elseif ( $item->isFile() ) {
				$zip->addFile( $item->getPathname(), $slug . '/' . $relative );
			}
		}
		if ( true !== $zip->close() ) {
			return PIB_Connector_Util::error( 'pib_backup_failed', 'Could not write the backup zip.', 500 );
		}

		$index        = self::index();
		$index[ $id ] = array(
			'slug'      => $slug,
			'version'   => $version,
			'createdAt' => gmdate( 'Y-m-d\TH:i:s\Z', $time ),
		);
		if ( false === get_option( self::INDEX_OPTION, false ) ) {
			add_option( self::INDEX_OPTION, $index, '', false );
		} else {
			update_option( self::INDEX_OPTION, $index, false );
		}
		return $id;
	}
}
