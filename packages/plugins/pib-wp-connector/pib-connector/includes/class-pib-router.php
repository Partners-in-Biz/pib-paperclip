<?php
/**
 * REST routes under /pib-connector/v1/. Every route is POST, signed, and mapped to a feature.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Router {

	const NS       = 'pib-connector/v1';
	const MAX_BODY = 262144; // 256 KB.

	/**
	 * endpoint => [ feature|null, handler ]
	 */
	public static function endpoints() {
		return array(
			'ping'             => array( null, array( 'PIB_Connector_Health', 'endpoint_ping' ) ),
			'health'           => array( null, array( 'PIB_Connector_Health', 'endpoint_health' ) ),
			'log'              => array( null, array( 'PIB_Connector_Undo', 'endpoint_log' ) ),
			'undo'             => array( null, array( 'PIB_Connector_Undo', 'endpoint_undo' ) ),
			'seo/get'          => array( 'seo', array( 'PIB_Connector_SEO', 'endpoint_get' ) ),
			'seo/set'          => array( 'seo', array( 'PIB_Connector_SEO', 'endpoint_set' ) ),
			'seo/list'         => array( 'seo', array( 'PIB_Connector_SEO_List', 'endpoint_list' ) ),
			'schema/get'       => array( 'schema', array( 'PIB_Connector_Schema', 'endpoint_get' ) ),
			'schema/set'       => array( 'schema', array( 'PIB_Connector_Schema', 'endpoint_set' ) ),
			'redirects/list'   => array( 'redirects', array( 'PIB_Connector_Redirects', 'endpoint_list' ) ),
			'redirects/set'    => array( 'redirects', array( 'PIB_Connector_Redirects', 'endpoint_set' ) ),
			'redirects/delete' => array( 'redirects', array( 'PIB_Connector_Redirects', 'endpoint_delete' ) ),
			'robots/get'       => array( 'robots', array( 'PIB_Connector_Robots', 'endpoint_get' ) ),
			'robots/set'       => array( 'robots', array( 'PIB_Connector_Robots', 'endpoint_set' ) ),
			'sitemap/get'      => array( 'sitemap', array( 'PIB_Connector_Sitemap', 'endpoint_get' ) ),
			'sitemap/set'      => array( 'sitemap', array( 'PIB_Connector_Sitemap', 'endpoint_set' ) ),
			'plugins/list'     => array( 'plugins', array( 'PIB_Connector_Plugins', 'endpoint_list' ) ),
			'plugins/backups'  => array( 'plugins', array( 'PIB_Connector_Plugins', 'endpoint_backups' ) ),
			'plugins/install'  => array( 'plugins', array( 'PIB_Connector_Plugins', 'endpoint_install' ) ),
			'plugins/rollback' => array( 'plugins', array( 'PIB_Connector_Plugins', 'endpoint_rollback' ) ),
			'media/list'       => array( 'media', array( 'PIB_Connector_Media', 'endpoint_list' ) ),
			'media/sideload'   => array( 'media', array( 'PIB_Connector_Media', 'endpoint_sideload' ) ),
			'media/set-featured' => array( 'media', array( 'PIB_Connector_Media', 'endpoint_set_featured' ) ),
			'media/alt'        => array( 'media', array( 'PIB_Connector_Media', 'endpoint_alt' ) ),
			'posts/get'        => array( 'content', array( 'PIB_Connector_Content', 'endpoint_get' ) ),
			'posts/images'     => array( 'content', array( 'PIB_Connector_Content', 'endpoint_images' ) ),
			'posts/img-alt'    => array( 'content', array( 'PIB_Connector_Content', 'endpoint_img_alt' ) ),
			'posts/update'     => array( 'content', array( 'PIB_Connector_Content', 'endpoint_update' ) ),
			'posts/create'     => array( 'content', array( 'PIB_Connector_Content', 'endpoint_create' ) ),
			'posts/publish'    => array( 'content', array( 'PIB_Connector_Content', 'endpoint_publish' ) ),
			'verify/get'       => array( 'verify', array( 'PIB_Connector_Verify', 'endpoint_get' ) ),
			'verify/set'       => array( 'verify', array( 'PIB_Connector_Verify', 'endpoint_set' ) ),
			'self/update'      => array( 'selfupdate', array( 'PIB_Connector_SelfUpdate', 'endpoint_update' ) ),
			'self/rollback'    => array( 'selfupdate', array( 'PIB_Connector_SelfUpdate', 'endpoint_rollback' ) ),
		);
	}

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	public static function register_routes() {
		foreach ( self::endpoints() as $endpoint => $def ) {
			register_rest_route(
				self::NS,
				'/' . $endpoint,
				array(
					'methods'             => 'POST',
					'callback'            => function ( $request ) use ( $endpoint ) {
						return PIB_Connector_Router::handle( $endpoint, $request );
					},
					'permission_callback' => function ( $request ) use ( $endpoint ) {
						return PIB_Connector_Router::authorize( $endpoint, $request );
					},
				)
			);
		}
	}

	/**
	 * Signature first, then the feature switch.
	 *
	 * @return true|WP_Error
	 */
	public static function authorize( $endpoint, $request ) {
		$endpoints = self::endpoints();
		if ( ! isset( $endpoints[ $endpoint ] ) ) {
			return PIB_Connector_Util::error( 'pib_not_found', 'Unknown endpoint.', 404 );
		}
		if ( strlen( (string) $request->get_body() ) > self::MAX_BODY ) {
			return PIB_Connector_Util::error( 'pib_too_large', 'The request body is larger than 256 KB.', 413 );
		}
		$ok = PIB_Connector_Auth::verify( $request, $endpoint );
		if ( is_wp_error( $ok ) ) {
			return $ok;
		}
		$feature = $endpoints[ $endpoint ][0];
		if ( null !== $feature && ! PIB_Connector_Settings::feature_enabled( $feature ) ) {
			return PIB_Connector_Util::error( 'pib_disabled', sprintf( 'The %s feature is switched off in Settings → PiB Connector.', $feature ), 403 );
		}
		return true;
	}

	/**
	 * @return WP_REST_Response|WP_Error
	 */
	public static function handle( $endpoint, $request ) {
		$endpoints = self::endpoints();
		if ( ! isset( $endpoints[ $endpoint ] ) ) {
			return PIB_Connector_Util::error( 'pib_not_found', 'Unknown endpoint.', 404 );
		}

		$body = trim( (string) $request->get_body() );
		if ( '' === $body ) {
			$params = array();
		} else {
			$params = json_decode( $body, true, 64 );
			if ( ! is_array( $params ) || ( ! empty( $params ) && array_keys( $params ) === range( 0, count( $params ) - 1 ) ) ) {
				return PIB_Connector_Util::bad_request( 'The body must be a JSON object.' );
			}
		}

		PIB_Connector_Log::$actor = PIB_Connector_Auth::actor( $request );

		try {
			$data = call_user_func( $endpoints[ $endpoint ][1], $params );
		} catch ( \Throwable $e ) {
			if ( function_exists( 'error_log' ) ) {
				error_log( 'PiB Connector ' . $endpoint . ': ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			}
			return PIB_Connector_Util::error( 'pib_internal', 'The Connector hit an internal error. See the PHP error log.', 500 );
		}

		if ( is_wp_error( $data ) ) {
			return $data;
		}
		$response = rest_ensure_response(
			array(
				'ok'   => true,
				'data' => $data,
			)
		);
		if ( is_object( $response ) && method_exists( $response, 'header' ) ) {
			$response->header( 'Cache-Control', 'no-store' );
		}
		return $response;
	}
}
