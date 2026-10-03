<?php
/**
 * 1.1.0 SEO: term and post type archive targets, ogImage on every adapter, the WooCommerce shop page
 * mirror, and seo/list.
 */

function pibt_t_setup( $adapter ) {
	pibt_pair();
	$GLOBALS['pibt']['adapter'] = $adapter;
	pibt_add_post( 10, 'about', 'page', 'publish', 'About', array( 'post_excerpt' => 'About us summary' ) );
	pibt_add_term( 50, 'category', 'rifles', 'Rifles' );
	pibt_add_term( 51, 'nav_menu', 'main', 'Main' );
	pibt_add_attachment( 60, 'rifle.jpg' );
	pibt_add_attachment( 61, 'hero.jpg' );
}

const PIBT_IMG60 = 'https://example.test/wp-content/uploads/rifle.jpg';
const PIBT_IMG61 = 'https://example.test/wp-content/uploads/hero.jpg';

foreach ( array( 'yoast', 'rankmath', 'none' ) as $pibt_adapter ) {
	pibt_test(
		"term target: set, get, storage and undo ($pibt_adapter)",
		function () use ( $pibt_adapter ) {
			pibt_t_setup( $pibt_adapter );
			$set = pibt_ok(
				pibt_call(
					'seo/set',
					array(
						'termId'        => 50,
						'title'         => 'Rifles for sale',
						'description'   => 'Hunting rifles',
						'canonical'     => 'https://example.test/category/rifles/',
						'noindex'       => true,
						'focusKeyword'  => 'hunting rifles',
						'ogTitle'       => 'OG rifles',
						'ogDescription' => 'OG desc',
						'ogImage'       => PIBT_IMG60,
						'reason'        => 'term seo',
					)
				),
				'term set'
			);
			pibt_eq( 'term', $set['target']['type'], 'term target' );
			pibt_eq( 50, $set['target']['termId'], 'termId' );
			pibt_eq( 'category', $set['target']['taxonomy'], 'taxonomy found' );
			pibt_eq( null, $set['target']['postId'], 'no post id' );
			pibt_eq( 'https://example.test/category/rifles/', $set['target']['url'], 'term url' );
			pibt_eq( 'Rifles', $set['target']['title'], 'term title' );
			pibt_eq( null, $set['before']['title'], 'before empty' );

			$g = pibt_ok( pibt_call( 'seo/get', array( 'termId' => 50, 'taxonomy' => 'category' ) ), 'term get' );
			pibt_eq( 'Rifles for sale', $g['fields']['title'], 'title' );
			pibt_eq( 'Hunting rifles', $g['fields']['description'], 'description' );
			pibt_eq( 'https://example.test/category/rifles/', $g['fields']['canonical'], 'canonical' );
			pibt_eq( true, $g['fields']['noindex'], 'noindex' );
			pibt_eq( 'hunting rifles', $g['fields']['focusKeyword'], 'focus kw' );
			pibt_eq( 'OG rifles', $g['fields']['ogTitle'], 'ogTitle' );
			pibt_eq( PIBT_IMG60, $g['fields']['ogImage'], 'ogImage' );

			if ( 'yoast' === $pibt_adapter ) {
				$row = get_option( 'wpseo_taxonomy_meta' )['category'][50];
				pibt_eq( 'Rifles for sale', $row['wpseo_title'], 'wpseo_title' );
				pibt_eq( 'Hunting rifles', $row['wpseo_desc'], 'wpseo_desc' );
				pibt_eq( 'noindex', $row['wpseo_noindex'], 'wpseo_noindex' );
				pibt_eq( 'hunting rifles', $row['wpseo_focuskw'], 'wpseo_focuskw' );
				pibt_eq( 'OG rifles', $row['wpseo_opengraph-title'], 'og title' );
				pibt_eq( PIBT_IMG60, $row['wpseo_opengraph-image'], 'og image' );
				pibt_eq( '60', $row['wpseo_opengraph-image-id'], 'og image id' );
				pibt_eq( 'https://example.test/category/rifles/', $row['wpseo_canonical'], 'wpseo_canonical' );
				// nofollow does not exist for Yoast terms.
				pibt_err( pibt_call( 'seo/set', array( 'termId' => 50, 'nofollow' => true ) ), 422, 'pib_unsupported', 'yoast term nofollow' );
				pibt_ok( pibt_call( 'seo/set', array( 'termId' => 50, 'nofollow' => null, 'noindex' => false ) ), 'null nofollow is a no-op' );
				pibt_eq( 'index', get_option( 'wpseo_taxonomy_meta' )['category'][50]['wpseo_noindex'], 'noindex false = index' );
				pibt_ok( pibt_call( 'seo/set', array( 'termId' => 50, 'noindex' => true ) ), 'restore noindex' );
			} elseif ( 'rankmath' === $pibt_adapter ) {
				$m = $GLOBALS['pibt']['termmeta'][50];
				pibt_eq( 'Rifles for sale', $m['rank_math_title'], 'rank_math_title' );
				pibt_eq( array( 'noindex' ), $m['rank_math_robots'], 'rank_math_robots' );
				pibt_eq( PIBT_IMG60, $m['rank_math_facebook_image'], 'facebook image' );
				pibt_eq( 60, $m['rank_math_facebook_image_id'], 'facebook image id' );
				$n = pibt_ok( pibt_call( 'seo/set', array( 'termId' => 50, 'nofollow' => true ) ), 'rankmath term nofollow' );
				pibt_eq( true, $n['after']['nofollow'], 'nofollow set' );
				pibt_ok( pibt_call( 'seo/set', array( 'termId' => 50, 'nofollow' => null ) ), 'nofollow cleared' );
			} else {
				$m = $GLOBALS['pibt']['termmeta'][50];
				pibt_eq( 'Rifles for sale', $m['_pib_seo_title'], '_pib_seo_title' );
				pibt_eq( '1', $m['_pib_seo_noindex'], '_pib_seo_noindex' );
				pibt_eq( PIBT_IMG60, $m['_pib_seo_og_image'], '_pib_seo_og_image' );
			}

			// Undo goes back to nothing stored.
			$u = pibt_ok( pibt_call( 'undo', array( 'changeId' => $set['changeId'] ) ), 'undo term' );
			$g = pibt_ok( pibt_call( 'seo/get', array( 'termId' => 50 ) ), 'get after undo' );
			foreach ( $g['fields'] as $field => $value ) {
				pibt_eq( null, $value, "$field back to null after undo" );
			}
			if ( 'yoast' === $pibt_adapter ) {
				pibt_assert( empty( get_option( 'wpseo_taxonomy_meta' ) ), 'taxonomy meta option emptied' );
			}
		}
	);

	pibt_test(
		"archive target: set, get, storage, unsupported fields and undo ($pibt_adapter)",
		function () use ( $pibt_adapter ) {
			pibt_t_setup( $pibt_adapter );
			if ( 'rankmath' === $pibt_adapter ) {
				pibt_err( pibt_call( 'seo/set', array( 'postTypeArchive' => 'product', 'title' => 'x' ) ), 422, 'pib_unsupported', 'rankmath archive set' );
				pibt_err( pibt_call( 'seo/get', array( 'postTypeArchive' => 'product' ) ), 422, 'pib_unsupported', 'rankmath archive get' );
				return;
			}
			$set = pibt_ok(
				pibt_call(
					'seo/set',
					array(
						'postTypeArchive' => 'product',
						'title'           => 'Shop',
						'description'     => 'All products',
						'noindex'         => true,
						'ogTitle'         => 'OG shop',
						'ogDescription'   => 'OG shop desc',
						'ogImage'         => PIBT_IMG61,
						'reason'          => 'archive seo',
					)
				),
				'archive set'
			);
			pibt_eq( 'archive', $set['target']['type'], 'archive target' );
			pibt_eq( 'product', $set['target']['postType'], 'postType' );
			pibt_eq( null, $set['target']['postId'], 'no post id' );
			pibt_eq( 'https://example.test/shop/', $set['target']['url'], 'archive url' );

			if ( 'yoast' === $pibt_adapter ) {
				$t = get_option( 'wpseo_titles' );
				pibt_eq( 'Shop', $t['title-ptarchive-product'], 'title-ptarchive' );
				pibt_eq( 'All products', $t['metadesc-ptarchive-product'], 'metadesc-ptarchive' );
				pibt_eq( true, $t['noindex-ptarchive-product'], 'noindex-ptarchive' );
				pibt_eq( 'OG shop', $t['social-title-ptarchive-product'], 'social-title' );
				pibt_eq( 'OG shop desc', $t['social-description-ptarchive-product'], 'social-description' );
				pibt_eq( PIBT_IMG61, $t['social-image-url-ptarchive-product'], 'social-image-url' );
				pibt_eq( 61, $t['social-image-id-ptarchive-product'], 'social-image-id' );
			} else {
				$o = get_option( 'pib_connector_archive_seo' );
				pibt_eq( 'Shop', $o['product']['title'], 'own archive title' );
				pibt_eq( 1, $o['product']['noindex'], 'own archive noindex' );
				pibt_eq( PIBT_IMG61, $o['product']['ogImage'], 'own archive ogImage' );
			}
			$g = pibt_ok( pibt_call( 'seo/get', array( 'postTypeArchive' => 'product' ) ), 'archive get' );
			pibt_eq( 'Shop', $g['fields']['title'], 'title read' );
			pibt_eq( true, $g['fields']['noindex'], 'noindex read' );
			pibt_eq( PIBT_IMG61, $g['fields']['ogImage'], 'ogImage read' );
			pibt_eq( null, $g['fields']['canonical'], 'canonical null' );

			// canonical, nofollow, focus keyword do not exist for archives.
			pibt_err( pibt_call( 'seo/set', array( 'postTypeArchive' => 'product', 'canonical' => 'https://example.test/shop/' ) ), 422, 'pib_unsupported', 'archive canonical' );
			pibt_err( pibt_call( 'seo/set', array( 'postTypeArchive' => 'product', 'nofollow' => true ) ), 422, 'pib_unsupported', 'archive nofollow' );
			pibt_err( pibt_call( 'seo/set', array( 'postTypeArchive' => 'product', 'focusKeyword' => 'x' ) ), 422, 'pib_unsupported', 'archive focus keyword' );
			pibt_err( pibt_call( 'seo/set', array( 'postTypeArchive' => 'product', 'canonical' => null ) ), 400, 'pib_bad_request', 'only unsupported clears = nothing to store' );

			// The archive is also found by its URL.
			$byurl = pibt_ok( pibt_call( 'seo/get', array( 'url' => 'https://example.test/shop' ) ), 'archive by url' );
			pibt_eq( 'archive', $byurl['target']['type'], 'url fallback → archive' );

			pibt_ok( pibt_call( 'undo', array( 'changeId' => $set['changeId'] ) ), 'undo archive' );
			$g = pibt_ok( pibt_call( 'seo/get', array( 'postTypeArchive' => 'product' ) ), 'archive after undo' );
			foreach ( $g['fields'] as $field => $value ) {
				pibt_eq( null, $value, "$field null after undo" );
			}
		}
	);

	pibt_test(
		"ogImage round trip on posts and the home page ($pibt_adapter)",
		function () use ( $pibt_adapter ) {
			pibt_t_setup( $pibt_adapter );
			$a = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'ogImage' => PIBT_IMG61, 'reason' => 'og' ) ), 'post ogImage' );
			pibt_eq( PIBT_IMG61, $a['after']['ogImage'], 'after' );
			pibt_eq( null, $a['before']['ogImage'], 'before' );
			$meta = $GLOBALS['pibt']['meta'][10];
			if ( 'yoast' === $pibt_adapter ) {
				pibt_eq( PIBT_IMG61, $meta['_yoast_wpseo_opengraph-image'], 'yoast image' );
				pibt_eq( 61, $meta['_yoast_wpseo_opengraph-image-id'], 'yoast image id' );
			} elseif ( 'rankmath' === $pibt_adapter ) {
				pibt_eq( PIBT_IMG61, $meta['rank_math_facebook_image'], 'rankmath image' );
				pibt_eq( 61, $meta['rank_math_facebook_image_id'], 'rankmath image id' );
			} else {
				pibt_eq( PIBT_IMG61, $meta['_pib_seo_og_image'], 'own image' );
			}
			$g = pibt_ok( pibt_call( 'seo/get', array( 'postId' => 10 ) ), 'get' );
			pibt_eq( PIBT_IMG61, $g['fields']['ogImage'], 'read back' );

			// Site-relative path becomes absolute, a non-library URL stores no id.
			$b = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'ogImage' => '/wp-content/uploads/other.jpg' ) ), 'relative' );
			pibt_eq( 'https://example.test/wp-content/uploads/other.jpg', $b['after']['ogImage'], 'absolute' );
			if ( 'yoast' === $pibt_adapter ) {
				pibt_assert( ! isset( $GLOBALS['pibt']['meta'][10]['_yoast_wpseo_opengraph-image-id'] ), 'no id for unknown file' );
			}

			// Undo the second write, then clear.
			pibt_ok( pibt_call( 'undo', array( 'changeId' => $b['changeId'] ) ), 'undo' );
			$g = pibt_ok( pibt_call( 'seo/get', array( 'postId' => 10 ) ), 'get after undo' );
			pibt_eq( PIBT_IMG61, $g['fields']['ogImage'], 'undo restores previous image' );
			$c = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'ogImage' => null ) ), 'clear' );
			pibt_eq( null, $c['after']['ogImage'], 'cleared' );
			if ( 'yoast' === $pibt_adapter ) {
				pibt_assert( ! isset( $GLOBALS['pibt']['meta'][10]['_yoast_wpseo_opengraph-image-id'] ), 'id cleared' );
			}
			$u = pibt_ok( pibt_call( 'undo', array( 'changeId' => $c['changeId'] ) ), 'undo clear' );
			$g = pibt_ok( pibt_call( 'seo/get', array( 'postId' => 10 ) ), 'get after undo clear' );
			pibt_eq( PIBT_IMG61, $g['fields']['ogImage'], 'undo of a clear restores the image' );

			// Validation.
			pibt_err( pibt_call( 'seo/set', array( 'postId' => 10, 'ogImage' => 'http://example.test/a.jpg' ) ), 400, 'pib_bad_request', 'http refused' );
			pibt_err( pibt_call( 'seo/set', array( 'postId' => 10, 'ogImage' => 'javascript:alert(1)' ) ), 400, 'pib_bad_request', 'javascript refused' );
			pibt_err( pibt_call( 'seo/set', array( 'postId' => 10, 'ogImage' => '//evil.example/a.jpg' ) ), 400, 'pib_bad_request', 'protocol-relative refused' );
			pibt_err( pibt_call( 'seo/set', array( 'postId' => 10, 'ogImage' => 5 ) ), 400, 'pib_bad_request', 'non-string refused' );

			// Home page.
			$h = pibt_ok( pibt_call( 'seo/set', array( 'url' => '/', 'ogImage' => PIBT_IMG61 ) ), 'home ogImage' );
			pibt_eq( 'home', $h['target']['type'], 'home' );
			pibt_eq( PIBT_IMG61, $h['after']['ogImage'], 'home after' );
			if ( 'yoast' === $pibt_adapter ) {
				pibt_eq( PIBT_IMG61, get_option( 'wpseo_titles' )['open_graph_frontpage_image'], 'open_graph_frontpage_image' );
				pibt_eq( 61, get_option( 'wpseo_titles' )['open_graph_frontpage_image_id'], 'open_graph_frontpage_image_id' );
			} elseif ( 'rankmath' === $pibt_adapter ) {
				pibt_eq( PIBT_IMG61, get_option( 'rank-math-options-titles' )['homepage_facebook_image'], 'homepage_facebook_image' );
				pibt_eq( 61, get_option( 'rank-math-options-titles' )['homepage_facebook_image_id'], 'homepage_facebook_image_id' );
			} else {
				pibt_eq( PIBT_IMG61, get_option( 'pib_connector_home_seo' )['ogImage'], 'own home ogImage' );
			}
			$hg = pibt_ok( pibt_call( 'seo/get', array( 'url' => '/' ) ), 'home get' );
			pibt_eq( PIBT_IMG61, $hg['fields']['ogImage'], 'home read back' );
			pibt_ok( pibt_call( 'undo', array( 'changeId' => $h['changeId'] ) ), 'home undo' );
			$hg = pibt_ok( pibt_call( 'seo/get', array( 'url' => '/' ) ), 'home get after undo' );
			pibt_eq( null, $hg['fields']['ogImage'], 'home ogImage undone' );
		}
	);
}

pibt_test(
	'term and archive targets: resolution and refusals',
	function () {
		pibt_t_setup( 'none' );
		$byurl = pibt_ok( pibt_call( 'seo/get', array( 'url' => '/category/rifles/' ) ), 'term by url' );
		pibt_eq( 'term', $byurl['target']['type'], 'term by url' );
		pibt_eq( 50, $byurl['target']['termId'], 'termId by url' );
		$abs = pibt_ok( pibt_call( 'seo/get', array( 'url' => 'https://example.test/category/rifles' ) ), 'no trailing slash' );
		pibt_eq( 50, $abs['target']['termId'], 'trailing slash ignored' );
		pibt_err( pibt_call( 'seo/get', array( 'url' => '/category/pistols/' ) ), 422, 'pib_unsupported_target', 'unknown term url' );
		pibt_err( pibt_call( 'seo/get', array( 'url' => '/tag/rifles/' ) ), 422, 'pib_unsupported_target', 'slug matches but path differs' );
		pibt_err( pibt_call( 'seo/get', array( 'termId' => 999 ) ), 422, 'pib_unsupported_target', 'missing term' );
		pibt_err( pibt_call( 'seo/get', array( 'termId' => 50, 'taxonomy' => 'post_tag' ) ), 422, 'pib_unsupported_target', 'wrong taxonomy' );
		pibt_err( pibt_call( 'seo/get', array( 'termId' => 51 ) ), 422, 'pib_unsupported_target', 'non-public taxonomy' );
		pibt_err( pibt_call( 'seo/get', array( 'termId' => 51, 'taxonomy' => 'nav_menu' ) ), 422, 'pib_unsupported_target', 'non-public taxonomy explicit' );
		pibt_err( pibt_call( 'seo/get', array( 'termId' => 'x' ) ), 400, 'pib_bad_request', 'bad termId' );
		pibt_err( pibt_call( 'seo/get', array( 'termId' => 50, 'taxonomy' => '../x' ) ), 400, 'pib_bad_request', 'bad taxonomy' );
		pibt_err( pibt_call( 'seo/get', array( 'postTypeArchive' => 'book' ) ), 422, 'pib_unsupported_target', 'post type without archive' );
		pibt_err( pibt_call( 'seo/get', array( 'postTypeArchive' => 'nope' ) ), 422, 'pib_unsupported_target', 'unknown post type' );
		pibt_err( pibt_call( 'seo/get', array( 'postTypeArchive' => '../x' ) ), 400, 'pib_bad_request', 'bad post type' );
		pibt_err( pibt_call( 'seo/get', array( 'termId' => 50, 'postId' => 10 ) ), 400, 'pib_bad_request', 'two targets' );
		// Posts still resolve exactly as before.
		$p = pibt_ok( pibt_call( 'seo/get', array( 'url' => '/about/' ) ), 'post' );
		pibt_eq( 10, $p['target']['postId'], 'post target unchanged' );
		// Schema keeps the old rule: terms are not schema targets.
		pibt_err( pibt_call( 'schema/get', array( 'url' => '/category/rifles/' ) ), 422, 'pib_unsupported_target', 'schema has no term targets' );
	}
);

pibt_test(
	'no SEO plugin: term and archive head output, og:image with featured image fallback',
	function () {
		pibt_t_setup( 'none' );
		pibt_ok( pibt_call( 'seo/set', array( 'termId' => 50, 'title' => 'Rifles', 'description' => 'Term desc', 'ogImage' => PIBT_IMG60 ) ), 'term' );
		$GLOBALS['pibt']['query'] = array( 'front_page' => false, 'home' => false, 'singular' => false, 'id' => 0, 'term' => 50 );
		pibt_eq( 'Rifles', apply_filters( 'pre_get_document_title', '' ), 'term title' );
		ob_start();
		PIB_Connector_SEO::print_head();
		$html = ob_get_clean();
		pibt_assert( false !== strpos( $html, 'content="Term desc"' ), 'term description printed' );
		pibt_assert( false !== strpos( $html, '<meta property="og:image" content="' . PIBT_IMG60 . '" />' ), 'og:image printed' );
		pibt_assert( false !== strpos( $html, '<meta name="twitter:image" content="' . PIBT_IMG60 . '" />' ), 'twitter:image printed' );

		pibt_ok( pibt_call( 'seo/set', array( 'postTypeArchive' => 'product', 'title' => 'Shop', 'description' => 'Archive desc' ) ), 'archive' );
		$GLOBALS['pibt']['query'] = array( 'front_page' => false, 'home' => false, 'singular' => false, 'id' => 0, 'archive' => 'product' );
		pibt_eq( 'Shop', apply_filters( 'pre_get_document_title', '' ), 'archive title' );

		// Post without ogImage: featured image is used.
		set_post_thumbnail( 10, 60 );
		$GLOBALS['pibt']['query'] = array( 'front_page' => false, 'home' => false, 'singular' => true, 'id' => 10 );
		ob_start();
		PIB_Connector_SEO::print_head();
		$html = ob_get_clean();
		pibt_assert( false !== strpos( $html, 'property="og:image" content="' . PIBT_IMG60 . '"' ), 'featured image fallback: ' . $html );
		pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'ogImage' => PIBT_IMG61 ) ), 'explicit' );
		ob_start();
		PIB_Connector_SEO::print_head();
		$html = ob_get_clean();
		pibt_assert( false !== strpos( $html, 'property="og:image" content="' . PIBT_IMG61 . '"' ), 'explicit ogImage wins' );
		pibt_assert( false === strpos( $html, PIBT_IMG60 ), 'featured image not printed too' );
	}
);

pibt_test(
	'WooCommerce: health block and the shop page mirrors into the product archive settings (Yoast)',
	function () {
		pibt_t_setup( 'yoast' );
		pibt_add_post( 11, 'shop', 'page', 'publish', 'Shop' );
		$h = pibt_ok( pibt_call( 'health' ), 'health without woo' );
		pibt_eq( array( 'active' => false, 'version' => null, 'shopPageId' => null ), $h['woocommerce'], 'woocommerce inactive' );

		if ( ! function_exists( 'wc_get_page_id' ) ) {
			function wc_get_page_id( $page ) {
				return 'shop' === $page ? (int) $GLOBALS['pibt']['shop_page'] : -1;
			}
		}
		if ( ! defined( 'WC_VERSION' ) ) {
			define( 'WC_VERSION', '9.9.9' );
		}
		$GLOBALS['pibt']['shop_page'] = 11;
		$h = pibt_ok( pibt_call( 'health' ), 'health with woo' );
		pibt_eq( array( 'active' => true, 'version' => '9.9.9', 'shopPageId' => 11 ), $h['woocommerce'], 'woocommerce active' );

		$set = pibt_ok(
			pibt_call(
				'seo/set',
				array(
					'postId'        => 11,
					'title'         => 'Shop title',
					'description'   => 'Shop description',
					'ogTitle'       => 'OG shop',
					'ogDescription' => 'OG shop desc',
					'ogImage'       => PIBT_IMG61,
					'noindex'       => true,
					'reason'        => 'shop',
				)
			),
			'shop set'
		);
		pibt_assert( in_array( 'shop page: also written to the product archive settings', $set['warnings'], true ), 'warning present' );
		$t = get_option( 'wpseo_titles' );
		pibt_eq( 'Shop title', $t['title-ptarchive-product'], 'archive title mirrored' );
		pibt_eq( 'Shop description', $t['metadesc-ptarchive-product'], 'archive description mirrored' );
		pibt_eq( 'OG shop', $t['social-title-ptarchive-product'], 'archive og title' );
		pibt_eq( PIBT_IMG61, $t['social-image-url-ptarchive-product'], 'archive og image' );
		pibt_eq( 61, $t['social-image-id-ptarchive-product'], 'archive og image id' );
		pibt_assert( ! isset( $t['noindex-ptarchive-product'] ), 'noindex is not mirrored' );
		pibt_eq( 'Shop title', $GLOBALS['pibt']['meta'][11]['_yoast_wpseo_title'], 'page meta written too' );

		$g = pibt_ok( pibt_call( 'seo/get', array( 'postId' => 11 ) ), 'shop get' );
		pibt_eq( 'Shop title', $g['fields']['title'], 'page value' );
		pibt_eq( 'Shop description', $g['archive']['description'], 'archive values returned' );
		$other = pibt_ok( pibt_call( 'seo/get', array( 'postId' => 10 ) ), 'other page' );
		pibt_assert( ! array_key_exists( 'archive', $other ), 'no archive block for other pages' );

		// A non-shop page is not mirrored.
		$before = get_option( 'wpseo_titles' );
		$o      = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'title' => 'About title' ) ), 'other page set' );
		pibt_eq( array(), $o['warnings'], 'no warning' );
		pibt_eq( $before, get_option( 'wpseo_titles' ), 'archive untouched' );

		// Undo restores the page and the archive.
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $set['changeId'] ) ), 'undo shop' );
		$t = get_option( 'wpseo_titles' );
		pibt_eq( '', $t['title-ptarchive-product'], 'archive title back to empty' );
		pibt_eq( '', $t['social-image-url-ptarchive-product'], 'archive image back to empty' );
		$g = pibt_ok( pibt_call( 'seo/get', array( 'postId' => 11 ) ), 'shop after undo' );
		pibt_eq( null, $g['fields']['title'], 'page title undone' );
		pibt_eq( null, $g['archive']['title'], 'archive title undone' );

		// Live finding (Yoast 28.6 + WooCommerce 11): the shop page is rendered from the page's own
		// post meta, so a product archive write is mirrored to the page, and the shop URL resolves
		// to the page, not to the archive.
		$byurl = pibt_ok( pibt_call( 'seo/get', array( 'url' => 'https://example.test/shop' ) ), 'shop url' );
		pibt_eq( 'post', $byurl['target']['type'], 'shop url resolves to the shop page' );
		pibt_eq( 11, $byurl['target']['postId'], 'shop page id' );
		$as = pibt_ok( pibt_call( 'seo/set', array( 'postTypeArchive' => 'product', 'title' => 'Archive first', 'ogImage' => PIBT_IMG61 ) ), 'archive set' );
		pibt_assert( in_array( 'product archive: also written to the shop page', $as['warnings'], true ), 'archive mirror warning' );
		pibt_eq( 'Archive first', $GLOBALS['pibt']['meta'][11]['_yoast_wpseo_title'], 'shop page meta written from the archive' );
		pibt_eq( PIBT_IMG61, $GLOBALS['pibt']['meta'][11]['_yoast_wpseo_opengraph-image'], 'shop page og image' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $as['changeId'] ) ), 'undo archive set' );
		pibt_assert( empty( $GLOBALS['pibt']['meta'][11]['_yoast_wpseo_title'] ), 'shop page title undone from the archive change' );

		// Only Yoast mirrors.
		$GLOBALS['pibt']['adapter'] = 'rankmath';
		$rm = pibt_ok( pibt_call( 'seo/set', array( 'postId' => 11, 'title' => 'RM shop' ) ), 'rankmath shop' );
		pibt_eq( array(), $rm['warnings'], 'no mirroring with rankmath' );
	}
);

pibt_test(
	'seo/list: fields, missing, filters and paging',
	function () {
		pibt_t_setup( 'yoast' );
		pibt_add_post( 13, 'contact', 'page', 'publish', 'Contact' );
		pibt_add_post( 14, 'team', 'page', 'draft', 'Team' );
		pibt_add_post( 15, 'blog-post', 'post', 'publish', 'Blog post' );
		pibt_ok( pibt_call( 'seo/set', array( 'postId' => 10, 'title' => 'About us', 'description' => 'About desc', 'ogImage' => PIBT_IMG61 ) ), 'seed' );
		set_post_thumbnail( 13, 60 );
		update_post_meta( 13, '_yoast_wpseo_title', 'Contact us' );

		$l = pibt_ok( pibt_call( 'seo/list' ), 'list' );
		pibt_eq( 2, $l['total'], 'only published pages by default' );
		pibt_eq( 1, $l['page'], 'page' );
		pibt_eq( 50, $l['perPage'], 'perPage' );
		$by = array();
		foreach ( $l['items'] as $item ) {
			$by[ $item['postId'] ] = $item;
		}
		pibt_eq( array(), $by[10]['missing'], 'about is complete' );
		pibt_eq( 'About us', $by[10]['fields']['title'], 'fields' );
		pibt_eq( 'page', $by[10]['postType'], 'postType' );
		pibt_eq( 'about', $by[10]['slug'], 'slug' );
		pibt_eq( 'publish', $by[10]['status'], 'status' );
		pibt_eq( '2026-03-01T10:00:00Z', $by[10]['modified'], 'modified' );
		pibt_eq( null, $by[10]['featuredImageId'], 'no featured image' );
		pibt_eq( array( 'description' ), $by[13]['missing'], 'contact: featured image covers ogImage, description missing' );
		pibt_eq( 60, $by[13]['featuredImageId'], 'featured image id' );
		pibt_eq( 'https://example.test/contact/', $by[13]['url'], 'url' );

		// The page title alone is not a description, an excerpt is.
		$e = pibt_ok( pibt_call( 'seo/list', array( 'missing' => array( 'title' ) ) ), 'missing title' );
		pibt_eq( array(), array_column( $e['items'], 'postId' ), 'all published pages have a title override' );
		update_post_meta( 10, '_yoast_wpseo_title', '' );
		$e = pibt_ok( pibt_call( 'seo/list', array( 'missing' => array( 'title' ) ) ), 'missing title 2' );
		pibt_eq( array( 10 ), array_column( $e['items'], 'postId' ), 'about has lost its title override' );
		pibt_eq( 1, $e['total'], 'total counts the filtered set' );

		$d = pibt_ok( pibt_call( 'seo/list', array( 'missing' => array( 'description', 'ogImage' ) ) ), 'missing description or ogImage' );
		pibt_eq( array( 13 ), array_column( $d['items'], 'postId' ), 'only contact' );
		pibt_add_post( 16, 'services', 'page', 'publish', 'Services', array( 'post_excerpt' => 'We do things' ) );
		$d = pibt_ok( pibt_call( 'seo/list', array( 'missing' => array( 'description' ) ) ), 'missing description' );
		pibt_eq( array( 13 ), array_column( $d['items'], 'postId' ), 'excerpt counts as a description' );

		$draft = pibt_ok( pibt_call( 'seo/list', array( 'status' => 'draft' ) ), 'drafts' );
		pibt_eq( array( 14 ), array_column( $draft['items'], 'postId' ), 'draft pages' );
		$posts = pibt_ok( pibt_call( 'seo/list', array( 'postType' => 'post' ) ), 'posts' );
		pibt_eq( array( 15 ), array_column( $posts['items'], 'postId' ), 'posts' );
		$q = pibt_ok( pibt_call( 'seo/list', array( 'search' => 'cont' ) ), 'search' );
		pibt_eq( array( 13 ), array_column( $q['items'], 'postId' ), 'search' );

		$p1 = pibt_ok( pibt_call( 'seo/list', array( 'perPage' => 2, 'page' => 1 ) ), 'page 1' );
		$p2 = pibt_ok( pibt_call( 'seo/list', array( 'perPage' => 2, 'page' => 2 ) ), 'page 2' );
		pibt_eq( 3, $p1['total'], 'total' );
		pibt_eq( 2, count( $p1['items'] ), 'page 1 size' );
		pibt_eq( 1, count( $p2['items'] ), 'page 2 size' );

		pibt_err( pibt_call( 'seo/list', array( 'perPage' => 101 ) ), 400, 'pib_bad_request', 'perPage max' );
		pibt_err( pibt_call( 'seo/list', array( 'page' => 0 ) ), 400, 'pib_bad_request', 'page min' );
		pibt_err( pibt_call( 'seo/list', array( 'missing' => array( 'nope' ) ) ), 400, 'pib_bad_request', 'bad missing' );
		pibt_err( pibt_call( 'seo/list', array( 'missing' => 'title' ) ), 400, 'pib_bad_request', 'missing must be a list' );
		pibt_err( pibt_call( 'seo/list', array( 'status' => 'trash' ) ), 400, 'pib_bad_request', 'bad status' );
		pibt_err( pibt_call( 'seo/list', array( 'postType' => 'nope' ) ), 400, 'pib_bad_request', 'bad post type' );

		$f        = PIB_Connector_Settings::features();
		$f['seo'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'seo/list' ), 403, 'pib_disabled', 'seo/list follows the seo switch' );
	}
);
