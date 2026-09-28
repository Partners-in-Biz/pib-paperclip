<?php
/**
 * Resolves `url` / `postId` to a target page.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Target {

	/**
	 * @param array $params Request params.
	 * @return array|WP_Error { postId, type, url, postType, title }
	 */
	public static function resolve( array $params ) {
		$has_post = array_key_exists( 'postId', $params ) && null !== $params['postId'];
		$has_url  = array_key_exists( 'url', $params ) && null !== $params['url'] && '' !== $params['url'];

		if ( $has_post ) {
			$post_id = PIB_Connector_Util::positive_int( $params['postId'] );
			if ( null === $post_id ) {
				return PIB_Connector_Util::bad_request( 'postId must be a positive integer.' );
			}
			return self::from_post_id( $post_id );
		}

		if ( $has_url ) {
			if ( ! is_string( $params['url'] ) || strlen( $params['url'] ) > 2048 || preg_match( '/[\x00-\x20\x7F]/', $params['url'] ) ) {
				return PIB_Connector_Util::bad_request( 'url must be a URL or a site-relative path.' );
			}
			return self::from_url( $params['url'] );
		}

		return PIB_Connector_Util::bad_request( 'Send url or postId.' );
	}

	/**
	 * @return array|WP_Error
	 */
	public static function from_url( $url ) {
		$parts = wp_parse_url( $url );
		if ( false === $parts || ! is_array( $parts ) ) {
			return PIB_Connector_Util::bad_request( 'url could not be parsed.' );
		}

		if ( isset( $parts['host'] ) ) {
			$scheme = isset( $parts['scheme'] ) ? strtolower( $parts['scheme'] ) : '';
			if ( ! in_array( $scheme, array( 'http', 'https' ), true ) ) {
				return PIB_Connector_Util::bad_request( 'url must be http(s) or site-relative.' );
			}
			if ( ! PIB_Connector_Util::is_same_host( $parts['host'] ) ) {
				return PIB_Connector_Util::error( 'pib_unsupported_target', 'That URL is not on this site.', 422 );
			}
			$absolute = $url;
		} else {
			if ( isset( $parts['scheme'] ) || '/' !== substr( $url, 0, 1 ) || '//' === substr( $url, 0, 2 ) ) {
				return PIB_Connector_Util::bad_request( 'A relative url must start with a single /.' );
			}
			$home_parts = wp_parse_url( home_url( '/' ) );
			$absolute   = ( isset( $home_parts['scheme'] ) ? $home_parts['scheme'] : 'https' ) . '://' . ( isset( $home_parts['host'] ) ? $home_parts['host'] : '' ) . ( isset( $home_parts['port'] ) ? ':' . $home_parts['port'] : '' ) . $url;
		}

		$path  = isset( $parts['path'] ) ? $parts['path'] : '/';
		$query = isset( $parts['query'] ) ? $parts['query'] : '';

		if ( '' === $query && self::is_home_path( $path ) ) {
			return self::home_target();
		}

		$post_id = (int) url_to_postid( $absolute );
		if ( $post_id <= 0 ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'That URL is not a single page or post (archives and terms are not supported).', 422 );
		}
		return self::from_post_id( $post_id );
	}

	private static function is_home_path( $path ) {
		$home_parts = wp_parse_url( home_url( '/' ) );
		$home_path  = isset( $home_parts['path'] ) ? $home_parts['path'] : '/';
		$norm       = function ( $p ) {
			$p = '/' . trim( (string) $p, '/' );
			return strtolower( $p );
		};
		return $norm( $path ) === $norm( $home_path );
	}

	/**
	 * The home page: the static front page, or `home` when the site shows latest posts.
	 *
	 * @return array|WP_Error
	 */
	public static function home_target() {
		if ( 'page' === get_option( 'show_on_front' ) ) {
			$front = (int) get_option( 'page_on_front' );
			if ( $front > 0 ) {
				return self::from_post_id( $front );
			}
		}
		return array(
			'postId'   => null,
			'type'     => 'home',
			'url'      => home_url( '/' ),
			'postType' => null,
			'title'    => (string) get_bloginfo( 'name' ),
		);
	}

	/**
	 * @return array|WP_Error
	 */
	public static function from_post_id( $post_id ) {
		$post = get_post( $post_id );
		if ( ! $post || ! is_object( $post ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'No post with that id.', 422 );
		}
		if ( in_array( $post->post_status, array( 'trash', 'auto-draft', 'inherit' ), true ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'That post is not a live page or post.', 422 );
		}
		$viewable = function_exists( 'is_post_type_viewable' ) ? is_post_type_viewable( $post->post_type ) : ! in_array( $post->post_type, array( 'revision', 'nav_menu_item', 'wp_block' ), true );
		if ( ! $viewable ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'That post type has no public page.', 422 );
		}
		return array(
			'postId'   => (int) $post->ID,
			'type'     => 'post',
			'url'      => (string) get_permalink( $post ),
			'postType' => (string) $post->post_type,
			'title'    => (string) get_the_title( $post ),
		);
	}
}
