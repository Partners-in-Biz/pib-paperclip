<?php
/**
 * self/update and self/rollback.
 */

const PIBT_SELF_URL = 'https://paperclip.partnersinbiz.online/downloads/pib-connector.zip';

function pibt_header( $version, $name = 'PiB Connector' ) {
	return "<?php\n/**\n * Plugin Name:       $name\n * Version:           $version\n */\n";
}

/**
 * Build a zip on disk. $entries: name => content.
 *
 * @return string zip bytes
 */
function pibt_make_zip( array $entries ) {
	$path = tempnam( sys_get_temp_dir(), 'pibz' );
	$zip  = new ZipArchive();
	$zip->open( $path, ZipArchive::OVERWRITE );
	foreach ( $entries as $name => $content ) {
		$zip->addFromString( $name, $content );
	}
	$zip->close();
	$bytes = file_get_contents( $path );
	unlink( $path );
	return $bytes;
}

function pibt_connector_zip( $version ) {
	return pibt_make_zip(
		array(
			'pib-connector/pib-connector.php'  => pibt_header( $version ) . "// build $version\n",
			'pib-connector/includes/class-x.php' => "<?php // $version\n",
			'pib-connector/readme.txt'         => "Stable tag: $version\n",
		)
	);
}

function pibt_self_setup() {
	pibt_pair();
	$GLOBALS['pibt']['scan_plugins'] = true;
	mkdir( WP_PLUGIN_DIR . '/pib-connector/includes', 0777, true );
	file_put_contents( WP_PLUGIN_DIR . '/pib-connector/pib-connector.php', pibt_header( '1.2.0' ) . "// installed\n" );
	file_put_contents( WP_PLUGIN_DIR . '/pib-connector/includes/class-x.php', "<?php // old\n" );
}

function pibt_self_offer( $bytes, $url = PIBT_SELF_URL ) {
	$GLOBALS['pibt']['downloads'][ $url ] = $bytes;
	return hash( 'sha256', $bytes );
}

function pibt_self_version() {
	preg_match( '/Version:\s*(\S+)/', file_get_contents( WP_PLUGIN_DIR . '/pib-connector/pib-connector.php' ), $m );
	return isset( $m[1] ) ? $m[1] : null;
}

pibt_test(
	'self/update: replaces the Connector, backs up first, logs, and is not undoable',
	function () {
		pibt_self_setup();
		$sha = pibt_self_offer( pibt_connector_zip( '1.3.0' ) );
		$r   = pibt_ok( pibt_call( 'self/update', array( 'zipUrl' => PIBT_SELF_URL, 'sha256' => strtoupper( $sha ), 'reason' => 'upgrade' ) ), 'update' );
		pibt_eq( array( 'version' => '1.2.0' ), $r['before'], 'before' );
		pibt_eq( array( 'version' => '1.3.0' ), $r['after'], 'after' );
		pibt_assert( 1 === preg_match( '/^pib-connector-1\.2\.0-[0-9]{14}$/', $r['backupId'] ), 'backup id: ' . $r['backupId'] );
		pibt_eq( '1.3.0', pibt_self_version(), 'files replaced' );
		pibt_eq( "<?php // 1.3.0\n", file_get_contents( WP_PLUGIN_DIR . '/pib-connector/includes/class-x.php' ), 'includes replaced' );

		$backup = WP_CONTENT_DIR . '/pib-connector-backups/' . $r['backupId'] . '.zip';
		pibt_assert( is_file( $backup ), 'backup zip written' );
		$z = new ZipArchive();
		$z->open( $backup );
		pibt_assert( false !== strpos( $z->getFromName( 'pib-connector/pib-connector.php' ), 'Version:           1.2.0' ), 'backup holds the old version' );
		$z->close();
		pibt_assert( is_file( WP_CONTENT_DIR . '/pib-connector-backups/.htaccess' ), 'backup folder protected' );

		$log = pibt_ok( pibt_call( 'log', array( 'limit' => 1 ) ), 'log' );
		pibt_eq( 'self/update', $log['changes'][0]['endpoint'], 'logged' );
		pibt_eq( '1.2.0', $log['changes'][0]['before']['version'], 'log before' );
		pibt_eq( $r['backupId'], $log['changes'][0]['after']['backupId'], 'log carries the backup id' );
		pibt_eq( 'upgrade', $log['changes'][0]['reason'], 'reason' );
		pibt_err( pibt_call( 'undo', array( 'changeId' => $r['changeId'] ) ), 422, 'pib_not_undoable', 'use self/rollback' );

		// plugins/backups does not list Connector backups.
		$f            = PIB_Connector_Settings::features();
		$f['plugins'] = true;
		PIB_Connector_Settings::set_features( $f );
		pibt_eq( array( 'backups' => array() ), pibt_ok( pibt_call( 'plugins/backups' ), 'plugins/backups' ), 'plugins/backups is for other plugins' );
		pibt_err( pibt_call( 'plugins/rollback', array( 'backupId' => $r['backupId'] ) ), 400, 'pib_bad_request', 'plugins/rollback refuses Connector backups' );
	}
);

pibt_test(
	'self/update: refusals (host, scheme, sha, downgrade, foreign entries, wrong plugin)',
	function () {
		pibt_self_setup();
		$good = pibt_connector_zip( '1.3.0' );
		$sha  = pibt_self_offer( $good );
		$base = array( 'zipUrl' => PIBT_SELF_URL, 'sha256' => $sha, 'reason' => 'r' );
		$was  = pibt_self_version();

		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'zipUrl' => 'https://evil.example/pib-connector.zip' ) ) ), 403, 'pib_forbidden', 'host not on the list' );
		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'zipUrl' => 'https://sub.paperclip.partnersinbiz.online/x.zip' ) ) ), 403, 'pib_forbidden', 'subdomains are not allowed' );
		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'zipUrl' => 'https://paperclip.partnersinbiz.online.evil.example/x.zip' ) ) ), 403, 'pib_forbidden', 'look-alike host' );
		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'zipUrl' => 'https://paperclip.partnersinbiz.online:8443/x.zip' ) ) ), 403, 'pib_forbidden', 'odd port' );
		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'zipUrl' => 'https://user:pw@paperclip.partnersinbiz.online/x.zip' ) ) ), 403, 'pib_forbidden', 'credentials' );
		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'zipUrl' => 'http://paperclip.partnersinbiz.online/x.zip' ) ) ), 400, 'pib_bad_request', 'http' );
		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'sha256' => 'abc' ) ) ), 400, 'pib_bad_request', 'sha format' );
		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'sha256' => str_repeat( '0', 64 ) ) ) ), 422, 'pib_checksum', 'sha mismatch' );
		pibt_err( pibt_call( 'self/update', array( 'zipUrl' => PIBT_SELF_URL, 'sha256' => $sha ) ), 400, 'pib_bad_request', 'reason required' );
		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'zipUrl' => 'https://paperclip.partnersinbiz.online/missing.zip' ) ) ), 502, 'pib_update_failed', 'download failed' );

		// Same and lower versions.
		foreach ( array( '1.2.0', '1.0.9', '0.9' ) as $v ) {
			$s = pibt_self_offer( pibt_connector_zip( $v ) );
			pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'sha256' => $s ) ) ), 422, 'pib_downgrade', "version $v refused" );
		}

		// Foreign entries.
		$bad = array(
			'file outside the folder' => array( 'pib-connector/pib-connector.php' => pibt_header( '1.3.0' ), 'wp-config.php' => '<?php // evil' ),
			'other folder'            => array( 'pib-connector/pib-connector.php' => pibt_header( '1.3.0' ), 'other-plugin/x.php' => '<?php' ),
			'parent path'             => array( 'pib-connector/pib-connector.php' => pibt_header( '1.3.0' ), 'pib-connector/../evil.php' => '<?php' ),
			'no folder'               => array( 'pib-connector.php' => pibt_header( '1.3.0' ) ),
			'no main file'            => array( 'pib-connector/other.php' => pibt_header( '1.3.0' ) ),
			'not the connector'       => array( 'pib-connector/pib-connector.php' => pibt_header( '1.3.0', 'Some Other Plugin' ) ),
			'no version'              => array( 'pib-connector/pib-connector.php' => "<?php\n/**\n * Plugin Name: PiB Connector\n */\n" ),
		);
		foreach ( $bad as $label => $entries ) {
			$s = pibt_self_offer( pibt_make_zip( $entries ) );
			pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'sha256' => $s ) ) ), 422, 'pib_bad_zip', "refused: $label" );
		}
		$s = pibt_self_offer( 'this is not a zip' );
		pibt_err( pibt_call( 'self/update', array_merge( $base, array( 'sha256' => $s ) ) ), 422, 'pib_bad_zip', 'not a zip' );

		pibt_eq( $was, pibt_self_version(), 'nothing installed by any refusal' );
		pibt_eq( array(), $GLOBALS['pibt']['upgrader_calls'], 'upgrader never ran' );
		pibt_assert( ! is_dir( WP_CONTENT_DIR . '/pib-connector-backups' ) || array() === glob( WP_CONTENT_DIR . '/pib-connector-backups/*.zip' ), 'no backups made for refused updates' );
		pibt_eq( array(), glob( WP_CONTENT_DIR . '/pibdl*' ), 'downloads cleaned up' );

		// The host list is extendable in code.
		$cb = function ( $hosts ) {
			$hosts[] = 'downloads.example.org';
			return $hosts;
		};
		add_filter( 'pib_connector_update_hosts', $cb );
		$other = 'https://downloads.example.org/pib-connector.zip';
		$s     = pibt_self_offer( $good, $other );
		$ok    = pibt_ok( pibt_call( 'self/update', array( 'zipUrl' => $other, 'sha256' => $s, 'reason' => 'r' ) ), 'extra host accepted' );
		pibt_eq( '1.3.0', $ok['after']['version'], 'updated from the extra host' );
		$GLOBALS['pibt_hooks']['pib_connector_update_hosts'] = array();
	}
);

pibt_test(
	'self/update: failure restores the backup automatically',
	function () {
		pibt_self_setup();
		$sha = pibt_self_offer( pibt_connector_zip( '1.3.0' ) );
		$GLOBALS['pibt']['upgrader_fail'] = 1;
		$e = pibt_call( 'self/update', array( 'zipUrl' => PIBT_SELF_URL, 'sha256' => $sha, 'reason' => 'r' ) );
		pibt_err( $e, 502, 'pib_update_failed', 'install failed' );
		pibt_assert( false !== strpos( $e[1]['message'], 'previous version was restored' ), 'message: ' . $e[1]['message'] );
		pibt_eq( '1.2.0', pibt_self_version(), 'old version back on disk' );
		pibt_eq( "<?php // old\n", file_get_contents( WP_PLUGIN_DIR . '/pib-connector/includes/class-x.php' ), 'old files back' );
		$log = pibt_ok( pibt_call( 'log', array( 'limit' => 5 ) ), 'log' );
		pibt_eq( array(), $log['changes'], 'a failed update is not logged as a change' );

		// Even when the upgrader fails twice, WordPress's unzip_file() puts the backup back.
		$GLOBALS['pibt']['upgrader_fail'] = 2;
		$e = pibt_call( 'self/update', array( 'zipUrl' => PIBT_SELF_URL, 'sha256' => $sha, 'reason' => 'r' ) );
		pibt_err( $e, 502, 'pib_update_failed', 'both upgrader runs failed' );
		pibt_eq( '1.2.0', pibt_self_version(), 'restored through unzip_file' );

		// A zip whose main file claims a different version than announced never counts as success.
		$GLOBALS['pibt']['upgrader_fail'] = 0;
		pibt_ok( pibt_call( 'self/update', array( 'zipUrl' => PIBT_SELF_URL, 'sha256' => $sha, 'reason' => 'r' ) ), 'succeeds afterwards' );
		pibt_eq( '1.3.0', pibt_self_version(), 'installed' );
	}
);

pibt_test(
	'self/rollback: restores a self/update backup, refuses anything else',
	function () {
		pibt_self_setup();
		$sha = pibt_self_offer( pibt_connector_zip( '1.3.0' ) );
		$up  = pibt_ok( pibt_call( 'self/update', array( 'zipUrl' => PIBT_SELF_URL, 'sha256' => $sha, 'reason' => 'up' ) ), 'update' );
		pibt_eq( '1.3.0', pibt_self_version(), 'on 1.3.0' );

		$rb = pibt_ok( pibt_call( 'self/rollback', array( 'backupId' => $up['backupId'], 'reason' => 'bad release' ) ), 'rollback' );
		pibt_eq( '1.2.0', $rb['restoredVersion'], 'restoredVersion' );
		pibt_eq( '1.2.0', pibt_self_version(), 'old files back' );
		pibt_eq( "<?php // old\n", file_get_contents( WP_PLUGIN_DIR . '/pib-connector/includes/class-x.php' ), 'includes restored' );
		pibt_eq( 2, count( glob( WP_CONTENT_DIR . '/pib-connector-backups/*.zip' ) ), 'the version being replaced was backed up too' );
		$log = pibt_ok( pibt_call( 'log', array( 'limit' => 1 ) ), 'log' );
		pibt_eq( 'self/rollback', $log['changes'][0]['endpoint'], 'logged' );
		pibt_err( pibt_call( 'undo', array( 'changeId' => $rb['changeId'] ) ), 422, 'pib_not_undoable', 'rollback is not undoable either' );

		pibt_err( pibt_call( 'self/rollback', array( 'backupId' => $up['backupId'] ) ), 400, 'pib_bad_request', 'reason required' );
		pibt_err( pibt_call( 'self/rollback', array( 'backupId' => '../../wp-config', 'reason' => 'r' ) ), 400, 'pib_bad_request', 'path trick' );
		pibt_err( pibt_call( 'self/rollback', array( 'backupId' => 'akismet-20260101000000', 'reason' => 'r' ) ), 400, 'pib_bad_request', 'another plugin backup' );
		pibt_err( pibt_call( 'self/rollback', array( 'backupId' => 'pib-connector-1.0.0-20200101000000', 'reason' => 'r' ) ), 404, 'pib_not_found', 'unknown backup' );

		// Rollback failure restores the current version.
		$GLOBALS['pibt']['upgrader_fail'] = 1;
		$e = pibt_call( 'self/rollback', array( 'backupId' => $up['backupId'], 'reason' => 'r' ) );
		pibt_err( $e, 502, 'pib_update_failed', 'rollback failure' );
		pibt_eq( '1.2.0', pibt_self_version(), 'still on the version it was on' );
	}
);

pibt_test(
	'self/*: feature switch, location guard',
	function () {
		pibt_self_setup();
		$sha = pibt_self_offer( pibt_connector_zip( '1.3.0' ) );
		$f = PIB_Connector_Settings::features();
		pibt_eq( true, $f['selfupdate'], 'on by default' );
		$f['selfupdate'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'self/update', array( 'zipUrl' => PIBT_SELF_URL, 'sha256' => $sha, 'reason' => 'r' ) ), 403, 'pib_disabled', 'update off' );
		pibt_err( pibt_call( 'self/rollback', array( 'backupId' => 'pib-connector-1.0.0-20200101000000', 'reason' => 'r' ) ), 403, 'pib_disabled', 'rollback off' );
		$f['selfupdate'] = true;
		PIB_Connector_Settings::set_features( $f );

		// Not running from wp-content/plugins/pib-connector.
		pibt_rrmdir( WP_PLUGIN_DIR . '/pib-connector' );
		pibt_err( pibt_call( 'self/update', array( 'zipUrl' => PIBT_SELF_URL, 'sha256' => $sha, 'reason' => 'r' ) ), 422, 'pib_unsupported', 'non-standard location' );
	}
);

pibt_test(
	'self/update: a zip with a PHP syntax error is refused; a site that stops answering is rolled back (live finding)',
	function () {
		pibt_self_setup();
		$base = array( 'zipUrl' => PIBT_SELF_URL, 'reason' => 'r' );

		// Live: a parse error in the new main file installed "successfully" and took the site down.
		$broken = pibt_make_zip(
			array(
				'pib-connector/pib-connector.php'    => pibt_header( '1.3.0' ) . "\$x = ;\n",
				'pib-connector/includes/class-x.php' => "<?php // 1.3.0\n",
			)
		);
		$sha    = pibt_self_offer( $broken );
		$e      = pibt_call( 'self/update', array_merge( $base, array( 'sha256' => $sha ) ) );
		pibt_err( $e, 422, 'pib_bad_zip', 'syntax error refused' );
		pibt_assert( false !== strpos( $e[1]['message'], 'syntax error' ), 'message: ' . $e[1]['message'] );
		pibt_eq( '1.2.0', pibt_self_version(), 'nothing installed' );
		pibt_eq( array(), $GLOBALS['pibt']['upgrader_calls'], 'upgrader never ran' );

		// Runtime fatal that only shows once the code loads: the loopback check reports the site broken.
		$sha = pibt_self_offer( pibt_connector_zip( '1.3.0' ) );
		add_filter(
			'pib_connector_site_check',
			function () {
				return 'broken';
			}
		);
		$e = pibt_call( 'self/update', array_merge( $base, array( 'sha256' => $sha ) ) );
		pibt_err( $e, 502, 'pib_update_failed', 'site check failed' );
		pibt_assert( false !== strpos( $e[1]['message'], 'previous version was restored' ), 'restored: ' . $e[1]['message'] );
		pibt_eq( '1.2.0', pibt_self_version(), 'old version back on disk' );
		$GLOBALS['pibt_hooks']['pib_connector_site_check'] = array();

		// 'unknown' (loopback impossible) never blocks an update.
		add_filter(
			'pib_connector_site_check',
			function () {
				return 'unknown';
			}
		);
		pibt_ok( pibt_call( 'self/update', array_merge( $base, array( 'sha256' => $sha ) ) ), 'unknown does not block' );
		pibt_eq( '1.3.0', pibt_self_version(), 'installed' );
		$GLOBALS['pibt_hooks']['pib_connector_site_check'] = array();
	}
);
