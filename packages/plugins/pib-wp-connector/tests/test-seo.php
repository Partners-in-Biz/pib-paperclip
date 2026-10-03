<?php
/**
 * seo/get + seo/set for yoast, rankmath and none; home target; undo.
 */

function pibt_seo_setup( $adapter ) {
	pibt_pair();
	$GLOBALS['pibt']['adapter'] = $adapter;
	pibt_add_post( 10, 'about' );
	pibt_add_post( 11, 'shop', 'page' );
	pibt_add_post( 12, 'old', 'page', 'trash' );
}

foreach ( array( 'yoast', 'rankmath', 'none' ) as $pibt_adapter ) {
	pibt_test(
		"seo/set + seo/get round trip ($pibt_adapter)",
		function () use ( $pibt_adapter ) {
			pibt_seo_setup( $pibt_adapter );
			$set = pibt_ok(
				pibt_call(
					'seo/set',
					array(
						'url'           => '/about/',
						'title'         => 'About Hunt & Gun',
						'description'   => 'Firearms <b>and</b> hunting gear',
						'canonical'     => 'https://example.test/about/',
						'noindex'       => true,
						'nofollow'      => true,
						'focusKeyword'  => 'hunting shop',
						'ogTitle'       => 'OG about',
						'ogDescription' => 'OG desc',
						'reason'        => 'test',
					)
				),
				'seo/set'
			);
			pibt_assert( 0 === strpos( $set['changeId'], 'chg_' ), 'changeId' );
			pibt_eq( 10, $set['target']['postId'], 'target post' );
			pibt_eq( 'post', $set['target']['type'], 'target type' );
			pibt_eq( null, $set['before']['title'], 'before title null' );
			pibt_eq( null, $set['before']['noindex'], 'before noindex null' );
			pibt_eq( 'Firearms and hunting gear', $set['after']['description'], 'tags stripped' );

			$get = pibt_ok( pibt_call( 'seo/get', array( 'postId' => 10 ) ), 'seo/get' );
			pibt_eq( $pibt_adapter, $get['seoPlugin'], 'seoPlugin' );
			pibt_eq(
				array(
					'title'         => 'About Hunt & Gun',
					'description'   => 'Firearms and hunting gear',
					'canonical'     => 'https://example.test/about/',
					'noindex'       => true,
					'nofollow'      => true,
					'focusKeyword'  => 'hunting shop',
					'ogTitle'       => 'OG about',
					'ogDescription' => 'OG desc',
					'ogImage'       => null,
				),
				$get['fields'],
				'fields after set'
			);

			$meta = $GLOBALS['pibt']['meta'][10];
			if ( 'yoast' === $pibt_adapter ) {
				pibt_eq( 'About Hunt & Gun', $meta['_yoast_wpseo_title'], 'yoast title meta' );
				pibt_eq( '1', $meta['_yoast_wpseo_meta-robots-noindex'], 'yoast noindex = 1' );
				pibt_eq( '1', $meta['_yoast_wpseo_meta-robots-nofollow'], 'yoast nofollow = 1' );
				pibt_eq( 'hunting shop', $meta['_yoast_wpseo_focuskw'], 'yoast focus kw' );
			} elseif ( 'rankmath' === $pibt_adapter ) {
				pibt_eq( 'About Hunt & Gun', $meta['rank_math_title'], 'rankmath title meta' );
				pibt_assert( in_array( 'noindex', $meta['rank_math_robots'], true ), 'rankmath robots has noindex' );
				pibt_assert( in_array( 'nofollow', $meta['rank_math_robots'], true ), 'rankmath robots has nofollow' );
			} else {
				pibt_eq( 'About Hunt & Gun', $meta['_pib_seo_title'], 'own title meta' );
				pibt_eq( '1', $meta['_pib_seo_noindex'], 'own noindex meta' );
			}

			// noindex false = explicit index; null = back to default.
			$d = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'noindex' => false ) ), 'noindex false' );
			pibt_eq( false, $d['after']['noindex'], 'noindex false read back' );
			pibt_eq( 'About Hunt & Gun', $d['after']['title'], 'other fields untouched' );
			if ( 'yoast' === $pibt_adapter ) {
				pibt_eq( '2', $GLOBALS['pibt']['meta'][10]['_yoast_wpseo_meta-robots-noindex'], 'yoast index = 2' );
			} elseif ( 'rankmath' === $pibt_adapter ) {
				pibt_assert( in_array( 'index', $GLOBALS['pibt']['meta'][10]['rank_math_robots'], true ), 'rankmath robots has index' );
				pibt_assert( ! in_array( 'noindex', $GLOBALS['pibt']['meta'][10]['rank_math_robots'], true ), 'rankmath robots lost noindex' );
			}
			$d = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'noindex' => null, 'title' => '' ) ), 'noindex null' );
			pibt_eq( null, $d['after']['noindex'], 'noindex default' );
			pibt_eq( null, $d['after']['title'], 'title cleared' );
			if ( 'yoast' === $pibt_adapter ) {
				pibt_assert( ! isset( $GLOBALS['pibt']['meta'][10]['_yoast_wpseo_meta-robots-noindex'] ), 'yoast noindex meta deleted' );
				pibt_assert( ! isset( $GLOBALS['pibt']['meta'][10]['_yoast_wpseo_title'] ), 'yoast title meta deleted' );
			}
		}
	);

	pibt_test(
		"home target when the site shows latest posts ($pibt_adapter)",
		function () use ( $pibt_adapter ) {
			pibt_seo_setup( $pibt_adapter );
			$d = pibt_ok( pibt_call( 'seo/set', array( 'url' => 'https://example.test/', 'title' => 'Home title', 'description' => 'Home desc', 'canonical' => 'https://example.test/' ) ), 'home set' );
			pibt_eq( 'home', $d['target']['type'], 'home target' );
			pibt_eq( null, $d['target']['postId'], 'no post id' );
			pibt_eq( 'Home title', $d['after']['title'], 'home title' );
			pibt_eq( 'Home desc', $d['after']['description'], 'home description' );
			if ( 'yoast' === $pibt_adapter ) {
				$t = get_option( 'wpseo_titles' );
				pibt_eq( 'Home title', $t['title-home-wpseo'], 'wpseo_titles title-home-wpseo' );
				pibt_eq( 'Home desc', $t['metadesc-home-wpseo'], 'wpseo_titles metadesc-home-wpseo' );
				pibt_eq( 1, count( $d['warnings'] ), 'canonical unsupported for yoast home → warning' );
				pibt_ok( pibt_call( 'seo/set', array( 'url' => '/', 'ogTitle' => 'OG home' ) ), 'og home' );
				$t = get_option( 'wpseo_titles' );
				pibt_eq( 'OG home', $t['open_graph_frontpage_title'], 'open_graph_frontpage_title' );
			} elseif ( 'rankmath' === $pibt_adapter ) {
				$t = get_option( 'rank-math-options-titles' );
				pibt_eq( 'Home title', $t['homepage_title'], 'rankmath homepage_title' );
				pibt_eq( 'Home desc', $t['homepage_description'], 'rankmath homepage_description' );
			} else {
				pibt_eq( 'https://example.test/', $d['after']['canonical'], 'own home canonical' );
			}
			$g = pibt_ok( pibt_call( 'seo/get', array( 'url' => '/' ) ), 'home get' );
			pibt_eq( 'Home title', $g['fields']['title'], 'home title read back' );
		}
	);
}

pibt_test(
	'home url resolves to the static front page',
	function () {
		pibt_seo_setup( 'yoast' );
		update_option( 'show_on_front', 'page' );
		update_option( 'page_on_front', 11 );
		$g = pibt_ok( pibt_call( 'seo/get', array( 'url' => '/' ) ), 'front page get' );
		pibt_eq( 'post', $g['target']['type'], 'post target' );
		pibt_eq( 11, $g['target']['postId'], 'front page id' );
	}
);

pibt_test(
	'unsupported and invalid targets',
	function () {
		pibt_seo_setup( 'none' );
		pibt_err( pibt_call( 'seo/get', array( 'url' => '/category/rifles/' ) ), 422, 'pib_unsupported_target', 'archive' );
		pibt_err( pibt_call( 'seo/get', array( 'url' => 'https://evil.example/about/' ) ), 422, 'pib_unsupported_target', 'other host' );
		pibt_err( pibt_call( 'seo/get', array( 'postId' => 12 ) ), 422, 'pib_unsupported_target', 'trashed post' );
		pibt_err( pibt_call( 'seo/get', array( 'postId' => 999 ) ), 422, 'pib_unsupported_target', 'missing post' );
		pibt_err( pibt_call( 'seo/get', array( 'postId' => 'abc' ) ), 400, 'pib_bad_request', 'bad postId' );
		pibt_err( pibt_call( 'seo/get', array() ), 400, 'pib_bad_request', 'no target' );
		pibt_err( pibt_call( 'seo/set', array( 'postId' => 10, 'canonical' => 'javascript:alert(1)' ) ), 400, 'pib_bad_request', 'bad canonical' );
		pibt_err( pibt_call( 'seo/set', array( 'postId' => 10, 'noindex' => 'yes' ) ), 400, 'pib_bad_request', 'bad noindex' );
		pibt_err( pibt_call( 'seo/set', array( 'postId' => 10 ) ), 400, 'pib_bad_request', 'nothing to change' );
	}
);

pibt_test(
	'undo restores the before state and is logged',
	function () {
		pibt_seo_setup( 'yoast' );
		update_post_meta( 10, '_yoast_wpseo_title', 'Original title' );
		$a = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'title' => 'New title', 'noindex' => true ) ), 'set' );
		pibt_eq( 'Original title', $a['before']['title'], 'before captured' );

		$u = pibt_ok( pibt_call( 'undo', array( 'changeId' => $a['changeId'] ) ), 'undo' );
		pibt_eq( $a['changeId'], $u['undid'], 'undid id' );
		$g = pibt_ok( pibt_call( 'seo/get', array( 'postId' => 10 ) ), 'get after undo' );
		pibt_eq( 'Original title', $g['fields']['title'], 'title restored' );
		pibt_eq( null, $g['fields']['noindex'], 'noindex restored to default' );

		pibt_err( pibt_call( 'undo', array( 'changeId' => $a['changeId'] ) ), 409, 'pib_already_undone', 'double undo' );
		pibt_err( pibt_call( 'undo', array( 'changeId' => 'chg_0000000000000000' ) ), 404, 'pib_not_found', 'unknown change' );

		$log = pibt_ok( pibt_call( 'log', array( 'limit' => 5 ) ), 'log' );
		pibt_eq( 'undo', $log['changes'][0]['endpoint'], 'newest first' );
		pibt_eq( $u['changeId'], $log['changes'][0]['changeId'], 'undo change id' );
		pibt_eq( true, $log['changes'][1]['undone'], 'original marked undone' );
		pibt_eq( 'agent:test', $log['changes'][1]['actor'], 'actor recorded' );

		// undo only works while the feature is on.
		$b = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'title' => 'Again' ) ), 'set again' );
		$f = PIB_Connector_Settings::features();
		$f['seo'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'undo', array( 'changeId' => $b['changeId'] ) ), 403, 'pib_disabled', 'undo with feature off' );
	}
);

pibt_test(
	'SEO plugin variables such as %%category%% survive cleaning',
	function () {
		pibt_seo_setup( 'yoast' );
		$d = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'title' => "%%title%% %%sep%% %%category%%\n%%sitename%% 50%ab" ) ), 'set' );
		pibt_eq( '%%title%% %%sep%% %%category%% %%sitename%% 50%ab', $d['after']['title'], 'variables kept' );
	}
);

pibt_test(
	'no SEO plugin: head output and document title',
	function () {
		pibt_seo_setup( 'none' );
		pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'title' => 'T <x>', 'description' => 'D "q"', 'noindex' => true ) ), 'set' );
		$GLOBALS['pibt']['query'] = array( 'front_page' => false, 'home' => false, 'singular' => true, 'id' => 10 );
		pibt_eq( 'T', apply_filters( 'pre_get_document_title', '' ), 'title filter' );
		$robots = apply_filters( 'wp_robots', array( 'max-image-preview' => 'large' ) );
		pibt_eq( true, $robots['noindex'], 'wp_robots noindex' );
		ob_start();
		PIB_Connector_SEO::print_head();
		$html = ob_get_clean();
		pibt_assert( false !== strpos( $html, 'content="D &quot;q&quot;"' ), 'description escaped: ' . $html );
	}
);
