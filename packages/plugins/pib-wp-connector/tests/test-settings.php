<?php
/**
 * 1.1.0 feature switches, the admin checkboxes, the router map and the undo map.
 */

if ( ! function_exists( 'current_user_can' ) ) {
	function current_user_can( $cap ) { return true; }
}
if ( ! function_exists( 'checked' ) ) {
	function checked( $v ) { echo $v ? "checked='checked'" : ''; }
}
if ( ! function_exists( 'wp_nonce_field' ) ) {
	function wp_nonce_field( $a ) { echo '<input type="hidden" name="_wpnonce" />'; }
}
if ( ! function_exists( 'submit_button' ) ) {
	function submit_button( $t ) { echo '<input type="submit" />'; }
}

pibt_test(
	'new features default on; settings saved before 1.1.0 get the defaults for them',
	function () {
		$d = PIB_Connector_Settings::feature_defaults();
		pibt_eq( true, $d['media'], 'media' );
		pibt_eq( true, $d['content'], 'content' );
		pibt_eq( true, $d['selfupdate'], 'selfupdate' );
		pibt_eq( false, $d['plugins'], 'plugins still off' );
		pibt_eq( array_keys( $d ), array_keys( PIB_Connector_Settings::feature_labels() ), 'every feature has a label' );

		// An option saved by 1.0.0.
		update_option(
			'pib_connector_settings',
			array(
				'features' => array(
					'seo' => true, 'schema' => false, 'redirects' => true, 'robots' => true, 'sitemap' => true, 'plugins' => false,
				),
			)
		);
		$f = PIB_Connector_Settings::features();
		pibt_eq( true, $f['media'], 'media default applied' );
		pibt_eq( true, $f['content'], 'content default applied' );
		pibt_eq( true, $f['selfupdate'], 'selfupdate default applied' );
		pibt_eq( false, $f['schema'], 'saved value kept' );

		// Saved with a new feature off: stays off.
		$f['content'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_eq( false, PIB_Connector_Settings::features()['content'], 'switch off is remembered' );
		pibt_eq( true, PIB_Connector_Settings::features()['media'], 'others unaffected' );
	}
);

pibt_test(
	'admin page lists the new features with the same checkbox style',
	function () {
		pibt_pair();
		ob_start();
		PIB_Connector_Admin::render();
		$html = ob_get_clean();
		foreach ( array_keys( PIB_Connector_Settings::feature_defaults() ) as $feature ) {
			pibt_assert( false !== strpos( $html, 'name="pib_features[' . $feature . ']" value="1"' ), "checkbox for $feature" );
		}
		pibt_assert( 1 === preg_match( '/name="pib_features\[media\]" value="1" checked=.checked./', $html ), 'media is checked by default' );
		pibt_assert( 1 === preg_match( '/name="pib_features\[selfupdate\]" value="1" checked=.checked./', $html ), 'selfupdate is checked by default' );
		pibt_assert( 1 !== preg_match( '/name="pib_features\[plugins\]" value="1" checked/', $html ), 'plugins is not checked by default' );
	}
);

pibt_test(
	'router map: every 1.1.0 route registered under the right feature; undo map only holds real endpoints',
	function () {
		$map      = PIB_Connector_Router::endpoints();
		$expected = array(
			'seo/list'           => 'seo',
			'media/list'         => 'media',
			'media/sideload'     => 'media',
			'media/set-featured' => 'media',
			'media/alt'          => 'media',
			'posts/get'          => 'content',
			'posts/images'       => 'content',
			'posts/img-alt'      => 'content',
			'posts/update'       => 'content',
			'posts/create'       => 'content',
			'posts/publish'      => 'content',
			'self/update'        => 'selfupdate',
			'self/rollback'      => 'selfupdate',
		);
		foreach ( $expected as $endpoint => $feature ) {
			pibt_assert( isset( $map[ $endpoint ] ), "$endpoint in the router map" );
			pibt_eq( $feature, $map[ $endpoint ][0], "$endpoint feature" );
			pibt_assert( isset( $GLOBALS['pibt_routes'][ '/pib-connector/v1/' . $endpoint ] ), "$endpoint registered as a REST route" );
			pibt_assert( is_callable( $map[ $endpoint ][1] ), "$endpoint handler is callable" );
		}
		foreach ( PIB_Connector_Undo::undoable() as $endpoint => $def ) {
			pibt_assert( isset( $map[ $endpoint ] ), "undoable $endpoint exists" );
			pibt_eq( $map[ $endpoint ][0], $def[0], "$endpoint undo feature matches" );
			pibt_assert( is_callable( $def[1] ), "$endpoint undo handler is callable" );
		}
		foreach ( array( 'seo/set', 'media/set-featured', 'media/alt', 'posts/img-alt', 'posts/update', 'posts/create', 'posts/publish' ) as $endpoint ) {
			pibt_assert( isset( PIB_Connector_Undo::undoable()[ $endpoint ] ), "$endpoint is undoable" );
		}
		foreach ( array( 'media/sideload', 'self/update', 'self/rollback', 'plugins/install' ) as $endpoint ) {
			pibt_assert( ! isset( PIB_Connector_Undo::undoable()[ $endpoint ] ), "$endpoint is not undoable" );
		}
	}
);

pibt_test(
	'unauthenticated calls to the new routes learn nothing (auth before feature switch)',
	function () {
		pibt_pair();
		foreach ( array( 'seo/list', 'media/list', 'posts/get', 'self/update' ) as $endpoint ) {
			pibt_err( pibt_call( $endpoint, array(), array( 'key_id' => '000000000000' ) ), 401, 'pib_bad_signature', "$endpoint needs a signature" );
		}
		$f = PIB_Connector_Settings::features();
		$f['selfupdate'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'self/update', array(), array( 'sig' => str_repeat( 'a', 64 ) ) ), 401, 'pib_bad_signature', 'bad signature beats the feature switch' );
	}
);
