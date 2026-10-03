<?php
/**
 * media/list, media/sideload, media/set-featured, media/alt.
 * Uploads are additive; the Connector never deletes attachments.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Media {

	const MAX_BYTES = 10485760; // 10 MB.
	const SCAN_MAX  = 2000;
	const ALT_MAX   = 300;

	/**
	 * Real MIME type => file extension for the images the Connector accepts.
	 */
	public static function allowed_mimes() {
		return array(
			'image/jpeg' => 'jpg',
			'image/png'  => 'png',
			'image/webp' => 'webp',
			'image/gif'  => 'gif',
			'image/avif' => 'avif',
		);
	}

	/* ------------------------------------------------------------------ */
	/* Helpers shared with the content endpoints                          */
	/* ------------------------------------------------------------------ */

	/**
	 * @return object|null The attachment post when $id is an image attachment.
	 */
	public static function image_attachment( $id ) {
		$post = get_post( (int) $id );
		if ( ! $post || ! is_object( $post ) || 'attachment' !== $post->post_type ) {
			return null;
		}
		$mime = isset( $post->post_mime_type ) ? (string) $post->post_mime_type : '';
		return 0 === strpos( $mime, 'image/' ) ? $post : null;
	}

	public static function get_alt( $id ) {
		$alt = get_post_meta( (int) $id, '_wp_attachment_image_alt', true );
		return is_string( $alt ) ? $alt : '';
	}

	public static function set_alt( $id, $alt ) {
		if ( '' === $alt ) {
			delete_post_meta( (int) $id, '_wp_attachment_image_alt' );
		} else {
			update_post_meta( (int) $id, '_wp_attachment_image_alt', wp_slash( $alt ) );
		}
	}

	/**
	 * Plain-text alt: '' clears. Returns a string or WP_Error.
	 */
	public static function clean_alt( $value, $label = 'alt' ) {
		if ( null === $value ) {
			return '';
		}
		if ( ! is_string( $value ) ) {
			return PIB_Connector_Util::bad_request( sprintf( '%s must be a string.', $label ) );
		}
		if ( preg_match( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $value ) ) {
			return PIB_Connector_Util::bad_request( sprintf( '%s contains control characters.', $label ) );
		}
		$clean = PIB_Connector_Util::clean_text( $value );
		if ( PIB_Connector_Util::strlen( $clean ) > self::ALT_MAX ) {
			return PIB_Connector_Util::bad_request( sprintf( '%s is longer than %d characters.', $label, self::ALT_MAX ) );
		}
		return $clean;
	}

	private static function load_media_includes() {
		foreach ( array( 'file.php', 'media.php', 'image.php' ) as $file ) {
			if ( defined( 'ABSPATH' ) && file_exists( ABSPATH . 'wp-admin/includes/' . $file ) ) {
				require_once ABSPATH . 'wp-admin/includes/' . $file;
			}
		}
	}

	public static function detect_mime( $path ) {
		$mime = null;
		if ( function_exists( 'finfo_open' ) ) {
			$f = finfo_open( FILEINFO_MIME_TYPE );
			if ( $f ) {
				$m = finfo_file( $f, $path );
				finfo_close( $f );
				if ( is_string( $m ) ) {
					$mime = $m;
				}
			}
		}
		if ( ( null === $mime || in_array( $mime, array( 'application/octet-stream', 'application/x-empty', 'text/plain' ), true ) ) && function_exists( 'wp_get_image_mime' ) ) {
			$wp = wp_get_image_mime( $path );
			if ( is_string( $wp ) ) {
				$mime = $wp;
			}
		}
		return $mime;
	}

	private static function valid_https_url( $url ) {
		if ( ! is_string( $url ) || strlen( $url ) > 2048 || 'https://' !== strtolower( substr( $url, 0, 8 ) ) || preg_match( '/[\x00-\x20\x7F]/', $url ) || ! wp_http_validate_url( $url ) ) {
			return false;
		}
		$parts = wp_parse_url( $url );
		return is_array( $parts ) && ! empty( $parts['host'] ) && ! isset( $parts['user'] ) && ! isset( $parts['pass'] );
	}

	/**
	 * Optional title / alt / filename / postId shared by sideload and set-featured.
	 *
	 * @return array|WP_Error { title, alt, filename, postId } (alt: null = not sent)
	 */
	private static function parse_image_options( array $params ) {
		$out   = array( 'title' => null, 'alt' => null, 'filename' => null, 'postId' => 0 );
		$title = PIB_Connector_Util::optional_string( $params, 'title', 200 );
		if ( is_wp_error( $title ) ) {
			return $title;
		}
		$out['title'] = null === $title ? null : PIB_Connector_Util::clean_text( $title );
		if ( array_key_exists( 'alt', $params ) ) {
			$alt = self::clean_alt( $params['alt'] );
			if ( is_wp_error( $alt ) ) {
				return $alt;
			}
			$out['alt'] = $alt;
		}
		if ( array_key_exists( 'filename', $params ) && null !== $params['filename'] && '' !== $params['filename'] ) {
			if ( ! is_string( $params['filename'] ) || ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/', $params['filename'] ) ) {
				return PIB_Connector_Util::bad_request( 'filename may only contain letters, digits, dot, dash and underscore.' );
			}
			$out['filename'] = $params['filename'];
		}
		if ( array_key_exists( 'postId', $params ) && null !== $params['postId'] ) {
			$pid = PIB_Connector_Util::positive_int( $params['postId'] );
			if ( null === $pid ) {
				return PIB_Connector_Util::bad_request( 'postId must be a positive integer.' );
			}
			$post = get_post( $pid );
			if ( ! $post || 'attachment' === $post->post_type || in_array( $post->post_status, array( 'trash', 'auto-draft' ), true ) ) {
				return PIB_Connector_Util::bad_request( 'postId does not match a post or page.' );
			}
			$out['postId'] = $pid;
		}
		return $out;
	}

	/**
	 * Download an image into the Media Library (or reuse the attachment for the same source URL).
	 *
	 * @param string      $url  https image URL.
	 * @param array       $opts title, alt, filename, postId (from parse_image_options).
	 * @return array|WP_Error { attachmentId, url, reused, altSet: {before, after}|null }
	 */
	public static function sideload( $url, array $opts ) {
		if ( ! self::valid_https_url( $url ) ) {
			return PIB_Connector_Util::bad_request( 'imageUrl must be a public https URL.' );
		}

		// Reuse: the same source URL is never imported twice.
		$found = new WP_Query(
			array(
				'post_type'      => 'attachment',
				'post_status'    => 'inherit',
				'posts_per_page' => 1,
				'fields'         => 'ids',
				'meta_key'       => '_pib_source_url', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
				'meta_value'     => $url, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
			)
		);
		if ( ! empty( $found->posts ) ) {
			$existing = (int) $found->posts[0];
			if ( null !== self::image_attachment( $existing ) ) {
				$alt_set = null;
				if ( null !== $opts['alt'] && '' !== $opts['alt'] && '' === self::get_alt( $existing ) ) {
					self::set_alt( $existing, $opts['alt'] );
					$alt_set = array( 'before' => '', 'after' => $opts['alt'] );
				}
				return array(
					'attachmentId' => $existing,
					'url'          => (string) wp_get_attachment_url( $existing ),
					'reused'       => true,
					'altSet'       => $alt_set,
				);
			}
		}

		self::load_media_includes();
		if ( ! function_exists( 'download_url' ) || ! function_exists( 'media_handle_sideload' ) ) {
			return PIB_Connector_Util::error( 'pib_media_failed', 'WordPress media functions are not available.', 502 );
		}

		$limiter = function ( $args ) {
			$args['limit_response_size'] = PIB_Connector_Media::MAX_BYTES + 1;
			return $args;
		};
		add_filter( 'http_request_args', $limiter, 99 );
		$tmp = download_url( $url, 60 );
		if ( function_exists( 'remove_filter' ) ) {
			remove_filter( 'http_request_args', $limiter, 99 );
		}
		if ( is_wp_error( $tmp ) ) {
			return PIB_Connector_Util::error( 'pib_media_failed', 'Download failed: ' . $tmp->get_error_message(), 502 );
		}

		$bytes = is_file( $tmp ) ? (int) filesize( $tmp ) : 0;
		if ( $bytes <= 0 || $bytes > self::MAX_BYTES ) {
			self::discard( $tmp );
			return PIB_Connector_Util::error( 'pib_media_failed', $bytes <= 0 ? 'The download was empty.' : 'The image is larger than 10 MB.', 502 );
		}
		$mime    = self::detect_mime( $tmp );
		$allowed = self::allowed_mimes();
		if ( ! is_string( $mime ) || ! isset( $allowed[ $mime ] ) ) {
			self::discard( $tmp );
			return PIB_Connector_Util::error( 'pib_media_failed', 'The file is not a jpeg, png, webp, gif or avif image.', 502 );
		}

		$name = $opts['filename'];
		if ( null === $name ) {
			$path = wp_parse_url( $url, PHP_URL_PATH );
			$name = is_string( $path ) ? basename( $path ) : '';
		}
		$stem = preg_replace( '/\.[A-Za-z0-9]{1,5}$/', '', (string) $name );
		$stem = preg_replace( '/[^A-Za-z0-9._-]+/', '-', $stem );
		$stem = trim( substr( $stem, 0, 90 ), '.-_' );
		if ( '' === $stem ) {
			$stem = 'image';
		}
		$file_name = $stem . '.' . $allowed[ $mime ];

		$id = media_handle_sideload(
			array(
				'name'     => $file_name,
				'tmp_name' => $tmp,
			),
			(int) $opts['postId'],
			$opts['title']
		);
		if ( is_wp_error( $id ) ) {
			self::discard( $tmp );
			return PIB_Connector_Util::error( 'pib_media_failed', 'Import failed: ' . $id->get_error_message(), 502 );
		}
		$id = (int) $id;
		update_post_meta( $id, '_pib_source_url', wp_slash( $url ) );
		$alt_set = null;
		if ( null !== $opts['alt'] && '' !== $opts['alt'] ) {
			self::set_alt( $id, $opts['alt'] );
			$alt_set = array( 'before' => '', 'after' => $opts['alt'] );
		}
		return array(
			'attachmentId' => $id,
			'url'          => (string) wp_get_attachment_url( $id ),
			'reused'       => false,
			'altSet'       => $alt_set,
		);
	}

	private static function discard( $tmp ) {
		if ( is_string( $tmp ) && is_file( $tmp ) ) {
			wp_delete_file( $tmp ); // Our own temporary download, never site content.
		}
	}

	/* ------------------------------------------------------------------ */
	/* media/list                                                         */
	/* ------------------------------------------------------------------ */

	private static function list_item( $id ) {
		$post = self::image_attachment( $id );
		if ( null === $post ) {
			return null;
		}
		$meta = function_exists( 'wp_get_attachment_metadata' ) ? wp_get_attachment_metadata( $id ) : array();
		$meta = is_array( $meta ) ? $meta : array();
		$size = null;
		if ( isset( $meta['filesize'] ) && is_numeric( $meta['filesize'] ) ) {
			$size = (int) $meta['filesize'];
		} elseif ( function_exists( 'get_attached_file' ) ) {
			$file = get_attached_file( $id );
			if ( is_string( $file ) && is_file( $file ) ) {
				$size = (int) filesize( $file );
			}
		}
		return array(
			'attachmentId' => (int) $id,
			'url'          => (string) wp_get_attachment_url( $id ),
			'title'        => (string) $post->post_title,
			'alt'          => self::get_alt( $id ),
			'mime'         => (string) $post->post_mime_type,
			'width'        => isset( $meta['width'] ) ? (int) $meta['width'] : null,
			'height'       => isset( $meta['height'] ) ? (int) $meta['height'] : null,
			'parentId'     => (int) $post->post_parent > 0 ? (int) $post->post_parent : null,
			'filesize'     => $size,
		);
	}

	public static function endpoint_list( array $params ) {
		$search = PIB_Connector_Util::optional_string( $params, 'search', 200 );
		if ( is_wp_error( $search ) ) {
			return $search;
		}
		$post_id = null;
		if ( array_key_exists( 'postId', $params ) && null !== $params['postId'] ) {
			$post_id = PIB_Connector_Util::positive_int( $params['postId'] );
			if ( null === $post_id ) {
				return PIB_Connector_Util::bad_request( 'postId must be a positive integer.' );
			}
		}
		$missing_alt = false;
		if ( array_key_exists( 'missingAlt', $params ) && null !== $params['missingAlt'] ) {
			if ( ! is_bool( $params['missingAlt'] ) ) {
				return PIB_Connector_Util::bad_request( 'missingAlt must be true or false.' );
			}
			$missing_alt = $params['missingAlt'];
		}
		if ( array_key_exists( 'mime', $params ) && null !== $params['mime'] && 'image' !== $params['mime'] ) {
			return PIB_Connector_Util::bad_request( 'mime may only be "image".' );
		}
		$page = 1;
		if ( array_key_exists( 'page', $params ) && null !== $params['page'] ) {
			$page = PIB_Connector_Util::positive_int( $params['page'] );
			if ( null === $page || $page > 100000 ) {
				return PIB_Connector_Util::bad_request( 'page must be a positive integer.' );
			}
		}
		$per_page = 50;
		if ( array_key_exists( 'perPage', $params ) && null !== $params['perPage'] ) {
			$per_page = PIB_Connector_Util::positive_int( $params['perPage'] );
			if ( null === $per_page || $per_page > 100 ) {
				return PIB_Connector_Util::bad_request( 'perPage must be 1 to 100.' );
			}
		}

		$args = array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'post_mime_type' => 'image',
			'orderby'        => 'date',
			'order'          => 'DESC',
			'fields'         => 'ids',
		);
		if ( null !== $search ) {
			$args['s'] = $search;
		}

		if ( null === $post_id && ! $missing_alt ) {
			$args['posts_per_page'] = $per_page;
			$args['paged']          = $page;
			$q                      = new WP_Query( $args );
			$items                  = array();
			foreach ( (array) $q->posts as $id ) {
				$item = self::list_item( (int) $id );
				if ( null !== $item ) {
					$items[] = $item;
				}
			}
			return array(
				'total'   => (int) $q->found_posts,
				'page'    => $page,
				'perPage' => $per_page,
				'items'   => $items,
			);
		}

		if ( null !== $post_id ) {
			$args['post_parent'] = $post_id;
		}
		$args['posts_per_page'] = self::SCAN_MAX;
		$args['paged']          = 1;
		$q                      = new WP_Query( $args );
		$ids                    = array_map( 'intval', (array) $q->posts );
		if ( null !== $post_id ) {
			$thumb = (int) get_post_thumbnail_id( $post_id );
			if ( $thumb > 0 && ! in_array( $thumb, $ids, true ) ) {
				$ids[] = $thumb;
			}
		}
		$matched = array();
		foreach ( $ids as $id ) {
			$item = self::list_item( $id );
			if ( null === $item ) {
				continue;
			}
			if ( $missing_alt && '' !== $item['alt'] ) {
				continue;
			}
			$matched[] = $item;
		}
		return array(
			'total'   => count( $matched ),
			'page'    => $page,
			'perPage' => $per_page,
			'items'   => array_slice( $matched, ( $page - 1 ) * $per_page, $per_page ),
		);
	}

	/* ------------------------------------------------------------------ */
	/* media/sideload                                                     */
	/* ------------------------------------------------------------------ */

	public static function endpoint_sideload( array $params ) {
		if ( ! isset( $params['imageUrl'] ) ) {
			return PIB_Connector_Util::bad_request( 'imageUrl is required.' );
		}
		$opts = self::parse_image_options( $params );
		if ( is_wp_error( $opts ) ) {
			return $opts;
		}
		$res = self::sideload( $params['imageUrl'], $opts );
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$change_id = PIB_Connector_Log::record(
			'media/sideload',
			'media',
			array(
				'attachmentId' => $res['attachmentId'],
				'url'          => $res['url'],
			),
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			null,
			array(
				'attachmentId' => $res['attachmentId'],
				'reused'       => $res['reused'],
				'sourceUrl'    => $params['imageUrl'],
			)
		);
		return array(
			'changeId'     => $change_id,
			'attachmentId' => $res['attachmentId'],
			'url'          => $res['url'],
			'reused'       => $res['reused'],
		);
	}

	/* ------------------------------------------------------------------ */
	/* media/set-featured                                                 */
	/* ------------------------------------------------------------------ */

	public static function endpoint_set_featured( array $params ) {
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$post_id = isset( $params['postId'] ) ? PIB_Connector_Util::positive_int( $params['postId'] ) : null;
		if ( null === $post_id ) {
			return PIB_Connector_Util::bad_request( 'postId must be a positive integer.' );
		}
		$post = get_post( $post_id );
		if ( ! $post || 'attachment' === $post->post_type || in_array( $post->post_status, array( 'trash', 'auto-draft' ), true ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported_target', 'No post or page with that id.', 422 );
		}
		if ( function_exists( 'post_type_supports' ) && ! post_type_supports( $post->post_type, 'thumbnail' ) ) {
			return PIB_Connector_Util::error( 'pib_unsupported', 'That post type does not support a featured image.', 422 );
		}
		$has_id  = array_key_exists( 'attachmentId', $params ) && null !== $params['attachmentId'];
		$has_url = array_key_exists( 'imageUrl', $params ) && null !== $params['imageUrl'] && '' !== $params['imageUrl'];
		if ( $has_id === $has_url ) {
			return PIB_Connector_Util::bad_request( 'Send exactly one of attachmentId or imageUrl.' );
		}
		$opts = self::parse_image_options( array_diff_key( $params, array( 'postId' => 1 ) ) );
		if ( is_wp_error( $opts ) ) {
			return $opts;
		}
		$opts['postId'] = $post_id;

		$reused  = null;
		$alt_set = null;
		if ( $has_id ) {
			$att_id = PIB_Connector_Util::positive_int( $params['attachmentId'] );
			if ( null === $att_id || null === self::image_attachment( $att_id ) ) {
				return PIB_Connector_Util::bad_request( 'attachmentId must be an image in the Media Library.' );
			}
			if ( null !== $opts['alt'] ) {
				$cur = self::get_alt( $att_id );
				if ( $cur !== $opts['alt'] ) {
					self::set_alt( $att_id, $opts['alt'] );
					$alt_set = array( 'before' => $cur, 'after' => $opts['alt'] );
				}
			}
		} else {
			$res = self::sideload( $params['imageUrl'], $opts );
			if ( is_wp_error( $res ) ) {
				return $res;
			}
			$att_id  = $res['attachmentId'];
			$reused  = $res['reused'];
			$alt_set = $res['altSet'];
		}

		$before_id = (int) get_post_thumbnail_id( $post_id );
		set_post_thumbnail( $post_id, $att_id );
		if ( (int) get_post_thumbnail_id( $post_id ) !== $att_id ) {
			return PIB_Connector_Util::error( 'pib_media_failed', 'WordPress did not accept the featured image.', 502 );
		}
		$url    = (string) wp_get_attachment_url( $att_id );
		$before = array( 'attachmentId' => $before_id > 0 ? $before_id : null );
		$after  = array(
			'attachmentId' => $att_id,
			'url'          => $url,
		);
		$extra  = array();
		if ( null !== $alt_set ) {
			$extra['alt'] = array_merge( array( 'attachmentId' => $att_id ), $alt_set );
		}
		$target    = array(
			'postId' => $post_id,
			'type'   => 'post',
			'url'    => (string) get_permalink( $post ),
		);
		$change_id = PIB_Connector_Log::record( 'media/set-featured', 'media', $target, $reason, $before, $after, $extra );

		$out = array(
			'changeId' => $change_id,
			'postId'   => $post_id,
			'before'   => $before,
			'after'    => $after,
		);
		if ( null !== $reused ) {
			$out['reused'] = $reused;
		}
		return $out;
	}

	public static function undo_featured( array $entry ) {
		$target = $entry['target'];
		$after  = is_array( $entry['after'] ) ? $entry['after'] : array();
		$before = is_array( $entry['before'] ) ? $entry['before'] : array();
		if ( ! is_array( $target ) || empty( $target['postId'] ) || ! get_post( (int) $target['postId'] ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'The post no longer exists.', 422 );
		}
		$post_id = (int) $target['postId'];
		$now     = (int) get_post_thumbnail_id( $post_id );
		$prev    = isset( $before['attachmentId'] ) ? (int) $before['attachmentId'] : 0;
		if ( $prev > 0 ) {
			if ( null === self::image_attachment( $prev ) ) {
				return PIB_Connector_Util::error( 'pib_not_undoable', 'The previous featured image no longer exists.', 422 );
			}
			set_post_thumbnail( $post_id, $prev );
		} else {
			delete_post_thumbnail( $post_id );
		}
		if ( isset( $entry['alt'] ) && is_array( $entry['alt'] ) && isset( $entry['alt']['attachmentId'] ) ) {
			$aid = (int) $entry['alt']['attachmentId'];
			if ( null !== self::image_attachment( $aid ) && self::get_alt( $aid ) === (string) $entry['alt']['after'] ) {
				self::set_alt( $aid, (string) $entry['alt']['before'] );
			}
		}
		$restored = (int) get_post_thumbnail_id( $post_id );
		return array(
			$target,
			array( 'attachmentId' => $now > 0 ? $now : null ),
			array( 'attachmentId' => $restored > 0 ? $restored : null ),
			array(),
		);
	}

	/* ------------------------------------------------------------------ */
	/* media/alt                                                          */
	/* ------------------------------------------------------------------ */

	public static function endpoint_alt( array $params ) {
		$reason = PIB_Connector_Util::require_reason( $params );
		if ( is_wp_error( $reason ) ) {
			return $reason;
		}
		$items = isset( $params['items'] ) ? $params['items'] : null;
		if ( ! is_array( $items ) || empty( $items ) || count( $items ) > 50 || array_keys( $items ) !== range( 0, count( $items ) - 1 ) ) {
			return PIB_Connector_Util::bad_request( 'items must be a list of 1 to 50 { attachmentId, alt }.' );
		}
		$clean = array();
		$seen  = array();
		foreach ( $items as $i => $item ) {
			if ( ! is_array( $item ) || ! array_key_exists( 'attachmentId', $item ) || ! array_key_exists( 'alt', $item ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'items[%d] needs attachmentId and alt.', $i ) );
			}
			$id = PIB_Connector_Util::positive_int( $item['attachmentId'] );
			if ( null === $id || null === self::image_attachment( $id ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'items[%d].attachmentId is not an image in the Media Library.', $i ) );
			}
			if ( isset( $seen[ $id ] ) ) {
				return PIB_Connector_Util::bad_request( sprintf( 'items[%d]: attachment %d is listed twice.', $i, $id ) );
			}
			$seen[ $id ] = true;
			$alt         = self::clean_alt( $item['alt'], sprintf( 'items[%d].alt', $i ) );
			if ( is_wp_error( $alt ) ) {
				return $alt;
			}
			$clean[] = array( $id, $alt );
		}

		$updated = array();
		$b_list  = array();
		$a_list  = array();
		foreach ( $clean as $pair ) {
			list( $id, $alt ) = $pair;
			$was              = self::get_alt( $id );
			self::set_alt( $id, $alt );
			$updated[] = array(
				'attachmentId' => $id,
				'before'       => $was,
				'after'        => $alt,
			);
			$b_list[]  = array( 'attachmentId' => $id, 'alt' => $was );
			$a_list[]  = array( 'attachmentId' => $id, 'alt' => $alt );
		}
		$change_id = PIB_Connector_Log::record(
			'media/alt',
			'media',
			array( 'attachmentIds' => array_keys( $seen ) ),
			$reason,
			array( 'items' => $b_list ),
			array( 'items' => $a_list )
		);
		return array(
			'changeId' => $change_id,
			'updated'  => $updated,
		);
	}

	public static function undo_alt( array $entry ) {
		$before = isset( $entry['before']['items'] ) && is_array( $entry['before']['items'] ) ? $entry['before']['items'] : array();
		$now    = array();
		$back   = array();
		foreach ( $before as $item ) {
			if ( ! is_array( $item ) || ! isset( $item['attachmentId'] ) ) {
				continue;
			}
			$id = (int) $item['attachmentId'];
			if ( null === self::image_attachment( $id ) ) {
				continue;
			}
			$now[]  = array( 'attachmentId' => $id, 'alt' => self::get_alt( $id ) );
			self::set_alt( $id, isset( $item['alt'] ) ? (string) $item['alt'] : '' );
			$back[] = array( 'attachmentId' => $id, 'alt' => self::get_alt( $id ) );
		}
		return array(
			$entry['target'],
			array( 'items' => $now ),
			array( 'items' => $back ),
			array(),
		);
	}
}
