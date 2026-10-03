<?php
/**
 * Plugin Name:       PiB Connector
 * Plugin URI:        https://partnersinbiz.online
 * Description:       Lets Partners in Biz (Paperclip CRM) make a short, fixed list of signed SEO and maintenance changes on this site. Every change is logged and can be undone.
 * Version:           1.2.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Partners in Biz
 * Author URI:        https://partnersinbiz.online
 * License:           GPL-2.0-or-later
 * Text Domain:       pib-connector
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// Loaded already (e.g. by the must-use loader and again as a normal plugin).
if ( defined( 'PIB_CONNECTOR_VERSION' ) ) {
	return;
}

// Nothing here depends on activation hooks: option defaults are applied lazily,
// so the plugin also works when loaded from wp-content/mu-plugins by
// mu-loader/pib-connector-loader.php.
define( 'PIB_CONNECTOR_VERSION', '1.2.0' );
define( 'PIB_CONNECTOR_FILE', __FILE__ );
define( 'PIB_CONNECTOR_DIR', __DIR__ );

require_once PIB_CONNECTOR_DIR . '/includes/class-pib-util.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-settings.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-auth.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-log.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-target.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-seo.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-seo-list.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-schema.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-redirects.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-robots.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-sitemap.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-verify.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-plugins.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-media.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-content.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-selfupdate.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-health.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-undo.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-router.php';
require_once PIB_CONNECTOR_DIR . '/includes/class-pib-admin.php';

PIB_Connector_Router::init();
PIB_Connector_SEO::init();
PIB_Connector_Schema::init();
PIB_Connector_Redirects::init();
PIB_Connector_Robots::init();
PIB_Connector_Sitemap::init();
PIB_Connector_Verify::init();
PIB_Connector_Admin::init();
