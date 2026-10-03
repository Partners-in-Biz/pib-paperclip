<?php
/**
 * self/update and self/rollback: the Connector replaces itself from a checksummed https zip on an
 * allow-listed host, after backing up its own folder, and restores the backup if anything fails.
 * Reuses the download / zip check / backup / Plugin_Upgrader code of the plugins feature.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_SelfUpdate {

	const SLUG      = 'pib-connector';
	const MAIN_FILE = 'pib-connector/pib-connector.php';
	const MAX_ENTRIES = 300;
	const MAX_UNPACKED = 8388608; // 8 MB.

	/**
	 * Hosts the update zip may come from. Extend in code with the filter
	 * `pib_connector_update_hosts`; there is no setting for it.
	 *
	 * @return string[]
	 */
	public static function allowed_hosts() {
		$hosts = apply_filters( 'pib_connector_update_hosts', array( 'paperclip.partnersinbiz.online' ) );
		$out   = array();
		foreach ( (array) $hosts as $h ) {
			if ( is_string( $h ) && preg_match( '/^[a-z0-9.-]{1,253}$/i', $h ) ) {
				$out[] = strtolower( $h );
			}
		}
		return $out;
	}

	/**
	 * Only a Connector that runs from wp-content/plugins/pib-connector can replace itself there.
	 *
	 * @return true|WP_Error
	 */
	private static function check_location() {
		$dir = apply_filters( 'pib_connector_self_dir', PIB_CONNECTOR_DIR );
		$a   = realpath( (string) $dir );
		$b   = realpath( WP_PLUGIN_DIR . '/' . self::SLUG );
		if ( false === $a || false === $b || $a !== $b ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'The Connector is not running from wp-content/plugins/pib-connector, so it cannot update itself.', 422 );
		}
		return true;
	}

	/**
	 * Validate the zip's shape and read the version of the Connector inside it.
	 *
	 * @return string|WP_Error version
	 */
	private static function inspect_zip( $path ) {
		$check = PIB_Connector_Plugins::check_zip_top_folder( $path, self::SLUG );
		if ( is_wp_error( $check ) ) {
			return $check;
		}
		$zip = new ZipArchive();
		if ( true !== $zip->open( $path ) ) {
			return PIB_Connector_Util::error( 'pib_bad_zip', 'The file is not a readable zip.', 422 );
		}
		$total = 0;
		$count = $zip->numFiles;
		if ( $count > self::MAX_ENTRIES ) {
			$zip->close();
			return PIB_Connector_Util::error( 'pib_bad_zip', 'The zip has too many entries.', 422 );
		}
		for ( $i = 0; $i < $count; $i++ ) {
			$st = $zip->statIndex( $i );
			if ( is_array( $st ) && isset( $st['size'] ) ) {
				$total += (int) $st['size'];
			}
		}
		if ( $total > self::MAX_UNPACKED ) {
			$zip->close();
			return PIB_Connector_Util::error( 'pib_bad_zip', 'The zip unpacks to more than 8 MB.', 422 );
		}
		$head = $zip->getFromName( self::MAIN_FILE, 8192 );
		$zip->close();
		if ( ! is_string( $head ) || '' === $head ) {
			return PIB_Connector_Util::error( 'pib_bad_zip', 'The zip has no pib-connector/pib-connector.php.', 422 );
		}
		if ( ! preg_match( '/^[ \t\/*#@]*Plugin Name:[ \t]*PiB Connector[ \t]*\r?$/mi', $head ) ) {
			return PIB_Connector_Util::error( 'pib_bad_zip', 'pib-connector.php is not the PiB Connector.', 422 );
		}
		if ( ! preg_match( '/^[ \t\/*#@]*Version:[ \t]*([0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9.]+)?)[ \t]*\r?$/mi', $head, $m ) ) {
			return PIB_Connector_Util::error( 'pib_bad_zip', 'pib-connector.php has no readable Version header.', 422 );
		}
		return $m[1];
	}

	/**
	 * Refuse a zip whose PHP files do not parse. A parse error in a new Connector would take the
	 * whole site down, and the Connector could not repair itself afterwards.
	 *
	 * @return true|WP_Error
	 */
	private static function check_php_syntax( $path ) {
		if ( ! function_exists( 'token_get_all' ) || ! defined( 'TOKEN_PARSE' ) ) {
			return true;
		}
		$zip = new ZipArchive();
		if ( true !== $zip->open( $path ) ) {
			return PIB_Connector_Util::error( 'pib_bad_zip', 'The file is not a readable zip.', 422 );
		}
		for ( $i = 0; $i < $zip->numFiles; $i++ ) {
			$name = (string) $zip->getNameIndex( $i );
			if ( '.php' !== strtolower( substr( $name, -4 ) ) ) {
				continue;
			}
			$src = $zip->getFromIndex( $i );
			if ( ! is_string( $src ) ) {
				$zip->close();
				return PIB_Connector_Util::error( 'pib_bad_zip', 'Could not read ' . $name . ' from the zip.', 422 );
			}
			try {
				token_get_all( $src, TOKEN_PARSE );
			} catch ( \Throwable $e ) {
				$zip->close();
				return PIB_Connector_Util::error( 'pib_bad_zip', sprintf( '%s has a PHP syntax error (line %d).', $name, (int) $e->getLine() ), 422 );
			}
		}
		$zip->close();
		return true;
	}

	/**
	 * After files were replaced: does the site still answer, with the Connector loaded? Asks the
	 * Connector's own route without a signature. A loaded Connector answers 401 `pib_*`; a fatal
	 * error in the new code shows up as a 5xx or WordPress's "critical error" page.
	 *
	 * @return string 'ok' | 'broken' | 'unknown' (loopback not possible on this host; not a failure)
	 */
	private static function site_check() {
		$forced = apply_filters( 'pib_connector_site_check', null );
		if ( is_string( $forced ) ) {
			return $forced;
		}
		if ( ! function_exists( 'wp_remote_post' ) || ! function_exists( 'home_url' ) ) {
			return 'unknown';
		}
		if ( function_exists( 'opcache_invalidate' ) ) {
			$base  = rtrim( (string) PIB_CONNECTOR_DIR, '/\\' );
			$files = array_merge( (array) glob( $base . '/*.php' ), (array) glob( $base . '/includes/*.php' ) );
			foreach ( $files as $f ) {
				@opcache_invalidate( $f, true ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- best effort.
			}
		}
		$url = add_query_arg( 'rest_route', '/pib-connector/v1/ping', home_url( '/' ) );
		$res = wp_remote_post(
			$url,
			array(
				'timeout'     => 20,
				'redirection' => 0,
				'sslverify'   => (bool) apply_filters( 'https_local_ssl_verify', false ),
				'headers'     => array( 'Content-Type' => 'application/json' ),
				'body'        => '{}',
			)
		);
		if ( is_wp_error( $res ) ) {
			return 'unknown';
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$body = (string) wp_remote_retrieve_body( $res );
		$json = json_decode( $body, true );
		if ( is_array( $json ) && isset( $json['code'] ) && is_string( $json['code'] ) && 0 === strpos( $json['code'], 'pib_' ) ) {
			return 'ok';
		}
		if ( $code >= 500 ) {
			return 'broken';
		}
		if ( 404 === $code && is_array( $json ) && isset( $json['code'] ) && 'rest_no_route' === $json['code'] ) {
			return 'broken'; // WordPress runs, but the Connector's route is gone.
		}
		return 'unknown';
	}

	/**
	 * Put a backup back over the Connector folder: Plugin_Upgrader first, WordPress's unzip_file() second.
	 *
	 * @return true|string true, or the reason it failed.
	 */
	private static function restore( $backup_id, $was_active ) {
		$path = PIB_Connector_Plugins::backup_path( $backup_id );
		if ( null === $path || ! is_file( $path ) ) {
			return 'the backup file is missing';
		}
		$res = PIB_Connector_Plugins::run_upgrader( $path, self::SLUG, $was_active );
		if ( ! is_wp_error( $res ) ) {
			return true;
		}
		$why = $res->get_error_message();
		if ( function_exists( 'unzip_file' ) && WP_Filesystem() ) {
			$un = unzip_file( $path, WP_PLUGIN_DIR );
			if ( true === $un ) {
				return true;
			}
			$why .= '; unzip_file: ' . ( is_wp_error( $un ) ? $un->get_error_message() : 'failed' );
		}
		return $why;
	}

	private static function plugin_file() {
		return PIB_Connector_Plugins::file_for_slug( self::SLUG );
	}

	public static function endpoint_update( array $params ) {
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$zip_url = isset( $params['zipUrl'] ) ? $params['zipUrl'] : null;
		$sha256  = isset( $params['sha256'] ) ? $params['sha256'] : null;

		if ( ! is_string( $zip_url ) || strlen( $zip_url ) > 2048 || 'https://' !== strtolower( substr( $zip_url, 0, 8 ) ) || preg_match( '/[\x00-\x20\x7F]/', $zip_url ) ) {
			return PIB_Connector_Util::bad_request( 'zipUrl must be an https URL.' );
		}
		if ( ! is_string( $sha256 ) || ! preg_match( '/^[0-9a-fA-F]{64}$/', $sha256 ) ) {
			return PIB_Connector_Util::bad_request( 'sha256 must be 64 hex characters.' );
		}
		$parts = wp_parse_url( $zip_url );
		$host  = ( is_array( $parts ) && ! empty( $parts['host'] ) ) ? strtolower( $parts['host'] ) : '';
		if ( '' === $host || isset( $parts['user'] ) || isset( $parts['pass'] ) || ( isset( $parts['port'] ) && 443 !== (int) $parts['port'] ) || ! in_array( $host, self::allowed_hosts(), true ) ) {
			return PIB_Connector_Util::error( 'pib_forbidden', 'The update zip must come from an allowed host over https on the default port.', 403 );
		}
		if ( ! wp_http_validate_url( $zip_url ) ) {
			return PIB_Connector_Util::bad_request( 'zipUrl must be an https URL.' );
		}
		if ( ! class_exists( 'ZipArchive' ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'PHP ZipArchive is not available on this server.', 422 );
		}
		$loc = self::check_location();
		if ( is_wp_error( $loc ) ) {
			return $loc;
		}

		PIB_Connector_Plugins::load_upgrader();
		$tmp = download_url( $zip_url, 300 );
		if ( is_wp_error( $tmp ) ) {
			return PIB_Connector_Util::error( 'pib_update_failed', 'Download failed: ' . $tmp->get_error_message(), 502 );
		}
		try {
			return self::update_from_file( $tmp, strtolower( $sha256 ), $reason );
		} finally {
			if ( is_string( $tmp ) && is_file( $tmp ) ) {
				wp_delete_file( $tmp ); // Our own temporary download, never site content.
			}
		}
	}

	private static function update_from_file( $tmp, $sha256, $reason ) {
		$actual = hash_file( 'sha256', $tmp );
		if ( ! is_string( $actual ) || ! hash_equals( $sha256, $actual ) ) {
			return PIB_Connector_Util::error( 'pib_checksum', 'The downloaded zip does not match sha256.', 422 );
		}
		$new_version = self::inspect_zip( $tmp );
		if ( is_wp_error( $new_version ) ) {
			return $new_version;
		}
		$syntax = self::check_php_syntax( $tmp );
		if ( is_wp_error( $syntax ) ) {
			return $syntax;
		}
		if ( version_compare( $new_version, PIB_CONNECTOR_VERSION, '<=' ) ) {
			return PIB_Connector_Util::error( 'pib_downgrade', sprintf( 'The zip is version %s; the installed Connector is %s. Only newer versions are installed (use self/rollback to go back).', $new_version, PIB_CONNECTOR_VERSION ), 422 );
		}

		$file = self::plugin_file();
		if ( null === $file ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'The Connector plugin folder was not found.', 422 );
		}
		$was_active = is_plugin_active( $file );
		$old        = PIB_CONNECTOR_VERSION;

		$backup_id = PIB_Connector_Plugins::backup_folder_as( self::SLUG, $old, true );
		if ( is_wp_error( $backup_id ) ) {
			return $backup_id;
		}

		$installed = PIB_Connector_Plugins::run_upgrader( $tmp, self::SLUG, $was_active );
		$problem   = null;
		if ( is_wp_error( $installed ) ) {
			$problem = $installed->get_error_message();
		} elseif ( $installed !== $new_version ) {
			$problem = sprintf( 'the installed version is %s, expected %s', $installed, $new_version );
		}
		if ( null === $problem && 'broken' === self::site_check() ) {
			$problem = 'the site stopped answering with the new version installed';
		}
		if ( null !== $problem ) {
			$restored = self::restore( $backup_id, $was_active );
			$msg      = 'Update failed: ' . $problem . '. ';
			$msg     .= true === $restored ? 'The previous version was restored.' : 'Restoring the previous version also failed (' . $restored . '); the backup is ' . $backup_id . '.';
			return PIB_Connector_Util::error( 'pib_update_failed', $msg, 502 );
		}

		$change_id = PIB_Connector_Log::record(
			'self/update',
			'selfupdate',
			array( 'slug' => self::SLUG ),
			$reason,
			array( 'version' => $old ),
			array(
				'version'  => $new_version,
				'backupId' => $backup_id,
			),
			array( 'backupId' => $backup_id )
		);
		return array(
			'changeId' => $change_id,
			'before'   => array( 'version' => $old ),
			'after'    => array( 'version' => $new_version ),
			'backupId' => $backup_id,
		);
	}

	public static function endpoint_rollback( array $params ) {
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$backup_id = isset( $params['backupId'] ) ? $params['backupId'] : null;
		if ( ! is_string( $backup_id ) || ! preg_match( PIB_Connector_Plugins::SELF_BACKUP_RE, $backup_id ) ) {
			return PIB_Connector_Util::bad_request( 'backupId is not a Connector backup id.' );
		}
		$index = PIB_Connector_Plugins::index();
		$path  = PIB_Connector_Plugins::backup_path( $backup_id );
		if ( ! isset( $index[ $backup_id ] ) || null === $path || ! is_file( $path ) ) {
			return PIB_Connector_Util::error( 'pib_not_found', 'No Connector backup with that id.', 404 );
		}
		if ( ! class_exists( 'ZipArchive' ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'PHP ZipArchive is not available on this server.', 422 );
		}
		$loc = self::check_location();
		if ( is_wp_error( $loc ) ) {
			return $loc;
		}
		PIB_Connector_Plugins::load_upgrader();
		$version = self::inspect_zip( $path );
		if ( is_wp_error( $version ) ) {
			return $version;
		}
		$syntax = self::check_php_syntax( $path );
		if ( is_wp_error( $syntax ) ) {
			return $syntax;
		}
		$file = self::plugin_file();
		if ( null === $file ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'The Connector plugin folder was not found.', 422 );
		}
		$was_active = is_plugin_active( $file );
		$current    = PIB_CONNECTOR_VERSION;

		$safety_id = PIB_Connector_Plugins::backup_folder_as( self::SLUG, $current, true );
		if ( is_wp_error( $safety_id ) ) {
			return $safety_id;
		}
		$installed = PIB_Connector_Plugins::run_upgrader( $path, self::SLUG, $was_active );
		$problem   = null;
		if ( is_wp_error( $installed ) ) {
			$problem = $installed->get_error_message();
		} elseif ( $installed !== $version ) {
			$problem = sprintf( 'the installed version is %s, expected %s', $installed, $version );
		}
		if ( null === $problem && 'broken' === self::site_check() ) {
			$problem = 'the site stopped answering with the restored version installed';
		}
		if ( null !== $problem ) {
			$restored = self::restore( $safety_id, $was_active );
			$msg      = 'Rollback failed: ' . $problem . '. ';
			$msg     .= true === $restored ? 'The current version was restored.' : 'Restoring the current version also failed (' . $restored . '); the backup is ' . $safety_id . '.';
			return PIB_Connector_Util::error( 'pib_update_failed', $msg, 502 );
		}

		$change_id = PIB_Connector_Log::record(
			'self/rollback',
			'selfupdate',
			array(
				'slug'     => self::SLUG,
				'backupId' => $backup_id,
			),
			$reason,
			array( 'version' => $current ),
			array(
				'version'  => $version,
				'backupId' => $safety_id,
			),
			array( 'backupId' => $safety_id )
		);
		return array(
			'changeId'        => $change_id,
			'restoredVersion' => $version,
		);
	}
}
