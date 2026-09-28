<?php
/**
 * JSON-LD schema pieces per page or for the whole site.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Schema {

	const META_KEY    = '_pib_schema';
	const SITE_OPTION = 'pib_connector_schema_site';
	const HOME_OPTION = 'pib_connector_schema_home';
	const MAX_PIECES  = 20;
	const MAX_BYTES   = 20480;
	const MAX_DEPTH   = 12;

	/**
	 * Resolve `site: true`, `url` or `postId`.
	 *
	 * @return array|WP_Error
	 */
	public static function resolve_target( array $params ) {
		if ( array_key_exists( 'site', $params ) && true === $params['site'] ) {
			return array(
				'postId'   => null,
				'type'     => 'site',
				'url'      => home_url( '/' ),
				'postType' => null,
				'title'    => (string) get_bloginfo( 'name' ),
			);
		}
		return PIB_Connector_Target::resolve( $params );
	}

	/**
	 * @return array list of { id, piece }
	 */
	public static function get_pieces( array $target ) {
		if ( 'site' === $target['type'] ) {
			$raw = get_option( self::SITE_OPTION, array() );
		} elseif ( 'home' === $target['type'] ) {
			$raw = get_option( self::HOME_OPTION, array() );
		} else {
			$raw = get_post_meta( (int) $target['postId'], self::META_KEY, true );
		}
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$out = array();
		foreach ( $raw as $item ) {
			if ( is_array( $item ) && isset( $item['id'], $item['piece'] ) && is_string( $item['id'] ) && is_array( $item['piece'] ) ) {
				$out[] = array(
					'id'    => $item['id'],
					'piece' => $item['piece'],
				);
			}
		}
		return $out;
	}

	public static function save_pieces( array $target, array $pieces ) {
		$pieces = array_values( $pieces );
		if ( 'site' === $target['type'] ) {
			update_option( self::SITE_OPTION, $pieces );
		} elseif ( 'home' === $target['type'] ) {
			update_option( self::HOME_OPTION, $pieces );
		} elseif ( empty( $pieces ) ) {
			delete_post_meta( (int) $target['postId'], self::META_KEY );
		} else {
			update_post_meta( (int) $target['postId'], self::META_KEY, wp_slash( $pieces ) );
		}
	}

	/**
	 * Validate and clean one piece.
	 *
	 * @return array|WP_Error
	 */
	public static function clean_piece( $piece ) {
		if ( ! is_array( $piece ) || empty( $piece ) || array_keys( $piece ) === range( 0, count( $piece ) - 1 ) ) {
			return PIB_Connector_Util::bad_request( 'piece must be one JSON-LD object.' );
		}
		unset( $piece['@context'] );
		if ( ! isset( $piece['@type'] ) || ! ( is_string( $piece['@type'] ) || is_array( $piece['@type'] ) ) || empty( $piece['@type'] ) ) {
			return PIB_Connector_Util::bad_request( 'piece needs an @type.' );
		}
		$check = self::check_value( $piece, 0 );
		if ( is_wp_error( $check ) ) {
			return $check;
		}
		$json = wp_json_encode( $piece );
		if ( false === $json || strlen( $json ) > self::MAX_BYTES ) {
			return PIB_Connector_Util::bad_request( 'piece is larger than 20 KB.' );
		}
		return $piece;
	}

	private static function check_value( $value, $depth ) {
		if ( $depth > self::MAX_DEPTH ) {
			return PIB_Connector_Util::bad_request( 'piece is nested too deeply.' );
		}
		if ( is_array( $value ) ) {
			foreach ( $value as $k => $v ) {
				if ( is_string( $k ) && ( strlen( $k ) > 200 || preg_match( '/[<>\x00-\x1F]/', $k ) ) ) {
					return PIB_Connector_Util::bad_request( 'piece has an invalid property name.' );
				}
				$r = self::check_value( $v, $depth + 1 );
				if ( is_wp_error( $r ) ) {
					return $r;
				}
			}
			return true;
		}
		if ( is_string( $value ) ) {
			if ( preg_match( '#<\s*/?\s*script#i', $value ) || false !== strpos( $value, '<!--' ) ) {
				return PIB_Connector_Util::bad_request( 'piece may not contain script tags or HTML comments.' );
			}
			return true;
		}
		if ( null === $value || is_bool( $value ) || is_int( $value ) || is_float( $value ) ) {
			return true;
		}
		return PIB_Connector_Util::bad_request( 'piece has an unsupported value.' );
	}

	/* Endpoints -------------------------------------------------------- */

	public static function endpoint_get( array $params ) {
		$target = self::resolve_target( $params );
		if ( is_wp_error( $target ) ) {
			return $target;
		}
		return array(
			'target' => $target,
			'pieces' => self::get_pieces( $target ),
		);
	}

	public static function endpoint_set( array $params ) {
		$target = self::resolve_target( $params );
		if ( is_wp_error( $target ) ) {
			return $target;
		}
		$id = isset( $params['id'] ) ? $params['id'] : null;
		if ( ! is_string( $id ) || ! preg_match( '/^[a-z0-9-]{1,64}$/', $id ) ) {
			return PIB_Connector_Util::bad_request( 'id must match [a-z0-9-]{1,64}.' );
		}
		$remove = array_key_exists( 'remove', $params ) && true === $params['remove'];

		$pieces = self::get_pieces( $target );
		$index  = null;
		foreach ( $pieces as $i => $item ) {
			if ( $item['id'] === $id ) {
				$index = $i;
				break;
			}
		}
		$before_piece = null === $index ? null : $pieces[ $index ]['piece'];

		if ( $remove ) {
			if ( null !== $index ) {
				array_splice( $pieces, $index, 1 );
			}
			$after_piece = null;
		} else {
			if ( ! array_key_exists( 'piece', $params ) ) {
				return PIB_Connector_Util::bad_request( 'Send piece, or remove: true.' );
			}
			$piece = self::clean_piece( $params['piece'] );
			if ( is_wp_error( $piece ) ) {
				return $piece;
			}
			if ( null === $index ) {
				if ( count( $pieces ) >= self::MAX_PIECES ) {
					return PIB_Connector_Util::error( 'pib_limit', 'This target already has 20 schema pieces.', 422 );
				}
				$pieces[] = array(
					'id'    => $id,
					'piece' => $piece,
				);
			} else {
				$pieces[ $index ]['piece'] = $piece;
			}
			$after_piece = $piece;
		}

		self::save_pieces( $target, $pieces );

		$change_id = PIB_Connector_Log::record(
			'schema/set',
			'schema',
			$target,
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			array(
				'id'    => $id,
				'piece' => $before_piece,
			),
			array(
				'id'    => $id,
				'piece' => $after_piece,
			)
		);

		return array(
			'changeId' => $change_id,
			'target'   => $target,
			'pieces'   => self::get_pieces( $target ),
		);
	}

	/**
	 * Restore a piece to its logged `before` state.
	 *
	 * @return array|WP_Error [ target, before, after, warnings ]
	 */
	public static function undo( array $entry ) {
		$target = $entry['target'];
		$before = $entry['before'];
		if ( ! is_array( $target ) || ! isset( $target['type'] ) || ! is_array( $before ) || ! isset( $before['id'] ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The logged change is incomplete.', 422 );
		}
		$id     = $before['id'];
		$pieces = self::get_pieces( $target );
		$now    = null;
		$index  = null;
		foreach ( $pieces as $i => $item ) {
			if ( $item['id'] === $id ) {
				$index = $i;
				$now   = $item['piece'];
				break;
			}
		}
		if ( null === $before['piece'] ) {
			if ( null !== $index ) {
				array_splice( $pieces, $index, 1 );
			}
		} elseif ( null === $index ) {
			$pieces[] = array(
				'id'    => $id,
				'piece' => $before['piece'],
			);
		} else {
			$pieces[ $index ]['piece'] = $before['piece'];
		}
		self::save_pieces( $target, $pieces );
		return array(
			$target,
			array(
				'id'    => $id,
				'piece' => $now,
			),
			array(
				'id'    => $id,
				'piece' => $before['piece'],
			),
			array(),
		);
	}

	/* Output ----------------------------------------------------------- */

	public static function init() {
		add_filter( 'wpseo_schema_graph', array( __CLASS__, 'filter_yoast_graph' ), 20, 2 );
		add_filter( 'rank_math/json_ld', array( __CLASS__, 'filter_rankmath_json_ld' ), 99, 2 );
		add_action( 'wp_head', array( __CLASS__, 'print_head_graph' ), 20 );
	}

	/**
	 * Pieces for the page being viewed: site pieces first, then the page's, each with an @id.
	 *
	 * @return array list of pieces
	 */
	public static function current_pieces() {
		$targets = array(
			array(
				'type' => 'site',
				'url'  => home_url( '/' ),
			),
		);
		if ( function_exists( 'is_front_page' ) && is_front_page() && is_home() ) {
			$targets[] = array(
				'type' => 'home',
				'url'  => home_url( '/' ),
			);
		} elseif ( function_exists( 'is_singular' ) && is_singular() ) {
			$id = (int) get_queried_object_id();
			if ( $id > 0 ) {
				$targets[] = array(
					'type'   => 'post',
					'postId' => $id,
					'url'    => (string) get_permalink( $id ),
				);
			}
		}
		$out = array();
		foreach ( $targets as $target ) {
			foreach ( self::get_pieces( $target ) as $item ) {
				$piece = $item['piece'];
				unset( $piece['@context'] );
				if ( empty( $piece['@id'] ) ) {
					$piece['@id'] = $target['url'] . '#pib-' . $item['id'];
				}
				$out[] = $piece;
			}
		}
		return $out;
	}

	public static function filter_yoast_graph( $graph, $context = null ) {
		if ( ! is_array( $graph ) ) {
			return $graph;
		}
		foreach ( self::current_pieces() as $piece ) {
			$graph[] = $piece;
		}
		return $graph;
	}

	public static function filter_rankmath_json_ld( $data, $jsonld = null ) {
		if ( 'rankmath' !== PIB_Connector_SEO::adapter() || ! is_array( $data ) ) {
			return $data;
		}
		foreach ( self::current_pieces() as $i => $piece ) {
			$data[ 'pib-' . $i ] = $piece;
		}
		return $data;
	}

	public static function print_head_graph() {
		if ( 'none' !== PIB_Connector_SEO::adapter() ) {
			return;
		}
		$pieces = self::current_pieces();
		if ( empty( $pieces ) ) {
			return;
		}
		$json = wp_json_encode(
			array(
				'@context' => 'https://schema.org',
				'@graph'   => $pieces,
			),
			JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
		);
		if ( false === $json ) {
			return;
		}
		echo '<script type="application/ld+json" class="pib-connector-schema">' . $json . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JSON with HEX_TAG, validated input.
	}
}
