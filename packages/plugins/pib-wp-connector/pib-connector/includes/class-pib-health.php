<?php
/**
 * ping and health.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Health {

	public static function endpoint_ping( array $params ) {
		$key = PIB_Connector_Settings::get_key();
		return array(
			'connector' => array( 'version' => PIB_CONNECTOR_VERSION ),
			'site'      => array(
				'url'  => home_url( '/' ),
				'name' => (string) get_bloginfo( 'name' ),
			),
			'keyId'     => null === $key ? null : PIB_Connector_Settings::key_id( $key ),
		);
	}

	public static function seo_plugin() {
		$key     = PIB_Connector_SEO::adapter();
		$version = null;
		$premium = false;
		if ( 'yoast' === $key ) {
			$version = defined( 'WPSEO_VERSION' ) ? WPSEO_VERSION : null;
			$premium = defined( 'WPSEO_PREMIUM_VERSION' ) || class_exists( 'WPSEO_Premium' );
		} elseif ( 'rankmath' === $key ) {
			$version = defined( 'RANK_MATH_VERSION' ) ? RANK_MATH_VERSION : null;
			$premium = defined( 'RANK_MATH_PRO_VERSION' );
		}
		return array(
			'key'     => $key,
			'version' => $version,
			'premium' => $premium,
		);
	}

	public static function woocommerce() {
		$active  = class_exists( 'WooCommerce' ) || function_exists( 'wc_get_page_id' );
		$shop_id = null;
		if ( $active && function_exists( 'wc_get_page_id' ) ) {
			$id      = (int) wc_get_page_id( 'shop' );
			$shop_id = $id > 0 ? $id : null;
		}
		return array(
			'active'     => $active,
			'version'    => ( $active && defined( 'WC_VERSION' ) ) ? (string) WC_VERSION : null,
			'shopPageId' => $shop_id,
		);
	}

	public static function endpoint_health( array $params ) {
		global $wp_version;

		if ( ! function_exists( 'get_plugins' ) && defined( 'ABSPATH' ) && file_exists( ABSPATH . 'wp-admin/includes/plugin.php' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}

		$plugins = array();
		if ( function_exists( 'get_plugins' ) ) {
			foreach ( get_plugins() as $file => $data ) {
				$plugins[] = array(
					'file'    => $file,
					'name'    => isset( $data['Name'] ) ? $data['Name'] : $file,
					'version' => isset( $data['Version'] ) ? $data['Version'] : '',
					'active'  => is_plugin_active( $file ),
					'mustUse' => false,
				);
			}
			if ( function_exists( 'get_mu_plugins' ) ) {
				foreach ( get_mu_plugins() as $file => $data ) {
					$plugins[] = array(
						'file'    => $file,
						'name'    => isset( $data['Name'] ) ? $data['Name'] : $file,
						'version' => isset( $data['Version'] ) ? $data['Version'] : '',
						'active'  => true,
						'mustUse' => true,
					);
				}
			}
		}

		$theme = function_exists( 'wp_get_theme' ) ? wp_get_theme() : null;
		$parent = ( $theme && $theme->parent() ) ? $theme->parent() : null;

		list( $sitemap_provider, $sitemap_url ) = PIB_Connector_Sitemap::provider();

		$core_update = null;
		$uc          = get_site_transient( 'update_core' );
		if ( is_object( $uc ) && ! empty( $uc->updates ) && is_array( $uc->updates ) ) {
			foreach ( $uc->updates as $u ) {
				if ( is_object( $u ) && isset( $u->response ) && 'upgrade' === $u->response && isset( $u->current ) ) {
					$core_update = (string) $u->current;
					break;
				}
			}
		}
		$up = get_site_transient( 'update_plugins' );
		$ut = get_site_transient( 'update_themes' );

		return array(
			'connector'         => array(
				'version'   => PIB_CONNECTOR_VERSION,
				'protocol'  => '1.2',
				'endpoints' => array_keys( PIB_Connector_Router::endpoints() ),
				'features'  => PIB_Connector_Settings::features(),
			),
			'wordpress'         => array(
				'version'   => isset( $wp_version ) ? (string) $wp_version : (string) get_bloginfo( 'version' ),
				'multisite' => function_exists( 'is_multisite' ) ? is_multisite() : false,
			),
			'php'               => array( 'version' => PHP_VERSION ),
			'site'              => array(
				'url'        => site_url( '/' ),
				'home'       => home_url( '/' ),
				'name'       => (string) get_bloginfo( 'name' ),
				'blogPublic' => PIB_Connector_Robots::blog_public(),
				'permalinks' => (string) get_option( 'permalink_structure' ),
				'language'   => function_exists( 'get_locale' ) ? get_locale() : null,
				'timezone'   => function_exists( 'wp_timezone_string' ) ? wp_timezone_string() : (string) get_option( 'timezone_string' ),
			),
			'theme'             => array(
				'name'    => $theme ? (string) $theme->get( 'Name' ) : null,
				'version' => $theme ? (string) $theme->get( 'Version' ) : null,
				'parent'  => $parent ? (string) $parent->get( 'Name' ) : null,
			),
			'seoPlugin'         => self::seo_plugin(),
			'woocommerce'       => self::woocommerce(),
			'sitemap'           => array(
				'provider' => $sitemap_provider,
				'url'      => $sitemap_url,
			),
			'redirectsProvider' => 'connector',
			'plugins'           => $plugins,
			'updates'           => array(
				'core'    => $core_update,
				'plugins' => ( is_object( $up ) && isset( $up->response ) && is_array( $up->response ) ) ? count( $up->response ) : 0,
				'themes'  => ( is_object( $ut ) && isset( $ut->response ) && is_array( $ut->response ) ) ? count( $ut->response ) : 0,
			),
		);
	}
}
