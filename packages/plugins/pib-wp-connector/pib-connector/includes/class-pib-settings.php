<?php
/**
 * Key and feature settings.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Settings {

	const KEY_OPTION      = 'pib_connector_key';
	const SETTINGS_OPTION = 'pib_connector_settings';
	const KEY_PATTERN     = '/^pibc_[A-Za-z0-9_-]{43}$/';

	/**
	 * Feature => default state. `plugins` is off until a person switches it on.
	 *
	 * @return array
	 */
	public static function feature_defaults() {
		return array(
			'seo'       => true,
			'schema'    => true,
			'redirects' => true,
			'robots'    => true,
			'sitemap'   => true,
			'plugins'   => false,
		);
	}

	public static function feature_labels() {
		return array(
			'seo'       => __( 'SEO titles, descriptions, canonicals and robots meta', 'pib-connector' ),
			'schema'    => __( 'Structured data (JSON-LD)', 'pib-connector' ),
			'redirects' => __( 'Redirects', 'pib-connector' ),
			'robots'    => __( 'robots.txt extra lines', 'pib-connector' ),
			'sitemap'   => __( 'XML sitemap settings', 'pib-connector' ),
			'plugins'   => __( 'Install and roll back plugins (off by default)', 'pib-connector' ),
		);
	}

	const KEY_FILE_NAME   = 'pib-connector-key.php';

	/**
	 * Per-request cache of the key file result (false = not read yet).
	 *
	 * @var string|null|false
	 */
	private static $file_key = false;

	/**
	 * The full key, or null when not paired.
	 * Order: the option `pib_connector_key`, else `wp-content/pib-connector-key.php`
	 * (which must `return 'pibc_...';`).
	 *
	 * @return string|null
	 */
	public static function get_key() {
		$key = get_option( self::KEY_OPTION, '' );
		if ( is_string( $key ) && preg_match( self::KEY_PATTERN, $key ) ) {
			return $key;
		}
		return self::file_key();
	}

	/**
	 * @return string|null 'settings', 'file' or null.
	 */
	public static function key_source() {
		$key = get_option( self::KEY_OPTION, '' );
		if ( is_string( $key ) && preg_match( self::KEY_PATTERN, $key ) ) {
			return 'settings';
		}
		return null === self::file_key() ? null : 'file';
	}

	public static function key_file_path() {
		return rtrim( WP_CONTENT_DIR, '/\\' ) . '/' . self::KEY_FILE_NAME;
	}

	/**
	 * Read the key file once per request. Its output (if any) is discarded; it is never echoed.
	 *
	 * @return string|null
	 */
	public static function file_key() {
		if ( false !== self::$file_key ) {
			return self::$file_key;
		}
		self::$file_key = null;
		if ( ! defined( 'WP_CONTENT_DIR' ) ) {
			return null;
		}
		$path = self::key_file_path();
		if ( ! is_file( $path ) || ! is_readable( $path ) ) {
			return null;
		}
		ob_start();
		try {
			$value = include $path;
		} catch ( \Throwable $e ) {
			$value = null;
		}
		ob_end_clean();
		if ( is_string( $value ) ) {
			$value = trim( $value );
			if ( preg_match( self::KEY_PATTERN, $value ) ) {
				self::$file_key = $value;
			}
		}
		return self::$file_key;
	}

	/**
	 * Forget the cached key file result (tests, or after the file changes).
	 */
	public static function reset_file_cache() {
		self::$file_key = false;
	}

	public static function is_valid_key( $key ) {
		return is_string( $key ) && 1 === preg_match( self::KEY_PATTERN, $key );
	}

	/**
	 * Store a key (autoload off).
	 *
	 * @param string $key Key.
	 * @return bool
	 */
	public static function set_key( $key ) {
		if ( ! self::is_valid_key( $key ) ) {
			return false;
		}
		if ( false === get_option( self::KEY_OPTION, false ) ) {
			return add_option( self::KEY_OPTION, $key, '', false );
		}
		return update_option( self::KEY_OPTION, $key, false );
	}

	public static function delete_key() {
		return delete_option( self::KEY_OPTION );
	}

	/**
	 * Key id: the first 12 hex characters of sha256(key).
	 *
	 * @param string $key Key.
	 * @return string
	 */
	public static function key_id( $key ) {
		return substr( hash( 'sha256', (string) $key ), 0, 12 );
	}

	/**
	 * @return array feature => bool
	 */
	public static function features() {
		$defaults = self::feature_defaults();
		$stored   = get_option( self::SETTINGS_OPTION, array() );
		$out      = array();
		$flags    = ( is_array( $stored ) && isset( $stored['features'] ) && is_array( $stored['features'] ) ) ? $stored['features'] : array();
		foreach ( $defaults as $feature => $default ) {
			$out[ $feature ] = array_key_exists( $feature, $flags ) ? (bool) $flags[ $feature ] : $default;
		}
		return $out;
	}

	public static function feature_enabled( $feature ) {
		$features = self::features();
		return ! empty( $features[ $feature ] );
	}

	/**
	 * @param array $features feature => bool (unknown keys ignored).
	 */
	public static function set_features( array $features ) {
		$clean = array();
		foreach ( self::feature_defaults() as $feature => $default ) {
			$clean[ $feature ] = ! empty( $features[ $feature ] );
		}
		$stored = get_option( self::SETTINGS_OPTION, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}
		$stored['features'] = $clean;
		update_option( self::SETTINGS_OPTION, $stored );
	}
}
