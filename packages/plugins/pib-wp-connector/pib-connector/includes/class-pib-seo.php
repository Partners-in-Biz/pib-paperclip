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

	const HOME_OPTION = 'pib_connector_home_seo';

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
		);
	}

	public static function field_names() {
		return array( 'title', 'description', 'canonical', 'noindex', 'nofollow', 'focusKeyword', 'ogTitle', 'ogDescription' );
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
		);
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
			);
		}
		if ( 'rankmath' === $adapter ) {
			return array(
				'title'       => 'homepage_title',
				'description' => 'homepage_description',
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

	/**
	 * @param array $target Resolved target.
	 * @return array field => value|null
	 */
	public static function get_fields( array $target ) {
		$adapter = self::adapter();
		$out     = array();
		foreach ( self::field_names() as $f ) {
			$out[ $f ] = null;
		}
		if ( 'home' === $target['type'] ) {
			$store = self::home_store( $adapter );
			foreach ( self::home_keys( $adapter ) as $field => $key ) {
				$value = isset( $store[ $key ] ) ? $store[ $key ] : null;
				if ( 'noindex' === $field || 'nofollow' === $field ) {
					$out[ $field ] = ( null === $value || '' === $value ) ? null : (bool) $value;
				} else {
					$out[ $field ] = ( is_string( $value ) && '' !== $value ) ? $value : null;
				}
			}
			return $out;
		}

		$post_id = (int) $target['postId'];
		$keys    = self::meta_keys( $adapter );
		foreach ( $keys as $field => $key ) {
			if ( 'noindex' === $field || 'nofollow' === $field ) {
				continue;
			}
			$value         = get_post_meta( $post_id, $key, true );
			$out[ $field ] = ( is_string( $value ) && '' !== $value ) ? $value : null;
		}

		if ( 'yoast' === $adapter ) {
			$ni             = (string) get_post_meta( $post_id, $keys['noindex'], true );
			$nf             = (string) get_post_meta( $post_id, $keys['nofollow'], true );
			$out['noindex'] = '1' === $ni ? true : ( '2' === $ni ? false : null );
			$out['nofollow'] = '1' === $nf ? true : ( '0' === $nf ? false : null );
		} elseif ( 'rankmath' === $adapter ) {
			$robots = get_post_meta( $post_id, 'rank_math_robots', true );
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
				$value         = (string) get_post_meta( $post_id, $keys[ $field ], true );
				$out[ $field ] = '1' === $value ? true : ( '0' === $value ? false : null );
			}
		}
		return $out;
	}

	private static function home_store( $adapter ) {
		if ( 'yoast' === $adapter ) {
			$opt = get_option( 'wpseo_titles', array() );
		} elseif ( 'rankmath' === $adapter ) {
			$opt = get_option( 'rank-math-options-titles', array() );
		} else {
			$opt = get_option( self::HOME_OPTION, array() );
		}
		return is_array( $opt ) ? $opt : array();
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

		if ( 'home' === $target['type'] ) {
			$keys = self::home_keys( $adapter );
			foreach ( $values as $field => $value ) {
				if ( ! isset( $keys[ $field ] ) ) {
					$warnings[] = sprintf( '%s is not supported for the home target with %s; it was not changed.', $field, $adapter );
					continue;
				}
				self::set_home_value( $adapter, $keys[ $field ], $value );
			}
			if ( 'yoast' === $adapter ) {
				self::rebuild_yoast_indexable( null, $warnings );
			}
			return;
		}

		$post_id = (int) $target['postId'];
		$keys    = self::meta_keys( $adapter );

		foreach ( $values as $field => $value ) {
			if ( 'noindex' === $field || 'nofollow' === $field ) {
				continue;
			}
			if ( null === $value ) {
				delete_post_meta( $post_id, $keys[ $field ] );
			} else {
				update_post_meta( $post_id, $keys[ $field ], wp_slash( $value ) );
			}
		}

		$has_ni = array_key_exists( 'noindex', $values );
		$has_nf = array_key_exists( 'nofollow', $values );

		if ( 'rankmath' === $adapter && ( $has_ni || $has_nf ) ) {
			$robots = get_post_meta( $post_id, 'rank_math_robots', true );
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
				delete_post_meta( $post_id, 'rank_math_robots' );
			} else {
				update_post_meta( $post_id, 'rank_math_robots', $robots );
			}
		} else {
			foreach ( array( 'noindex', 'nofollow' ) as $field ) {
				if ( ! array_key_exists( $field, $values ) ) {
					continue;
				}
				$value = $values[ $field ];
				if ( null === $value ) {
					delete_post_meta( $post_id, $keys[ $field ] );
				} elseif ( 'yoast' === $adapter && 'noindex' === $field ) {
					update_post_meta( $post_id, $keys[ $field ], $value ? '1' : '2' );
				} else {
					update_post_meta( $post_id, $keys[ $field ], $value ? '1' : '0' );
				}
			}
		}

		if ( 'yoast' === $adapter ) {
			self::rebuild_yoast_indexable( $post_id, $warnings );
		}
		if ( function_exists( 'clean_post_cache' ) ) {
			clean_post_cache( $post_id );
		}
	}

	private static function set_home_value( $adapter, $key, $value ) {
		if ( 'yoast' === $adapter ) {
			$stored = null === $value ? '' : $value;
			if ( class_exists( 'WPSEO_Options' ) && method_exists( 'WPSEO_Options', 'set' ) ) {
				WPSEO_Options::set( $key, $stored );
				return;
			}
			$opt         = get_option( 'wpseo_titles', array() );
			$opt         = is_array( $opt ) ? $opt : array();
			$opt[ $key ] = $stored;
			update_option( 'wpseo_titles', $opt );
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
	 * Rebuild Yoast's indexable for a post (or the home page when $post_id is null).
	 * Guarded: failures become warnings, never fatal.
	 */
	private static function rebuild_yoast_indexable( $post_id, array &$warnings ) {
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
			if ( null === $post_id ) {
				$indexable = method_exists( $repo, 'find_for_home_page' ) ? $repo->find_for_home_page( false ) : false;
				if ( method_exists( $builder, 'build_for_home_page' ) ) {
					$builder->build_for_home_page( $indexable ? $indexable : false );
				}
			} else {
				$indexable = $repo->find_by_id_and_type( $post_id, 'post', false );
				$builder->build_for_id_and_type( $post_id, 'post', $indexable ? $indexable : false );
			}
		} catch ( \Throwable $e ) {
			$warnings[] = 'Yoast indexable rebuild failed: ' . $e->getMessage();
		}
	}

	/* ------------------------------------------------------------------ */
	/* Endpoints                                                          */
	/* ------------------------------------------------------------------ */

	public static function endpoint_get( array $params ) {
		$target = PIB_Connector_Target::resolve( $params );
		if ( is_wp_error( $target ) ) {
			return $target;
		}
		return array(
			'target'    => $target,
			'seoPlugin' => self::adapter(),
			'fields'    => self::get_fields( $target ),
		);
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

	public static function endpoint_set( array $params ) {
		$target = PIB_Connector_Target::resolve( $params );
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

		$warnings = array();
		$before   = self::get_fields( $target );
		self::apply_fields( $target, $values, $warnings );
		$after = self::get_fields( $target );

		$change_id = PIB_Connector_Log::record(
			'seo/set',
			'seo',
			$target,
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			$before,
			$after,
			array( 'seoPlugin' => self::adapter() )
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
	 * Undo a seo/set entry: restore every field that changed.
	 *
	 * @return array|WP_Error [ before, after, warnings ]
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
		}
		$restore = array();
		$before  = is_array( $entry['before'] ) ? $entry['before'] : array();
		$after   = is_array( $entry['after'] ) ? $entry['after'] : array();
		foreach ( self::field_names() as $field ) {
			$b = array_key_exists( $field, $before ) ? $before[ $field ] : null;
			$a = array_key_exists( $field, $after ) ? $after[ $field ] : null;
			if ( $b !== $a ) {
				$restore[ $field ] = $b;
			}
		}
		$warnings = array();
		$now      = self::get_fields( $target );
		self::apply_fields( $target, $restore, $warnings );
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
	 * Fields for the page being viewed (adapter `none` only), else null.
	 */
	public static function current_fields() {
		if ( 'none' !== self::adapter() ) {
			return null;
		}
		if ( function_exists( 'is_front_page' ) && is_front_page() && is_home() ) {
			return self::get_fields( array( 'type' => 'home', 'postId' => null ) );
		}
		if ( function_exists( 'is_singular' ) && is_singular() ) {
			$id = (int) get_queried_object_id();
			if ( $id > 0 ) {
				return self::get_fields( array( 'type' => 'post', 'postId' => $id ) );
			}
		}
		return null;
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
		if ( ! empty( $lines ) ) {
			echo "<!-- PiB Connector -->\n" . implode( "\n", $lines ) . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- each line escaped above.
		}
	}
}
