<?php
/**
 * Site verification: meta tags in wp_head and a few root files, both served by the
 * Connector. Nothing is ever written to disk.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Verify {

	const OPTION    = 'pib_connector_verify';
	const MAX_TAGS  = 20;
	const MAX_FILES = 10;

	/**
	 * Meta names the Connector may print.
	 *
	 * @return string[]
	 */
	public static function allowed_names() {
		return array(
			'google-site-verification',
			'msvalidate.01',
			'yandex-verification',
			'p:domain_verify',
			'facebook-domain-verification',
			'norton-safeweb-site-verification',
			'baidu-site-verification',
			'naver-site-verification',
			'alexaVerifyID',
		);
	}

	public static function init() {
		add_action( 'wp_head', array( __CLASS__, 'print_meta_tags' ), 1 );
		add_action( 'parse_request', array( __CLASS__, 'serve' ), 0 );
	}

	/* Storage ---------------------------------------------------------- */

	/**
	 * The stored lists, re-checked against the rules (a tampered option can never print
	 * or serve anything the rules do not allow).
	 *
	 * @return array { metaTags: [], files: [] }
	 */
	public static function stored() {
		$raw   = get_option( self::OPTION, array() );
		$tags  = array();
		$files = array();
		if ( is_array( $raw ) ) {
			if ( isset( $raw['metaTags'] ) && is_array( $raw['metaTags'] ) ) {
				foreach ( $raw['metaTags'] as $t ) {
					if ( is_array( $t ) && isset( $t['name'], $t['content'] ) && is_string( $t['name'] ) && is_string( $t['content'] )
						&& self::tag_ok( $t['name'], $t['content'] ) ) {
						$tags[] = array( 'name' => $t['name'], 'content' => $t['content'] );
					}
				}
			}
			if ( isset( $raw['files'] ) && is_array( $raw['files'] ) ) {
				foreach ( $raw['files'] as $f ) {
					if ( is_array( $f ) && isset( $f['path'], $f['content'] ) && is_string( $f['path'] ) && is_string( $f['content'] ) ) {
						$type = self::file_type( $f['path'], $f['content'] );
						if ( null !== $type ) {
							$files[] = array( 'path' => $f['path'], 'contentType' => $type, 'content' => $f['content'] );
						}
					}
				}
			}
		}
		return array( 'metaTags' => $tags, 'files' => $files );
	}

	private static function save( array $tags, array $files ) {
		if ( empty( $tags ) && empty( $files ) ) {
			delete_option( self::OPTION );
			return;
		}
		$value = array(
			'metaTags' => array_values( $tags ),
			'files'    => array_map(
				function ( $f ) {
					return array( 'path' => $f['path'], 'content' => $f['content'] );
				},
				array_values( $files )
			),
		);
		if ( false === get_option( self::OPTION, false ) ) {
			add_option( self::OPTION, $value, '', 'yes' );
		} else {
			update_option( self::OPTION, $value, 'yes' );
		}
	}

	/* Rules ------------------------------------------------------------ */

	private static function tag_ok( $name, $content ) {
		return in_array( $name, self::allowed_names(), true )
			&& 1 === preg_match( '/^[A-Za-z0-9._:=+\/-]{1,200}\z/', $content );
	}

	/**
	 * Content type for a path/content pair that satisfies its rule, else null.
	 *
	 * @return string|null
	 */
	public static function file_type( $path, $content ) {
		// Google HTML file.
		if ( 1 === preg_match( '/^\/(google[0-9a-fA-F]{16,32}\.html)\z/', $path, $m ) ) {
			return ( 'google-site-verification: ' . $m[1] === $content ) ? 'text/html; charset=utf-8' : null;
		}
		// Bing.
		if ( '/BingSiteAuth.xml' === $path ) {
			return 1 === preg_match( '/^<\?xml version="1\.0"\?>\s*<users>\s*<user>[0-9A-F]{16,64}<\/user>\s*<\/users>\s*\z/', $content ) ? 'application/xml' : null;
		}
		// IndexNow key file.
		if ( 1 === preg_match( '/^\/([A-Za-z0-9-]{8,128})\.txt\z/', $path, $m ) ) {
			return ( $m[1] === $content || $m[1] . "\n" === $content || $m[1] . "\r\n" === $content ) ? 'text/plain; charset=utf-8' : null;
		}
		return null;
	}

	private static function is_list( array $a ) {
		return empty( $a ) || array_keys( $a ) === range( 0, count( $a ) - 1 );
	}

	/**
	 * @return array|WP_Error
	 */
	public static function validate_tags( $value ) {
		if ( ! is_array( $value ) || ! self::is_list( $value ) ) {
			return PIB_Connector_Util::bad_request( 'metaTags must be a list of { name, content }.' );
		}
		if ( count( $value ) > self::MAX_TAGS ) {
			return PIB_Connector_Util::bad_request( sprintf( 'metaTags holds at most %d items.', self::MAX_TAGS ) );
		}
		$out  = array();
		$seen = array();
		foreach ( $value as $i => $item ) {
			if ( ! is_array( $item ) || self::is_list( $item ) || array_diff( array_keys( $item ), array( 'name', 'content' ) ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'metaTags[%d] must be an object with name and content only.', $i ) );
			}
			if ( ! isset( $item['name'], $item['content'] ) || ! is_string( $item['name'] ) || ! is_string( $item['content'] ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'metaTags[%d] needs a string name and a string content.', $i ) );
			}
			if ( ! in_array( $item['name'], self::allowed_names(), true ) ) {
				return PIB_Connector_Util::error( 'pib_unsafe', sprintf( 'metaTags[%d]: "%s" is not a verification meta name the Connector prints.', $i, self::short( $item['name'] ) ), 422 );
			}
			if ( ! self::tag_ok( $item['name'], $item['content'] ) ) {
				return PIB_Connector_Util::error( 'pib_unsafe', sprintf( 'metaTags[%d]: content must be 1 to 200 characters of A-Z a-z 0-9 . _ : = + / -.', $i ), 422 );
			}
			$k = $item['name'] . "\n" . $item['content'];
			if ( isset( $seen[ $k ] ) ) {
				continue; // An exact duplicate adds nothing.
			}
			$seen[ $k ] = true;
			$out[]      = array( 'name' => $item['name'], 'content' => $item['content'] );
		}
		return $out;
	}

	/**
	 * @return array|WP_Error
	 */
	public static function validate_files( $value ) {
		if ( ! is_array( $value ) || ! self::is_list( $value ) ) {
			return PIB_Connector_Util::bad_request( 'files must be a list of { path, content }.' );
		}
		if ( count( $value ) > self::MAX_FILES ) {
			return PIB_Connector_Util::bad_request( sprintf( 'files holds at most %d items.', self::MAX_FILES ) );
		}
		$out   = array();
		$paths = array();
		foreach ( $value as $i => $item ) {
			if ( ! is_array( $item ) || self::is_list( $item ) || array_diff( array_keys( $item ), array( 'path', 'content' ) ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'files[%d] must be an object with path and content only.', $i ) );
			}
			if ( ! isset( $item['path'], $item['content'] ) || ! is_string( $item['path'] ) || ! is_string( $item['content'] ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'files[%d] needs a string path and a string content.', $i ) );
			}
			$type = self::file_type( $item['path'], $item['content'] );
			if ( null === $type ) {
				return PIB_Connector_Util::error( 'pib_unsafe', sprintf( 'files[%d]: "%s" is not an IndexNow key file, a Google HTML file or BingSiteAuth.xml, or its content does not match what that file must contain.', $i, self::short( $item['path'] ) ), 422 );
			}
			if ( isset( $paths[ $item['path'] ] ) ) {
				if ( $paths[ $item['path'] ] === $item['content'] ) {
					continue;
				}
				return PIB_Connector_Util::bad_request( sprintf( 'files[%d]: the path %s is listed twice with different content.', $i, $item['path'] ) );
			}
			$paths[ $item['path'] ] = $item['content'];
			$out[]                  = array( 'path' => $item['path'], 'contentType' => $type, 'content' => $item['content'] );
		}
		return $out;
	}

	private static function short( $s ) {
		$s = preg_replace( '/[^\x20-\x7E]/', '?', (string) $s );
		return strlen( $s ) > 60 ? substr( $s, 0, 60 ) . '...' : $s;
	}

	/* Disk conflicts --------------------------------------------------- */

	/**
	 * Stored paths that also exist as a real file (the web server serves those first).
	 *
	 * @return string[]
	 */
	public static function disk_conflicts( array $files ) {
		$roots = array( rtrim( ABSPATH, '/\\' ) );
		if ( ! empty( $_SERVER['DOCUMENT_ROOT'] ) && is_string( $_SERVER['DOCUMENT_ROOT'] ) ) {
			$roots[] = rtrim( $_SERVER['DOCUMENT_ROOT'], '/\\' ) . self::home_prefix(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		}
		$roots = array_unique( $roots );
		$out   = array();
		foreach ( $files as $f ) {
			foreach ( $roots as $root ) {
				if ( is_file( $root . $f['path'] ) ) {
					$out[] = $f['path'];
					break;
				}
			}
		}
		return $out;
	}

	private static function conflict_warnings( array $conflicts ) {
		$w = array();
		foreach ( $conflicts as $p ) {
			$w[] = sprintf( '%s also exists as a file on disk; the web server serves that file and the Connector never sees the request.', $p );
		}
		return $w;
	}

	/* Output ----------------------------------------------------------- */

	public static function print_meta_tags() {
		if ( ! PIB_Connector_Settings::feature_enabled( 'verify' ) ) {
			return;
		}
		$s = self::stored();
		foreach ( $s['metaTags'] as $t ) {
			echo '<meta name="' . esc_attr( $t['name'] ) . '" content="' . esc_attr( $t['content'] ) . '" />' . "\n";
		}
	}

	/**
	 * Path of the home URL without trailing slash ('' for a site at the domain root).
	 */
	private static function home_prefix() {
		$path = wp_parse_url( home_url( '/' ), PHP_URL_PATH );
		return is_string( $path ) ? rtrim( $path, '/' ) : '';
	}

	/**
	 * The response for a request, or null when the Connector has nothing to say.
	 *
	 * @param string $method GET, HEAD, ...
	 * @param string $uri    Raw REQUEST_URI.
	 * @return array|null { status, contentType, headers, body, sendBody }
	 */
	public static function match( $method, $uri ) {
		$method = strtoupper( (string) $method );
		if ( 'GET' !== $method && 'HEAD' !== $method ) {
			return null;
		}
		$uri = (string) $uri;
		if ( 1 === preg_match( '/^[A-Za-z][A-Za-z0-9+.-]*:\/\//', $uri ) ) {
			$p   = wp_parse_url( $uri, PHP_URL_PATH );
			$uri = is_string( $p ) ? $p : '';
		}
		$cut = strcspn( $uri, '?#' );
		$uri = substr( $uri, 0, $cut );
		$path = rtrim( $uri, '/' );

		$prefix = self::home_prefix();
		if ( '' !== $prefix ) {
			if ( 0 !== strpos( $path, $prefix . '/' ) ) {
				return null;
			}
			$path = substr( $path, strlen( $prefix ) );
		}
		if ( '' === $path || '/' !== $path[0] ) {
			return null;
		}
		if ( ! PIB_Connector_Settings::feature_enabled( 'verify' ) ) {
			return null;
		}
		foreach ( self::stored()['files'] as $f ) {
			if ( $f['path'] === $path ) {
				return array(
					'status'      => 200,
					'contentType' => $f['contentType'],
					'headers'     => array(
						'Content-Type'  => $f['contentType'],
						'Cache-Control' => 'no-cache',
						'X-Robots-Tag'  => 'noindex',
					),
					'body'        => $f['content'],
					'sendBody'    => 'GET' === $method,
				);
			}
		}
		return null;
	}

	/**
	 * parse_request handler: answer and stop, or do nothing.
	 */
	public static function serve() {
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? (string) $_SERVER['REQUEST_METHOD'] : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		if ( 'GET' !== strtoupper( $method ) && 'HEAD' !== strtoupper( $method ) ) {
			return;
		}
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		$res = self::match( $method, $uri );
		if ( null === $res ) {
			return;
		}
		if ( ! headers_sent() ) {
			if ( function_exists( 'status_header' ) ) {
				status_header( 200 );
			} else {
				http_response_code( 200 );
			}
			foreach ( $res['headers'] as $k => $v ) {
				header( $k . ': ' . $v );
			}
		}
		if ( $res['sendBody'] ) {
			echo $res['body']; // phpcs:ignore WordPress.Security.EscapeOutput -- validated against a fixed pattern for its path.
		}
		if ( apply_filters( 'pib_connector_verify_exit', true ) ) {
			exit;
		}
	}

	/* Endpoints -------------------------------------------------------- */

	public static function endpoint_get( array $params ) {
		$s = self::stored();
		return array(
			'metaTags'      => $s['metaTags'],
			'files'         => $s['files'],
			'diskConflicts' => self::disk_conflicts( $s['files'] ),
		);
	}

	public static function endpoint_set( array $params ) {
		$has_tags  = array_key_exists( 'metaTags', $params );
		$has_files = array_key_exists( 'files', $params );
		if ( ! $has_tags && ! $has_files ) {
			return PIB_Connector_Util::bad_request( 'Send metaTags and/or files.' );
		}
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$tags  = null;
		$files = null;
		if ( $has_tags ) {
			$tags = self::validate_tags( $params['metaTags'] );
			if ( is_wp_error( $tags ) ) {
				return $tags;
			}
		}
		if ( $has_files ) {
			$files = self::validate_files( $params['files'] );
			if ( is_wp_error( $files ) ) {
				return $files;
			}
		}

		$before = self::stored();
		$new    = array(
			'metaTags' => $has_tags ? $tags : $before['metaTags'],
			'files'    => $has_files ? $files : $before['files'],
		);
		self::save( $new['metaTags'], $new['files'] );
		$after = self::stored();

		$change_id = PIB_Connector_Log::record(
			'verify/set',
			'verify',
			array( 'verify' => true ),
			$reason,
			$before,
			$after
		);

		$out = array(
			'changeId' => $change_id,
			'metaTags' => $after['metaTags'],
			'files'    => $after['files'],
		);
		$out['warnings'] = self::conflict_warnings( self::disk_conflicts( $after['files'] ) );
		return $out;
	}

	/**
	 * Restore the previous lists.
	 *
	 * @return array|WP_Error [ target, before, after, warnings ]
	 */
	public static function undo( array $entry ) {
		$before = isset( $entry['before'] ) && is_array( $entry['before'] ) ? $entry['before'] : array();
		$tags   = self::validate_tags( isset( $before['metaTags'] ) ? $before['metaTags'] : array() );
		$files  = self::validate_files( array_map(
			function ( $f ) {
				return is_array( $f ) ? array_intersect_key( $f, array( 'path' => 1, 'content' => 1 ) ) : $f;
			},
			isset( $before['files'] ) && is_array( $before['files'] ) ? $before['files'] : array()
		) );
		if ( is_wp_error( $tags ) || is_wp_error( $files ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The saved previous state no longer passes the verification rules.', 422 );
		}
		$now = self::stored();
		self::save( $tags, $files );
		$after = self::stored();
		return array( $entry['target'], $now, $after, self::conflict_warnings( self::disk_conflicts( $after['files'] ) ) );
	}
}
