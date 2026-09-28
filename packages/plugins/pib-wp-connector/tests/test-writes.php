<?php
/**
 * schema, redirects, robots, sitemap, plugins and the log ring buffer.
 */

pibt_test(
	'schema set/remove and Yoast graph output',
	function () {
		pibt_pair();
		$GLOBALS['pibt']['adapter'] = 'yoast';
		pibt_add_post( 10, 'about' );

		$org = array(
			'@context' => 'https://schema.org',
			'@type'    => 'Organization',
			'name'     => 'Hunt and Gun',
		);
		$s = pibt_ok( pibt_call( 'schema/set', array( 'site' => true, 'id' => 'org', 'piece' => $org ) ), 'site piece' );
		pibt_eq( 'site', $s['target']['type'], 'site target' );
		pibt_assert( ! isset( $s['pieces'][0]['piece']['@context'] ), '@context stripped' );

		$faq = array(
			'@type' => 'FAQPage',
			'@id'   => 'https://example.test/about/#faq',
			'mainEntity' => array( array( '@type' => 'Question', 'name' => 'Open on Sunday?' ) ),
		);
		pibt_ok( pibt_call( 'schema/set', array( 'url' => '/about/', 'id' => 'faq', 'piece' => $faq ) ), 'page piece' );
		$g = pibt_ok( pibt_call( 'schema/get', array( 'postId' => 10 ) ), 'schema/get' );
		pibt_eq( 'faq', $g['pieces'][0]['id'], 'stored piece id' );
		pibt_assert( is_array( get_post_meta( 10, '_pib_schema', true ) ), 'stored in _pib_schema' );
		pibt_assert( is_array( get_option( 'pib_connector_schema_site' ) ), 'stored in pib_connector_schema_site' );

		$GLOBALS['pibt']['query'] = array( 'front_page' => false, 'home' => false, 'singular' => true, 'id' => 10 );
		$graph = apply_filters( 'wpseo_schema_graph', array( array( '@type' => 'WebPage' ) ), null );
		pibt_eq( 3, count( $graph ), 'two pieces appended to the Yoast graph' );
		pibt_eq( 'Organization', $graph[1]['@type'], 'site piece first' );
		pibt_eq( 'https://example.test/#pib-org', $graph[1]['@id'], 'default @id' );
		pibt_eq( 'https://example.test/about/#faq', $graph[2]['@id'], 'own @id kept' );

		// On another page only the site piece is added.
		$GLOBALS['pibt']['query']['id'] = 11;
		pibt_eq( 2, count( apply_filters( 'wpseo_schema_graph', array( array( '@type' => 'WebPage' ) ), null ) ), 'site piece only' );

		$r = pibt_ok( pibt_call( 'schema/set', array( 'postId' => 10, 'id' => 'faq', 'remove' => true ) ), 'remove' );
		pibt_eq( array(), $r['pieces'], 'removed' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $r['changeId'] ) ), 'undo remove' );
		$g = pibt_ok( pibt_call( 'schema/get', array( 'postId' => 10 ) ), 'get after undo' );
		pibt_eq( 'FAQPage', $g['pieces'][0]['piece']['@type'], 'piece restored' );
	}
);

pibt_test(
	'schema validation and limits',
	function () {
		pibt_pair();
		pibt_add_post( 10, 'about' );
		$p = array( '@type' => 'Thing', 'name' => 'x' );
		pibt_err( pibt_call( 'schema/set', array( 'postId' => 10, 'id' => 'Bad_ID', 'piece' => $p ) ), 400, 'pib_bad_request', 'bad id' );
		pibt_err( pibt_call( 'schema/set', array( 'postId' => 10, 'id' => 'x', 'piece' => array( 'name' => 'no type' ) ) ), 400, 'pib_bad_request', 'no @type' );
		pibt_err( pibt_call( 'schema/set', array( 'postId' => 10, 'id' => 'x', 'piece' => array( array( '@type' => 'Thing' ) ) ) ), 400, 'pib_bad_request', 'list, not object' );
		pibt_err( pibt_call( 'schema/set', array( 'postId' => 10, 'id' => 'x', 'piece' => array( '@type' => 'Thing', 'name' => '</script><script>alert(1)</script>' ) ) ), 400, 'pib_bad_request', 'script tag' );
		pibt_err( pibt_call( 'schema/set', array( 'postId' => 10, 'id' => 'x', 'piece' => array( '@type' => 'Thing', 'text' => str_repeat( 'a', 21000 ) ) ) ), 400, 'pib_bad_request', 'over 20 KB' );
		for ( $i = 1; $i <= 20; $i++ ) {
			pibt_ok( pibt_call( 'schema/set', array( 'postId' => 10, 'id' => 'p' . $i, 'piece' => $p ) ), "piece $i" );
		}
		pibt_err( pibt_call( 'schema/set', array( 'postId' => 10, 'id' => 'p21', 'piece' => $p ) ), 422, 'pib_limit', '21st piece' );
		pibt_ok( pibt_call( 'schema/set', array( 'postId' => 10, 'id' => 'p5', 'piece' => $p ) ), 'replacing an existing piece is fine' );
	}
);

pibt_test(
	'schema output without an SEO plugin is one ld+json script with @graph',
	function () {
		pibt_pair();
		$GLOBALS['pibt']['adapter'] = 'none';
		pibt_ok( pibt_call( 'schema/set', array( 'site' => true, 'id' => 'org', 'piece' => array( '@type' => 'Organization', 'name' => 'A<b>' ) ) ), 'set' );
		ob_start();
		PIB_Connector_Schema::print_head_graph();
		$html = ob_get_clean();
		pibt_assert( 1 === substr_count( $html, '<script type="application/ld+json"' ), 'one script' );
		pibt_assert( false !== strpos( $html, '"@graph"' ), '@graph' );
		pibt_assert( false === strpos( $html, 'A<b>' ), 'HTML hex-escaped' );
	}
);

pibt_test(
	'redirects: normalisation, loops, 410, delete, undo',
	function () {
		pibt_pair();
		$r = pibt_ok( pibt_call( 'redirects/set', array( 'from' => 'Old-Page/?utm=x', 'to' => '/new-page/', 'code' => 301 ) ), 'set' );
		pibt_eq( '/old-page', $r['redirect']['from'], 'normalised from' );
		pibt_eq( 301, $r['redirect']['code'], 'code' );
		pibt_eq( '/', PIB_Connector_Redirects::normalize_from( '/' ), 'root stays /' );
		pibt_eq( '/a/b', PIB_Connector_Redirects::normalize_from( 'https://example.test//A//b/#x' ), 'same-host absolute from' );

		pibt_err( pibt_call( 'redirects/set', array( 'from' => '/x', 'to' => '/X/', 'code' => 301 ) ), 422, 'pib_redirect_loop', 'to equals from' );
		pibt_err( pibt_call( 'redirects/set', array( 'from' => '/new-page', 'to' => 'https://example.test/Old-Page', 'code' => 302 ) ), 422, 'pib_redirect_loop', 'two-step loop' );
		pibt_ok( pibt_call( 'redirects/set', array( 'from' => '/b', 'to' => '/c', 'code' => 301 ) ), 'b→c' );
		pibt_ok( pibt_call( 'redirects/set', array( 'from' => '/c', 'to' => '/d', 'code' => 308 ) ), 'c→d' );
		pibt_err( pibt_call( 'redirects/set', array( 'from' => '/d', 'to' => '/b', 'code' => 301 ) ), 422, 'pib_redirect_loop', 'three-step loop' );
		pibt_ok( pibt_call( 'redirects/set', array( 'from' => '/d', 'to' => 'https://other.example/b', 'code' => 301 ) ), 'external target' );

		pibt_err( pibt_call( 'redirects/set', array( 'from' => '/e', 'to' => '/f', 'code' => 303 ) ), 400, 'pib_bad_request', 'bad code' );
		pibt_err( pibt_call( 'redirects/set', array( 'from' => '/e', 'code' => 301 ) ), 400, 'pib_bad_request', 'missing to' );
		pibt_err( pibt_call( 'redirects/set', array( 'from' => '/e', 'to' => 'javascript:alert(1)', 'code' => 301 ) ), 400, 'pib_bad_request', 'javascript to' );
		pibt_err( pibt_call( 'redirects/set', array( 'from' => '/e', 'to' => '//evil.example', 'code' => 301 ) ), 400, 'pib_bad_request', 'protocol-relative to' );
		pibt_err( pibt_call( 'redirects/set', array( 'from' => 'https://evil.example/e', 'to' => '/f', 'code' => 301 ) ), 400, 'pib_bad_request', 'foreign from' );

		$gone = pibt_ok( pibt_call( 'redirects/set', array( 'from' => '/discontinued', 'code' => 410 ) ), '410 without to' );
		pibt_eq( null, $gone['redirect']['to'], '410 has no to' );

		$m = PIB_Connector_Redirects::match_request( '/OLD-page/?a=1' );
		pibt_eq( '/old-page', $m[0], 'request matching is normalised' );
		pibt_eq( null, PIB_Connector_Redirects::match_request( '/nothing' ), 'no match' );

		$list = pibt_ok( pibt_call( 'redirects/list' ), 'list' );
		pibt_eq( 'connector', $list['provider'], 'provider' );
		pibt_eq( 5, count( $list['redirects'] ), 'count' );
		pibt_assert( array_key_exists( 'hits', $list['redirects'][0] ) && array_key_exists( 'lastHit', $list['redirects'][0] ), 'hits fields' );

		$del = pibt_ok( pibt_call( 'redirects/delete', array( 'from' => '/OLD-PAGE' ) ), 'delete' );
		pibt_eq( true, $del['removed'], 'removed' );
		pibt_eq( false, pibt_ok( pibt_call( 'redirects/delete', array( 'from' => '/old-page' ) ), 'delete again' )['removed'], 'already gone' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $del['changeId'] ) ), 'undo delete' );
		$all = PIB_Connector_Redirects::all();
		pibt_eq( '/new-page/', $all['/old-page']['to'], 'redirect restored' );

		$upd = pibt_ok( pibt_call( 'redirects/set', array( 'from' => '/old-page', 'to' => '/newer', 'code' => 302 ) ), 'update' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $upd['changeId'] ) ), 'undo update' );
		$all = PIB_Connector_Redirects::all();
		pibt_eq( 301, $all['/old-page']['code'], 'previous code restored' );
	}
);

pibt_test(
	'robots: unsafe Disallow refused, blog_public never set to 0',
	function () {
		pibt_pair();
		pibt_err( pibt_call( 'robots/set', array( 'extraLines' => "Disallow: /" ) ), 422, 'pib_unsafe', 'Disallow: / in WP\'s * group' );
		pibt_err( pibt_call( 'robots/set', array( 'extraLines' => "User-agent: *\r\nDisallow: /   # all" ) ), 422, 'pib_unsafe', 'explicit *' );
		pibt_err( pibt_call( 'robots/set', array( 'extraLines' => "User-agent: Bingbot\nUser-agent: *\nDisallow: /*" ) ), 422, 'pib_unsafe', '* in a multi-agent group' );
		pibt_ok( pibt_call( 'robots/set', array( 'extraLines' => "User-agent: GPTBot\nDisallow: /" ) ), 'Disallow: / for one bot is allowed' );
		pibt_ok( pibt_call( 'robots/set', array( 'extraLines' => "User-agent: *\nDisallow: /private/" ) ), 'path disallow ok' );
		pibt_err( pibt_call( 'robots/set', array( 'extraLines' => str_repeat( "Disallow: /x/\n", 400 ) ) ), 400, 'pib_bad_request', 'over 4 KB' );

		$g = pibt_ok( pibt_call( 'robots/get' ), 'robots/get' );
		pibt_assert( false !== strpos( $g['robotsTxt'], "# PiB Connector\nUser-agent: *\nDisallow: /private/\n# /PiB Connector" ), 'rendered with markers: ' . $g['robotsTxt'] );

		update_option( 'blog_public', '0' );
		$s = pibt_ok( pibt_call( 'robots/set', array( 'allowSearchEngines' => true ) ), 'allow' );
		pibt_eq( true, $s['blogPublic'], 'blog_public on' );
		pibt_eq( '1', get_option( 'blog_public' ), 'option 1' );

		$u = pibt_ok( pibt_call( 'undo', array( 'changeId' => $s['changeId'] ) ), 'undo allow' );
		pibt_eq( '1', get_option( 'blog_public' ), 'undo never sets blog_public to 0' );
		pibt_eq( 1, count( $u['warnings'] ), 'undo warns' );

		$f = pibt_ok( pibt_call( 'robots/set', array( 'allowSearchEngines' => false, 'extraLines' => null ) ), 'false ignored' );
		pibt_eq( '1', get_option( 'blog_public' ), 'false never discourages' );
		pibt_eq( null, $f['extraLines'], 'extra lines cleared' );
		pibt_assert( ! isset( $GLOBALS['pibt']['options']['pib_connector_robots_extra'] ), 'option removed' );
		foreach ( $GLOBALS['pibt']['options'] as $k => $v ) {
			pibt_assert( ! ( 'blog_public' === $k && '0' === (string) $v ), 'blog_public is never 0' );
		}
	}
);

pibt_test(
	'sitemap exclude ids and Yoast switch',
	function () {
		pibt_pair();
		$GLOBALS['pibt']['adapter'] = 'none';
		pibt_err( pibt_call( 'sitemap/set', array( 'seoPluginSitemap' => false ) ), 422, 'pib_unsupported', 'switch without Yoast' );
		$s = pibt_ok( pibt_call( 'sitemap/set', array( 'excludePostIds' => array( 5, '7', 5 ) ) ), 'exclude' );
		pibt_eq( array( 5, 7 ), $s['excludePostIds'], 'deduplicated ids' );
		pibt_eq( array( 1, 5, 7 ), apply_filters( 'wpseo_exclude_from_sitemap_by_post_ids', array( 1 ) ), 'yoast filter' );
		pibt_eq( array( 5, 7 ), apply_filters( 'rank_math/sitemap/posts_to_exclude', array() ), 'rankmath filter' );
		$args = apply_filters( 'wp_sitemaps_posts_query_args', array( 'post_type' => 'page' ), 'page' );
		pibt_eq( array( 5, 7 ), $args['post__not_in'], 'core filter' );
		pibt_err( pibt_call( 'sitemap/set', array( 'excludePostIds' => array( -1 ) ) ), 400, 'pib_bad_request', 'negative id' );

		$GLOBALS['pibt']['adapter'] = 'yoast';
		update_option( 'wpseo', array( 'enable_xml_sitemap' => true ) );
		$g = pibt_ok( pibt_call( 'sitemap/get' ), 'get' );
		pibt_eq( 'yoast', $g['provider'], 'provider' );
		pibt_eq( 'https://example.test/sitemap_index.xml', $g['url'], 'url' );
		$off = pibt_ok( pibt_call( 'sitemap/set', array( 'seoPluginSitemap' => false ) ), 'switch off' );
		pibt_eq( false, $off['seoPluginSitemap'], 'off' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $off['changeId'] ) ), 'undo' );
		pibt_eq( true, WPSEO_Options::get( 'enable_xml_sitemap' ), 'switch restored' );
	}
);

pibt_test(
	'plugins: input validation and zip top-folder check',
	function () {
		pibt_pair();
		PIB_Connector_Settings::set_features( array_merge( PIB_Connector_Settings::features(), array( 'plugins' => true ) ) );
		$sha = str_repeat( 'a', 64 );
		pibt_err( pibt_call( 'plugins/install', array( 'zipUrl' => 'http://x.example/a.zip', 'sha256' => $sha, 'slug' => 'akismet' ) ), 400, 'pib_bad_request', 'http refused' );
		pibt_err( pibt_call( 'plugins/install', array( 'zipUrl' => 'https://x.example/a.zip', 'sha256' => 'abc', 'slug' => 'akismet' ) ), 400, 'pib_bad_request', 'bad sha' );
		pibt_err( pibt_call( 'plugins/install', array( 'zipUrl' => 'https://x.example/a.zip', 'sha256' => $sha, 'slug' => '../etc' ) ), 400, 'pib_bad_request', 'bad slug' );
		pibt_err( pibt_call( 'plugins/install', array( 'zipUrl' => 'https://x.example/a.zip', 'sha256' => $sha, 'slug' => 'pib-connector' ) ), 403, 'pib_forbidden', 'never itself' );
		pibt_err( pibt_call( 'plugins/rollback', array( 'backupId' => '../../wp-config' ) ), 400, 'pib_bad_request', 'bad backup id' );
		pibt_err( pibt_call( 'plugins/rollback', array( 'backupId' => 'akismet-20260101000000' ) ), 404, 'pib_not_found', 'unknown backup' );
		pibt_eq( array( 'backups' => array() ), pibt_ok( pibt_call( 'plugins/backups' ), 'backups' ), 'no backups' );

		if ( class_exists( 'ZipArchive' ) ) {
			$good = WP_CONTENT_DIR . '/good.zip';
			$zip  = new ZipArchive();
			$zip->open( $good, ZipArchive::CREATE | ZipArchive::OVERWRITE );
			$zip->addFromString( 'akismet/akismet.php', '<?php // Plugin Name: A' );
			$zip->addFromString( 'akismet/readme.txt', 'x' );
			$zip->close();
			pibt_eq( true, PIB_Connector_Plugins::check_zip_top_folder( $good, 'akismet' ), 'good zip' );
			pibt_assert( is_wp_error( PIB_Connector_Plugins::check_zip_top_folder( $good, 'other' ) ), 'wrong slug' );

			$bad = WP_CONTENT_DIR . '/bad.zip';
			$zip = new ZipArchive();
			$zip->open( $bad, ZipArchive::CREATE | ZipArchive::OVERWRITE );
			$zip->addFromString( 'akismet/akismet.php', '<?php' );
			$zip->addFromString( 'akismet/../../evil.php', '<?php' );
			$zip->close();
			pibt_assert( is_wp_error( PIB_Connector_Plugins::check_zip_top_folder( $bad, 'akismet' ) ), 'traversal refused' );
			unlink( $good );
			unlink( $bad );
		}
	}
);

pibt_test(
	'plugin install/rollback cannot be undone with undo',
	function () {
		pibt_pair();
		PIB_Connector_Log::record( 'plugins/install', 'plugins', array( 'slug' => 'akismet' ), null, null, array( 'version' => '5' ) );
		$id = PIB_Connector_Log::all()[0]['changeId'];
		pibt_err( pibt_call( 'undo', array( 'changeId' => $id ) ), 422, 'pib_not_undoable', 'use plugins/rollback' );
	}
);

pibt_test(
	'log ring buffer keeps the newest 200',
	function () {
		pibt_pair();
		for ( $i = 1; $i <= 230; $i++ ) {
			PIB_Connector_Log::record( 'robots/set', 'robots', array( 'n' => $i ), null, null, null );
		}
		pibt_eq( 200, count( get_option( 'pib_connector_log' ) ), 'stored entries capped' );
		$log = pibt_ok( pibt_call( 'log' ), 'log' );
		pibt_eq( 200, count( $log['changes'] ), '200 returned by default' );
		pibt_eq( 230, $log['changes'][0]['target']['n'], 'newest first' );
		pibt_eq( 31, $log['changes'][199]['target']['n'], 'oldest kept' );
		pibt_eq( false, $GLOBALS['pibt']['autoload']['pib_connector_log'], 'log autoload off' );
		pibt_eq( 3, count( pibt_ok( pibt_call( 'log', array( 'limit' => 3 ) ), 'limit' )['changes'] ), 'limit' );
		pibt_eq(
			array( 'changeId', 'at', 'actor', 'endpoint', 'target', 'reason', 'before', 'after', 'undone' ),
			array_keys( $log['changes'][0] ),
			'public shape'
		);
	}
);

pibt_test(
	'key option is stored with autoload off',
	function () {
		PIB_Connector_Settings::set_key( PIBT_KEY );
		pibt_assert( in_array( $GLOBALS['pibt']['autoload']['pib_connector_key'], array( false, 'no' ), true ), 'autoload off' );
		pibt_eq( false, PIB_Connector_Settings::set_key( 'pibc_short' ), 'invalid key refused' );
	}
);
