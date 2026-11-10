<?php
/**
 * `archive/get` and `archive/set`: intro copy (H1 + text) on category, tag and taxonomy archive
 * pages. Stored in term meta and printed at the start or end of the main archive loop, page 1.
 * Title and meta description of these pages stay with seo/set.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Archive {

	const META_HTML = '_pib_archive_intro';
	const META_POS  = '_pib_archive_intro_pos';
	const MAX_CHARS = 20000;

	/**
	 * True once the intro was printed in this request.
	 *
	 * @var bool
	 */
	public static $printed = false;

	public static function init() {
		add_action( 'loop_start', array( __CLASS__, 'on_loop_start' ), 10, 1 );
		add_action( 'loop_end', array( __CLASS__, 'on_loop_end' ), 10, 1 );
	}

	/**
	 * @return array|WP_Error Term target.
	 */
	private static function resolve_term( array $params ) {
		$target = PIB_Connector_Target::resolve( $params, true );
		if ( is_wp_error( $target ) ) {
			return $target;
		}
		if ( ! isset( $target['type'] ) || 'term' !== $target['type'] ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'archive/get and archive/set take a category, tag or taxonomy archive (url or termId). Use posts/update for pages and posts.', 422 );
		}
		return $target;
	}

	/**
	 * @return array { html, position } with html '' when none is set.
	 */
	public static function read( $term_id ) {
		$html = get_term_meta( (int) $term_id, self::META_HTML, true );
		$pos  = get_term_meta( (int) $term_id, self::META_POS, true );
		return array(
			'html'     => is_string( $html ) ? $html : '',
			'position' => 'after' === $pos ? 'after' : 'before',
		);
	}

	private static function write( $term_id, $taxonomy, $html, $position ) {
		if ( '' === $html ) {
			delete_term_meta( (int) $term_id, self::META_HTML );
			delete_term_meta( (int) $term_id, self::META_POS );
		} else {
			update_term_meta( (int) $term_id, self::META_HTML, wp_slash( $html ) );
			update_term_meta( (int) $term_id, self::META_POS, $position );
		}
		if ( function_exists( 'clean_term_cache' ) ) {
			clean_term_cache( (int) $term_id, (string) $taxonomy );
		}
	}

	public static function endpoint_get( array $params ) {
		$target = self::resolve_term( $params );
		if ( is_wp_error( $target ) ) {
			return $target;
		}
		$term = get_term( $target['termId'], $target['taxonomy'] );
		$cur  = self::read( $target['termId'] );
		return array(
			'termId'    => (int) $target['termId'],
			'taxonomy'  => (string) $target['taxonomy'],
			'url'       => (string) $target['url'],
			'name'      => (string) $target['title'],
			'postCount' => ( is_object( $term ) && isset( $term->count ) ) ? (int) $term->count : 0,
			'html'      => $cur['html'],
			'position'  => $cur['position'],
		);
	}

	public static function endpoint_set( array $params ) {
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$target = self::resolve_term( $params );
		if ( is_wp_error( $target ) ) {
			return $target;
		}
		if ( ! array_key_exists( 'html', $params ) || ! is_string( $params['html'] ) ) {
			return PIB_Connector_Util::bad_request( 'html must be a string (an empty string removes the intro).' );
		}
		$html = $params['html'];
		if ( false !== strpos( $html, "\0" ) || ! preg_match( '//u', $html ) ) {
			return PIB_Connector_Util::bad_request( 'html must be valid UTF-8 text.' );
		}
		if ( PIB_Connector_Util::strlen( $html ) > self::MAX_CHARS ) {
			return PIB_Connector_Util::bad_request( sprintf( 'html is longer than %d characters.', self::MAX_CHARS ) );
		}
		if ( '' === trim( $html ) ) {
			$html = '';
		}
		$position = 'before';
		if ( array_key_exists( 'position', $params ) && null !== $params['position'] ) {
			if ( ! in_array( $params['position'], array( 'before', 'after' ), true ) ) {
				return PIB_Connector_Util::bad_request( 'position must be before or after.' );
			}
			$position = $params['position'];
		}

		$before = self::read( $target['termId'] );
		// Same safety rule as posts/update: nothing executable that is not already there.
		$safe = PIB_Connector_Content::check_content( $html, $before['html'] );
		if ( is_wp_error( $safe ) ) {
			return $safe;
		}
		$after = array(
			'html'     => $html,
			'position' => '' === $html ? 'before' : $position,
		);
		if ( $after === $before ) {
			return array(
				'changeId' => null,
				'target'   => $target,
				'before'   => $before,
				'after'    => $after,
				'warnings' => array( 'No change: the values match the current intro.' ),
			);
		}

		self::write( $target['termId'], $target['taxonomy'], $after['html'], $after['position'] );
		$change_id = PIB_Connector_Log::record( 'archive/set', 'content', $target, $reason, $before, $after );

		$warnings = array();
		$term     = get_term( $target['termId'], $target['taxonomy'] );
		if ( '' !== $html && is_object( $term ) && isset( $term->count ) && 0 === (int) $term->count ) {
			$warnings[] = 'This term has no posts, so its archive page has no loop and the intro is not shown.';
		}
		if ( '' !== $html && function_exists( 'wp_is_block_theme' ) && wp_is_block_theme() ) {
			$warnings[] = 'The active theme is a block theme. The intro is printed only by classic themes, so it is not shown on this site.';
		}
		return array(
			'changeId' => $change_id,
			'target'   => $target,
			'before'   => $before,
			'after'    => $after,
			'warnings' => $warnings,
		);
	}

	/**
	 * Undo archive/set: put the logged `before` back.
	 *
	 * @return array|WP_Error
	 */
	public static function undo( array $entry ) {
		$target = isset( $entry['target'] ) ? $entry['target'] : null;
		$before = isset( $entry['before'] ) ? $entry['before'] : null;
		if ( ! is_array( $target ) || empty( $target['termId'] ) || ! is_array( $before ) || ! isset( $before['html'] ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The logged change is incomplete.', 422 );
		}
		$term = get_term( (int) $target['termId'], isset( $target['taxonomy'] ) ? (string) $target['taxonomy'] : '' );
		if ( ! is_object( $term ) || is_wp_error( $term ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The term no longer exists.', 422 );
		}
		$now = self::read( $target['termId'] );
		self::write( $target['termId'], $term->taxonomy, (string) $before['html'], isset( $before['position'] ) && 'after' === $before['position'] ? 'after' : 'before' );
		return array( $target, $now, self::read( $target['termId'] ), array() );
	}

	/* ------------------------------------------------------------------ */
	/* Front end                                                          */
	/* ------------------------------------------------------------------ */

	public static function on_loop_start( $query ) {
		self::maybe_print( $query, 'before' );
	}

	public static function on_loop_end( $query ) {
		self::maybe_print( $query, 'after' );
	}

	/**
	 * Print the intro of the queried term on its main archive query, page 1, once per request.
	 */
	public static function maybe_print( $query, $where ) {
		if ( self::$printed || ! is_object( $query ) || ! method_exists( $query, 'is_main_query' ) || ! $query->is_main_query() ) {
			return;
		}
		// Block themes render the whole template to a string before <head> is printed, and the main
		// loop runs inside that, so an echo here would land before <!DOCTYPE>. Classic themes run the
		// loop after wp_head. Print only then.
		if ( is_admin() || ! did_action( 'wp_head' ) || ! PIB_Connector_Settings::feature_enabled( 'content' ) ) {
			return;
		}
		if ( ! ( $query->is_category() || $query->is_tag() || $query->is_tax() ) || $query->is_paged() || $query->is_feed() ) {
			return;
		}
		$term = $query->get_queried_object();
		if ( ! is_object( $term ) || empty( $term->term_id ) ) {
			return;
		}
		$cur = self::read( $term->term_id );
		if ( '' === $cur['html'] || $cur['position'] !== $where ) {
			return;
		}
		self::$printed = true;
		echo '<div class="pib-archive-intro">' . wp_kses_post( $cur['html'] ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- kses-filtered.
	}
}
