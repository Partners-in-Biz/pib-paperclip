<?php
/**
 * XML sitemap: provider detection, Yoast's sitemap switch and excluded post ids.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Sitemap {

	const EXCLUDE_OPTION = 'pib_connector_sitemap_exclude';
	const MAX_EXCLUDE    = 1000;

	public static function init() {
		add_filter( 'wpseo_exclude_from_sitemap_by_post_ids', array( __CLASS__, 'filter_ids' ), 20 );
		add_filter( 'rank_math/sitemap/posts_to_exclude', array( __CLASS__, 'filter_ids' ), 20 );
		add_filter( 'wp_sitemaps_posts_query_args', array( __CLASS__, 'filter_core_query_args' ), 20, 2 );
	}

	/**
	 * @return int[]
	 */
	public static function exclude_ids() {
		$ids = get_option( self::EXCLUDE_OPTION, array() );
		if ( ! is_array( $ids ) ) {
			return array();
		}
		return array_values( array_unique( array_filter( array_map( 'intval', $ids ) ) ) );
	}

	public static function filter_ids( $ids ) {
		$mine = self::exclude_ids();
		if ( empty( $mine ) ) {
			return $ids;
		}
		if ( is_string( $ids ) ) {
			$ids = '' === $ids ? array() : array_map( 'intval', explode( ',', $ids ) );
		}
		$ids = is_array( $ids ) ? $ids : array();
		return array_values( array_unique( array_merge( array_map( 'intval', $ids ), $mine ) ) );
	}

	public static function filter_core_query_args( $args, $post_type = null ) {
		$mine = self::exclude_ids();
		if ( empty( $mine ) || ! is_array( $args ) ) {
			return $args;
		}
		$existing              = ( isset( $args['post__not_in'] ) && is_array( $args['post__not_in'] ) ) ? $args['post__not_in'] : array();
		$args['post__not_in'] = array_values( array_unique( array_merge( array_map( 'intval', $existing ), $mine ) ) );
		return $args;
	}

	/**
	 * Yoast's sitemap switch, or null when Yoast isn't the SEO plugin.
	 *
	 * @return bool|null
	 */
	public static function yoast_sitemap_enabled() {
		if ( 'yoast' !== PIB_Connector_SEO::adapter() ) {
			return null;
		}
		if ( class_exists( 'WPSEO_Options' ) && method_exists( 'WPSEO_Options', 'get' ) ) {
			return (bool) WPSEO_Options::get( 'enable_xml_sitemap' );
		}
		$opt = get_option( 'wpseo', array() );
		return is_array( $opt ) && ! empty( $opt['enable_xml_sitemap'] );
	}

	/**
	 * @return array [ provider, url ]
	 */
	public static function provider() {
		$adapter = PIB_Connector_SEO::adapter();
		if ( 'yoast' === $adapter && self::yoast_sitemap_enabled() ) {
			return array( 'yoast', home_url( '/sitemap_index.xml' ) );
		}
		if ( 'rankmath' === $adapter ) {
			$modules = get_option( 'rank_math_modules', array() );
			if ( ! is_array( $modules ) || in_array( 'sitemap', $modules, true ) ) {
				return array( 'rankmath', home_url( '/sitemap_index.xml' ) );
			}
		}
		if ( function_exists( 'wp_sitemaps_get_server' ) ) {
			$enabled = (bool) apply_filters( 'wp_sitemaps_enabled', '1' === (string) get_option( 'blog_public' ) );
			if ( $enabled ) {
				return array( 'core', home_url( '/wp-sitemap.xml' ) );
			}
		}
		return array( 'none', null );
	}

	private static function state() {
		list( $provider, $url ) = self::provider();
		return array(
			'provider'         => $provider,
			'url'              => $url,
			'seoPluginSitemap' => self::yoast_sitemap_enabled(),
			'excludePostIds'   => self::exclude_ids(),
		);
	}

	/* Endpoints -------------------------------------------------------- */

	public static function endpoint_get( array $params ) {
		return self::state();
	}

	public static function endpoint_set( array $params ) {
		$has_switch  = array_key_exists( 'seoPluginSitemap', $params ) && null !== $params['seoPluginSitemap'];
		$has_exclude = array_key_exists( 'excludePostIds', $params );
		if ( ! $has_switch && ! $has_exclude ) {
			return PIB_Connector_Util::bad_request( 'Send seoPluginSitemap and/or excludePostIds.' );
		}
		if ( $has_switch ) {
			if ( ! is_bool( $params['seoPluginSitemap'] ) ) {
				return PIB_Connector_Util::bad_request( 'seoPluginSitemap must be true or false.' );
			}
			if ( 'yoast' !== PIB_Connector_SEO::adapter() || ! class_exists( 'WPSEO_Options' ) ) {
				return PIB_Connector_Util::error( 'pib_unsupported', 'seoPluginSitemap can only be switched when Yoast SEO is active.', 422 );
			}
		}
		$ids = null;
		if ( $has_exclude ) {
			$ids = self::parse_ids( $params['excludePostIds'] );
			if ( is_wp_error( $ids ) ) {
				return $ids;
			}
		}

		$before = self::state();
		self::apply( $has_switch ? $params['seoPluginSitemap'] : null, $ids );
		$after = self::state();

		$change_id = PIB_Connector_Log::record(
			'sitemap/set',
			'sitemap',
			array( 'sitemap' => true ),
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			array(
				'seoPluginSitemap' => $before['seoPluginSitemap'],
				'excludePostIds'   => $before['excludePostIds'],
			),
			array(
				'seoPluginSitemap' => $after['seoPluginSitemap'],
				'excludePostIds'   => $after['excludePostIds'],
			)
		);

		return array_merge( array( 'changeId' => $change_id ), $after );
	}

	/**
	 * @return int[]|WP_Error
	 */
	public static function parse_ids( $value ) {
		if ( null === $value ) {
			return array();
		}
		if ( ! is_array( $value ) || count( $value ) > self::MAX_EXCLUDE ) {
			return PIB_Connector_Util::bad_request( 'excludePostIds must be a list of at most 1000 post ids.' );
		}
		$ids = array();
		foreach ( $value as $v ) {
			$id = PIB_Connector_Util::positive_int( $v );
			if ( null === $id ) {
				return PIB_Connector_Util::bad_request( 'excludePostIds must contain positive integers only.' );
			}
			$ids[ $id ] = $id;
		}
		return array_values( $ids );
	}

	/**
	 * @param bool|null  $switch Yoast sitemap on/off, null = leave.
	 * @param int[]|null $ids    Excluded ids, null = leave.
	 */
	private static function apply( $switch, $ids ) {
		if ( null !== $switch && class_exists( 'WPSEO_Options' ) ) {
			WPSEO_Options::set( 'enable_xml_sitemap', (bool) $switch );
		}
		if ( null !== $ids ) {
			if ( empty( $ids ) ) {
				delete_option( self::EXCLUDE_OPTION );
			} else {
				update_option( self::EXCLUDE_OPTION, $ids );
			}
		}
	}

	/**
	 * @return array|WP_Error [ target, before, after, warnings ]
	 */
	public static function undo( array $entry ) {
		$before   = is_array( $entry['before'] ) ? $entry['before'] : array();
		$after    = is_array( $entry['after'] ) ? $entry['after'] : array();
		$warnings = array();
		$now      = self::state();

		$switch = null;
		if ( isset( $before['seoPluginSitemap'] ) && is_bool( $before['seoPluginSitemap'] ) && ( ! isset( $after['seoPluginSitemap'] ) || $after['seoPluginSitemap'] !== $before['seoPluginSitemap'] ) ) {
			if ( 'yoast' === PIB_Connector_SEO::adapter() && class_exists( 'WPSEO_Options' ) ) {
				$switch = $before['seoPluginSitemap'];
			} else {
				$warnings[] = 'Yoast SEO is not active, so its sitemap switch was not restored.';
			}
		}
		$ids = array_key_exists( 'excludePostIds', $before ) && is_array( $before['excludePostIds'] ) ? array_map( 'intval', $before['excludePostIds'] ) : array();
		self::apply( $switch, $ids );
		$new = self::state();
		return array(
			$entry['target'],
			array(
				'seoPluginSitemap' => $now['seoPluginSitemap'],
				'excludePostIds'   => $now['excludePostIds'],
			),
			array(
				'seoPluginSitemap' => $new['seoPluginSitemap'],
				'excludePostIds'   => $new['excludePostIds'],
			),
			$warnings,
		);
	}
}
