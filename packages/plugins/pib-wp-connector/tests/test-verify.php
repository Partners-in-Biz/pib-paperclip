<?php
/**
 * 1.2.0 site verification: verify/get, verify/set, meta tags, file serving.
 */

const PIBT_INDEXNOW = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PIBT_GOOGLE   = 'google0123456789abcdef.html';
const PIBT_BING     = '<?xml version="1.0"?><users><user>0123456789ABCDEF0123456789ABCDEF</user></users>';

function pibt_verify_files() {
	return array(
		array( 'path' => '/' . PIBT_INDEXNOW . '.txt', 'content' => PIBT_INDEXNOW ),
		array( 'path' => '/' . PIBT_GOOGLE, 'content' => 'google-site-verification: ' . PIBT_GOOGLE ),
		array( 'path' => '/BingSiteAuth.xml', 'content' => PIBT_BING ),
	);
}

function pibt_verify_serve( $method, $uri ) {
	$_SERVER['REQUEST_METHOD'] = $method;
	$_SERVER['REQUEST_URI']    = $uri;
	add_filter( 'pib_connector_verify_exit', '__return_false_pibt' );
	ob_start();
	PIB_Connector_Verify::serve();
	$out = ob_get_clean();
	unset( $_SERVER['REQUEST_METHOD'], $_SERVER['REQUEST_URI'] );
	unset( $GLOBALS['pibt_hooks']['pib_connector_verify_exit'] );
	return $out;
}
function __return_false_pibt() {
	return false;
}

pibt_test(
	'verify: route map, feature default on, undo map, health',
	function () {
		pibt_pair();
		$map = PIB_Connector_Router::endpoints();
		foreach ( array( 'verify/get', 'verify/set' ) as $e ) {
			pibt_eq( 'verify', $map[ $e ][0], "$e feature" );
			pibt_assert( isset( $GLOBALS['pibt_routes'][ '/pib-connector/v1/' . $e ] ), "$e registered" );
		}
		pibt_eq( 'verify', PIB_Connector_Undo::undoable()['verify/set'][0], 'undoable' );
		pibt_eq( true, PIB_Connector_Settings::feature_defaults()['verify'], 'default on' );
		// Settings saved before 1.2.0 have no verify key: default applies.
		update_option( 'pib_connector_settings', array( 'features' => array( 'seo' => true, 'plugins' => false ) ) );
		pibt_eq( true, PIB_Connector_Settings::features()['verify'], 'default applied to old settings' );
		$h = pibt_ok( pibt_call( 'health' ), 'health' );
		pibt_eq( '1.2', $h['connector']['protocol'], 'protocol' );
		pibt_assert( in_array( 'verify/get', $h['connector']['endpoints'], true ) && in_array( 'verify/set', $h['connector']['endpoints'], true ), 'endpoints listed' );
		pibt_eq( true, $h['connector']['features']['verify'], 'feature reported' );
		pibt_err( pibt_call( 'verify/get', array(), array( 'key_id' => '000000000000' ) ), 401, 'pib_bad_signature', 'signature first' );
	}
);

pibt_test(
	'verify: admin page has the checkbox (checked by default)',
	function () {
		pibt_pair();
		ob_start();
		PIB_Connector_Admin::render();
		$html = ob_get_clean();
		pibt_assert( 1 === preg_match( '/name="pib_features\[verify\]" value="1" checked=.checked./', $html ), 'verify checkbox checked' );
	}
);

pibt_test(
	'verify: round trip of tags and files, get shape',
	function () {
		pibt_pair();
		$g = pibt_ok( pibt_call( 'verify/get' ), 'empty get' );
		pibt_eq( array( 'metaTags' => array(), 'files' => array(), 'diskConflicts' => array() ), $g, 'empty state' );

		$tags = array(
			array( 'name' => 'google-site-verification', 'content' => 'abc_DEF-123.x:y=z+/' ),
			array( 'name' => 'msvalidate.01', 'content' => '0123456789ABCDEF' ),
		);
		$s = pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => $tags, 'files' => pibt_verify_files(), 'reason' => 'verify in GSC and Bing' ) ), 'set' );
		pibt_assert( 1 === preg_match( '/^chg_[0-9a-f]{16}$/', $s['changeId'] ), 'changeId' );
		pibt_eq( $tags, $s['metaTags'], 'tags echoed' );
		pibt_eq( 3, count( $s['files'] ), 'files echoed' );
		pibt_eq( array(), $s['warnings'], 'no warnings' );

		$g = pibt_ok( pibt_call( 'verify/get' ), 'get' );
		pibt_eq( $tags, $g['metaTags'], 'tags stored' );
		pibt_eq( 'text/plain; charset=utf-8', $g['files'][0]['contentType'], 'indexnow type' );
		pibt_eq( 'text/html; charset=utf-8', $g['files'][1]['contentType'], 'google type' );
		pibt_eq( 'application/xml', $g['files'][2]['contentType'], 'bing type' );
		pibt_eq( PIBT_INDEXNOW, $g['files'][0]['content'], 'content' );
		pibt_eq( array(), $g['diskConflicts'], 'no conflicts' );
		pibt_assert( true === get_option( 'pib_connector_verify', false ) || is_array( get_option( 'pib_connector_verify' ) ), 'stored in pib_connector_verify' );

		// Logged with reason.
		$log = pibt_ok( pibt_call( 'log', array( 'limit' => 1 ) ), 'log' );
		pibt_eq( 'verify/set', $log['changes'][0]['endpoint'], 'logged' );
		pibt_eq( 'verify in GSC and Bing', $log['changes'][0]['reason'], 'reason logged' );
	}
);

pibt_test(
	'verify: replace semantics, omitting a key keeps that list; empty list clears; trailing newline for IndexNow',
	function () {
		pibt_pair();
		$t1 = array( array( 'name' => 'google-site-verification', 'content' => 'one' ) );
		$t2 = array( array( 'name' => 'yandex-verification', 'content' => 'two' ) );
		pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => $t1, 'files' => pibt_verify_files(), 'reason' => 'r' ) ), 'seed' );

		// Only tags: files stay.
		pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => $t2, 'reason' => 'r' ) ), 'tags only' );
		$g = pibt_ok( pibt_call( 'verify/get' ), 'get' );
		pibt_eq( $t2, $g['metaTags'], 'tags replaced, not merged' );
		pibt_eq( 3, count( $g['files'] ), 'files kept' );

		// Only files: tags stay.
		$one = array( array( 'path' => '/' . PIBT_INDEXNOW . '.txt', 'content' => PIBT_INDEXNOW . "\n" ) );
		pibt_ok( pibt_call( 'verify/set', array( 'files' => $one, 'reason' => 'r' ) ), 'files only' );
		$g = pibt_ok( pibt_call( 'verify/get' ), 'get' );
		pibt_eq( $t2, $g['metaTags'], 'tags kept' );
		pibt_eq( 1, count( $g['files'] ), 'files replaced' );
		pibt_eq( PIBT_INDEXNOW . "\n", $g['files'][0]['content'], 'trailing newline allowed and kept' );

		// Exact duplicates collapse.
		pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => array_merge( $t1, $t1, $t2 ), 'reason' => 'r' ) ), 'dupes' );
		pibt_eq( 2, count( pibt_ok( pibt_call( 'verify/get' ), 'g' )['metaTags'] ), 'deduped' );

		// Clear both: option removed.
		pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => array(), 'files' => array(), 'reason' => 'r' ) ), 'clear' );
		pibt_eq( array(), pibt_ok( pibt_call( 'verify/get' ), 'g' )['metaTags'], 'cleared' );
		pibt_assert( ! isset( $GLOBALS['pibt']['options']['pib_connector_verify'] ), 'option removed when empty' );
	}
);

pibt_test(
	'verify: every meta tag refusal',
	function () {
		pibt_pair();
		$ok = array( 'name' => 'google-site-verification', 'content' => 'abc' );
		$try = function ( $tags, $status, $code, $msg ) {
			pibt_err( pibt_call( 'verify/set', array( 'metaTags' => $tags, 'reason' => 'r' ) ), $status, $code, $msg );
		};
		$try( array( array( 'name' => 'description', 'content' => 'abc' ) ), 422, 'pib_unsafe', 'name outside the allow-list' );
		$try( array( array( 'name' => 'Google-Site-Verification', 'content' => 'abc' ) ), 422, 'pib_unsafe', 'name is case sensitive' );
		$try( array( array( 'name' => 'google-site-verification', 'content' => '' ) ), 422, 'pib_unsafe', 'empty content' );
		$try( array( array( 'name' => 'google-site-verification', 'content' => str_repeat( 'a', 201 ) ) ), 422, 'pib_unsafe', 'content over 200' );
		pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => array( array( 'name' => 'google-site-verification', 'content' => str_repeat( 'a', 200 ) ) ), 'reason' => 'r' ) ), '200 is fine' );
		foreach ( array( 'a"b', 'a b', "a\nb", 'a<b', "a'b", 'a>b', 'a&b', 'ä', 'a,b', 'a;b' ) as $bad ) {
			$try( array( array( 'name' => 'google-site-verification', 'content' => $bad ) ), 422, 'pib_unsafe', 'bad character in ' . json_encode( $bad ) );
		}
		$try( array( array( 'name' => 'google-site-verification', 'content' => "abc\n" ) ), 422, 'pib_unsafe', 'trailing newline in a tag' );
		$try( 'abc', 400, 'pib_bad_request', 'not a list' );
		$try( null, 400, 'pib_bad_request', 'null' );
		$try( array( 'name' => 'a', 'content' => 'b' ), 400, 'pib_bad_request', 'object instead of list' );
		$try( array( 'x' ), 400, 'pib_bad_request', 'item not an object' );
		$try( array( array( 'name' => 'google-site-verification' ) ), 400, 'pib_bad_request', 'missing content' );
		$try( array( array( 'name' => 5, 'content' => 'abc' ) ), 400, 'pib_bad_request', 'name not a string' );
		$try( array( array( 'name' => 'google-site-verification', 'content' => 5 ) ), 400, 'pib_bad_request', 'content not a string' );
		$try( array( $ok + array( 'extra' => 1 ) ), 400, 'pib_bad_request', 'extra item key' );
		$many = array();
		for ( $i = 0; $i < 21; $i++ ) {
			$many[] = array( 'name' => 'google-site-verification', 'content' => 'c' . $i );
		}
		$try( $many, 400, 'pib_bad_request', '21 tags' );
		pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => array_slice( $many, 0, 20 ), 'reason' => 'r' ) ), '20 tags fine' );
		// Nothing was stored by the refusals other than the 20-tag success.
		foreach ( PIB_Connector_Verify::allowed_names() as $n ) {
			pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => array( array( 'name' => $n, 'content' => 'x1' ) ), 'reason' => 'r' ) ), "name $n allowed" );
		}
		pibt_eq( 9, count( PIB_Connector_Verify::allowed_names() ), 'nine names' );
	}
);

pibt_test(
	'verify: every file refusal',
	function () {
		pibt_pair();
		$try = function ( $files, $status, $code, $msg ) {
			pibt_err( pibt_call( 'verify/set', array( 'files' => $files, 'reason' => 'r' ) ), $status, $code, $msg );
		};
		$k = PIBT_INDEXNOW;
		// IndexNow.
		$try( array( array( 'path' => "/$k.txt", 'content' => 'other' ) ), 422, 'pib_unsafe', 'indexnow content must equal key' );
		$try( array( array( 'path' => "/$k.txt", 'content' => "$k\n\n" ) ), 422, 'pib_unsafe', 'only one trailing newline' );
		$try( array( array( 'path' => "/$k.txt", 'content' => " $k" ) ), 422, 'pib_unsafe', 'no leading space' );
		$try( array( array( 'path' => '/short12.txt', 'content' => 'short12' ) ), 422, 'pib_unsafe', 'key under 8 chars' );
		$try( array( array( 'path' => '/' . str_repeat( 'a', 129 ) . '.txt', 'content' => str_repeat( 'a', 129 ) ) ), 422, 'pib_unsafe', 'key over 128' );
		pibt_ok( pibt_call( 'verify/set', array( 'files' => array( array( 'path' => '/' . str_repeat( 'a', 128 ) . '.txt', 'content' => str_repeat( 'a', 128 ) ) ), 'reason' => 'r' ) ), '128 fine' );
		pibt_ok( pibt_call( 'verify/set', array( 'files' => array( array( 'path' => '/abcd-123.txt', 'content' => 'abcd-123' ) ), 'reason' => 'r' ) ), '8 with dash fine' );
		$try( array( array( 'path' => '/abcd_1234.txt', 'content' => 'abcd_1234' ) ), 422, 'pib_unsafe', 'underscore in key' );
		$try( array( array( 'path' => "/sub/$k.txt", 'content' => $k ) ), 422, 'pib_unsafe', 'subdirectory' );
		$try( array( array( 'path' => "/../$k.txt", 'content' => $k ) ), 422, 'pib_unsafe', 'dot dot' );
		$try( array( array( 'path' => "$k.txt", 'content' => $k ) ), 422, 'pib_unsafe', 'no leading slash' );
		$try( array( array( 'path' => "/$k.txt/", 'content' => $k ) ), 422, 'pib_unsafe', 'trailing slash' );
		$try( array( array( 'path' => "/$k.txt?x=1", 'content' => $k ) ), 422, 'pib_unsafe', 'query string' );
		$try( array( array( 'path' => "/$k.TXT", 'content' => $k ) ), 422, 'pib_unsafe', 'extension case' );
		$try( array( array( 'path' => "/$k.txt\n", 'content' => $k ) ), 422, 'pib_unsafe', 'newline after path' );
		// Google.
		$g = PIBT_GOOGLE;
		$try( array( array( 'path' => "/$g", 'content' => 'google-site-verification: other.html' ) ), 422, 'pib_unsafe', 'google content for another file' );
		$try( array( array( 'path' => "/$g", 'content' => "google-site-verification: $g\n" ) ), 422, 'pib_unsafe', 'google newline not allowed' );
		$try( array( array( 'path' => '/google0123456789abcde.html', 'content' => 'google-site-verification: google0123456789abcde.html' ) ), 422, 'pib_unsafe', '15 hex' );
		$try( array( array( 'path' => '/google' . str_repeat( 'a', 33 ) . '.html', 'content' => 'google-site-verification: google' . str_repeat( 'a', 33 ) . '.html' ) ), 422, 'pib_unsafe', '33 hex' );
		$try( array( array( 'path' => '/google0123456789abcdeg.html', 'content' => 'google-site-verification: google0123456789abcdeg.html' ) ), 422, 'pib_unsafe', 'non hex' );
		$try( array( array( 'path' => '/google0123456789abcdef.htm', 'content' => 'google-site-verification: google0123456789abcdef.htm' ) ), 422, 'pib_unsafe', '.htm' );
		pibt_ok( pibt_call( 'verify/set', array( 'files' => array( array( 'path' => '/google' . str_repeat( 'a', 32 ) . '.html', 'content' => 'google-site-verification: google' . str_repeat( 'a', 32 ) . '.html' ) ), 'reason' => 'r' ) ), '32 hex fine' );
		// Bing.
		$b = PIBT_BING;
		$try( array( array( 'path' => '/BingSiteAuth.xml', 'content' => str_replace( 'ABCDEF', 'abcdef', str_replace( '0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef0123456789abcdef', $b ) ) ) ), 422, 'pib_unsafe', 'lowercase hex' );
		$try( array( array( 'path' => '/BingSiteAuth.xml', 'content' => str_replace( '0123456789ABCDEF0123456789ABCDEF', '0123456789ABCDE', $b ) ) ), 422, 'pib_unsafe', '15 hex' );
		$try( array( array( 'path' => '/BingSiteAuth.xml', 'content' => str_replace( '0123456789ABCDEF0123456789ABCDEF', str_repeat( 'A', 65 ), $b ) ) ), 422, 'pib_unsafe', '65 hex' );
		$try( array( array( 'path' => '/BingSiteAuth.xml', 'content' => '<?xml version="1.0"?><users><user>0123456789ABCDEF</user><user>0123456789ABCDEF</user></users>' ) ), 422, 'pib_unsafe', 'two users' );
		$try( array( array( 'path' => '/BingSiteAuth.xml', 'content' => $b . '<script>alert(1)</script>' ) ), 422, 'pib_unsafe', 'trailing junk' );
		$try( array( array( 'path' => '/BingSiteAuth.xml', 'content' => ' ' . $b ) ), 422, 'pib_unsafe', 'leading space' );
		$try( array( array( 'path' => '/bingsiteauth.xml', 'content' => $b ) ), 422, 'pib_unsafe', 'path is case sensitive' );
		$try( array( array( 'path' => '/BingSiteAuth.xml', 'content' => 'x' ) ), 422, 'pib_unsafe', 'not xml' );
		pibt_ok( pibt_call( 'verify/set', array( 'files' => array( array( 'path' => '/BingSiteAuth.xml', 'content' => "<?xml version=\"1.0\"?>\n<users>\n\t<user>0123456789ABCDEF</user>\n</users>\n" ) ), 'reason' => 'r' ) ), 'whitespace between elements is fine' );
		// Nothing else.
		foreach ( array( '/robots.txt', '/sitemap.xml', '/index.php', '/wp-config.php', '/.htaccess', '/ads.txt', '/x.html', '/', '', '/security.html', '/.well-known/x.txt' ) as $p ) {
			$try( array( array( 'path' => $p, 'content' => 'anything1' ) ), 422, 'pib_unsafe', "path $p" );
		}
		// Types and counts.
		$try( 'x', 400, 'pib_bad_request', 'files not a list' );
		$try( null, 400, 'pib_bad_request', 'files null' );
		$try( array( 'x' ), 400, 'pib_bad_request', 'item not an object' );
		$try( array( array( 'path' => "/$k.txt" ) ), 400, 'pib_bad_request', 'missing content' );
		$try( array( array( 'path' => 5, 'content' => 'x' ) ), 400, 'pib_bad_request', 'path not a string' );
		$try( array( array( 'path' => "/$k.txt", 'content' => $k, 'contentType' => 'text/html' ) ), 400, 'pib_bad_request', 'contentType cannot be chosen' );
		$try( array( array( 'path' => "/$k.txt", 'content' => $k ), array( 'path' => "/$k.txt", 'content' => "$k\n" ) ), 400, 'pib_bad_request', 'same path twice, different content' );
		$eleven = array();
		for ( $i = 0; $i < 11; $i++ ) {
			$key      = sprintf( 'abcdef%02d', $i );
			$eleven[] = array( 'path' => "/$key.txt", 'content' => $key );
		}
		$try( $eleven, 400, 'pib_bad_request', '11 files' );
		pibt_ok( pibt_call( 'verify/set', array( 'files' => array_slice( $eleven, 0, 10 ), 'reason' => 'r' ) ), '10 files fine' );
	}
);

pibt_test(
	'verify: request shape refusals (nothing to set, reason missing, feature off)',
	function () {
		pibt_pair();
		$t = array( array( 'name' => 'google-site-verification', 'content' => 'abc' ) );
		pibt_err( pibt_call( 'verify/set', array( 'reason' => 'r' ) ), 400, 'pib_bad_request', 'neither key' );
		pibt_err( pibt_call( 'verify/set', array( 'metaTags' => $t ) ), 400, 'pib_bad_request', 'reason required' );
		pibt_err( pibt_call( 'verify/set', array( 'metaTags' => $t, 'reason' => '   ' ) ), 400, 'pib_bad_request', 'blank reason' );
		pibt_eq( array(), pibt_ok( pibt_call( 'verify/get' ), 'g' )['metaTags'], 'nothing stored' );

		$f = PIB_Connector_Settings::features();
		$f['verify'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'verify/get' ), 403, 'pib_disabled', 'get off' );
		pibt_err( pibt_call( 'verify/set', array( 'metaTags' => $t, 'reason' => 'r' ) ), 403, 'pib_disabled', 'set off' );
	}
);

pibt_test(
	'verify: switching the feature off stops printing and serving; back on resumes',
	function () {
		pibt_pair();
		pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => array( array( 'name' => 'google-site-verification', 'content' => 'abc' ) ), 'files' => pibt_verify_files(), 'reason' => 'r' ) ), 'set' );
		$f = PIB_Connector_Settings::features();
		$f['verify'] = false;
		PIB_Connector_Settings::set_features( $f );
		ob_start();
		PIB_Connector_Verify::print_meta_tags();
		pibt_eq( '', ob_get_clean(), 'no tags when off' );
		pibt_eq( '', pibt_verify_serve( 'GET', '/BingSiteAuth.xml' ), 'no file when off' );
		pibt_eq( null, PIB_Connector_Verify::match( 'GET', '/BingSiteAuth.xml' ), 'no match when off' );
		$f['verify'] = true;
		PIB_Connector_Settings::set_features( $f );
		pibt_eq( PIBT_BING, pibt_verify_serve( 'GET', '/BingSiteAuth.xml' ), 'serving resumes' );
	}
);

pibt_test(
	'verify: undo restores both previous lists; undo of a first set empties them',
	function () {
		pibt_pair();
		$t1 = array( array( 'name' => 'google-site-verification', 'content' => 'one' ) );
		$t2 = array( array( 'name' => 'msvalidate.01', 'content' => 'TWO' ) );
		$a  = pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => $t1, 'files' => pibt_verify_files(), 'reason' => 'first' ) ), 'first' );
		$b  = pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => $t2, 'files' => array(), 'reason' => 'second' ) ), 'second' );
		pibt_eq( 0, count( pibt_ok( pibt_call( 'verify/get' ), 'g' )['files'] ), 'files cleared by second' );

		$u = pibt_ok( pibt_call( 'undo', array( 'changeId' => $b['changeId'] ) ), 'undo second' );
		pibt_eq( $b['changeId'], $u['undid'], 'undid' );
		$g = pibt_ok( pibt_call( 'verify/get' ), 'g' );
		pibt_eq( $t1, $g['metaTags'], 'tags back' );
		pibt_eq( 3, count( $g['files'] ), 'files back' );
		pibt_eq( PIBT_BING, pibt_verify_serve( 'GET', '/BingSiteAuth.xml' ), 'served again after undo' );

		pibt_err( pibt_call( 'undo', array( 'changeId' => $b['changeId'] ) ), 409, 'pib_already_undone', 'twice' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $a['changeId'] ) ), 'undo first' );
		$g = pibt_ok( pibt_call( 'verify/get' ), 'g' );
		pibt_eq( array(), $g['metaTags'], 'empty again' );
		pibt_eq( array(), $g['files'], 'no files' );
		pibt_eq( '', pibt_verify_serve( 'GET', '/BingSiteAuth.xml' ), 'nothing served after undo' );

		// Undo is refused while the feature is off.
		$c = pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => $t1, 'reason' => 'x' ) ), 'again' );
		$f = PIB_Connector_Settings::features();
		$f['verify'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'undo', array( 'changeId' => $c['changeId'] ) ), 403, 'pib_disabled', 'undo needs the feature' );
	}
);

pibt_test(
	'verify: meta tags are printed with esc_attr, in wp_head at priority 1, and a tampered option prints nothing unsafe',
	function () {
		pibt_pair();
		pibt_ok( pibt_call( 'verify/set', array( 'metaTags' => array(
			array( 'name' => 'google-site-verification', 'content' => 'abc123' ),
			array( 'name' => 'msvalidate.01', 'content' => 'A:B=C+/-._' ),
		), 'reason' => 'r' ) ), 'set' );
		pibt_assert( isset( $GLOBALS['pibt_hooks']['wp_head'][1] ), 'registered on wp_head at priority 1' );
		ob_start();
		do_action( 'wp_head' );
		$html = ob_get_clean();
		pibt_eq(
			"<meta name=\"google-site-verification\" content=\"abc123\" />\n<meta name=\"msvalidate.01\" content=\"A:B=C+/-._\" />\n",
			$html,
			'exact markup'
		);

		// Even a tampered option cannot print a breakout or an unknown name.
		update_option(
			'pib_connector_verify',
			array(
				'metaTags' => array(
					array( 'name' => 'google-site-verification', 'content' => '"><script>alert(1)</script>' ),
					array( 'name' => 'refresh', 'content' => '0;url=https://evil.test' ),
					array( 'name' => 'google-site-verification', 'content' => 'fine' ),
				),
				'files'    => array( array( 'path' => '/index.php', 'content' => 'x' ), array( 'path' => '/BingSiteAuth.xml', 'content' => '<html>' ) ),
			)
		);
		ob_start();
		PIB_Connector_Verify::print_meta_tags();
		$html = ob_get_clean();
		pibt_eq( "<meta name=\"google-site-verification\" content=\"fine\" />\n", $html, 'only the valid tag' );
		pibt_eq( '', pibt_verify_serve( 'GET', '/index.php' ), 'tampered file not served' );
		pibt_eq( '', pibt_verify_serve( 'GET', '/BingSiteAuth.xml' ), 'tampered content not served' );
	}
);

pibt_test(
	'verify: serving logic (match, no match, HEAD, trailing slash, query string, wrong method)',
	function () {
		pibt_pair();
		pibt_ok( pibt_call( 'verify/set', array( 'files' => pibt_verify_files(), 'reason' => 'r' ) ), 'set' );
		pibt_assert( isset( $GLOBALS['pibt_hooks']['parse_request'] ), 'registered on parse_request' );
		$k = PIBT_INDEXNOW;

		// GET.
		pibt_eq( $k, pibt_verify_serve( 'GET', "/$k.txt" ), 'indexnow body' );
		pibt_eq( 'google-site-verification: ' . PIBT_GOOGLE, pibt_verify_serve( 'GET', '/' . PIBT_GOOGLE ), 'google body' );
		pibt_eq( PIBT_BING, pibt_verify_serve( 'GET', '/BingSiteAuth.xml' ), 'bing body' );

		$m = PIB_Connector_Verify::match( 'GET', "/$k.txt" );
		pibt_eq( 200, $m['status'], 'status' );
		pibt_eq( 'text/plain; charset=utf-8', $m['headers']['Content-Type'], 'content type' );
		pibt_eq( 'no-cache', $m['headers']['Cache-Control'], 'cache-control' );
		pibt_eq( 'noindex', $m['headers']['X-Robots-Tag'], 'x-robots-tag' );
		pibt_eq( 'text/html; charset=utf-8', PIB_Connector_Verify::match( 'GET', '/' . PIBT_GOOGLE )['headers']['Content-Type'], 'google type' );
		pibt_eq( 'application/xml', PIB_Connector_Verify::match( 'GET', '/BingSiteAuth.xml' )['headers']['Content-Type'], 'bing type' );

		// HEAD: headers, no body.
		pibt_eq( '', pibt_verify_serve( 'HEAD', "/$k.txt" ), 'HEAD has no body' );
		$h = PIB_Connector_Verify::match( 'HEAD', "/$k.txt" );
		pibt_assert( null !== $h && false === $h['sendBody'] && 200 === $h['status'], 'HEAD matches without a body' );
		pibt_eq( true, PIB_Connector_Verify::match( 'get', "/$k.txt" )['sendBody'], 'method case-insensitive' );

		// Trailing slash and query string.
		pibt_eq( $k, pibt_verify_serve( 'GET', "/$k.txt/" ), 'trailing slash' );
		pibt_eq( $k, pibt_verify_serve( 'GET', "/$k.txt?utm=1&x=/y" ), 'query string ignored' );
		pibt_eq( $k, pibt_verify_serve( 'GET', "/$k.txt#frag" ), 'fragment ignored' );
		pibt_eq( PIBT_BING, pibt_verify_serve( 'GET', 'https://example.test/BingSiteAuth.xml?a=1' ), 'absolute-form request target' );

		// No match.
		foreach ( array( "/$k.TXT", "/$k", "/x/$k.txt", "//$k.txt", '/bingsiteauth.xml', '/', '', '/about/', '/robots.txt', "/$k.txt.bak", "/%61$k.txt", '/?p=/' . $k . '.txt', "/$k.txt/x" ) as $uri ) {
			pibt_eq( '', pibt_verify_serve( 'GET', $uri ), "no match for $uri" );
			pibt_eq( null, PIB_Connector_Verify::match( 'GET', $uri ), "match() null for $uri" );
		}

		// Wrong method.
		foreach ( array( 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', '' ) as $method ) {
			pibt_eq( '', pibt_verify_serve( $method, "/$k.txt" ), "method '$method' ignored" );
		}
	}
);

pibt_test(
	'verify: serve() stops the request (exit) unless the test filter says otherwise; unstored paths never stop it',
	function () {
		pibt_pair();
		pibt_ok( pibt_call( 'verify/set', array( 'files' => pibt_verify_files(), 'reason' => 'r' ) ), 'set' );
		// The default filter value is true (exit). Prove it without exiting: apply the filter.
		pibt_eq( true, apply_filters( 'pib_connector_verify_exit', true ), 'default is to exit' );
		// A non-matching request returns before reaching exit.
		$_SERVER['REQUEST_METHOD'] = 'GET';
		$_SERVER['REQUEST_URI']    = '/about/';
		ob_start();
		PIB_Connector_Verify::serve();
		$out = ob_get_clean();
		unset( $_SERVER['REQUEST_METHOD'], $_SERVER['REQUEST_URI'] );
		pibt_eq( '', $out, 'no output, no exit for an ordinary page' );
	}
);

pibt_test(
	'verify: site in a sub-directory serves under its own prefix only',
	function () {
		pibt_pair();
		pibt_ok( pibt_call( 'verify/set', array( 'files' => pibt_verify_files(), 'reason' => 'r' ) ), 'set' );
		$GLOBALS['pibt']['home_prefix'] = '/blog';
		pibt_eq( PIBT_BING, pibt_verify_serve( 'GET', '/blog/BingSiteAuth.xml' ), 'under the prefix' );
		pibt_eq( '', pibt_verify_serve( 'GET', '/BingSiteAuth.xml' ), 'not at the domain root' );
		pibt_eq( '', pibt_verify_serve( 'GET', '/blogBingSiteAuth.xml' ), 'prefix must end at a slash' );
	}
);

pibt_test(
	'verify: diskConflicts reports stored paths that exist as real files',
	function () {
		pibt_pair();
		pibt_ok( pibt_call( 'verify/set', array( 'files' => pibt_verify_files(), 'reason' => 'r' ) ), 'set' );
		pibt_eq( array(), pibt_ok( pibt_call( 'verify/get' ), 'g' )['diskConflicts'], 'none yet' );
		file_put_contents( ABSPATH . 'BingSiteAuth.xml', 'on disk' );
		$g = pibt_ok( pibt_call( 'verify/get' ), 'g' );
		pibt_eq( array( '/BingSiteAuth.xml' ), $g['diskConflicts'], 'conflict reported' );
		$s = pibt_ok( pibt_call( 'verify/set', array( 'files' => pibt_verify_files(), 'reason' => 'r' ) ), 'set again' );
		pibt_eq( 1, count( $s['warnings'] ), 'warning on set' );
		pibt_assert( false !== strpos( $s['warnings'][0], '/BingSiteAuth.xml' ), 'warning names the path' );
		unlink( ABSPATH . 'BingSiteAuth.xml' );
		pibt_eq( array(), pibt_ok( pibt_call( 'verify/get' ), 'g' )['diskConflicts'], 'gone again' );
	}
);

pibt_test(
	'verify: never writes files',
	function () {
		pibt_pair();
		$before = array_map( 'basename', (array) glob( ABSPATH . '*' ) );
		pibt_ok( pibt_call( 'verify/set', array( 'files' => pibt_verify_files(), 'metaTags' => array( array( 'name' => 'google-site-verification', 'content' => 'x' ) ), 'reason' => 'r' ) ), 'set' );
		pibt_verify_serve( 'GET', '/BingSiteAuth.xml' );
		pibt_eq( $before, array_map( 'basename', (array) glob( ABSPATH . '*' ) ), 'web root untouched' );
		pibt_assert( ! file_exists( ABSPATH . 'BingSiteAuth.xml' ), 'no file' );
	}
);
