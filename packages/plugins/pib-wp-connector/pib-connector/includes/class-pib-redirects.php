<?php
/**
 * Redirects stored and served by the Connector.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Redirects {

	const OPTION      = 'pib_connector_redirects';
	const HITS_OPTION = 'pib_connector_redirect_hits';
	const MAX         = 2000;

	public static function codes() {
		return array( 301, 302, 307, 308, 410 );
	}

	/**
	 * @return array from => { to, code, createdAt }
	 */
	public static function all() {
		$raw = get_option( self::OPTION, array() );
		return is_array( $raw ) ? $raw : array();
	}

	private static function save( array $redirects ) {
		ksort( $redirects );
		if ( false === get_option( self::OPTION, false ) ) {
			add_option( self::OPTION, $redirects, '', false );
		} else {
			update_option( self::OPTION, $redirects, false );
		}
	}

	/**
	 * Normalise a site-relative path: leading slash, no trailing slash except `/`,
	 * lower-cased, query and fragment stripped.
	 *
	 * @return string|WP_Error
	 */
	public static function normalize_from( $from ) {
		if ( ! is_string( $from ) || '' === trim( $from ) || strlen( $from ) > 2048 ) {
			return PIB_Connector_Util::bad_request( 'from must be a site-relative path.' );
		}
		$from = trim( $from );
		if ( preg_match( '/[\x00-\x20\x7F\\\\]/', $from ) ) {
			return PIB_Connector_Util::bad_request( 'from contains spaces, backslashes or control characters.' );
		}
		if ( preg_match( '#^[a-z][a-z0-9+.-]*://#i', $from ) || '//' === substr( $from, 0, 2 ) ) {
			$parts = wp_parse_url( $from );
			if ( ! is_array( $parts ) || empty( $parts['host'] ) || ! PIB_Connector_Util::is_same_host( $parts['host'] ) ) {
				return PIB_Connector_Util::bad_request( 'from must be a path on this site.' );
			}
			$from = isset( $parts['path'] ) ? $parts['path'] : '/';
		}
		$cut = strcspn( $from, '?#' );
		$from = substr( $from, 0, $cut );
		$from = '/' . ltrim( $from, '/' );
		$from = preg_replace( '#/{2,}#', '/', $from );
		if ( '/' !== $from ) {
			$from = rtrim( $from, '/' );
		}
		return strtolower( $from );
	}

	/**
	 * Validate `to`: a site-relative path or an absolute http(s) URL.
	 *
	 * @return string|WP_Error
	 */
	public static function validate_to( $to ) {
		if ( ! is_string( $to ) || '' === trim( $to ) || strlen( $to ) > 2048 ) {
			return PIB_Connector_Util::bad_request( 'to must be a relative path or an absolute http(s) URL.' );
		}
		$to = trim( $to );
		if ( preg_match( '/[\x00-\x20\x7F\\\\]/', $to ) ) {
			return PIB_Connector_Util::bad_request( 'to contains spaces, backslashes or control characters.' );
		}
		if ( '/' === substr( $to, 0, 1 ) ) {
			if ( '//' === substr( $to, 0, 2 ) ) {
				return PIB_Connector_Util::bad_request( 'to may not be protocol-relative.' );
			}
			return $to;
		}
		$parts = wp_parse_url( $to );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || ! isset( $parts['scheme'] ) || ! in_array( strtolower( $parts['scheme'] ), array( 'http', 'https' ), true ) ) {
			return PIB_Connector_Util::bad_request( 'to must be a relative path or an absolute http(s) URL.' );
		}
		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return PIB_Connector_Util::bad_request( 'to may not contain credentials.' );
		}
		return $to;
	}

	/**
	 * The normalised local path a `to` points at, or null when it leaves the site.
	 */
	public static function local_path_of( $to ) {
		if ( '/' === substr( $to, 0, 1 ) ) {
			$n = self::normalize_from( $to );
			return is_wp_error( $n ) ? null : $n;
		}
		$parts = wp_parse_url( $to );
		if ( is_array( $parts ) && ! empty( $parts['host'] ) && PIB_Connector_Util::is_same_host( $parts['host'] ) ) {
			$n = self::normalize_from( isset( $parts['path'] ) ? $parts['path'] : '/' );
			return is_wp_error( $n ) ? null : $n;
		}
		return null;
	}

	/**
	 * Would adding from→to create a loop with the existing redirects?
	 */
	public static function creates_loop( $from, $to, array $redirects ) {
		$seen = array( $from => true );
		$next = self::local_path_of( $to );
		$step = 0;
		while ( null !== $next && $step <= self::MAX + 1 ) {
			if ( isset( $seen[ $next ] ) ) {
				return true;
			}
			$seen[ $next ] = true;
			if ( ! isset( $redirects[ $next ] ) || 410 === (int) $redirects[ $next ]['code'] || empty( $redirects[ $next ]['to'] ) ) {
				return false;
			}
			$next = self::local_path_of( $redirects[ $next ]['to'] );
			$step++;
		}
		return false;
	}

	/**
	 * Public shape of one redirect.
	 */
	public static function public_redirect( $from, $r, $hits = null ) {
		if ( null === $hits ) {
			$all  = get_option( self::HITS_OPTION, array() );
			$hits = ( is_array( $all ) && isset( $all[ $from ] ) ) ? $all[ $from ] : array();
		}
		return array(
			'from'    => $from,
			'to'      => isset( $r['to'] ) ? $r['to'] : null,
			'code'    => (int) $r['code'],
			'hits'    => isset( $hits['hits'] ) ? (int) $hits['hits'] : 0,
			'lastHit' => isset( $hits['lastHit'] ) ? $hits['lastHit'] : null,
		);
	}

	/* Endpoints -------------------------------------------------------- */

	public static function endpoint_list( array $params ) {
		$hits = get_option( self::HITS_OPTION, array() );
		$hits = is_array( $hits ) ? $hits : array();
		$out  = array();
		foreach ( self::all() as $from => $r ) {
			$out[] = self::public_redirect( (string) $from, $r, isset( $hits[ $from ] ) ? $hits[ $from ] : array() );
		}
		return array(
			'provider'  => 'connector',
			'redirects' => $out,
		);
	}

	public static function endpoint_set( array $params ) {
		$from = self::normalize_from( isset( $params['from'] ) ? $params['from'] : null );
		if ( is_wp_error( $from ) ) {
			return $from;
		}
		$code = isset( $params['code'] ) ? $params['code'] : null;
		if ( is_string( $code ) && ctype_digit( $code ) ) {
			$code = (int) $code;
		}
		if ( ! is_int( $code ) || ! in_array( $code, self::codes(), true ) ) {
			return PIB_Connector_Util::bad_request( 'code must be 301, 302, 307, 308 or 410.' );
		}
		$to = null;
		if ( 410 !== $code ) {
			$to = self::validate_to( isset( $params['to'] ) ? $params['to'] : null );
			if ( is_wp_error( $to ) ) {
				return $to;
			}
			if ( self::local_path_of( $to ) === $from ) {
				return PIB_Connector_Util::error( 'pib_redirect_loop', 'to is the same page as from.', 422 );
			}
		}

		$redirects = self::all();
		if ( ! isset( $redirects[ $from ] ) && count( $redirects ) >= self::MAX ) {
			return PIB_Connector_Util::error( 'pib_limit', 'This site already has 2000 redirects.', 422 );
		}
		if ( null !== $to && self::creates_loop( $from, $to, $redirects ) ) {
			return PIB_Connector_Util::error( 'pib_redirect_loop', 'That redirect would create a loop with an existing redirect.', 422 );
		}

		$before             = isset( $redirects[ $from ] ) ? self::public_redirect( $from, $redirects[ $from ] ) : null;
		$redirects[ $from ] = array(
			'to'        => $to,
			'code'      => $code,
			'createdAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
		);
		self::save( $redirects );
		$after = self::public_redirect( $from, $redirects[ $from ] );

		$change_id = PIB_Connector_Log::record(
			'redirects/set',
			'redirects',
			array( 'from' => $from ),
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			self::strip_hits( $before ),
			self::strip_hits( $after )
		);

		return array(
			'changeId' => $change_id,
			'redirect' => $after,
		);
	}

	public static function endpoint_delete( array $params ) {
		$from = self::normalize_from( isset( $params['from'] ) ? $params['from'] : null );
		if ( is_wp_error( $from ) ) {
			return $from;
		}
		$redirects = self::all();
		$removed   = isset( $redirects[ $from ] );
		$before    = $removed ? self::public_redirect( $from, $redirects[ $from ] ) : null;
		if ( $removed ) {
			unset( $redirects[ $from ] );
			self::save( $redirects );
		}
		$change_id = PIB_Connector_Log::record(
			'redirects/delete',
			'redirects',
			array( 'from' => $from ),
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			self::strip_hits( $before ),
			null
		);
		return array(
			'changeId' => $change_id,
			'removed'  => $removed,
		);
	}

	private static function strip_hits( $r ) {
		if ( ! is_array( $r ) ) {
			return null;
		}
		return array(
			'from' => $r['from'],
			'to'   => $r['to'],
			'code' => $r['code'],
		);
	}

	/**
	 * Restore the logged `before` state of one redirect.
	 *
	 * @return array|WP_Error [ target, before, after, warnings ]
	 */
	public static function undo( array $entry ) {
		$target = $entry['target'];
		if ( ! is_array( $target ) || ! isset( $target['from'] ) || ! is_string( $target['from'] ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The logged change is incomplete.', 422 );
		}
		$from      = $target['from'];
		$redirects = self::all();
		$now       = isset( $redirects[ $from ] ) ? self::strip_hits( self::public_redirect( $from, $redirects[ $from ] ) ) : null;
		$before    = $entry['before'];
		if ( is_array( $before ) && isset( $before['code'] ) ) {
			if ( ! isset( $redirects[ $from ] ) && count( $redirects ) >= self::MAX ) {
				return PIB_Connector_Util::error( 'pib_limit', 'This site already has 2000 redirects.', 422 );
			}
			$redirects[ $from ] = array(
				'to'        => isset( $before['to'] ) ? $before['to'] : null,
				'code'      => (int) $before['code'],
				'createdAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
			);
		} else {
			unset( $redirects[ $from ] );
		}
		self::save( $redirects );
		$after = isset( $redirects[ $from ] ) ? self::strip_hits( self::public_redirect( $from, $redirects[ $from ] ) ) : null;
		return array( $target, $now, $after, array() );
	}

	/* Serving ---------------------------------------------------------- */

	public static function init() {
		add_action( 'template_redirect', array( __CLASS__, 'maybe_redirect' ), 1 );
	}

	/**
	 * Should this request be considered for redirects?
	 */
	public static function is_front_request() {
		if ( is_admin() ) {
			return false;
		}
		if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
			return false;
		}
		if ( function_exists( 'wp_doing_cron' ) && wp_doing_cron() ) {
			return false;
		}
		if ( function_exists( 'wp_doing_ajax' ) && wp_doing_ajax() ) {
			return false;
		}
		if ( isset( $GLOBALS['pagenow'] ) && 'wp-login.php' === $GLOBALS['pagenow'] ) {
			return false;
		}
		return true;
	}

	/**
	 * Find the redirect for a request URI.
	 *
	 * @return array|null [ from, redirect ]
	 */
	public static function match_request( $request_uri ) {
		$redirects = self::all();
		if ( empty( $redirects ) ) {
			return null;
		}
		$path = wp_parse_url( (string) $request_uri, PHP_URL_PATH );
		if ( ! is_string( $path ) || '' === $path ) {
			return null;
		}
		foreach ( array_unique( array( $path, rawurldecode( $path ) ) ) as $candidate ) {
			$n = self::normalize_from( $candidate );
			if ( ! is_wp_error( $n ) && isset( $redirects[ $n ] ) ) {
				return array( $n, $redirects[ $n ] );
			}
		}
		return null;
	}

	public static function maybe_redirect() {
		if ( ! self::is_front_request() || ! isset( $_SERVER['REQUEST_URI'] ) ) {
			return;
		}
		$match = self::match_request( wp_unslash( $_SERVER['REQUEST_URI'] ) ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- only parsed and compared.
		if ( null === $match ) {
			return;
		}
		list( $from, $r ) = $match;
		self::record_hit( $from );

		$code = (int) $r['code'];
		if ( 410 === $code ) {
			global $wp_query;
			if ( is_object( $wp_query ) && method_exists( $wp_query, 'set_404' ) ) {
				$wp_query->set_404();
			}
			status_header( 410 );
			nocache_headers();
			return;
		}

		$to = (string) $r['to'];
		if ( '/' === substr( $to, 0, 1 ) ) {
			$home = wp_parse_url( home_url( '/' ) );
			$to   = ( isset( $home['scheme'] ) ? $home['scheme'] : 'https' ) . '://' . $home['host'] . ( isset( $home['port'] ) ? ':' . $home['port'] : '' ) . $to;
		}
		// phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect -- external targets are intentional and validated.
		if ( wp_redirect( $to, $code, 'PiB Connector' ) ) {
			exit;
		}
	}

	private static function record_hit( $from ) {
		$hits = get_option( self::HITS_OPTION, array() );
		$hits = is_array( $hits ) ? $hits : array();
		$prev = isset( $hits[ $from ]['hits'] ) ? (int) $hits[ $from ]['hits'] : 0;

		$hits[ $from ] = array(
			'hits'    => $prev + 1,
			'lastHit' => gmdate( 'Y-m-d\TH:i:s\Z' ),
		);
		if ( false === get_option( self::HITS_OPTION, false ) ) {
			add_option( self::HITS_OPTION, $hits, '', false );
		} else {
			update_option( self::HITS_OPTION, $hits, false );
		}
	}
}
