<?php
/**
 * SEO fields: adapters for Yoast, RankMath and "no SEO plugin".
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_SEO {

	const HOME_OPTION    = 'pib_connector_home_seo';
	const ARCHIVE_OPTION = 'pib_connector_archive_seo';

	/**
	 * Field => max length for string fields.
	 */
	public static function string_fields() {
		return array(
			'title'         => 300,
			'description'   => 1000,
			'canonical'     => 2048,
			'focusKeyword'  => 200,
			'ogTitle'       => 300,
			'ogDescription' => 1000,
			'ogImage'       => 2048,
		);
	}

	public static function field_names() {
		return array( 'title', 'description', 'canonical', 'noindex', 'nofollow', 'focusKeyword', 'ogTitle', 'ogDescription', 'ogImage' );
	}

	/**
	 * Post meta keys per adapter (booleans handled separately for RankMath).
	 */
	public static function meta_keys( $adapter ) {
		if ( 'yoast' === $adapter ) {
			return array(
				'title'         => '_yoast_wpseo_title',
				'description'   => '_yoast_wpseo_metadesc',
				'canonical'     => '_yoast_wpseo_canonical',
				'noindex'       => '_yoast_wpseo_meta-robots-noindex',
				'nofollow'      => '_yoast_wpseo_meta-robots-nofollow',
				'focusKeyword'  => '_yoast_wpseo_focuskw',
				'ogTitle'       => '_yoast_wpseo_opengraph-title',
				'ogDescription' => '_yoast_wpseo_opengraph-description',
				'ogImage'       => '_yoast_wpseo_opengraph-image',
			);
		}
		if ( 'rankmath' === $adapter ) {
			return array(
				'title'         => 'rank_math_title',
				'description'   => 'rank_math_description',
				'canonical'     => 'rank_math_canonical_url',
				'noindex'       => 'rank_math_robots',
				'nofollow'      => 'rank_math_robots',
				'focusKeyword'  => 'rank_math_focus_keyword',
				'ogTitle'       => 'rank_math_facebook_title',
				'ogDescription' => 'rank_math_facebook_description',
				'ogImage'       => 'rank_math_facebook_image',
			);
		}
		return array(
			'title'         => '_pib_seo_title',
			'description'   => '_pib_seo_description',
			'canonical'     => '_pib_seo_canonical',
			'noindex'       => '_pib_seo_noindex',
			'nofollow'      => '_pib_seo_nofollow',
			'focusKeyword'  => '_pib_seo_focus_keyword',
			'ogTitle'       => '_pib_seo_og_title',
			'ogDescription' => '_pib_seo_og_description',
			'ogImage'       => '_pib_seo_og_image',
		);
	}

	/**
	 * Post/term meta key that holds the attachment id next to the ogImage URL (null = none).
	 */
	public static function image_id_key( $adapter ) {
		if ( 'yoast' === $adapter ) {
			return '_yoast_wpseo_opengraph-image-id';
		}
		if ( 'rankmath' === $adapter ) {
			return 'rank_math_facebook_image_id';
		}
		return null;
	}

	/**
	 * Home-page option keys per adapter (fields not listed are not supported for `home`).
	 */
	public static function home_keys( $adapter ) {
		if ( 'yoast' === $adapter ) {
			return array(
				'title'         => 'title-home-wpseo',
				'description'   => 'metadesc-home-wpseo',
				'ogTitle'       => 'open_graph_frontpage_title',
				'ogDescription' => 'open_graph_frontpage_desc',
				'ogImage'       => 'open_graph_frontpage_image',
			);
		}
		if ( 'rankmath' === $adapter ) {
			return array(
				'title'       => 'homepage_title',
				'description' => 'homepage_description',
				'ogImage'     => 'homepage_facebook_image',
			);
		}
		$keys = array();
		foreach ( self::field_names() as $f ) {
			$keys[ $f ] = $f;
		}
		return $keys;
	}

	/**
	 * Active SEO plugin: yoast | rankmath | none.
	 */
	public static function adapter() {
		$detected = 'none';
		if ( defined( 'WPSEO_VERSION' ) ) {
			$detected = 'yoast';
		} elseif ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) ) {
			$detected = 'rankmath';
		}
		$filtered = apply_filters( 'pib_connector_seo_plugin', $detected );
		return in_array( $filtered, array( 'yoast', 'rankmath', 'none' ), true ) ? $filtered : $detected;
	}

	/* ------------------------------------------------------------------ */
	/* Read / write                                                       */
	/* ------------------------------------------------------------------ */

	private static function blank_fields() {
		$out = array();
		foreach ( self::field_names() as $f ) {
			$out[ $f ] = null;
		}
		return $out;
	}

	private static function str_or_null( $value ) {
		return ( is_string( $value ) && '' !== $value ) ? $value : null;
	}

	/**
	 * @param array $target Resolved target.
	 * @return array field => value|null
	 */
	public static function get_fields( array $target ) {
		$adapter = self::adapter();
		$out     = self::blank_fields();
		$type    = $target['type'];

		if ( 'home' === $type ) {
			foreach ( self::home_keys( $adapter ) as $field => $key ) {
				$value = self::home_read( $adapter, $key );
				if ( 'noindex' === $field || 'nofollow' === $field ) {
					$out[ $field ] = ( null === $value || '' === $value ) ? null : (bool) $value;
				} else {
					$out[ $field ] = self::str_or_null( $value );
				}
			}
			return $out;
		}

		if ( 'archive' === $type ) {
			return self::archive_get( $adapter, (string) $target['postType'] );
		}

		if ( 'term' === $type && 'yoast' === $adapter ) {
			return self::yoast_term_get( $target );
		}

		// Post meta (post targets) or term meta (RankMath / no plugin, term targets).
		$keys = self::meta_keys( $adapter );
		foreach ( $keys as $field => $key ) {
			if ( 'noindex' === $field || 'nofollow' === $field ) {
				continue;
			}
			$out[ $field ] = self::str_or_null( self::m_get( $target, $key ) );
		}

		if ( 'yoast' === $adapter ) {
			$ni              = (string) self::m_get( $target, $keys['noindex'] );
			$nf              = (string) self::m_get( $target, $keys['nofollow'] );
			$out['noindex']  = '1' === $ni ? true : ( '2' === $ni ? false : null );
			$out['nofollow'] = '1' === $nf ? true : ( '0' === $nf ? false : null );
		} elseif ( 'rankmath' === $adapter ) {
			$robots = self::m_get( $target, 'rank_math_robots' );
			$robots = is_array( $robots ) ? $robots : array();
			if ( in_array( 'noindex', $robots, true ) ) {
				$out['noindex'] = true;
			} elseif ( in_array( 'index', $robots, true ) ) {
				$out['noindex'] = false;
			}
			if ( in_array( 'nofollow', $robots, true ) ) {
				$out['nofollow'] = true;
			} elseif ( ! empty( $robots ) ) {
				$out['nofollow'] = false;
			}
		} else {
			foreach ( array( 'noindex', 'nofollow' ) as $field ) {
				$value         = (string) self::m_get( $target, $keys[ $field ] );
				$out[ $field ] = '1' === $value ? true : ( '0' === $value ? false : null );
			}
		}
		return $out;
	}

	/* -- meta helpers (post or term) -- */

	private static function m_get( array $target, $key ) {
		if ( 'term' === $target['type'] ) {
			return get_term_meta( (int) $target['termId'], $key, true );
		}
		return get_post_meta( (int) $target['postId'], $key, true );
	}

	private static function m_update( array $target, $key, $value ) {
		if ( 'term' === $target['type'] ) {
			update_term_meta( (int) $target['termId'], $key, $value );
		} else {
			update_post_meta( (int) $target['postId'], $key, $value );
		}
	}

	private static function m_delete( array $target, $key ) {
		if ( 'term' === $target['type'] ) {
			delete_term_meta( (int) $target['termId'], $key );
		} else {
			delete_post_meta( (int) $target['postId'], $key );
		}
	}

	private static function attachment_id_for( $url ) {
		if ( ! is_string( $url ) || '' === $url || ! function_exists( 'attachment_url_to_postid' ) ) {
			return 0;
		}
		return (int) attachment_url_to_postid( $url );
	}

	/* -- home -- */

	private static function home_option_name( $adapter, $key ) {
		if ( 'yoast' === $adapter ) {
			return 'wpseo_titles';
		}
		if ( 'rankmath' === $adapter ) {
			return 'rank-math-options-titles';
		}
		return self::HOME_OPTION;
	}

	private static function home_id_key( $adapter ) {
		if ( 'yoast' === $adapter ) {
			return 'open_graph_frontpage_image_id';
		}
		if ( 'rankmath' === $adapter ) {
			return 'homepage_facebook_image_id';
		}
		return null;
	}

	private static function home_read( $adapter, $key ) {
		$opt = get_option( self::home_option_name( $adapter, $key ), array() );
		return ( is_array( $opt ) && isset( $opt[ $key ] ) ) ? $opt[ $key ] : null;
	}

	/* -- Yoast terms: option wpseo_taxonomy_meta[taxonomy][termId] -- */

	private static function yoast_term_keys() {
		return array(
			'title'         => 'wpseo_title',
			'description'   => 'wpseo_desc',
			'canonical'     => 'wpseo_canonical',
			'focusKeyword'  => 'wpseo_focuskw',
			'ogTitle'       => 'wpseo_opengraph-title',
			'ogDescription' => 'wpseo_opengraph-description',
			'ogImage'       => 'wpseo_opengraph-image',
		);
	}

	private static function yoast_term_row( array $target ) {
		$opt = get_option( 'wpseo_taxonomy_meta', array() );
		$tax = (string) $target['taxonomy'];
		$id  = (int) $target['termId'];
		return ( is_array( $opt ) && isset( $opt[ $tax ][ $id ] ) && is_array( $opt[ $tax ][ $id ] ) ) ? $opt[ $tax ][ $id ] : array();
	}

	private static function yoast_term_get( array $target ) {
		$out = self::blank_fields();
		$row = self::yoast_term_row( $target );
		foreach ( self::yoast_term_keys() as $field => $key ) {
			$out[ $field ] = self::str_or_null( isset( $row[ $key ] ) ? $row[ $key ] : null );
		}
		$ni             = isset( $row['wpseo_noindex'] ) ? $row['wpseo_noindex'] : 'default';
		$out['noindex'] = 'noindex' === $ni ? true : ( 'index' === $ni ? false : null );
		return $out;
	}

	private static function yoast_term_write( array $target, $key, $value ) {
		$tax = (string) $target['taxonomy'];
		$id  = (int) $target['termId'];
		if ( class_exists( 'WPSEO_Taxonomy_Meta' ) && method_exists( 'WPSEO_Taxonomy_Meta', 'set_values' ) ) {
			// Yoast's signature is set_values( $term_id, $taxonomy, $meta_values ), and it resets every
			// key that is not in $meta_values, so always send the whole stored row with the one change.
			$row         = self::yoast_term_row( $target );
			$row[ $key ] = null === $value ? '' : $value;
			WPSEO_Taxonomy_Meta::set_values( $id, $tax, $row );
			return;
		}
		$opt = get_option( 'wpseo_taxonomy_meta', array() );
		$opt = is_array( $opt ) ? $opt : array();
		if ( null === $value || '' === $value || ( 'wpseo_noindex' === $key && 'default' === $value ) ) {
			unset( $opt[ $tax ][ $id ][ $key ] );
			if ( isset( $opt[ $tax ][ $id ] ) && empty( $opt[ $tax ][ $id ] ) ) {
				unset( $opt[ $tax ][ $id ] );
			}
			if ( isset( $opt[ $tax ] ) && empty( $opt[ $tax ] ) ) {
				unset( $opt[ $tax ] );
			}
		} else {
			$opt[ $tax ][ $id ][ $key ] = $value;
		}
		update_option( 'wpseo_taxonomy_meta', $opt );
	}

	private static function yoast_term_apply( array $target, array $values ) {
		$keys = self::yoast_term_keys();
		foreach ( $values as $field => $value ) {
			if ( 'noindex' === $field ) {
				self::yoast_term_write( $target, 'wpseo_noindex', null === $value ? 'default' : ( $value ? 'noindex' : 'index' ) );
			} elseif ( isset( $keys[ $field ] ) ) {
				self::yoast_term_write( $target, $keys[ $field ], $value );
				if ( 'ogImage' === $field ) {
					$aid = null === $value ? 0 : self::attachment_id_for( $value );
					self::yoast_term_write( $target, 'wpseo_opengraph-image-id', $aid > 0 ? (string) $aid : null );
				}
			}
		}
	}

	/* -- post type archives -- */

	private static function yoast_archive_keys( $type ) {
		return array(
			'title'         => 'title-ptarchive-' . $type,
			'description'   => 'metadesc-ptarchive-' . $type,
			'noindex'       => 'noindex-ptarchive-' . $type,
			'ogTitle'       => 'social-title-ptarchive-' . $type,
			'ogDescription' => 'social-description-ptarchive-' . $type,
			'ogImage'       => 'social-image-url-ptarchive-' . $type,
		);
	}

	private static function archive_get( $adapter, $type ) {
		$out = self::blank_fields();
		if ( 'yoast' === $adapter ) {
			$titles = get_option( 'wpseo_titles', array() );
			$titles = is_array( $titles ) ? $titles : array();
			foreach ( self::yoast_archive_keys( $type ) as $field => $key ) {
				$value = isset( $titles[ $key ] ) ? $titles[ $key ] : null;
				if ( 'noindex' === $field ) {
					// Yoast stores false for "index"; only true is distinguishable from the default.
					$out[ $field ] = ( true === $value || 1 === $value || '1' === $value ) ? true : null;
				} else {
					$out[ $field ] = self::str_or_null( $value );
				}
			}
			return $out;
		}
		if ( 'none' === $adapter ) {
			$opt = get_option( self::ARCHIVE_OPTION, array() );
			$row = ( is_array( $opt ) && isset( $opt[ $type ] ) && is_array( $opt[ $type ] ) ) ? $opt[ $type ] : array();
			foreach ( array( 'title', 'description', 'ogTitle', 'ogDescription', 'ogImage' ) as $field ) {
				$out[ $field ] = self::str_or_null( isset( $row[ $field ] ) ? $row[ $field ] : null );
			}
			if ( isset( $row['noindex'] ) && '' !== $row['noindex'] ) {
				$out['noindex'] = (bool) $row['noindex'];
			}
		}
		return $out;
	}

	private static function archive_apply( $adapter, $type, array $values ) {
		if ( 'yoast' === $adapter ) {
			$keys = self::yoast_archive_keys( $type );
			foreach ( $values as $field => $value ) {
				if ( ! isset( $keys[ $field ] ) ) {
					continue;
				}
				if ( 'noindex' === $field ) {
					self::yoast_titles_set( $keys[ $field ], true === $value );
				} else {
					self::yoast_titles_set( $keys[ $field ], null === $value ? '' : $value );
				}
				if ( 'ogImage' === $field ) {
					$aid = null === $value ? 0 : self::attachment_id_for( $value );
					self::yoast_titles_set( 'social-image-id-ptarchive-' . $type, $aid > 0 ? $aid : 0 );
				}
			}
			return;
		}
		$opt = get_option( self::ARCHIVE_OPTION, array() );
		$opt = is_array( $opt ) ? $opt : array();
		$row = ( isset( $opt[ $type ] ) && is_array( $opt[ $type ] ) ) ? $opt[ $type ] : array();
		foreach ( $values as $field => $value ) {
			if ( ! in_array( $field, array( 'title', 'description', 'noindex', 'ogTitle', 'ogDescription', 'ogImage' ), true ) ) {
				continue;
			}
			if ( null === $value ) {
				unset( $row[ $field ] );
			} else {
				$row[ $field ] = is_bool( $value ) ? ( $value ? 1 : 0 ) : $value;
			}
		}
		if ( empty( $row ) ) {
			unset( $opt[ $type ] );
		} else {
			$opt[ $type ] = $row;
		}
		update_option( self::ARCHIVE_OPTION, $opt );
	}

	private static function yoast_titles_set( $key, $value ) {
		if ( class_exists( 'WPSEO_Options' ) && method_exists( 'WPSEO_Options', 'set' ) ) {
			WPSEO_Options::set( $key, $value );
			return;
		}
		$opt         = get_option( 'wpseo_titles', array() );
		$opt         = is_array( $opt ) ? $opt : array();
		$opt[ $key ] = $value;
		update_option( 'wpseo_titles', $opt );
	}

	/**
	 * Write field values (already validated). null clears.
	 *
	 * @param array $target   Target.
	 * @param array $values   field => value|null.
	 * @param array $warnings Collected warnings.
	 */
	public static function apply_fields( array $target, array $values, array &$warnings ) {
		$adapter = self::adapter();
		if ( empty( $values ) ) {
			return;
		}
		$type = $target['type'];

		if ( 'home' === $type ) {
			$keys = self::home_keys( $adapter );
			foreach ( $values as $field => $value ) {
				if ( ! isset( $keys[ $field ] ) ) {
					$warnings[] = sprintf( '%s is not supported for the home target with %s; it was not changed.', $field, $adapter );
					continue;
				}
				self::set_home_value( $adapter, $keys[ $field ], $value );
				if ( 'ogImage' === $field ) {
					$id_key = self::home_id_key( $adapter );
					if ( null !== $id_key ) {
						$aid = null === $value ? 0 : self::attachment_id_for( $value );
						self::set_home_value( $adapter, $id_key, $aid > 0 ? $aid : null );
					}
				}
			}
			if ( 'yoast' === $adapter ) {
				self::rebuild_yoast_indexable( 'home', null, $warnings );
			}
			return;
		}

		if ( 'archive' === $type ) {
			self::archive_apply( $adapter, (string) $target['postType'], $values );
			if ( 'yoast' === $adapter ) {
				self::rebuild_yoast_indexable( 'archive', (string) $target['postType'], $warnings );
			}
			return;
		}

		if ( 'term' === $type && 'yoast' === $adapter ) {
			self::yoast_term_apply( $target, $values );
			self::rebuild_yoast_indexable( 'term', (int) $target['termId'], $warnings );
			return;
		}

		$keys = self::meta_keys( $adapter );

		foreach ( $values as $field => $value ) {
			if ( 'noindex' === $field || 'nofollow' === $field ) {
				continue;
			}
			if ( null === $value ) {
				self::m_delete( $target, $keys[ $field ] );
			} else {
				self::m_update( $target, $keys[ $field ], wp_slash( $value ) );
			}
			if ( 'ogImage' === $field ) {
				$id_key = self::image_id_key( $adapter );
				if ( null !== $id_key ) {
					$aid = null === $value ? 0 : self::attachment_id_for( $value );
					if ( $aid > 0 ) {
						self::m_update( $target, $id_key, $aid );
					} else {
						self::m_delete( $target, $id_key );
					}
				}
			}
		}

		$has_ni = array_key_exists( 'noindex', $values );
		$has_nf = array_key_exists( 'nofollow', $values );

		if ( 'rankmath' === $adapter && ( $has_ni || $has_nf ) ) {
			$robots = self::m_get( $target, 'rank_math_robots' );
			$robots = is_array( $robots ) ? array_values( $robots ) : array();
			if ( $has_ni ) {
				$robots = array_values( array_diff( $robots, array( 'index', 'noindex' ) ) );
				if ( true === $values['noindex'] ) {
					array_unshift( $robots, 'noindex' );
				} elseif ( false === $values['noindex'] ) {
					array_unshift( $robots, 'index' );
				}
			}
			if ( $has_nf ) {
				$robots = array_values( array_diff( $robots, array( 'nofollow' ) ) );
				if ( true === $values['nofollow'] ) {
					$robots[] = 'nofollow';
				}
			}
			if ( empty( $robots ) ) {
				self::m_delete( $target, 'rank_math_robots' );
			} else {
				self::m_update( $target, 'rank_math_robots', $robots );
			}
		} else {
			foreach ( array( 'noindex', 'nofollow' ) as $field ) {
				if ( ! array_key_exists( $field, $values ) ) {
					continue;
				}
				$value = $values[ $field ];
				if ( null === $value ) {
					self::m_delete( $target, $keys[ $field ] );
				} elseif ( 'yoast' === $adapter && 'noindex' === $field ) {
					self::m_update( $target, $keys[ $field ], $value ? '1' : '2' );
				} else {
					self::m_update( $target, $keys[ $field ], $value ? '1' : '0' );
				}
			}
		}

		if ( 'post' === $type ) {
			if ( 'yoast' === $adapter ) {
				self::rebuild_yoast_indexable( 'post', (int) $target['postId'], $warnings );
			}
			if ( function_exists( 'clean_post_cache' ) ) {
				clean_post_cache( (int) $target['postId'] );
			}
		}
	}

	private static function set_home_value( $adapter, $key, $value ) {
		if ( 'yoast' === $adapter ) {
			$stored = null === $value ? '' : $value;
			if ( class_exists( 'WPSEO_Options' ) && method_exists( 'WPSEO_Options', 'set' ) ) {
				WPSEO_Options::set( $key, $stored );
				return;
			}
			$name        = self::home_option_name( $adapter, $key );
			$opt         = get_option( $name, array() );
			$opt         = is_array( $opt ) ? $opt : array();
			$opt[ $key ] = $stored;
			update_option( $name, $opt );
			return;
		}
		if ( 'rankmath' === $adapter ) {
			$opt         = get_option( 'rank-math-options-titles', array() );
			$opt         = is_array( $opt ) ? $opt : array();
			$opt[ $key ] = null === $value ? '' : $value;
			update_option( 'rank-math-options-titles', $opt );
			return;
		}
		$opt = get_option( self::HOME_OPTION, array() );
		$opt = is_array( $opt ) ? $opt : array();
		if ( null === $value ) {
			unset( $opt[ $key ] );
		} else {
			$opt[ $key ] = is_bool( $value ) ? ( $value ? 1 : 0 ) : $value;
		}
		update_option( self::HOME_OPTION, $opt );
	}

	/**
	 * Rebuild Yoast's indexable for a post, term, post type archive or the home page.
	 * Guarded: failures become warnings, never fatal.
	 *
	 * @param string          $kind 'home' | 'post' | 'term' | 'archive'.
	 * @param int|string|null $id   Post id, term id, or post type name.
	 */
	private static function rebuild_yoast_indexable( $kind, $id, array &$warnings ) {
		if ( ! function_exists( 'YoastSEO' ) ) {
			return;
		}
		$repo_class    = 'Yoast\\WP\\SEO\\Repositories\\Indexable_Repository';
		$builder_class = 'Yoast\\WP\\SEO\\Builders\\Indexable_Builder';
		try {
			if ( ! class_exists( $repo_class ) || ! class_exists( $builder_class ) ) {
				return;
			}
			$yoast = YoastSEO();
			if ( ! is_object( $yoast ) || ! isset( $yoast->classes ) || ! is_object( $yoast->classes ) ) {
				return;
			}
			$repo    = $yoast->classes->get( $repo_class );
			$builder = $yoast->classes->get( $builder_class );
			if ( 'home' === $kind ) {
				$indexable = method_exists( $repo, 'find_for_home_page' ) ? $repo->find_for_home_page( false ) : false;
				if ( method_exists( $builder, 'build_for_home_page' ) ) {
					$builder->build_for_home_page( $indexable ? $indexable : false );
				}
			} elseif ( 'archive' === $kind ) {
				$indexable = method_exists( $repo, 'find_for_post_type_archive' ) ? $repo->find_for_post_type_archive( $id, false ) : false;
				if ( method_exists( $builder, 'build_for_post_type_archive' ) ) {
					$builder->build_for_post_type_archive( $id, $indexable ? $indexable : false );
				}
			} else {
				$indexable = $repo->find_by_id_and_type( $id, $kind, false );
				$builder->build_for_id_and_type( $id, $kind, $indexable ? $indexable : false );
			}
		} catch ( \Throwable $e ) {
			$warnings[] = 'Yoast indexable rebuild failed: ' . $e->getMessage();
		}
	}

	/* ------------------------------------------------------------------ */
	/* WooCommerce shop page                                              */
	/* ------------------------------------------------------------------ */

	/**
	 * With Yoast, the WooCommerce shop page is served from the `product` archive settings.
	 *
	 * @return array|null The product archive target when $target is the shop page.
	 */
	public static function shop_archive_target( array $target ) {
		if ( 'post' !== $target['type'] || 'yoast' !== self::adapter() || ! function_exists( 'wc_get_page_id' ) ) {
			return null;
		}
		$shop = (int) wc_get_page_id( 'shop' );
		if ( $shop <= 0 || $shop !== (int) $target['postId'] ) {
			return null;
		}
		$link = function_exists( 'get_post_type_archive_link' ) ? get_post_type_archive_link( 'product' ) : false;
		return array(
			'postId'   => null,
			'type'     => 'archive',
			'postType' => 'product',
			'url'      => is_string( $link ) && '' !== $link ? $link : $target['url'],
			'title'    => $target['title'],
		);
	}

	/**
	 * The other way round: with Yoast, WooCommerce renders the shop page from the shop page's own
	 * post indexable (its post meta), not from the `product` archive settings. So a write to the
	 * `product` archive target is mirrored to the shop page, or it would never show on the site.
	 *
	 * @return array|null The shop page (post) target when $target is the `product` archive.
	 */
	public static function shop_page_target( array $target ) {
		if ( 'archive' !== $target['type'] || 'product' !== $target['postType'] || 'yoast' !== self::adapter() || ! function_exists( 'wc_get_page_id' ) ) {
			return null;
		}
		$shop = (int) wc_get_page_id( 'shop' );
		if ( $shop <= 0 ) {
			return null;
		}
		$page = PIB_Connector_Target::from_post_id( $shop );
		return is_wp_error( $page ) ? null : $page;
	}

	/**
	 * The counterpart written together with $target (shop page <-> product archive), or null.
	 */
	public static function shop_counterpart( array $target ) {
		$shop = self::shop_archive_target( $target );
		return null !== $shop ? $shop : self::shop_page_target( $target );
	}

	/* ------------------------------------------------------------------ */
	/* Endpoints                                                          */
	/* ------------------------------------------------------------------ */

	public static function endpoint_get( array $params ) {
		$target = PIB_Connector_Target::resolve( $params, true );
		if ( is_wp_error( $target ) ) {
			return $target;
		}
		$adapter = self::adapter();
		if ( 'archive' === $target['type'] && 'rankmath' === $adapter ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'Rank Math does not expose post type archive SEO settings to the Connector.', 422 );
		}
		$out = array(
			'target'    => $target,
			'seoPlugin' => $adapter,
			'fields'    => self::get_fields( $target ),
		);
		$shop = self::shop_archive_target( $target );
		if ( null !== $shop ) {
			$out['archive'] = self::get_fields( $shop );
		}
		return $out;
	}

	/**
	 * Validate the field values present in $params.
	 *
	 * @return array|WP_Error field => value|null
	 */
	public static function parse_values( array $params ) {
		$values = array();
		foreach ( self::string_fields() as $field => $max ) {
			if ( ! array_key_exists( $field, $params ) ) {
				continue;
			}
			$value = PIB_Connector_Util::optional_string( $params, $field, $max );
			if ( is_wp_error( $value ) ) {
				return $value;
			}
			if ( null !== $value ) {
				if ( 'canonical' === $field ) {
					$parts = wp_parse_url( $value );
					if ( ! is_array( $parts ) || empty( $parts['host'] ) || ! isset( $parts['scheme'] ) || ! in_array( strtolower( $parts['scheme'] ), array( 'http', 'https' ), true ) ) {
						return PIB_Connector_Util::bad_request( 'canonical must be an absolute http(s) URL.' );
					}
					$value = esc_url_raw( $value, array( 'http', 'https' ) );
					if ( '' === $value ) {
						return PIB_Connector_Util::bad_request( 'canonical is not a valid URL.' );
					}
				} elseif ( 'ogImage' === $field ) {
					if ( 0 === strpos( $value, '/' ) && 0 !== strpos( $value, '//' ) ) {
						$value = home_url( $value );
					}
					$parts = wp_parse_url( $value );
					if ( ! is_array( $parts ) || empty( $parts['host'] ) || ! isset( $parts['scheme'] ) || 'https' !== strtolower( $parts['scheme'] ) || isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
						return PIB_Connector_Util::bad_request( 'ogImage must be an https URL or a site-relative path starting with /.' );
					}
					$value = esc_url_raw( $value, array( 'https' ) );
					if ( '' === $value ) {
						return PIB_Connector_Util::bad_request( 'ogImage is not a valid URL.' );
					}
				} else {
					$value = PIB_Connector_Util::clean_text( $value );
					$value = '' === $value ? null : $value;
				}
			}
			$values[ $field ] = $value;
		}
		foreach ( array( 'noindex', 'nofollow' ) as $field ) {
			if ( ! array_key_exists( $field, $params ) ) {
				continue;
			}
			$value = $params[ $field ];
			if ( null === $value || '' === $value ) {
				$values[ $field ] = null;
			} elseif ( is_bool( $value ) ) {
				$values[ $field ] = $value;
			} else {
				return PIB_Connector_Util::bad_request( sprintf( '%s must be true, false or null.', $field ) );
			}
		}
		return $values;
	}

	/**
	 * Term and archive targets cannot store every field. A non-null value for an unsupported
	 * field is refused (`pib_unsupported`); a clear (null) of one is dropped as a no-op.
	 *
	 * @return true|WP_Error
	 */
	private static function filter_supported( array $target, array &$values, $adapter ) {
		$unsupported = array();
		if ( 'archive' === $target['type'] ) {
			if ( 'rankmath' === $adapter ) {
				return PIB_Connector_Util::error( 'pib_unsupported', 'Rank Math does not expose post type archive SEO settings to the Connector.', 422 );
			}
			$unsupported = array( 'canonical', 'nofollow', 'focusKeyword' );
		} elseif ( 'term' === $target['type'] && 'yoast' === $adapter ) {
			$unsupported = array( 'nofollow' );
		}
		foreach ( $unsupported as $field ) {
			if ( ! array_key_exists( $field, $values ) ) {
				continue;
			}
			if ( null !== $values[ $field ] ) {
				return PIB_Connector_Util::error( 'pib_unsupported', sprintf( '%s is not supported for this %s target with %s.', $field, $target['type'], $adapter ), 422 );
			}
			unset( $values[ $field ] );
		}
		return true;
	}

	public static function endpoint_set( array $params ) {
		$target = PIB_Connector_Target::resolve( $params, true );
		if ( is_wp_error( $target ) ) {
			return $target;
		}
		$values = self::parse_values( $params );
		if ( is_wp_error( $values ) ) {
			return $values;
		}
		if ( empty( $values ) ) {
			return PIB_Connector_Util::bad_request( 'Send at least one SEO field to change.' );
		}
		$ok = self::filter_supported( $target, $values, self::adapter() );
		if ( is_wp_error( $ok ) ) {
			return $ok;
		}
		if ( empty( $values ) ) {
			return PIB_Connector_Util::bad_request( 'None of the fields sent can be stored for this target.' );
		}

		$warnings = array();
		$before   = self::get_fields( $target );
		self::apply_fields( $target, $values, $warnings );
		$after = self::get_fields( $target );

		$extra = array( 'seoPlugin' => self::adapter() );

		// WooCommerce shop page (Yoast): mirror to the product archive settings, and the reverse.
		$shop = self::shop_counterpart( $target );
		if ( null !== $shop ) {
			$mirror = array();
			foreach ( array( 'title', 'description', 'ogTitle', 'ogDescription', 'ogImage' ) as $field ) {
				if ( array_key_exists( $field, $values ) ) {
					$mirror[ $field ] = $values[ $field ];
				}
			}
			if ( ! empty( $mirror ) ) {
				$m_before = self::get_fields( $shop );
				self::apply_fields( $shop, $mirror, $warnings );
				$m_after            = self::get_fields( $shop );
				$warnings[]         = 'post' === $target['type'] ? 'shop page: also written to the product archive settings' : 'product archive: also written to the shop page';
				$extra['mirror']    = array(
					'target' => $shop,
					'before' => $m_before,
					'after'  => $m_after,
				);
			}
		}

		$change_id = PIB_Connector_Log::record(
			'seo/set',
			'seo',
			$target,
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			$before,
			$after,
			$extra
		);

		return array(
			'changeId' => $change_id,
			'target'   => $target,
			'before'   => $before,
			'after'    => $after,
			'warnings' => $warnings,
		);
	}

	/**
	 * Fields that differ between two snapshots, taken from $before.
	 */
	private static function diff_restore( $before, $after ) {
		$restore = array();
		$before  = is_array( $before ) ? $before : array();
		$after   = is_array( $after ) ? $after : array();
		foreach ( self::field_names() as $field ) {
			$b = array_key_exists( $field, $before ) ? $before[ $field ] : null;
			$a = array_key_exists( $field, $after ) ? $after[ $field ] : null;
			if ( $b !== $a ) {
				$restore[ $field ] = $b;
			}
		}
		return $restore;
	}

	/**
	 * Undo a seo/set entry: restore every field that changed.
	 *
	 * @return array|WP_Error [ target, before, after, warnings ]
	 */
	public static function undo( array $entry ) {
		$target = $entry['target'];
		if ( ! is_array( $target ) || ! isset( $target['type'] ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The logged target is missing.', 422 );
		}
		if ( 'post' === $target['type'] ) {
			$fresh = PIB_Connector_Target::from_post_id( (int) $target['postId'] );
			if ( is_wp_error( $fresh ) ) {
				return $fresh;
			}
		} elseif ( 'term' === $target['type'] ) {
			$fresh = PIB_Connector_Target::from_term_id( (int) $target['termId'], (string) $target['taxonomy'] );
			if ( is_wp_error( $fresh ) ) {
				return $fresh;
			}
		} elseif ( 'archive' === $target['type'] ) {
			$fresh = PIB_Connector_Target::from_post_type_archive( (string) $target['postType'] );
			if ( is_wp_error( $fresh ) ) {
				return $fresh;
			}
		}
		$restore  = self::diff_restore( isset( $entry['before'] ) ? $entry['before'] : null, isset( $entry['after'] ) ? $entry['after'] : null );
		$warnings = array();
		$now      = self::get_fields( $target );
		self::apply_fields( $target, $restore, $warnings );

		if ( isset( $entry['mirror'] ) && is_array( $entry['mirror'] ) && isset( $entry['mirror']['target']['type'] ) && in_array( $entry['mirror']['target']['type'], array( 'archive', 'post' ), true ) ) {
			$mirror_restore = self::diff_restore( isset( $entry['mirror']['before'] ) ? $entry['mirror']['before'] : null, isset( $entry['mirror']['after'] ) ? $entry['mirror']['after'] : null );
			self::apply_fields( $entry['mirror']['target'], $mirror_restore, $warnings );
		}
		return array( $target, $now, self::get_fields( $target ), $warnings );
	}

	/* ------------------------------------------------------------------ */
	/* Front-end output when no SEO plugin is active                      */
	/* ------------------------------------------------------------------ */

	public static function init() {
		add_filter( 'pre_get_document_title', array( __CLASS__, 'filter_document_title' ), 20 );
		add_action( 'wp_head', array( __CLASS__, 'print_head' ), 1 );
		add_filter( 'wp_robots', array( __CLASS__, 'filter_wp_robots' ), 20 );
		add_action( 'wp', array( __CLASS__, 'maybe_replace_core_canonical' ) );
	}

	/**
	 * Target of the page being viewed, or null.
	 */
	private static function current_target() {
		if ( function_exists( 'is_front_page' ) && is_front_page() && function_exists( 'is_home' ) && is_home() ) {
			return array( 'type' => 'home', 'postId' => null );
		}
		if ( function_exists( 'is_singular' ) && is_singular() ) {
			$id = (int) get_queried_object_id();
			if ( $id > 0 ) {
				return array( 'type' => 'post', 'postId' => $id );
			}
		}
		if ( function_exists( 'is_post_type_archive' ) && is_post_type_archive() && function_exists( 'get_queried_object' ) ) {
			$obj = get_queried_object();
			if ( is_object( $obj ) && isset( $obj->name ) && is_string( $obj->name ) ) {
				return array( 'type' => 'archive', 'postId' => null, 'postType' => $obj->name );
			}
		}
		$is_term = ( function_exists( 'is_category' ) && is_category() ) || ( function_exists( 'is_tag' ) && is_tag() ) || ( function_exists( 'is_tax' ) && is_tax() );
		if ( $is_term && function_exists( 'get_queried_object' ) ) {
			$obj = get_queried_object();
			if ( is_object( $obj ) && isset( $obj->term_id, $obj->taxonomy ) ) {
				return array( 'type' => 'term', 'postId' => null, 'termId' => (int) $obj->term_id, 'taxonomy' => (string) $obj->taxonomy );
			}
		}
		return null;
	}

	/**
	 * Fields for the page being viewed (adapter `none` only), else null.
	 */
	public static function current_fields() {
		if ( 'none' !== self::adapter() ) {
			return null;
		}
		$target = self::current_target();
		return null === $target ? null : self::get_fields( $target );
	}

	public static function filter_document_title( $title ) {
		$fields = self::current_fields();
		if ( $fields && null !== $fields['title'] ) {
			return $fields['title'];
		}
		return $title;
	}

	public static function filter_wp_robots( $robots ) {
		$fields = self::current_fields();
		if ( ! $fields || ! is_array( $robots ) ) {
			return $robots;
		}
		if ( true === $fields['noindex'] ) {
			$robots['noindex'] = true;
			unset( $robots['index'], $robots['max-image-preview'] );
		}
		if ( true === $fields['nofollow'] ) {
			$robots['nofollow'] = true;
			unset( $robots['follow'] );
		}
		return $robots;
	}

	public static function maybe_replace_core_canonical() {
		$fields = self::current_fields();
		if ( $fields && null !== $fields['canonical'] ) {
			remove_action( 'wp_head', 'rel_canonical' );
		}
	}

	public static function print_head() {
		$fields = self::current_fields();
		if ( ! $fields ) {
			return;
		}
		$lines = array();
		if ( null !== $fields['description'] ) {
			$lines[] = '<meta name="description" content="' . esc_attr( $fields['description'] ) . '" />';
		}
		if ( null !== $fields['canonical'] ) {
			$lines[] = '<link rel="canonical" href="' . esc_url( $fields['canonical'] ) . '" />';
		}
		if ( null !== $fields['ogTitle'] ) {
			$lines[] = '<meta property="og:title" content="' . esc_attr( $fields['ogTitle'] ) . '" />';
		}
		if ( null !== $fields['ogDescription'] ) {
			$lines[] = '<meta property="og:description" content="' . esc_attr( $fields['ogDescription'] ) . '" />';
		}
		$image = $fields['ogImage'];
		if ( null === $image && function_exists( 'is_singular' ) && is_singular() && function_exists( 'get_the_post_thumbnail_url' ) ) {
			$thumb = get_the_post_thumbnail_url( (int) get_queried_object_id(), 'full' );
			$image = ( is_string( $thumb ) && '' !== $thumb ) ? $thumb : null;
		}
		if ( null !== $image ) {
			$lines[] = '<meta property="og:image" content="' . esc_url( $image ) . '" />';
			$lines[] = '<meta name="twitter:image" content="' . esc_url( $image ) . '" />';
		}
		if ( ! empty( $lines ) ) {
			echo "<!-- PiB Connector -->\n" . implode( "\n", $lines ) . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- each line escaped above.
		}
	}
}
