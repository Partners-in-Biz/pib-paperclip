<?php
/**
 * posts/get, posts/images, posts/img-alt, posts/update, posts/create, posts/publish.
 */

function pibt_c_setup( array $extra = array() ) {
	pibt_pair();
	pibt_add_post(
		10,
		'about',
		'page',
		'publish',
		'About us',
		array_merge(
			array(
				'post_content' => "<!-- wp:paragraph -->\n<p>Hello world.</p>\n<!-- /wp:paragraph -->",
				'post_excerpt' => 'Short about',
			),
			$extra
		)
	);
}

const PIBT_IFRAME = '<iframe src="https://www.youtube.com/embed/abc" width="560"></iframe>';

pibt_test(
	'posts/get: fields, url lookup, drafts, truncation',
	function () {
		pibt_c_setup();
		set_post_thumbnail( 10, 5 );
		$g = pibt_ok( pibt_call( 'posts/get', array( 'postId' => 10 ) ), 'get' );
		pibt_eq( 10, $g['postId'], 'postId' );
		pibt_eq( 'page', $g['postType'], 'type' );
		pibt_eq( 'publish', $g['status'], 'status' );
		pibt_eq( 'https://example.test/about/', $g['url'], 'url' );
		pibt_eq( 'About us', $g['title'], 'title' );
		pibt_eq( 'about', $g['slug'], 'slug' );
		pibt_eq( 'Short about', $g['excerpt'], 'excerpt' );
		pibt_eq( "<!-- wp:paragraph -->\n<p>Hello world.</p>\n<!-- /wp:paragraph -->", $g['content'], 'raw block markup' );
		pibt_eq( '2026-03-01T10:00:00Z', $g['modified'], 'modified' );
		pibt_eq( 5, $g['featuredImageId'], 'featured image' );
		pibt_eq( null, $g['parentId'], 'parent' );
		pibt_eq( false, $g['createdByConnector'], 'not created by connector' );
		pibt_eq( false, $g['truncated'], 'not truncated' );

		$byurl = pibt_ok( pibt_call( 'posts/get', array( 'url' => '/about/' ) ), 'by url' );
		pibt_eq( 10, $byurl['postId'], 'url resolves' );

		pibt_add_post( 12, 'draft-page', 'page', 'draft', 'Draft', array( 'post_content' => 'draft body' ) );
		$d = pibt_ok( pibt_call( 'posts/get', array( 'postId' => 12 ) ), 'draft' );
		pibt_eq( 'draft', $d['status'], 'drafts readable' );

		pibt_add_post( 13, 'big', 'page', 'publish', 'Big', array( 'post_content' => str_repeat( 'a', 600000 ) ) );
		$b = pibt_ok( pibt_call( 'posts/get', array( 'postId' => 13 ) ), 'big' );
		pibt_eq( true, $b['truncated'], 'truncated' );
		pibt_eq( 512000, strlen( $b['content'] ), 'cut at 500 KB' );

		pibt_err( pibt_call( 'posts/get', array( 'postId' => 999 ) ), 422, 'pib_unsupported_target', 'missing' );
		pibt_err( pibt_call( 'posts/get', array() ), 400, 'pib_bad_request', 'no target' );
		pibt_err( pibt_call( 'posts/get', array( 'url' => '/' ) ), 422, 'pib_unsupported_target', 'blog home is not a post' );
		$f            = PIB_Connector_Settings::features();
		$f['content'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'posts/get', array( 'postId' => 10 ) ), 403, 'pib_disabled', 'content switch' );
	}
);

pibt_test(
	'posts/images: every img in order with alt and attachment id',
	function () {
		pibt_add_attachment( 70, 'kitchen.jpg' );
		pibt_add_attachment( 71, 'garden.jpg' );
		$html = '<p>x</p><img src="https://example.test/wp-content/uploads/kitchen.jpg" class="a wp-image-70 b" alt="Kitchen &amp; dining">'
			. '<figure><IMG SRC=\'https://example.test/wp-content/uploads/garden.jpg\' alt=\'\' /></figure>'
			. '<img src="https://other.test/x.png" data-alt="nope" title="alt=trap" width=20>'
			. '<img alt="a > b" src="https://example.test/y.png" class="wp-image-999">';
		pibt_c_setup( array( 'post_content' => $html ) );
		$r = pibt_ok( pibt_call( 'posts/images', array( 'postId' => 10 ) ), 'images' );
		pibt_eq( 10, $r['postId'], 'postId' );
		pibt_eq(
			array(
				array( 'index' => 0, 'src' => 'https://example.test/wp-content/uploads/kitchen.jpg', 'alt' => 'Kitchen & dining', 'attachmentId' => 70 ),
				array( 'index' => 1, 'src' => 'https://example.test/wp-content/uploads/garden.jpg', 'alt' => '', 'attachmentId' => 71 ),
				array( 'index' => 2, 'src' => 'https://other.test/x.png', 'alt' => '', 'attachmentId' => null ),
				array( 'index' => 3, 'src' => 'https://example.test/y.png', 'alt' => 'a > b', 'attachmentId' => null ),
			),
			$r['images'],
			'images'
		);
	}
);

pibt_test(
	'posts/img-alt: only the alt attributes change; undo restores content and library alt',
	function () {
		pibt_add_attachment( 70, 'kitchen.jpg' );
		pibt_add_attachment( 71, 'garden.jpg' );
		update_post_meta( 71, '_wp_attachment_image_alt', 'Library alt' );
		$content = '<p>Intro</p>' . PIBT_IFRAME . "\n"
			. '<img src="https://example.test/wp-content/uploads/kitchen.jpg" class="wp-image-70" alt="old">'
			. '<img src="https://example.test/wp-content/uploads/garden.jpg" class="wp-image-71" />'
			. '<img class="c" src="https://other.test/x.png" title="alt=trap" data-alt="keep">'
			. '<img src="https://other.test/z.png" alt="untouched">';
		pibt_c_setup( array( 'post_content' => $content ) );

		$r = pibt_ok(
			pibt_call(
				'posts/img-alt',
				array(
					'postId' => 10,
					'alts'   => array(
						array( 'index' => 0, 'alt' => 'A "modern" kitchen' ),
						array( 'index' => 1, 'alt' => 'Garden view' ),
						array( 'index' => 2, 'alt' => 'External <b>photo</b>' ),
					),
					'reason' => 'alts',
				)
			),
			'img-alt'
		);
		pibt_eq( 3, $r['updated'], 'updated count' );
		$expected = '<p>Intro</p>' . PIBT_IFRAME . "\n"
			. '<img src="https://example.test/wp-content/uploads/kitchen.jpg" class="wp-image-70" alt="A &quot;modern&quot; kitchen">'
			. '<img src="https://example.test/wp-content/uploads/garden.jpg" class="wp-image-71" alt="Garden view" />'
			. '<img class="c" src="https://other.test/x.png" title="alt=trap" data-alt="keep" alt="External photo">'
			. '<img src="https://other.test/z.png" alt="untouched">';
		pibt_eq( $expected, get_post( 10 )->post_content, 'content differs only in the alt attributes (iframe kept although kses is active)' );
		pibt_eq( array( 'off', 'on' ), $GLOBALS['pibt']['kses_seen'], 'kses filters were switched off around the write and back on' );
		pibt_eq( 'A "modern" kitchen', get_post_meta( 70, '_wp_attachment_image_alt', true ), 'empty library alt gets the new alt' );
		pibt_eq( 'Library alt', get_post_meta( 71, '_wp_attachment_image_alt', true ), 'existing library alt is not overwritten' );

		$imgs = pibt_ok( pibt_call( 'posts/images', array( 'postId' => 10 ) ), 'images' );
		pibt_eq( 'A "modern" kitchen', $imgs['images'][0]['alt'], 'entities decode back to the alt' );

		// Same values again = nothing to do.
		$noop = pibt_ok( pibt_call( 'posts/img-alt', array( 'postId' => 10, 'alts' => array( array( 'index' => 1, 'alt' => 'Garden view' ) ), 'reason' => 'again' ) ), 'noop' );
		pibt_eq( 0, $noop['updated'], 'no-op' );
		pibt_eq( null, $noop['changeId'], 'no change recorded' );

		pibt_ok( pibt_call( 'undo', array( 'changeId' => $r['changeId'] ) ), 'undo' );
		pibt_eq( $content, get_post( 10 )->post_content, 'content restored byte for byte' );
		pibt_assert( ! isset( $GLOBALS['pibt']['meta'][70]['_wp_attachment_image_alt'] ), 'library alt set by the change is undone' );
		pibt_eq( 'Library alt', get_post_meta( 71, '_wp_attachment_image_alt', true ), 'other library alt intact' );
		$log = pibt_ok( pibt_call( 'log', array( 'limit' => 3 ) ), 'log' );
		pibt_eq( 'undo', $log['changes'][0]['endpoint'], 'undo logged' );
		pibt_eq( 'posts/img-alt', $log['changes'][1]['endpoint'], 'change logged' );
		pibt_assert( false === strpos( json_encode( $log ), 'Intro' ), 'post text is not stored in the log' );

		// Validation.
		$a = array( array( 'index' => 0, 'alt' => 'x' ) );
		pibt_err( pibt_call( 'posts/img-alt', array( 'postId' => 10, 'alts' => $a ) ), 400, 'pib_bad_request', 'reason' );
		pibt_err( pibt_call( 'posts/img-alt', array( 'postId' => 10, 'alts' => array(), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'empty' );
		pibt_err( pibt_call( 'posts/img-alt', array( 'postId' => 10, 'alts' => array_fill( 0, 101, $a[0] ), 'reason' => 'r' ) ), 400, 'pib_bad_request', '101' );
		pibt_err( pibt_call( 'posts/img-alt', array( 'postId' => 10, 'alts' => array( array( 'index' => 9, 'alt' => 'x' ) ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'index out of range' );
		pibt_err( pibt_call( 'posts/img-alt', array( 'postId' => 10, 'alts' => array( array( 'index' => -1, 'alt' => 'x' ) ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'negative index' );
		pibt_err( pibt_call( 'posts/img-alt', array( 'postId' => 10, 'alts' => array( array( 'index' => '0', 'alt' => 'x' ) ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'index type' );
		pibt_err( pibt_call( 'posts/img-alt', array( 'postId' => 10, 'alts' => array( $a[0], $a[0] ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'duplicate index' );
		pibt_err( pibt_call( 'posts/img-alt', array( 'postId' => 10, 'alts' => array( array( 'index' => 0, 'alt' => str_repeat( 'a', 301 ) ) ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'alt too long' );
		pibt_eq( $content, get_post( 10 )->post_content, 'failed calls changed nothing' );
	}
);

pibt_test(
	'posts/update: fields, backups, undo, ignored fields, slug warning',
	function () {
		pibt_c_setup();
		$r = pibt_ok(
			pibt_call(
				'posts/update',
				array(
					'postId'   => 10,
					'title'    => 'About <b>our</b> shop',
					'content'  => '<p>New body</p>',
					'excerpt'  => 'New excerpt',
					'slug'     => 'About Our Shop!',
					'status'   => 'trash',
					'author'   => 5,
					'password' => 'x',
					'reason'   => 'rewrite',
				)
			),
			'update'
		);
		pibt_eq( array( 'title', 'content', 'excerpt', 'slug' ), $r['changed'], 'changed fields' );
		$p = get_post( 10 );
		pibt_eq( 'About our shop', $p->post_title, 'title cleaned' );
		pibt_eq( '<p>New body</p>', $p->post_content, 'content' );
		pibt_eq( 'New excerpt', $p->post_excerpt, 'excerpt' );
		pibt_eq( 'about-our-shop', $p->post_name, 'slug sanitized' );
		pibt_eq( 'publish', $p->post_status, 'status ignored' );
		pibt_eq( 0, $p->post_author, 'author ignored' );
		pibt_assert( ! isset( $p->post_password ), 'password ignored' );
		pibt_assert( 1 === count( $r['warnings'] ) && false !== strpos( $r['warnings'][0], 'redirects/set' ), 'slug warning: ' . json_encode( $r['warnings'] ) );

		$backups = get_post_meta( 10, '_pib_content_backups', true );
		pibt_eq( 1, count( $backups ), 'one backup' );
		pibt_eq( 'About us', $backups[0]['title'], 'backup keeps the old title' );
		pibt_assert( false !== strpos( $backups[0]['content'], 'Hello world.' ), 'backup keeps the old content' );
		pibt_eq( 'about', $backups[0]['slug'], 'backup keeps the old slug' );

		$log = pibt_ok( pibt_call( 'log', array( 'limit' => 1 ) ), 'log' );
		pibt_eq( 'posts/update', $log['changes'][0]['endpoint'], 'logged' );
		pibt_eq( 'About us', $log['changes'][0]['before']['title'], 'before title in the log' );
		pibt_eq( 'About our shop', $log['changes'][0]['after']['title'], 'after title in the log' );
		pibt_assert( 0 === strpos( $log['changes'][0]['before']['content'], 'sha256:' ), 'log holds a content digest, not the text' );

		pibt_ok( pibt_call( 'undo', array( 'changeId' => $r['changeId'] ) ), 'undo' );
		$p = get_post( 10 );
		pibt_eq( 'About us', $p->post_title, 'title restored' );
		pibt_eq( "<!-- wp:paragraph -->\n<p>Hello world.</p>\n<!-- /wp:paragraph -->", $p->post_content, 'content restored' );
		pibt_eq( 'Short about', $p->post_excerpt, 'excerpt restored' );
		pibt_eq( 'about', $p->post_name, 'slug restored' );

		// Only the fields that changed are undone.
		$t = pibt_ok( pibt_call( 'posts/update', array( 'postId' => 10, 'title' => 'Only title', 'reason' => 'title' ) ), 'title only' );
		pibt_eq( array( 'title' ), $t['changed'], 'only the title' );
		pibt_eq( array(), $t['warnings'], 'no slug warning' );
		pibt_ok( pibt_call( 'posts/update', array( 'postId' => 10, 'excerpt' => 'Second edit', 'reason' => 'x' ) ), 'excerpt edit' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $t['changeId'] ) ), 'undo title' );
		pibt_eq( 'About us', get_post( 10 )->post_title, 'title back' );
		pibt_eq( 'Second edit', get_post( 10 )->post_excerpt, 'later excerpt edit untouched' );

		// Same values = no-op; excerpt null clears; url works.
		$noop = pibt_ok( pibt_call( 'posts/update', array( 'url' => '/about/', 'title' => 'About us', 'reason' => 'same' ) ), 'noop' );
		pibt_eq( null, $noop['changeId'], 'no change' );
		pibt_eq( array(), $noop['changed'], 'nothing changed' );
		$c = pibt_ok( pibt_call( 'posts/update', array( 'url' => '/about/', 'excerpt' => null, 'reason' => 'clear' ) ), 'clear excerpt' );
		pibt_eq( '', get_post( 10 )->post_excerpt, 'excerpt cleared' );

		// Validation.
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'title' => 'x' ) ), 400, 'pib_bad_request', 'reason required' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'reason' => 'r' ) ), 400, 'pib_bad_request', 'nothing to change' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'title' => '   ', 'reason' => 'r' ) ), 400, 'pib_bad_request', 'empty title' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'title' => str_repeat( 'a', 301 ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'title too long' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => 5, 'reason' => 'r' ) ), 400, 'pib_bad_request', 'content type' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => "bad \xC3\x28 utf8", 'reason' => 'r' ), array( 'body' => '{"postId":10,"reason":"r","content":"' . "bad \xC3\x28" . '"}' ) ), 400, 'pib_bad_request', 'invalid utf-8 body' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => str_repeat( 'a', 300000 ), 'reason' => 'r' ) ), 413, 'pib_too_large', 'request body over 256 KB is refused by the router' );
		$direct = PIB_Connector_Content::endpoint_update( array( 'postId' => 10, 'content' => str_repeat( 'a', 512001 ), 'reason' => 'r' ) );
		pibt_assert( is_wp_error( $direct ) && 'pib_bad_request' === $direct->get_error_code(), 'content over 500 KB refused by the endpoint itself' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'slug' => '!!!', 'reason' => 'r' ) ), 400, 'pib_bad_request', 'slug empty after cleaning' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 999, 'title' => 'x', 'reason' => 'r' ) ), 422, 'pib_unsupported_target', 'missing post' );
		pibt_add_post( 14, 'trashed', 'page', 'trash', 'Trashed' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 14, 'title' => 'x', 'reason' => 'r' ) ), 422, 'pib_unsupported_target', 'trashed post' );
		pibt_add_post( 15, 'huge', 'page', 'publish', 'Huge', array( 'post_content' => str_repeat( 'a', 512001 ) ) );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 15, 'title' => 'x', 'reason' => 'r' ) ), 422, 'pib_unsupported', 'existing content too large to back up' );
	}
);

pibt_test(
	'posts/update: unsafe content is refused, existing embeds survive',
	function () {
		pibt_c_setup( array( 'post_content' => '<p>Watch</p>' . PIBT_IFRAME . '<a onclick="track()" href="javascript:void(0)">old</a>' ) );
		$before = get_post( 10 )->post_content;

		$bad = array(
			'script'         => '<p>x</p><script>alert(1)</script>',
			'script src'     => '<script src="https://evil.example/x.js"></script>',
			'unclosed script' => '<SCRIPT src=x>',
			'iframe'         => '<iframe src="https://evil.example"></iframe>',
			'object'         => '<object data="x.swf"></object>',
			'embed'          => '<embed src="x.swf">',
			'form'           => '<form action="https://evil.example"><input name="p"></form>',
			'javascript url' => '<a href="javascript:alert(1)">x</a>',
			'spaced js url'  => '<a href="java' . "\t" . 'script:alert(1)">x</a>',
			'entity js url'  => '<a href="&#106;avascript:alert(1)">x</a>',
			'onerror'        => '<img src="x" onerror="alert(1)">',
			'onload no space' => '<img src="x"/onload=alert(1)>',
			'onclick quote'  => '<p class="a"onclick=\'x()\'>hi</p>',
			'svg onload'     => '<svg onload="alert(1)"></svg>',
		);
		foreach ( $bad as $label => $html ) {
			pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => $html, 'reason' => 'r' ) ), 422, 'pib_unsafe', "refused: $label" );
			pibt_err( pibt_call( 'posts/create', array( 'title' => 'T', 'content' => $html, 'reason' => 'r' ) ), 422, 'pib_unsafe', "create refused: $label" );
		}
		pibt_eq( $before, get_post( 10 )->post_content, 'nothing written' );
		pibt_eq( '', get_post_meta( 10, '_pib_content_backups', true ), 'no backup for a refused edit' );

		// The same text that is already in the post may stay.
		$keep = '<p>Watch again</p>' . PIBT_IFRAME . '<a onclick="track()" href="javascript:void(0)">old</a>';
		$ok   = pibt_ok( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => $keep, 'reason' => 'edit around embed' ) ), 'edit keeping the embed' );
		pibt_eq( array( 'content' ), $ok['changed'], 'accepted' );
		pibt_eq( $keep, get_post( 10 )->post_content, 'iframe survived the write (kses off during the write)' );

		// A changed or additional embed is refused.
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => str_replace( 'abc', 'zzz', $keep ), 'reason' => 'r' ) ), 422, 'pib_unsafe', 'changed iframe' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => $keep . PIBT_IFRAME . '<iframe src="https://evil.example"></iframe>', 'reason' => 'r' ) ), 422, 'pib_unsafe', 'extra iframe' );
		pibt_err( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => $keep . '<b onmouseover="x()">y</b>', 'reason' => 'r' ) ), 422, 'pib_unsafe', 'extra handler' );
		$e = pibt_call( 'posts/update', array( 'postId' => 10, 'content' => '<form></form>', 'reason' => 'r' ) );
		pibt_assert( false !== strpos( $e[1]['message'], '<form>' ), 'message names the problem' );

		// Harmless look-alikes are fine.
		$fine = pibt_ok( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => '<p>Contact information: on Monday = open, javascripts are fun, <b>iframe</b> is a word</p>' . PIBT_IFRAME . '<a onclick="track()" href="javascript:void(0)">old</a>', 'reason' => 'x' ) ), 'look-alikes' );
		pibt_eq( array( 'content' ), $fine['changed'], 'look-alike text accepted' );
	}
);

pibt_test(
	'posts/update: only the last 5 versions are kept; undo of a rotated-out version is refused',
	function () {
		pibt_c_setup();
		$ids = array();
		for ( $i = 1; $i <= 6; $i++ ) {
			$r     = pibt_ok( pibt_call( 'posts/update', array( 'postId' => 10, 'content' => "<p>v$i</p>", 'reason' => "v$i" ) ), "v$i" );
			$ids[] = $r['changeId'];
		}
		pibt_eq( 5, count( get_post_meta( 10, '_pib_content_backups', true ) ), 'five backups' );
		pibt_err( pibt_call( 'undo', array( 'changeId' => $ids[0] ) ), 422, 'pib_not_undoable', 'oldest backup rotated out' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $ids[5] ) ), 'newest still undoable' );
		pibt_eq( '<p>v5</p>', get_post( 10 )->post_content, 'back to v5' );
		$f            = PIB_Connector_Settings::features();
		$f['content'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'undo', array( 'changeId' => $ids[4] ) ), 403, 'pib_disabled', 'undo needs the feature' );
	}
);

pibt_test(
	'posts/create + posts/publish: drafts only, marker, undo to trash, publish guard',
	function () {
		pibt_c_setup();
		pibt_add_post( 20, 'parent', 'page', 'publish', 'Parent' );
		$c = pibt_ok(
			pibt_call(
				'posts/create',
				array(
					'title'    => 'New landing <em>page</em>',
					'content'  => '<p>Landing</p>',
					'excerpt'  => 'Landing excerpt',
					'slug'     => 'Landing Page',
					'parentId' => 20,
					'reason'   => 'new page',
				)
			),
			'create'
		);
		$id = $c['postId'];
		pibt_eq( 'draft', $c['status'], 'draft' );
		$p = get_post( $id );
		pibt_eq( 'page', $p->post_type, 'default page' );
		pibt_eq( 'draft', $p->post_status, 'stored as draft' );
		pibt_eq( 'New landing page', $p->post_title, 'title' );
		pibt_eq( 'landing-page', $p->post_name, 'slug' );
		pibt_eq( 20, $p->post_parent, 'parent' );
		pibt_eq( '1', get_post_meta( $id, '_pib_created_by_connector', true ), 'marker' );
		pibt_eq( "https://example.test/wp-admin/post.php?post=$id&action=edit", $c['editUrl'], 'edit url' );
		pibt_eq( "https://example.test/?p=$id&preview=true", $c['previewUrl'], 'preview url' );
		pibt_eq( true, pibt_ok( pibt_call( 'posts/get', array( 'postId' => $id ) ), 'get' )['createdByConnector'], 'posts/get reports the marker' );

		// Undo moves it to the trash; it is not deleted.
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $c['changeId'] ) ), 'undo create' );
		pibt_eq( 'trash', get_post( $id )->post_status, 'trashed, still exists' );
		pibt_eq( array( $id ), $GLOBALS['pibt']['trashed'], 'wp_trash_post used' );

		// A post (not a page).
		$post = pibt_ok( pibt_call( 'posts/create', array( 'postType' => 'post', 'title' => 'A post', 'reason' => 'r' ) ), 'create post' );
		pibt_eq( 'post', get_post( $post['postId'] )->post_type, 'post type' );
		pibt_eq( '', get_post( $post['postId'] )->post_content, 'empty content default' );

		// Publish guard.
		pibt_err( pibt_call( 'posts/publish', array( 'postId' => 10, 'reason' => 'r' ) ), 403, 'pib_forbidden', 'not created by the connector' );
		pibt_add_post( 21, 'other-draft', 'page', 'draft', 'Other draft' );
		pibt_err( pibt_call( 'posts/publish', array( 'postId' => 21, 'reason' => 'r' ) ), 403, 'pib_forbidden', 'foreign draft' );
		pibt_err( pibt_call( 'posts/publish', array( 'postId' => 999, 'reason' => 'r' ) ), 422, 'pib_unsupported_target', 'missing' );
		pibt_err( pibt_call( 'posts/publish', array( 'postId' => $post['postId'] ) ), 400, 'pib_bad_request', 'reason required' );
		pibt_err( pibt_call( 'posts/publish', array( 'reason' => 'r' ) ), 400, 'pib_bad_request', 'postId required' );

		$pub = pibt_ok( pibt_call( 'posts/publish', array( 'postId' => $post['postId'], 'reason' => 'go live' ) ), 'publish' );
		pibt_eq( 'publish', $pub['status'], 'status' );
		pibt_eq( 'publish', get_post( $post['postId'] )->post_status, 'published' );
		pibt_assert( 0 === strpos( $pub['url'], 'https://example.test/' ), 'url' );
		pibt_err( pibt_call( 'posts/publish', array( 'postId' => $post['postId'], 'reason' => 'again' ) ), 409, 'pib_conflict', 'already published' );

		// Undo of the create is refused while it is published; undoing the publish first works.
		pibt_err( pibt_call( 'undo', array( 'changeId' => $post['changeId'] ) ), 422, 'pib_not_undoable', 'published page cannot be trashed by undo' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $pub['changeId'] ) ), 'undo publish' );
		pibt_eq( 'draft', get_post( $post['postId'] )->post_status, 'back to draft' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $post['changeId'] ) ), 'now the create can be undone' );
		pibt_eq( 'trash', get_post( $post['postId'] )->post_status, 'trashed' );

		// Create validation.
		pibt_err( pibt_call( 'posts/create', array( 'title' => 'x' ) ), 400, 'pib_bad_request', 'reason required' );
		pibt_err( pibt_call( 'posts/create', array( 'reason' => 'r' ) ), 400, 'pib_bad_request', 'title required' );
		pibt_err( pibt_call( 'posts/create', array( 'title' => 'x', 'postType' => 'product', 'reason' => 'r' ) ), 400, 'pib_bad_request', 'only page or post' );
		pibt_err( pibt_call( 'posts/create', array( 'title' => 'x', 'parentId' => 999, 'reason' => 'r' ) ), 400, 'pib_bad_request', 'unknown parent' );
		pibt_err( pibt_call( 'posts/create', array( 'title' => 'x', 'postType' => 'post', 'parentId' => 20, 'reason' => 'r' ) ), 400, 'pib_bad_request', 'posts have no parent' );
		pibt_err( pibt_call( 'posts/create', array( 'title' => '', 'reason' => 'r' ) ), 400, 'pib_bad_request', 'empty title' );

		$f            = PIB_Connector_Settings::features();
		$f['content'] = false;
		PIB_Connector_Settings::set_features( $f );
		foreach ( array( 'posts/create', 'posts/publish', 'posts/update', 'posts/img-alt', 'posts/images', 'posts/get' ) as $ep ) {
			pibt_err( pibt_call( $ep, array() ), 403, 'pib_disabled', "$ep off" );
		}
	}
);
