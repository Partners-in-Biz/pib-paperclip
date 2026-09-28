<?php
/**
 * Uninstall: removes the key and the settings. Keeps the change log, plugin backups
 * and the site's SEO data (redirects, schema, robots lines) so nothing on the live
 * site silently changes and every past change stays visible.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'pib_connector_key' );
delete_option( 'pib_connector_settings' );
