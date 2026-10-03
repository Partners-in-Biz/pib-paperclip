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
	 * @param array $params         Request params.
	 * @param bool  $allow_non_post Also accept termId / postTypeArchive and fall back to archive and
	 *                              term URLs (SEO endpoints only).
	 * @return array|WP_Error { postId, type, url, postType, title } (+ termId, taxonomy for terms)
	 */
	public static function resolve( array $params, $allow_non_post = false ) {
		$has_post = array_key_exists( 'postId', $params ) && null !== $params['postId'];
		$has_url  = array_key_exists( 'url', $params ) && null !== $params['url'] && '' !== $params['url'];

		if ( $allow_non_post ) {
			$has_term    = array_key_exists( 'termId', $params ) && null !== $params['termId'];
			$has_archive = array_key_exists( 'postTypeArchive', $params ) && null !== $params['postTypeArchive'] && '' !== $params['postTypeArchive'];
			if ( ( $has_term ? 1 : 0 ) + ( $has_archive ? 1 : 0 ) + ( $has_post ? 1 : 0 ) > 1 ) {
				return PIB_Connector_Util::bad_request( 'Send only one of postId, termId or postTypeArchive.' );
			}
			if ( $has_term ) {
				$term_id = PIB_Connector_Util::positive_int( $params['termId'] );
				if ( null === $term_id ) {
					return PIB_Connector_Util::bad_request( 'termId must be a positive integer.' );
				}
				$taxonomy = null;
				if ( array_key_exists( 'taxonomy', $params ) && null !== $params['taxonomy'] && '' !== $params['taxonomy'] ) {
					if ( ! is_string( $params['taxonomy'] ) || ! preg_match( '/^[a-z0-9_-]{1,32}$/', $params['taxonomy'] ) ) {
						return PIB_Connector_Util::bad_request( 'taxonomy must be a taxonomy name.' );
					}
					$taxonomy = $params['taxonomy'];
				}
				return self::from_term_id( $term_id, $taxonomy );
			}
			if ( $has_archive ) {
				if ( ! is_string( $params['postTypeArchive'] ) || ! preg_match( '/^[a-z0-9_-]{1,20}$/', $params['postTypeArchive'] ) ) {
					return PIB_Connector_Util::bad_request( 'postTypeArchive must be a post type name.' );
				}
				return self::from_post_type_archive( $params['postTypeArchive'] );
			}
		}

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
			return self::from_url( $params['url'], $allow_non_post );
		}

		return PIB_Connector_Util::bad_request( $allow_non_post ? 'Send url, postId, termId or postTypeArchive.' : 'Send url or postId.' );
	}

	/**
	 * @return array|WP_Error
	 */
	public static function from_url( $url, $allow_non_post = false ) {
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
			if ( $allow_non_post && '' === $query ) {
				$found = self::archive_or_term_for_path( $path );
				if ( null !== $found ) {
					return $found;
				}
			}
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'That URL is not a single page, post, post type archive or term.', 422 );
		}
		return self::from_post_id( $post_id );
	}

	private static function norm_path( $path ) {
		return '/' . trim( rawurldecode( (string) $path ), '/' );
	}

	/**
	 * Exact path match against post type archive links, then public term links.
	 *
	 * @return array|null
	 */
	private static function archive_or_term_for_path( $path ) {
		$want = strtolower( self::norm_path( $path ) );

		if ( function_exists( 'get_post_types' ) && function_exists( 'get_post_type_archive_link' ) ) {
			foreach ( array_keys( (array) get_post_types( array( 'public' => true ), 'names' ) ) as $type ) {
				$name = is_string( $type ) ? $type : (string) $type;
				$link = get_post_type_archive_link( $name );
				if ( is_string( $link ) && '' !== $link ) {
					$lp = wp_parse_url( $link, PHP_URL_PATH );
					if ( strtolower( self::norm_path( is_string( $lp ) ? $lp : '/' ) ) === $want ) {
						// WooCommerce: the shop page and the `product` archive share one URL and
						// url_to_postid() cannot see the page. Yoast renders it from the page, so
						// answer with the page (seo/set mirrors it to the archive settings).
						if ( 'product' === $name && function_exists( 'wc_get_page_id' ) && (int) wc_get_page_id( 'shop' ) > 0 ) {
							$page = self::from_post_id( (int) wc_get_page_id( 'shop' ) );
							if ( ! is_wp_error( $page ) ) {
								return $page;
							}
						}
						$t = self::from_post_type_archive( $name );
						if ( ! is_wp_error( $t ) ) {
							return $t;
						}
					}
				}
			}
		}

		if ( function_exists( 'get_taxonomies' ) && function_exists( 'get_terms' ) && function_exists( 'get_term_link' ) ) {
			$segments = explode( '/', trim( $want, '/' ) );
			$slug     = end( $segments );
			if ( is_string( $slug ) && '' !== $slug ) {
				$taxes = array_values( (array) get_taxonomies( array( 'public' => true ), 'names' ) );
				if ( ! empty( $taxes ) ) {
					$terms = get_terms(
						array(
							'taxonomy'   => $taxes,
							'slug'       => $slug,
							'hide_empty' => false,
						)
					);
					if ( is_array( $terms ) ) {
						foreach ( $terms as $term ) {
							if ( ! is_object( $term ) ) {
								continue;
							}
							$link = get_term_link( $term );
							if ( is_string( $link ) ) {
								$lp = wp_parse_url( $link, PHP_URL_PATH );
								if ( strtolower( self::norm_path( is_string( $lp ) ? $lp : '/' ) ) === $want ) {
									return self::term_target( $term, $link );
								}
							}
						}
					}
				}
			}
		}
		return null;
	}

	private static function term_target( $term, $link ) {
		return array(
			'postId'   => null,
			'type'     => 'term',
			'termId'   => (int) $term->term_id,
			'taxonomy' => (string) $term->taxonomy,
			'url'      => (string) $link,
			'title'    => (string) $term->name,
		);
	}

	/**
	 * @return array|WP_Error
	 */
	public static function from_term_id( $term_id, $taxonomy = null ) {
		if ( ! function_exists( 'get_term' ) || ! function_exists( 'get_taxonomies' ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'Terms are not available.', 422 );
		}
		if ( null !== $taxonomy ) {
			$taxes = array( $taxonomy );
		} else {
			$taxes = array_values( (array) get_taxonomies( array( 'public' => true ), 'names' ) );
		}
		foreach ( $taxes as $tax ) {
			if ( ! taxonomy_exists( $tax ) ) {
				continue;
			}
			$tax_obj = get_taxonomy( $tax );
			if ( ! $tax_obj || empty( $tax_obj->public ) ) {
				continue;
			}
			$term = get_term( $term_id, $tax );
			if ( is_object( $term ) && ! is_wp_error( $term ) && isset( $term->term_id ) ) {
				$link = get_term_link( $term );
				if ( ! is_string( $link ) ) {
					return PIB_Connector_Util::error( 'pib_unsupported_target', 'That term has no public page.', 422 );
				}
				return self::term_target( $term, $link );
			}
		}
		return PIB_Connector_Util::error( 'pib_unsupported_target', 'No public term with that id.', 422 );
	}

	/**
	 * @return array|WP_Error
	 */
	public static function from_post_type_archive( $type ) {
		$obj = function_exists( 'get_post_type_object' ) ? get_post_type_object( $type ) : null;
		if ( ! $obj || empty( $obj->public ) || empty( $obj->has_archive ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'That post type has no public archive page.', 422 );
		}
		$link = get_post_type_archive_link( $type );
		if ( ! is_string( $link ) || '' === $link ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'That post type has no archive link.', 422 );
		}
		return array(
			'postId'   => null,
			'type'     => 'archive',
			'postType' => (string) $type,
			'url'      => $link,
			'title'    => isset( $obj->labels->name ) ? (string) $obj->labels->name : (string) $type,
		);
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
