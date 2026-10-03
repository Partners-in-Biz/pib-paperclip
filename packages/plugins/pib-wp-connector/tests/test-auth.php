<?php
/**
 * Signature, pairing, key file and feature switches.
 */

// Fixed vector, produced by tests/sign.mjs with node:crypto (the TypeScript side uses the same).
const PIBT_VECTOR = array(
	'key'      => 'pibc_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
	'keyId'    => 'ff6dfdf7cd7d',
	'ts'       => '1767225600',
	'nonce'    => '0123456789abcdef0123456789abcdef',
	'route'    => '/pib-connector/v1/seo/get',
	'body'     => '{"url":"/about/"}',
	'bodyHash' => 'e08de92cef1c88fbb5768b4075a9c9c62cc10ee543ab1f23b81f2ed974a4131f',
	'sig'      => '55fae793f35512198dec6aaf9cefe0f85f84df3295739891c2ac8c7b374fc723',
);

pibt_test(
	'signer matches the fixed node:crypto vector',
	function () {
		$v = PIBT_VECTOR;
		pibt_eq( $v['keyId'], PIB_Connector_Settings::key_id( $v['key'] ), 'key id' );
		pibt_eq( $v['bodyHash'], hash( 'sha256', $v['body'] ), 'body hash' );
		pibt_eq(
			$v['ts'] . "\n" . $v['nonce'] . "\nPOST\n" . $v['route'] . "\n" . $v['bodyHash'],
			PIB_Connector_Auth::string_to_sign( $v['ts'], $v['nonce'], $v['route'], $v['body'] ),
			'string to sign'
		);
		pibt_eq( $v['sig'], PIB_Connector_Auth::sign( $v['key'], $v['ts'], $v['nonce'], $v['route'], $v['body'] ), 'signature' );
	}
);

pibt_test(
	'good signature → ping ok',
	function () {
		pibt_pair();
		$data = pibt_ok( pibt_call( 'ping' ), 'ping' );
		pibt_eq( '1.2.0', $data['connector']['version'], 'version' );
		pibt_eq( 'ff6dfdf7cd7d', $data['keyId'], 'keyId' );
		pibt_eq( 'Hunt and Gun', $data['site']['name'], 'site name' );
	}
);

pibt_test(
	'not paired → 401 pib_not_paired',
	function () {
		pibt_err( pibt_call( 'ping' ), 401, 'pib_not_paired', 'no key' );
		update_option( 'pib_connector_key', 'garbage' );
		pibt_err( pibt_call( 'ping' ), 401, 'pib_not_paired', 'invalid stored key' );
	}
);

pibt_test(
	'bad signature → 401 pib_bad_signature',
	function () {
		pibt_pair();
		pibt_err( pibt_call( 'ping', array(), array( 'sig' => str_repeat( 'a', 64 ) ) ), 401, 'pib_bad_signature', 'wrong sig' );
		pibt_err( pibt_call( 'ping', array(), array( 'sig' => 'nothex' ) ), 401, 'pib_bad_signature', 'malformed sig' );
		$other = 'pibc_' . str_repeat( 'B', 43 );
		pibt_err( pibt_call( 'ping', array(), array( 'key' => $other, 'key_id' => substr( hash( 'sha256', PIBT_KEY ), 0, 12 ) ) ), 401, 'pib_bad_signature', 'signed with another key' );
		pibt_err( pibt_call( 'ping', array(), array( 'sign_route' => '/pib-connector/v1/health' ) ), 401, 'pib_bad_signature', 'signed for another route' );
		pibt_err( pibt_call( 'ping', array(), array( 'nonce' => 'short' ) ), 401, 'pib_bad_signature', 'malformed nonce' );
	}
);

pibt_test(
	'tampered body → 401 pib_bad_signature',
	function () {
		pibt_pair();
		$route = '/pib-connector/v1/ping';
		$ts    = (string) time();
		$nonce = bin2hex( random_bytes( 16 ) );
		$sig   = PIB_Connector_Auth::sign( PIBT_KEY, $ts, $nonce, $route, '{}' );
		pibt_err( pibt_call( 'ping', array(), array( 'body' => '{"x":1}', 'sig' => $sig, 'ts' => $ts, 'nonce' => $nonce ) ), 401, 'pib_bad_signature', 'body changed after signing' );
	}
);

pibt_test(
	'wrong key id → 401 pib_bad_signature',
	function () {
		pibt_pair();
		pibt_err( pibt_call( 'ping', array(), array( 'key_id' => '000000000000' ) ), 401, 'pib_bad_signature', 'key id' );
	}
);

pibt_test(
	'stale timestamp → 401 pib_stale',
	function () {
		pibt_pair();
		pibt_err( pibt_call( 'ping', array(), array( 'ts' => time() - 301 ) ), 401, 'pib_stale', 'too old' );
		pibt_err( pibt_call( 'ping', array(), array( 'ts' => time() + 400 ) ), 401, 'pib_stale', 'too far ahead' );
		pibt_ok( pibt_call( 'ping', array(), array( 'ts' => time() - 250 ) ), 'within 300 s' );
	}
);

pibt_test(
	'replayed nonce → 401 pib_replay',
	function () {
		pibt_pair();
		$nonce = bin2hex( random_bytes( 16 ) );
		pibt_ok( pibt_call( 'ping', array(), array( 'nonce' => $nonce ) ), 'first use' );
		pibt_err( pibt_call( 'ping', array(), array( 'nonce' => $nonce ) ), 401, 'pib_replay', 'second use' );
		pibt_assert( isset( $GLOBALS['pibt']['transients'][ 'pib_cn_' . $nonce ] ), 'nonce stored as transient' );
	}
);

pibt_test(
	'key file pairs the site when no option is set; option wins',
	function () {
		$file = WP_CONTENT_DIR . '/pib-connector-key.php';
		file_put_contents( $file, "<?php echo 'LEAK'; return '" . PIBT_KEY . "';\n" );
		PIB_Connector_Settings::reset_file_cache();
		ob_start();
		$res    = pibt_call( 'ping' );
		$output = ob_get_clean();
		pibt_ok( $res, 'ping via key file' );
		pibt_eq( '', $output, 'key file output is never echoed' );
		pibt_eq( 'file', PIB_Connector_Settings::key_source(), 'source = file' );

		$other = 'pibc_' . str_repeat( 'C', 43 );
		update_option( 'pib_connector_key', $other );
		pibt_eq( 'settings', PIB_Connector_Settings::key_source(), 'source = settings' );
		pibt_err( pibt_call( 'ping' ), 401, 'pib_bad_signature', 'file key no longer accepted once a settings key exists' );
		pibt_ok( pibt_call( 'ping', array(), array( 'key' => $other ) ), 'settings key accepted' );

		delete_option( 'pib_connector_key' );
		file_put_contents( $file, "<?php return 'not-a-key';\n" );
		PIB_Connector_Settings::reset_file_cache();
		pibt_err( pibt_call( 'ping' ), 401, 'pib_not_paired', 'invalid key file' );
		pibt_eq( null, PIB_Connector_Settings::key_source(), 'no source' );
	}
);

pibt_test(
	'feature switched off → 403 pib_disabled; plugins off by default',
	function () {
		pibt_pair();
		pibt_add_post( 10, 'about' );
		pibt_ok( pibt_call( 'seo/get', array( 'postId' => 10 ) ), 'seo on by default' );
		pibt_err( pibt_call( 'plugins/list' ), 403, 'pib_disabled', 'plugins default off' );

		$f        = PIB_Connector_Settings::features();
		$f['seo'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'seo/get', array( 'postId' => 10 ) ), 403, 'pib_disabled', 'seo off' );
		pibt_ok( pibt_call( 'ping' ), 'ping always available' );
		pibt_ok( pibt_call( 'health' ), 'health always available' );
		pibt_ok( pibt_call( 'log' ), 'log always available' );

		pibt_err( pibt_call( 'seo/get', array( 'postId' => 10 ), array( 'key_id' => '000000000000' ) ), 401, 'pib_bad_signature', 'auth is checked before the feature switch' );

		$f['plugins'] = true;
		PIB_Connector_Settings::set_features( $f );
		$data = pibt_ok( pibt_call( 'plugins/list' ), 'plugins on' );
		pibt_eq( 'pib-connector', $data['plugins'][0]['slug'], 'plugin slug' );
	}
);

pibt_test(
	'body must be a JSON object',
	function () {
		pibt_pair();
		pibt_err( pibt_call( 'ping', array(), array( 'body' => '[1,2]' ) ), 400, 'pib_bad_request', 'array body' );
		pibt_err( pibt_call( 'ping', array(), array( 'body' => 'nope' ) ), 400, 'pib_bad_request', 'non-JSON body' );
	}
);

pibt_test(
	'health shape',
	function () {
		pibt_pair();
		$d = pibt_ok( pibt_call( 'health' ), 'health' );
		pibt_eq( false, $d['connector']['features']['plugins'], 'plugins feature off' );
		pibt_eq( 'none', $d['seoPlugin']['key'], 'seo plugin' );
		pibt_eq( 'connector', $d['redirectsProvider'], 'redirects provider' );
		pibt_eq( true, $d['site']['blogPublic'], 'blogPublic' );
		pibt_eq( PHP_VERSION, $d['php']['version'], 'php version' );
		pibt_assert( is_array( $d['plugins'] ) && count( $d['plugins'] ) === 2, 'plugins list' );
		pibt_eq( '1.2.0', $d['connector']['version'], 'connector version' );
		pibt_eq( '1.2', $d['connector']['protocol'], 'protocol' );
		pibt_eq( array_keys( PIB_Connector_Router::endpoints() ), $d['connector']['endpoints'], 'endpoints list is the router map' );
		foreach ( array( 'ping', 'seo/list', 'media/list', 'media/sideload', 'media/set-featured', 'media/alt', 'posts/get', 'posts/images', 'posts/img-alt', 'posts/update', 'posts/create', 'posts/publish', 'self/update', 'self/rollback' ) as $ep ) {
			pibt_assert( in_array( $ep, $d['connector']['endpoints'], true ), "endpoint $ep listed" );
		}
		pibt_eq( true, $d['connector']['features']['media'], 'media default on' );
		pibt_eq( true, $d['connector']['features']['content'], 'content default on' );
		pibt_eq( true, $d['connector']['features']['selfupdate'], 'selfupdate default on' );
		pibt_assert( array_key_exists( 'woocommerce', $d ) && array_key_exists( 'active', $d['woocommerce'] ) && array_key_exists( 'shopPageId', $d['woocommerce'] ), 'woocommerce block' );
	}
);
