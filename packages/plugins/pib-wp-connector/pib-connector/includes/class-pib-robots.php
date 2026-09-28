<?php
/**
 * robots.txt extra lines and the "allow search engines" switch (never off).
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Robots {

	const OPTION    = 'pib_connector_robots_extra';
	const MAX_BYTES = 4096;
	const MARKER    = '# PiB Connector';
	const END       = '# /PiB Connector';

	public static function init() {
		add_filter( 'robots_txt', array( __CLASS__, 'filter_robots_txt' ), 99, 2 );
	}

	public static function extra_lines() {
		$v = get_option( self::OPTION, '' );
		return ( is_string( $v ) && '' !== $v ) ? $v : null;
	}

	public static function blog_public() {
		return '1' === (string) get_option( 'blog_public' );
	}

	public static function filter_robots_txt( $output, $public = null ) {
		$extra = self::extra_lines();
		if ( null === $extra ) {
			return $output;
		}
		$output = rtrim( (string) $output, "\n" ) . "\n\n" . self::MARKER . "\n" . $extra . "\n" . self::END . "\n";
		return $output;
	}

	/**
	 * Validate extra lines.
	 *
	 * @return string|null|WP_Error
	 */
	public static function validate_extra( $value ) {
		if ( null === $value ) {
			return null;
		}
		if ( ! is_string( $value ) ) {
			return PIB_Connector_Util::bad_request( 'extraLines must be a string or null.' );
		}
		$value = str_replace( array( "\r\n", "\r" ), "\n", $value );
		$value = trim( $value, "\n " );
		if ( '' === $value ) {
			return null;
		}
		if ( strlen( $value ) > self::MAX_BYTES ) {
			return PIB_Connector_Util::bad_request( 'extraLines is larger than 4 KB.' );
		}
		if ( preg_match( '/[\x00-\x08\x0B-\x1F\x7F<>]/', $value ) ) {
			return PIB_Connector_Util::bad_request( 'extraLines contains characters that do not belong in robots.txt.' );
		}
		if ( false !== stripos( $value, 'PiB Connector' ) ) {
			return PIB_Connector_Util::bad_request( 'extraLines may not contain the PiB Connector markers.' );
		}
		if ( self::blocks_everything( $value ) ) {
			return PIB_Connector_Util::error( 'pib_unsafe', 'extraLines may not contain "Disallow: /" under "User-agent: *".', 422 );
		}
		return $value;
	}

	/**
	 * True when a `Disallow: /` (or `/*`) line applies to `User-agent: *`.
	 * Lines before any User-agent line land in WordPress's own `User-agent: *` group.
	 */
	public static function blocks_everything( $text ) {
		$agents        = array( '*' );
		$in_agent_list = false; // WordPress's own group already has rules, so a User-agent line starts a new group.
		foreach ( explode( "\n", $text ) as $raw ) {
			$line = trim( preg_replace( '/#.*$/', '', $raw ) );
			if ( '' === $line ) {
				continue;
			}
			if ( preg_match( '/^user-agent\s*:\s*(.*)$/i', $line, $m ) ) {
				if ( ! $in_agent_list ) {
					$agents = array();
				}
				$agents[]      = trim( $m[1] );
				$in_agent_list = true;
				continue;
			}
			$in_agent_list = false;
			if ( preg_match( '/^disallow\s*:\s*(\S*)\s*$/i', $line, $m ) ) {
				$path = $m[1];
				if ( in_array( $path, array( '/', '/*', '/*$' ), true ) && in_array( '*', $agents, true ) ) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Render robots.txt the way WordPress serves it (a physical file wins).
	 */
	public static function render() {
		if ( defined( 'ABSPATH' ) && is_readable( ABSPATH . 'robots.txt' ) ) {
			$physical = file_get_contents( ABSPATH . 'robots.txt' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			return is_string( $physical ) ? $physical : '';
		}
		if ( ! function_exists( 'do_robots' ) ) {
			return '';
		}
		ob_start();
		do_robots();
		$txt = (string) ob_get_clean();
		// do_robots() sends a text/plain header; restore JSON for this REST response.
		if ( ! headers_sent() ) {
			header( 'Content-Type: application/json; charset=' . get_option( 'blog_charset', 'UTF-8' ) );
		}
		return $txt;
	}

	/* Endpoints -------------------------------------------------------- */

	public static function endpoint_get( array $params ) {
		return array(
			'blogPublic' => self::blog_public(),
			'extraLines' => self::extra_lines(),
			'robotsTxt'  => self::render(),
		);
	}

	public static function endpoint_set( array $params ) {
		$has_extra = array_key_exists( 'extraLines', $params );
		$allow     = array_key_exists( 'allowSearchEngines', $params ) ? $params['allowSearchEngines'] : null;

		if ( null !== $allow && ! is_bool( $allow ) ) {
			return PIB_Connector_Util::bad_request( 'allowSearchEngines must be true.' );
		}
		if ( ! $has_extra && true !== $allow ) {
			return PIB_Connector_Util::bad_request( 'Send extraLines and/or allowSearchEngines: true.' );
		}

		$extra = null;
		if ( $has_extra ) {
			$extra = self::validate_extra( $params['extraLines'] );
			if ( is_wp_error( $extra ) ) {
				return $extra;
			}
		}

		$before = array(
			'blogPublic' => self::blog_public(),
			'extraLines' => self::extra_lines(),
		);
		$warnings = array();

		if ( $has_extra ) {
			self::save_extra( $extra );
		}
		// The Connector only ever turns search engines ON. `false` is ignored.
		if ( true === $allow && ! self::blog_public() ) {
			update_option( 'blog_public', '1' );
		} elseif ( false === $allow ) {
			$warnings[] = 'allowSearchEngines: false is ignored; the Connector never discourages search engines.';
		}

		$after = array(
			'blogPublic' => self::blog_public(),
			'extraLines' => self::extra_lines(),
		);

		$change_id = PIB_Connector_Log::record(
			'robots/set',
			'robots',
			array( 'robots' => true ),
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			$before,
			$after
		);

		$out = array(
			'changeId'   => $change_id,
			'blogPublic' => $after['blogPublic'],
			'extraLines' => $after['extraLines'],
		);
		if ( ! empty( $warnings ) ) {
			$out['warnings'] = $warnings;
		}
		return $out;
	}

	private static function save_extra( $extra ) {
		if ( null === $extra ) {
			delete_option( self::OPTION );
			return;
		}
		if ( false === get_option( self::OPTION, false ) ) {
			add_option( self::OPTION, $extra, '', false );
		} else {
			update_option( self::OPTION, $extra, false );
		}
	}

	/**
	 * Restore extraLines. blog_public is never set back to 0.
	 *
	 * @return array [ target, before, after, warnings ]
	 */
	public static function undo( array $entry ) {
		$before   = is_array( $entry['before'] ) ? $entry['before'] : array();
		$now      = array(
			'blogPublic' => self::blog_public(),
			'extraLines' => self::extra_lines(),
		);
		$warnings = array();
		$restore  = array_key_exists( 'extraLines', $before ) ? $before['extraLines'] : null;
		self::save_extra( is_string( $restore ) && '' !== $restore ? $restore : null );
		if ( array_key_exists( 'blogPublic', $before ) && false === $before['blogPublic'] && $now['blogPublic'] ) {
			$warnings[] = 'Search engines stay allowed: the Connector never sets blog_public to 0. Change it in Settings → Reading if you must.';
		}
		$after = array(
			'blogPublic' => self::blog_public(),
			'extraLines' => self::extra_lines(),
		);
		return array( $entry['target'], $now, $after, $warnings );
	}
}
