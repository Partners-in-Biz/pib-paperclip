<?php
/**
 * Plugin Name: PiB Connector (must-use loader)
 * Description: Loads the PiB Connector from wp-content/plugins/pib-connector/ without activation. Copy this file to wp-content/mu-plugins/ to use it; inside the plugin folder it does nothing.
 * Version:     1.0.0
 * Author:      Partners in Biz
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$pib_connector_main = ( defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR : WP_CONTENT_DIR . '/plugins' ) . '/pib-connector/pib-connector.php';
if ( ! defined( 'PIB_CONNECTOR_VERSION' ) && is_readable( $pib_connector_main ) ) {
	require_once $pib_connector_main;
}
unset( $pib_connector_main );
