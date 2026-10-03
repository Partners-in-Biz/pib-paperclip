<?php
/**
 * seo/list: pages and posts with their SEO fields and what is missing.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_SEO_List {

	const SCAN_MAX = 2000; // Upper bound when `missing` needs a post-query filter.

	public static function endpoint_list( array $params ) {
		$type = 'page';
		if ( array_key_exists( 'postType', $params ) && null !== $params['postType'] ) {
			if ( ! is_string( $params['postType'] ) || ! preg_match( '/^[a-z0-9_-]{1,20}$/', $params['postType'] ) ) {
				return PIB_Connector_Util::bad_request( 'postType must be a post type name.' );
			}
			$type = $params['postType'];
		}
		if ( ! post_type_exists( $type ) || ! is_post_type_viewable( $type ) ) {
			return PIB_Connector_Util::bad_request( 'postType is not a public post type.' );
		}

		$status = 'publish';
		if ( array_key_exists( 'status', $params ) && null !== $params['status'] ) {
			if ( ! is_string( $params['status'] ) || ! in_array( $params['status'], array( 'publish', 'draft', 'pending', 'private', 'future', 'any' ), true ) ) {
				return PIB_Connector_Util::bad_request( 'status must be publish, draft, pending, private, future or any.' );
			}
			$status = $params['status'];
		}

		$search = PIB_Connector_Util::optional_string( $params, 'search', 200 );
		if ( is_wp_error( $search ) ) {
			return $search;
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

		$missing_filter = array();
		if ( array_key_exists( 'missing', $params ) && null !== $params['missing'] ) {
			if ( ! is_array( $params['missing'] ) || empty( $params['missing'] ) || count( $params['missing'] ) > 3 ) {
				return PIB_Connector_Util::bad_request( 'missing must be a list of title, description or ogImage.' );
			}
			foreach ( $params['missing'] as $m ) {
				if ( ! is_string( $m ) || ! in_array( $m, array( 'title', 'description', 'ogImage' ), true ) ) {
					return PIB_Connector_Util::bad_request( 'missing may only contain title, description or ogImage.' );
				}
				$missing_filter[] = $m;
			}
		}

		$args = array(
			'post_type'           => $type,
			'post_status'         => $status,
			'orderby'             => 'modified',
			'order'               => 'DESC',
			'fields'              => 'ids',
			'ignore_sticky_posts' => true,
		);
		if ( null !== $search ) {
			$args['s'] = $search;
		}

		if ( empty( $missing_filter ) ) {
			$args['posts_per_page'] = $per_page;
			$args['paged']          = $page;
			$q                      = new WP_Query( $args );
			$items                  = array();
			foreach ( (array) $q->posts as $id ) {
				$item = self::build_item( (int) $id );
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

		$args['posts_per_page'] = self::SCAN_MAX;
		$args['paged']          = 1;
		$q                      = new WP_Query( $args );
		$matched                = array();
		foreach ( (array) $q->posts as $id ) {
			$item = self::build_item( (int) $id );
			if ( null !== $item && count( array_intersect( $item['missing'], $missing_filter ) ) > 0 ) {
				$matched[] = $item;
			}
		}
		return array(
			'total'   => count( $matched ),
			'page'    => $page,
			'perPage' => $per_page,
			'items'   => array_slice( $matched, ( $page - 1 ) * $per_page, $per_page ),
		);
	}

	/**
	 * @return array|null
	 */
	private static function build_item( $id ) {
		$post = get_post( $id );
		if ( ! $post || ! is_object( $post ) ) {
			return null;
		}
		$target = array(
			'postId'   => (int) $post->ID,
			'type'     => 'post',
			'url'      => (string) get_permalink( $post ),
			'postType' => (string) $post->post_type,
			'title'    => (string) get_the_title( $post ),
		);
		$fields = PIB_Connector_SEO::get_fields( $target );
		$thumb  = (int) get_post_thumbnail_id( $post->ID );

		// Effective state. The plugin's title template always yields a title, but only an override
		// is a written title; the page title alone is not a description; a featured image is an
		// og:image fallback.
		$missing = array();
		if ( null === $fields['title'] ) {
			$missing[] = 'title';
		}
		if ( null === $fields['description'] && '' === trim( (string) ( isset( $post->post_excerpt ) ? $post->post_excerpt : '' ) ) ) {
			$missing[] = 'description';
		}
		if ( null === $fields['ogImage'] && $thumb <= 0 ) {
			$missing[] = 'ogImage';
		}

		$modified = ( isset( $post->post_modified_gmt ) && is_string( $post->post_modified_gmt ) && '' !== $post->post_modified_gmt && 0 !== strpos( $post->post_modified_gmt, '0000' ) )
			? gmdate( 'Y-m-d\TH:i:s\Z', strtotime( $post->post_modified_gmt . ' UTC' ) )
			: null;

		return array(
			'postId'          => $target['postId'],
			'url'             => $target['url'],
			'postType'        => $target['postType'],
			'title'           => $target['title'],
			'slug'            => isset( $post->post_name ) ? (string) $post->post_name : '',
			'status'          => (string) $post->post_status,
			'modified'        => $modified,
			'featuredImageId' => $thumb > 0 ? $thumb : null,
			'fields'          => $fields,
			'missing'         => $missing,
		);
	}
}
