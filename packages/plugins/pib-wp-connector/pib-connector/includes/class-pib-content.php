<?php
/**
 * posts/get, posts/images, posts/img-alt, posts/update, posts/create, posts/publish.
 * Edits existing posts and pages; creates drafts. Never deletes content, never touches the author.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Content {

	const MAX_CONTENT   = 512000; // 500 KB.
	const BACKUP_META   = '_pib_content_backups';
	const BACKUP_KEEP   = 5;
	const CREATED_META  = '_pib_created_by_connector';
	const TITLE_MAX     = 300;
	const EXCERPT_MAX   = 2000;
	const SLUG_MAX      = 200;

	/* ------------------------------------------------------------------ */
	/* Helpers                                                            */
	/* ------------------------------------------------------------------ */

	/**
	 * @return object|WP_Error The post (drafts allowed; trash, revisions and non-public types are not).
	 */
	private static function resolve_post( array $params ) {
		$target = PIB_Connector_Target::resolve( $params, false );
		if ( is_wp_error( $target ) ) {
			return $target;
		}
		if ( 'post' !== $target['type'] ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'That URL is the blog home page, not a single post or page. Send a postId.', 422 );
		}
		return get_post( (int) $target['postId'] );
	}

	private static function target_of( $post ) {
		return array(
			'postId'   => (int) $post->ID,
			'type'     => 'post',
			'url'      => (string) get_permalink( $post ),
			'postType' => (string) $post->post_type,
		);
	}

	private static function iso( $gmt ) {
		if ( ! is_string( $gmt ) || '' === $gmt || 0 === strpos( $gmt, '0000' ) ) {
			return null;
		}
		$t = strtotime( $gmt . ' UTC' );
		return false === $t ? null : gmdate( 'Y-m-d\TH:i:s\Z', $t );
	}

	private static function content_summary( $content ) {
		return 'sha256:' . substr( hash( 'sha256', (string) $content ), 0, 16 ) . ' (' . strlen( (string) $content ) . ' bytes)';
	}

	private static function fields_summary( $post, array $fields ) {
		$out = array();
		foreach ( $fields as $f ) {
			if ( 'title' === $f ) {
				$out['title'] = (string) $post->post_title;
			} elseif ( 'content' === $f ) {
				$out['content'] = self::content_summary( $post->post_content );
			} elseif ( 'excerpt' === $f ) {
				$out['excerpt'] = (string) $post->post_excerpt;
			} elseif ( 'slug' === $f ) {
				$out['slug'] = (string) $post->post_name;
			}
		}
		return $out;
	}

	/**
	 * Run a post write with WordPress's kses filters off. A Connector request has no logged-in
	 * user, so kses would silently strip embeds and attributes from content we are told to keep.
	 * Our own safety check (check_content) has already run.
	 *
	 * @return mixed
	 */
	private static function unfiltered( callable $fn ) {
		if ( function_exists( 'kses_remove_filters' ) ) {
			kses_remove_filters();
		}
		try {
			return $fn();
		} finally {
			if ( function_exists( 'kses_init' ) ) {
				kses_init();
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Content safety                                                     */
	/* ------------------------------------------------------------------ */

	/**
	 * @return array [ [label, snippet], ... ]  (a regex failure counts as a finding: fail closed)
	 */
	private static function findings( $text ) {
		$out   = array();
		$rules = array(
			'<script>'  => '/<(script)\b[^>]*+>(?:.*?<\/script\s*+>)?/is',
			'<iframe>'  => '/<(iframe)\b[^>]*+>(?:.*?<\/iframe\s*+>)?/is',
			'<object>'  => '/<(object)\b[^>]*+>(?:.*?<\/object\s*+>)?/is',
			'<form>'    => '/<(form)\b[^>]*+>(?:.*?<\/form\s*+>)?/is',
			'<embed>'   => '/<(embed)\b[^>]*+>/i',
		);
		foreach ( $rules as $label => $re ) {
			$n = preg_match_all( $re, $text, $m );
			if ( false === $n ) {
				$out[] = array( $label, '#regex-error-' . $label );
				continue;
			}
			foreach ( $m[0] as $snippet ) {
				$out[] = array( $label, $snippet );
			}
		}

		$n = preg_match_all( '/j[\x00-\x20]*a[\x00-\x20]*v[\x00-\x20]*a[\x00-\x20]*s[\x00-\x20]*c[\x00-\x20]*r[\x00-\x20]*i[\x00-\x20]*p[\x00-\x20]*t[\x00-\x20]*:/i', $text, $m, PREG_OFFSET_CAPTURE );
		if ( false === $n ) {
			$out[] = array( 'javascript: URL', '#regex-error-js' );
		} else {
			foreach ( $m[0] as $hit ) {
				$start = max( 0, $hit[1] - 40 );
				$out[] = array( 'javascript: URL', substr( $text, $start, ( $hit[1] - $start ) + strlen( $hit[0] ) + 100 ) );
			}
		}

		$tags = preg_match_all( '/<[a-zA-Z][a-zA-Z0-9:-]*+(?:[^>"\']++|"[^"]*+"|\'[^\']*+\')*+>/', $text, $tm );
		if ( false === $tags ) {
			$out[] = array( 'event handler attribute', '#regex-error-tags' );
		} else {
			foreach ( $tm[0] as $tag ) {
				$k = preg_match_all( '/[\s\/"\']on[a-z]{2,30}\s*=\s*(?:"[^"]*+"|\'[^\']*+\'|[^\s>]*+)/i', $tag, $am );
				if ( false === $k ) {
					$out[] = array( 'event handler attribute', '#regex-error-on' );
					continue;
				}
				foreach ( $am[0] as $attr ) {
					$out[] = array( 'event handler attribute', $attr );
				}
			}
		}
		return $out;
	}

	private static function decoded( $text ) {
		return html_entity_decode( $text, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
	}

	/**
	 * Refuse script/iframe/object/embed/form, javascript: URLs and on*= attributes in $new unless
	 * the same text is already in $old.
	 *
	 * @return true|WP_Error
	 */
	public static function check_content( $new, $old ) {
		$allowed = array();
		foreach ( array( $old, self::decoded( $old ) ) as $variant ) {
			foreach ( self::findings( $variant ) as $f ) {
				$allowed[ $f[1] ] = true;
			}
		}
		foreach ( array( $new, self::decoded( $new ) ) as $variant ) {
			foreach ( self::findings( $variant ) as $f ) {
				if ( ! isset( $allowed[ $f[1] ] ) ) {
					$shown = function_exists( 'mb_substr' ) ? mb_substr( $f[1], 0, 80, 'UTF-8' ) : substr( $f[1], 0, 80 );
					return PIB_Connector_Util::error(
						'pib_unsafe',
						sprintf( 'The content contains %s that is not already in the post (%s). Scripts, iframes, objects, embeds, forms, javascript: URLs and event-handler attributes cannot be added through the Connector.', $f[0], $shown ),
						422
					);
				}
			}
		}
		return true;
	}

	/**
	 * Body text: valid UTF-8, no NUL, within the size cap.
	 *
	 * @return string|WP_Error
	 */
	private static function clean_content( $value ) {
		if ( ! is_string( $value ) ) {
			return PIB_Connector_Util::bad_request( 'content must be a string.' );
		}
		if ( strlen( $value ) > self::MAX_CONTENT ) {
			return PIB_Connector_Util::bad_request( 'content is larger than 500 KB.' );
		}
		if ( false !== strpos( $value, "\0" ) || ! preg_match( '//u', $value ) ) {
			return PIB_Connector_Util::bad_request( 'content must be valid UTF-8 text.' );
		}
		return $value;
	}

	private static function clean_title( $value ) {
		if ( ! is_string( $value ) ) {
			return PIB_Connector_Util::bad_request( 'title must be a string.' );
		}
		$t = PIB_Connector_Util::clean_text( $value );
		if ( '' === $t ) {
			return PIB_Connector_Util::bad_request( 'title cannot be empty.' );
		}
		if ( PIB_Connector_Util::strlen( $t ) > self::TITLE_MAX ) {
			return PIB_Connector_Util::bad_request( sprintf( 'title is longer than %d characters.', self::TITLE_MAX ) );
		}
		return $t;
	}

	private static function clean_excerpt( $value ) {
		if ( null === $value ) {
			return '';
		}
		if ( ! is_string( $value ) ) {
			return PIB_Connector_Util::bad_request( 'excerpt must be a string or null.' );
		}
		if ( ! preg_match( '//u', $value ) || false !== strpos( $value, "\0" ) ) {
			return PIB_Connector_Util::bad_request( 'excerpt must be valid UTF-8 text.' );
		}
		$t = trim( wp_strip_all_tags( $value ) );
		if ( PIB_Connector_Util::strlen( $t ) > self::EXCERPT_MAX ) {
			return PIB_Connector_Util::bad_request( sprintf( 'excerpt is longer than %d characters.', self::EXCERPT_MAX ) );
		}
		return $t;
	}

	private static function clean_slug( $value ) {
		if ( ! is_string( $value ) || strlen( $value ) > self::SLUG_MAX * 3 ) {
			return PIB_Connector_Util::bad_request( 'slug must be a string.' );
		}
		$slug = sanitize_title( $value );
		if ( '' === $slug || strlen( $slug ) > self::SLUG_MAX ) {
			return PIB_Connector_Util::bad_request( 'slug is empty or too long after cleaning.' );
		}
		return $slug;
	}

	/* ------------------------------------------------------------------ */
	/* Backups (post meta, last 5 per post)                               */
	/* ------------------------------------------------------------------ */

	private static function backups( $post_id ) {
		$list = get_post_meta( (int) $post_id, self::BACKUP_META, true );
		return is_array( $list ) ? array_values( $list ) : array();
	}

	/**
	 * @return string|WP_Error backup id
	 */
	private static function backup( $post ) {
		if ( strlen( (string) $post->post_content ) > self::MAX_CONTENT ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'The existing content is larger than 500 KB and cannot be backed up, so the Connector will not change it.', 422 );
		}
		$id    = 'bk_' . bin2hex( random_bytes( 6 ) );
		$list  = self::backups( $post->ID );
		array_unshift(
			$list,
			array(
				'id'      => $id,
				'at'      => gmdate( 'Y-m-d\TH:i:s\Z' ),
				'title'   => (string) $post->post_title,
				'content' => (string) $post->post_content,
				'excerpt' => (string) $post->post_excerpt,
				'slug'    => (string) $post->post_name,
			)
		);
		$list = array_slice( $list, 0, self::BACKUP_KEEP );
		update_post_meta( (int) $post->ID, self::BACKUP_META, wp_slash( $list ) );
		return $id;
	}

	private static function find_backup( $post_id, $backup_id ) {
		foreach ( self::backups( $post_id ) as $b ) {
			if ( is_array( $b ) && isset( $b['id'] ) && $b['id'] === $backup_id ) {
				return $b;
			}
		}
		return null;
	}

	/* ------------------------------------------------------------------ */
	/* posts/get, posts/images                                            */
	/* ------------------------------------------------------------------ */

	public static function endpoint_get( array $params ) {
		$post = self::resolve_post( $params );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$content   = (string) $post->post_content;
		$truncated = strlen( $content ) > self::MAX_CONTENT;
		if ( $truncated ) {
			$content = function_exists( 'mb_strcut' ) ? mb_strcut( $content, 0, self::MAX_CONTENT, 'UTF-8' ) : substr( $content, 0, self::MAX_CONTENT );
		}
		$thumb = (int) get_post_thumbnail_id( $post->ID );
		return array(
			'postId'            => (int) $post->ID,
			'postType'          => (string) $post->post_type,
			'status'            => (string) $post->post_status,
			'url'               => (string) get_permalink( $post ),
			'title'             => (string) $post->post_title,
			'slug'              => (string) $post->post_name,
			'excerpt'           => (string) $post->post_excerpt,
			'content'           => $content,
			'modified'          => self::iso( isset( $post->post_modified_gmt ) ? $post->post_modified_gmt : null ),
			'featuredImageId'   => $thumb > 0 ? $thumb : null,
			'parentId'          => (int) $post->post_parent > 0 ? (int) $post->post_parent : null,
			'createdByConnector' => '1' === (string) get_post_meta( $post->ID, self::CREATED_META, true ),
			'truncated'         => $truncated,
		);
	}

	/**
	 * Every <img> tag in order: [ [ 'tag' => string, 'offset' => int ], ... ] or false on regex failure.
	 */
	private static function img_tags( $content ) {
		$n = preg_match_all( '/<img\b(?:[^>"\']++|"[^"]*+"|\'[^\']*+\')*+>/i', $content, $m, PREG_OFFSET_CAPTURE );
		if ( false === $n ) {
			return false;
		}
		$out = array();
		foreach ( $m[0] as $hit ) {
			$out[] = array( 'tag' => $hit[0], 'offset' => $hit[1] );
		}
		return $out;
	}

	/**
	 * Attributes of a tag: name (lower-case) => [ value|null, start, length ] (first occurrence wins).
	 */
	private static function tag_attrs( $tag ) {
		$attrs = array();
		$body  = substr( $tag, 4 ); // After "<img".
		if ( false === preg_match_all( '/([^\s"\'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?/', $body, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE ) ) {
			return $attrs;
		}
		foreach ( $m as $hit ) {
			$name = strtolower( $hit[1][0] );
			if ( isset( $attrs[ $name ] ) ) {
				continue;
			}
			$value = null;
			if ( isset( $hit[2] ) && -1 !== $hit[2][1] ) {
				$value = $hit[2][0];
			} elseif ( isset( $hit[3] ) && -1 !== $hit[3][1] ) {
				$value = $hit[3][0];
			} elseif ( isset( $hit[4] ) && -1 !== $hit[4][1] ) {
				$value = $hit[4][0];
			}
			$attrs[ $name ] = array( $value, $hit[0][1] + 4, strlen( $hit[0][0] ) );
		}
		return $attrs;
	}

	private static function attr_text( $raw ) {
		return null === $raw ? '' : html_entity_decode( $raw, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
	}

	private static function images_of( $content ) {
		$tags = self::img_tags( $content );
		if ( false === $tags ) {
			return PIB_Connector_Util::error( 'pib_internal', 'The content could not be scanned for images.', 500 );
		}
		$out = array();
		foreach ( $tags as $i => $t ) {
			$attrs = self::tag_attrs( $t['tag'] );
			$src   = isset( $attrs['src'] ) ? self::attr_text( $attrs['src'][0] ) : '';
			$alt   = isset( $attrs['alt'] ) ? self::attr_text( $attrs['alt'][0] ) : '';
			$aid   = null;
			$class = isset( $attrs['class'] ) ? self::attr_text( $attrs['class'][0] ) : '';
			if ( preg_match( '/(?:^|\s)wp-image-([0-9]{1,18})(?:\s|$)/', $class, $cm ) && null !== PIB_Connector_Media::image_attachment( (int) $cm[1] ) ) {
				$aid = (int) $cm[1];
			} elseif ( '' !== $src && function_exists( 'attachment_url_to_postid' ) ) {
				$found = (int) attachment_url_to_postid( $src );
				$aid   = $found > 0 ? $found : null;
			}
			$out[] = array(
				'index'        => $i,
				'src'          => $src,
				'alt'          => $alt,
				'attachmentId' => $aid,
			);
		}
		return $out;
	}

	public static function endpoint_images( array $params ) {
		$post = self::resolve_post( $params );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$images = self::images_of( (string) $post->post_content );
		if ( is_wp_error( $images ) ) {
			return $images;
		}
		return array(
			'postId' => (int) $post->ID,
			'images' => $images,
		);
	}

	/* ------------------------------------------------------------------ */
	/* posts/img-alt                                                      */
	/* ------------------------------------------------------------------ */

	public static function endpoint_img_alt( array $params ) {
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$post = self::resolve_post( $params );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$alts = isset( $params['alts'] ) ? $params['alts'] : null;
		if ( ! is_array( $alts ) || empty( $alts ) || count( $alts ) > 100 || array_keys( $alts ) !== range( 0, count( $alts ) - 1 ) ) {
			return PIB_Connector_Util::bad_request( 'alts must be a list of 1 to 100 { index, alt }.' );
		}
		$content = (string) $post->post_content;
		$tags    = self::img_tags( $content );
		if ( false === $tags ) {
			return PIB_Connector_Util::error( 'pib_internal', 'The content could not be scanned for images.', 500 );
		}
		$want = array();
		foreach ( $alts as $i => $item ) {
			if ( ! is_array( $item ) || ! array_key_exists( 'index', $item ) || ! array_key_exists( 'alt', $item ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'alts[%d] needs index and alt.', $i ) );
			}
			if ( ! is_int( $item['index'] ) || $item['index'] < 0 || $item['index'] >= count( $tags ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'alts[%d].index does not match an <img> in the content (%d found).', $i, count( $tags ) ) );
			}
			if ( isset( $want[ $item['index'] ] ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'alts[%d]: image %d is listed twice.', $i, $item['index'] ) );
			}
			$alt = PIB_Connector_Media::clean_alt( $item['alt'], sprintf( 'alts[%d].alt', $i ) );
			if ( is_wp_error( $alt ) ) {
				return $alt;
			}
			$want[ $item['index'] ] = $alt;
		}

		$images = self::images_of( $content );

		// Rebuild the content with only the alt attributes of the chosen tags changed.
		$new       = '';
		$cursor    = 0;
		$updated   = 0;
		$att_alts  = array();
		foreach ( $tags as $i => $t ) {
			if ( ! isset( $want[ $i ] ) ) {
				continue;
			}
			$tag   = $t['tag'];
			$attrs = self::tag_attrs( $tag );
			$alt   = $want[ $i ];
			$cur   = isset( $attrs['alt'] ) ? self::attr_text( $attrs['alt'][0] ) : null;
			if ( $cur === $alt || ( null === $cur && '' === $alt ) ) {
				continue;
			}
			$attr_html = 'alt="' . esc_attr( $alt ) . '"';
			if ( isset( $attrs['alt'] ) ) {
				$tag = substr( $tag, 0, $attrs['alt'][1] ) . $attr_html . substr( $tag, $attrs['alt'][1] + $attrs['alt'][2] );
			} else {
				$p = strlen( $tag ) - 1;
				if ( $p > 0 && '/' === $tag[ $p - 1 ] ) {
					$p--;
				}
				while ( $p > 0 && ctype_space( $tag[ $p - 1 ] ) ) {
					$p--;
				}
				$tag = substr( $tag, 0, $p ) . ' ' . $attr_html . substr( $tag, $p );
			}
			$new     .= substr( $content, $cursor, $t['offset'] - $cursor ) . $tag;
			$cursor   = $t['offset'] + strlen( $t['tag'] );
			$updated++;

			// Library alt: only when the image has an attachment and its alt is empty.
			if ( is_array( $images ) && isset( $images[ $i ] ) && null !== $images[ $i ]['attachmentId'] && '' !== $alt ) {
				$aid = $images[ $i ]['attachmentId'];
				if ( '' === PIB_Connector_Media::get_alt( $aid ) && ! isset( $att_alts[ $aid ] ) ) {
					$att_alts[ $aid ] = $alt;
				}
			}
		}
		$new .= substr( $content, $cursor );

		if ( 0 === $updated ) {
			return array(
				'changeId' => null,
				'postId'   => (int) $post->ID,
				'updated'  => 0,
			);
		}

		$backup_id = self::backup( $post );
		if ( is_wp_error( $backup_id ) ) {
			return $backup_id;
		}
		$res = self::unfiltered(
			function () use ( $post, $new ) {
				return wp_update_post(
					array(
						'ID'           => (int) $post->ID,
						'post_content' => wp_slash( $new ),
					),
					true
				);
			}
		);
		if ( is_wp_error( $res ) || ! $res ) {
			return PIB_Connector_Util::error( 'pib_write_failed', 'WordPress did not save the content.', 500 );
		}
		$log_alts = array();
		foreach ( $att_alts as $aid => $alt ) {
			PIB_Connector_Media::set_alt( $aid, $alt );
			$log_alts[] = array( 'attachmentId' => $aid, 'after' => $alt );
		}

		$change_id = PIB_Connector_Log::record(
			'posts/img-alt',
			'content',
			self::target_of( $post ),
			$reason,
			array( 'content' => self::content_summary( $content ), 'images' => $updated ),
			array( 'content' => self::content_summary( $new ), 'images' => $updated ),
			array(
				'backupId'       => $backup_id,
				'attachmentAlts' => $log_alts,
			)
		);
		return array(
			'changeId' => $change_id,
			'postId'   => (int) $post->ID,
			'updated'  => $updated,
		);
	}

	/* ------------------------------------------------------------------ */
	/* posts/update                                                       */
	/* ------------------------------------------------------------------ */

	public static function endpoint_update( array $params ) {
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$post = self::resolve_post( $params );
		if ( is_wp_error( $post ) ) {
			return $post;
		}

		$new_vals = array();
		if ( array_key_exists( 'title', $params ) ) {
			$v = self::clean_title( $params['title'] );
			if ( is_wp_error( $v ) ) {
				return $v;
			}
			$new_vals['title'] = $v;
		}
		if ( array_key_exists( 'content', $params ) ) {
			$v = self::clean_content( $params['content'] );
			if ( is_wp_error( $v ) ) {
				return $v;
			}
			$safe = self::check_content( $v, (string) $post->post_content );
			if ( is_wp_error( $safe ) ) {
				return $safe;
			}
			$new_vals['content'] = $v;
		}
		if ( array_key_exists( 'excerpt', $params ) ) {
			$v = self::clean_excerpt( $params['excerpt'] );
			if ( is_wp_error( $v ) ) {
				return $v;
			}
			$new_vals['excerpt'] = $v;
		}
		if ( array_key_exists( 'slug', $params ) ) {
			$v = self::clean_slug( $params['slug'] );
			if ( is_wp_error( $v ) ) {
				return $v;
			}
			$new_vals['slug'] = $v;
		}
		if ( empty( $new_vals ) ) {
			return PIB_Connector_Util::bad_request( 'Send at least one of title, content, excerpt or slug.' );
		}

		$current = array(
			'title'   => (string) $post->post_title,
			'content' => (string) $post->post_content,
			'excerpt' => (string) $post->post_excerpt,
			'slug'    => (string) $post->post_name,
		);
		$changed = array();
		foreach ( $new_vals as $f => $v ) {
			if ( $v !== $current[ $f ] ) {
				$changed[] = $f;
			}
		}
		if ( empty( $changed ) ) {
			return array(
				'changeId' => null,
				'postId'   => (int) $post->ID,
				'changed'  => array(),
				'warnings' => array( 'No change: the values match the current post.' ),
			);
		}

		$backup_id = self::backup( $post );
		if ( is_wp_error( $backup_id ) ) {
			return $backup_id;
		}
		$before_summary = self::fields_summary( $post, $changed );

		$args = array( 'ID' => (int) $post->ID );
		$map  = array(
			'title'   => 'post_title',
			'content' => 'post_content',
			'excerpt' => 'post_excerpt',
			'slug'    => 'post_name',
		);
		foreach ( $changed as $f ) {
			$args[ $map[ $f ] ] = wp_slash( $new_vals[ $f ] );
		}
		$res = self::unfiltered(
			function () use ( $args ) {
				return wp_update_post( $args, true );
			}
		);
		if ( is_wp_error( $res ) || ! $res ) {
			return PIB_Connector_Util::error( 'pib_write_failed', 'WordPress did not save the post.', 500 );
		}
		$fresh = get_post( (int) $post->ID );

		$warnings = array();
		if ( in_array( 'slug', $changed, true ) && 'publish' === $post->post_status ) {
			$warnings[] = 'The slug of a published page changed. WordPress keeps its old-slug redirect, but add a redirect with redirects/set if the page has traffic.';
		}

		$change_id = PIB_Connector_Log::record(
			'posts/update',
			'content',
			self::target_of( $post ),
			$reason,
			$before_summary,
			self::fields_summary( $fresh, $changed ),
			array(
				'backupId' => $backup_id,
				'changed'  => $changed,
			)
		);
		return array(
			'changeId' => $change_id,
			'postId'   => (int) $post->ID,
			'changed'  => $changed,
			'warnings' => $warnings,
		);
	}

	/**
	 * Undo posts/update and posts/img-alt from the saved post backup.
	 *
	 * @return array|WP_Error
	 */
	public static function undo_update( array $entry ) {
		$target = $entry['target'];
		$post   = ( is_array( $target ) && ! empty( $target['postId'] ) ) ? get_post( (int) $target['postId'] ) : null;
		if ( ! $post || 'trash' === $post->post_status ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The post no longer exists.', 422 );
		}
		$bk = isset( $entry['backupId'] ) ? self::find_backup( $post->ID, $entry['backupId'] ) : null;
		if ( null === $bk ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The saved copy of the old text is gone (only the last 5 versions of a post are kept).', 422 );
		}
		if ( 'posts/img-alt' === $entry['endpoint'] ) {
			$fields = array( 'content' );
		} else {
			$fields = ( isset( $entry['changed'] ) && is_array( $entry['changed'] ) ) ? array_values( array_intersect( $entry['changed'], array( 'title', 'content', 'excerpt', 'slug' ) ) ) : array();
		}
		if ( empty( $fields ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The change did not record which fields it touched.', 422 );
		}
		$now  = self::fields_summary( $post, $fields );
		$map  = array(
			'title'   => 'post_title',
			'content' => 'post_content',
			'excerpt' => 'post_excerpt',
			'slug'    => 'post_name',
		);
		$args = array( 'ID' => (int) $post->ID );
		foreach ( $fields as $f ) {
			$args[ $map[ $f ] ] = wp_slash( (string) $bk[ $f ] );
		}
		$res = self::unfiltered(
			function () use ( $args ) {
				return wp_update_post( $args, true );
			}
		);
		if ( is_wp_error( $res ) || ! $res ) {
			return PIB_Connector_Util::error( 'pib_write_failed', 'WordPress did not save the post.', 500 );
		}
		// Library alt text set together with the image alts goes back to empty.
		if ( ! empty( $entry['attachmentAlts'] ) && is_array( $entry['attachmentAlts'] ) ) {
			foreach ( $entry['attachmentAlts'] as $item ) {
				if ( isset( $item['attachmentId'], $item['after'] ) && PIB_Connector_Media::get_alt( (int) $item['attachmentId'] ) === (string) $item['after'] ) {
					PIB_Connector_Media::set_alt( (int) $item['attachmentId'], '' );
				}
			}
		}
		return array( $target, $now, self::fields_summary( get_post( (int) $post->ID ), $fields ), array() );
	}

	/* ------------------------------------------------------------------ */
	/* posts/create, posts/publish                                        */
	/* ------------------------------------------------------------------ */

	public static function endpoint_create( array $params ) {
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$type = 'page';
		if ( array_key_exists( 'postType', $params ) && null !== $params['postType'] ) {
			if ( ! is_string( $params['postType'] ) || ! in_array( $params['postType'], array( 'page', 'post' ), true ) ) {
				return PIB_Connector_Util::bad_request( 'postType must be "page" or "post".' );
			}
			$type = $params['postType'];
		}
		if ( ! isset( $params['title'] ) ) {
			return PIB_Connector_Util::bad_request( 'title is required.' );
		}
		$title = self::clean_title( $params['title'] );
		if ( is_wp_error( $title ) ) {
			return $title;
		}
		$content = '';
		if ( array_key_exists( 'content', $params ) && null !== $params['content'] ) {
			$content = self::clean_content( $params['content'] );
			if ( is_wp_error( $content ) ) {
				return $content;
			}
			$safe = self::check_content( $content, '' );
			if ( is_wp_error( $safe ) ) {
				return $safe;
			}
		}
		$excerpt = '';
		if ( array_key_exists( 'excerpt', $params ) ) {
			$excerpt = self::clean_excerpt( $params['excerpt'] );
			if ( is_wp_error( $excerpt ) ) {
				return $excerpt;
			}
		}
		$slug = '';
		if ( array_key_exists( 'slug', $params ) && null !== $params['slug'] && '' !== $params['slug'] ) {
			$slug = self::clean_slug( $params['slug'] );
			if ( is_wp_error( $slug ) ) {
				return $slug;
			}
		}
		$parent = 0;
		if ( array_key_exists( 'parentId', $params ) && null !== $params['parentId'] ) {
			if ( 'page' !== $type ) {
				return PIB_Connector_Util::bad_request( 'parentId is only for pages.' );
			}
			$parent = PIB_Connector_Util::positive_int( $params['parentId'] );
			$pp     = null === $parent ? null : get_post( $parent );
			if ( null === $parent || ! $pp || 'page' !== $pp->post_type || in_array( $pp->post_status, array( 'trash', 'auto-draft' ), true ) ) {
				return PIB_Connector_Util::bad_request( 'parentId must be an existing page.' );
			}
		}

		$args = array(
			'post_type'    => $type,
			'post_status'  => 'draft',
			'post_title'   => wp_slash( $title ),
			'post_content' => wp_slash( $content ),
			'post_excerpt' => wp_slash( $excerpt ),
			'post_parent'  => $parent,
		);
		if ( '' !== $slug ) {
			$args['post_name'] = $slug;
		}
		$id = self::unfiltered(
			function () use ( $args ) {
				return wp_insert_post( $args, true );
			}
		);
		if ( is_wp_error( $id ) || ! $id ) {
			return PIB_Connector_Util::error( 'pib_write_failed', 'WordPress did not create the draft.', 500 );
		}
		$id = (int) $id;
		update_post_meta( $id, self::CREATED_META, '1' );
		$post = get_post( $id );

		$change_id = PIB_Connector_Log::record(
			'posts/create',
			'content',
			self::target_of( $post ),
			$reason,
			null,
			array(
				'postId' => $id,
				'status' => 'draft',
				'title'  => $title,
			)
		);
		return array(
			'changeId'   => $change_id,
			'postId'     => $id,
			'status'     => 'draft',
			'editUrl'    => admin_url( 'post.php?post=' . $id . '&action=edit' ),
			'previewUrl' => home_url( '/' ) . '?p=' . $id . '&preview=true',
		);
	}

	public static function undo_create( array $entry ) {
		$target = $entry['target'];
		$post   = ( is_array( $target ) && ! empty( $target['postId'] ) ) ? get_post( (int) $target['postId'] ) : null;
		if ( ! $post || '1' !== (string) get_post_meta( $post->ID, self::CREATED_META, true ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The draft no longer exists.', 422 );
		}
		if ( 'draft' !== $post->post_status ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', sprintf( 'The page is %s now; only a Connector draft can be undone (it is moved to the trash, not deleted).', $post->post_status ), 422 );
		}
		wp_trash_post( (int) $post->ID );
		$fresh = get_post( (int) $post->ID );
		return array(
			$target,
			array( 'postId' => (int) $post->ID, 'status' => 'draft' ),
			array( 'postId' => (int) $post->ID, 'status' => $fresh ? (string) $fresh->post_status : 'trash' ),
			array(),
		);
	}

	public static function endpoint_publish( array $params ) {
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$id = isset( $params['postId'] ) ? PIB_Connector_Util::positive_int( $params['postId'] ) : null;
		if ( null === $id ) {
			return PIB_Connector_Util::bad_request( 'postId must be a positive integer.' );
		}
		$post = get_post( $id );
		if ( ! $post || 'attachment' === $post->post_type ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'No post or page with that id.', 422 );
		}
		if ( '1' !== (string) get_post_meta( $id, self::CREATED_META, true ) ) {
			return PIB_Connector_Util::error( 'pib_forbidden', 'The Connector only publishes drafts it created itself.', 403 );
		}
		if ( 'draft' !== $post->post_status ) {
			return PIB_Connector_Util::error( 'pib_conflict', sprintf( 'The page is %s, not a draft.', $post->post_status ), 409 );
		}
		$res = wp_update_post(
			array(
				'ID'          => $id,
				'post_status' => 'publish',
			),
			true
		);
		if ( is_wp_error( $res ) || ! $res ) {
			return PIB_Connector_Util::error( 'pib_write_failed', 'WordPress did not publish the page.', 500 );
		}
		$fresh = get_post( $id );
		$url   = (string) get_permalink( $fresh );
		$change_id = PIB_Connector_Log::record(
			'posts/publish',
			'content',
			self::target_of( $fresh ),
			$reason,
			array( 'status' => 'draft' ),
			array( 'status' => (string) $fresh->post_status )
		);
		return array(
			'changeId' => $change_id,
			'postId'   => $id,
			'status'   => (string) $fresh->post_status,
			'url'      => $url,
		);
	}

	public static function undo_publish( array $entry ) {
		$target = $entry['target'];
		$post   = ( is_array( $target ) && ! empty( $target['postId'] ) ) ? get_post( (int) $target['postId'] ) : null;
		if ( ! $post || '1' !== (string) get_post_meta( $post->ID, self::CREATED_META, true ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The page no longer exists.', 422 );
		}
		if ( 'publish' !== $post->post_status ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', sprintf( 'The page is %s now, not published.', $post->post_status ), 422 );
		}
		$res = wp_update_post(
			array(
				'ID'          => (int) $post->ID,
				'post_status' => 'draft',
			),
			true
		);
		if ( is_wp_error( $res ) || ! $res ) {
			return PIB_Connector_Util::error( 'pib_write_failed', 'WordPress did not move the page back to draft.', 500 );
		}
		$fresh = get_post( (int) $post->ID );
		return array( $target, array( 'status' => 'publish' ), array( 'status' => (string) $fresh->post_status ), array() );
	}
}
