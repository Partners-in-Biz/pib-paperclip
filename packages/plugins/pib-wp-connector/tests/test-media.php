<?php
/**
 * media/list, media/sideload, media/set-featured, media/alt.
 */

const PIBT_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PIBT_GIF_B64 = 'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

function pibt_m_setup() {
	pibt_pair();
	pibt_add_post( 10, 'about', 'page', 'publish', 'About' );
	pibt_add_post( 11, 'contact', 'page', 'publish', 'Contact' );
}

pibt_test(
	'media/list: filters, missingAlt, postId, paging',
	function () {
		pibt_m_setup();
		pibt_add_attachment( 70, 'kitchen.jpg', 'image/jpeg', 10 );
		pibt_add_attachment( 71, 'garden.png', 'image/png', 0 );
		pibt_add_attachment( 72, 'brochure.pdf', 'application/pdf', 10 );
		pibt_add_attachment( 73, 'hero.jpg', 'image/jpeg', 0 );
		update_post_meta( 71, '_wp_attachment_image_alt', 'A garden' );
		update_post_meta( 70, '_wp_attachment_metadata', array( 'width' => 800, 'height' => 600, 'filesize' => 12345 ) );
		set_post_thumbnail( 10, 73 );

		$l = pibt_ok( pibt_call( 'media/list' ), 'list' );
		pibt_eq( 3, $l['total'], 'pdf excluded' );
		pibt_eq( 'image', explode( '/', $l['items'][0]['mime'] )[0], 'images only' );
		$by = array();
		foreach ( $l['items'] as $i ) {
			$by[ $i['attachmentId'] ] = $i;
		}
		pibt_eq( 'https://example.test/wp-content/uploads/kitchen.jpg', $by[70]['url'], 'url' );
		pibt_eq( 800, $by[70]['width'], 'width' );
		pibt_eq( 600, $by[70]['height'], 'height' );
		pibt_eq( 12345, $by[70]['filesize'], 'filesize' );
		pibt_eq( 10, $by[70]['parentId'], 'parent' );
		pibt_eq( null, $by[71]['parentId'], 'no parent' );
		pibt_eq( 'A garden', $by[71]['alt'], 'alt' );
		pibt_eq( '', $by[70]['alt'], 'empty alt' );
		pibt_eq( 'image/png', $by[71]['mime'], 'mime' );

		$m = pibt_ok( pibt_call( 'media/list', array( 'missingAlt' => true ) ), 'missing alt' );
		pibt_eq( array( 70, 73 ), array_column( $m['items'], 'attachmentId' ), 'missing alt only' );
		pibt_eq( 2, $m['total'], 'missing alt total' );

		$post = pibt_ok( pibt_call( 'media/list', array( 'postId' => 10 ) ), 'postId' );
		pibt_eq( array( 70, 73 ), array_column( $post['items'], 'attachmentId' ), 'attached image plus featured image' );

		$s = pibt_ok( pibt_call( 'media/list', array( 'search' => 'garden', 'mime' => 'image' ) ), 'search' );
		pibt_eq( array( 71 ), array_column( $s['items'], 'attachmentId' ), 'search' );

		$p = pibt_ok( pibt_call( 'media/list', array( 'perPage' => 2, 'page' => 2 ) ), 'page 2' );
		pibt_eq( 1, count( $p['items'] ), 'second page' );
		pibt_eq( 3, $p['total'], 'total' );

		pibt_err( pibt_call( 'media/list', array( 'perPage' => 500 ) ), 400, 'pib_bad_request', 'perPage max' );
		pibt_err( pibt_call( 'media/list', array( 'mime' => 'video' ) ), 400, 'pib_bad_request', 'mime' );
		pibt_err( pibt_call( 'media/list', array( 'missingAlt' => 'yes' ) ), 400, 'pib_bad_request', 'missingAlt type' );
		pibt_err( pibt_call( 'media/list', array( 'postId' => 'x' ) ), 400, 'pib_bad_request', 'postId type' );
	}
);

pibt_test(
	'media/alt: update, clear, undo and validation',
	function () {
		pibt_m_setup();
		pibt_add_attachment( 70, 'kitchen.jpg' );
		pibt_add_attachment( 71, 'garden.jpg' );
		pibt_add_attachment( 72, 'brochure.pdf', 'application/pdf' );
		update_post_meta( 71, '_wp_attachment_image_alt', 'Old alt' );

		$r = pibt_ok(
			pibt_call(
				'media/alt',
				array(
					'items'  => array(
						array( 'attachmentId' => 70, 'alt' => 'A <b>modern</b> kitchen' ),
						array( 'attachmentId' => 71, 'alt' => '' ),
					),
					'reason' => 'alt text',
				)
			),
			'alt'
		);
		pibt_eq( 'A modern kitchen', get_post_meta( 70, '_wp_attachment_image_alt', true ), 'alt stored, tags stripped' );
		pibt_assert( ! isset( $GLOBALS['pibt']['meta'][71]['_wp_attachment_image_alt'] ), 'empty alt clears the meta' );
		pibt_eq(
			array(
				array( 'attachmentId' => 70, 'before' => '', 'after' => 'A modern kitchen' ),
				array( 'attachmentId' => 71, 'before' => 'Old alt', 'after' => '' ),
			),
			$r['updated'],
			'updated list'
		);

		pibt_ok( pibt_call( 'undo', array( 'changeId' => $r['changeId'] ) ), 'undo' );
		pibt_assert( ! isset( $GLOBALS['pibt']['meta'][70]['_wp_attachment_image_alt'] ), 'first restored to empty' );
		pibt_eq( 'Old alt', get_post_meta( 71, '_wp_attachment_image_alt', true ), 'second restored' );

		$ok = array( array( 'attachmentId' => 70, 'alt' => 'x' ) );
		pibt_err( pibt_call( 'media/alt', array( 'items' => $ok ) ), 400, 'pib_bad_request', 'reason required' );
		pibt_err( pibt_call( 'media/alt', array( 'items' => array(), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'empty list' );
		pibt_err( pibt_call( 'media/alt', array( 'items' => array_fill( 0, 51, $ok[0] ), 'reason' => 'r' ) ), 400, 'pib_bad_request', '51 items' );
		pibt_err( pibt_call( 'media/alt', array( 'items' => array( array( 'attachmentId' => 72, 'alt' => 'x' ) ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'not an image' );
		pibt_err( pibt_call( 'media/alt', array( 'items' => array( array( 'attachmentId' => 10, 'alt' => 'x' ) ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'not an attachment' );
		pibt_err( pibt_call( 'media/alt', array( 'items' => array( array( 'attachmentId' => 70, 'alt' => str_repeat( 'a', 301 ) ) ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'alt too long' );
		pibt_err( pibt_call( 'media/alt', array( 'items' => array( array( 'attachmentId' => 70, 'alt' => 5 ) ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'alt type' );
		pibt_err( pibt_call( 'media/alt', array( 'items' => array( $ok[0], $ok[0] ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'duplicate' );
		pibt_err( pibt_call( 'media/alt', array( 'items' => array( array( 'attachmentId' => 70 ) ), 'reason' => 'r' ) ), 400, 'pib_bad_request', 'missing alt key' );
		pibt_assert( ! isset( $GLOBALS['pibt']['meta'][70]['_wp_attachment_image_alt'] ), 'nothing written by failed calls' );
	}
);

pibt_test(
	'media/sideload: import, alt, parent, reuse, and it is not undoable',
	function () {
		pibt_m_setup();
		$url = 'https://cdn.example.test/img/photo.jpeg?v=2';
		$GLOBALS['pibt']['downloads'][ $url ] = base64_decode( PIBT_PNG_B64 );

		$r = pibt_ok( pibt_call( 'media/sideload', array( 'imageUrl' => $url, 'title' => 'The <i>photo</i>', 'alt' => 'A photo', 'postId' => 10, 'reason' => 'add image' ) ), 'sideload' );
		pibt_eq( false, $r['reused'], 'new' );
		$id = $r['attachmentId'];
		$p  = get_post( $id );
		pibt_eq( 'attachment', $p->post_type, 'attachment created' );
		pibt_eq( 'image/png', $p->post_mime_type, 'real mime type wins over the .jpeg extension' );
		pibt_eq( 'photo.png', $GLOBALS['pibt']['sideloaded'][ $id ], 'extension follows the mime type' );
		pibt_eq( 'The photo', $p->post_title, 'title cleaned' );
		pibt_eq( 10, $p->post_parent, 'attached to the post' );
		pibt_eq( 'A photo', get_post_meta( $id, '_wp_attachment_image_alt', true ), 'alt' );
		pibt_eq( $url, get_post_meta( $id, '_pib_source_url', true ), 'source url kept' );
		pibt_eq( 0, get_post_thumbnail_id( 10 ), 'featured image untouched' );
		pibt_eq( wp_get_attachment_url( $id ), $r['url'], 'url' );

		$again = pibt_ok( pibt_call( 'media/sideload', array( 'imageUrl' => $url ) ), 'sideload again' );
		pibt_eq( true, $again['reused'], 'reused' );
		pibt_eq( $id, $again['attachmentId'], 'same attachment' );
		pibt_eq( 1, count( $GLOBALS['pibt']['download_calls'] ), 'not downloaded a second time' );

		pibt_err( pibt_call( 'undo', array( 'changeId' => $r['changeId'] ) ), 422, 'pib_not_undoable', 'sideload is additive' );
		$log = pibt_ok( pibt_call( 'log', array( 'limit' => 2 ) ), 'log' );
		pibt_eq( 'media/sideload', $log['changes'][0]['endpoint'], 'logged' );

		// Custom filename and gif.
		$g = 'https://cdn.example.test/g';
		$GLOBALS['pibt']['downloads'][ $g ] = base64_decode( PIBT_GIF_B64 );
		$r2 = pibt_ok( pibt_call( 'media/sideload', array( 'imageUrl' => $g, 'filename' => 'team-photo.jpg' ) ), 'custom filename' );
		pibt_eq( 'team-photo.gif', $GLOBALS['pibt']['sideloaded'][ $r2['attachmentId'] ], 'filename with the right extension' );
	}
);

pibt_test(
	'media/sideload: refusals (scheme, type, size, download and import failures)',
	function () {
		pibt_m_setup();
		pibt_err( pibt_call( 'media/sideload', array() ), 400, 'pib_bad_request', 'imageUrl required' );
		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => 'http://x.example/a.png' ) ), 400, 'pib_bad_request', 'http refused' );
		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => 'https://user:pw@x.example/a.png' ) ), 400, 'pib_bad_request', 'credentials in url refused' );
		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => 'https://x.example/a.png', 'filename' => '../evil.php' ) ), 400, 'pib_bad_request', 'bad filename' );
		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => 'https://x.example/a.png', 'postId' => 999 ) ), 400, 'pib_bad_request', 'unknown post' );
		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => 'https://x.example/a.png', 'alt' => str_repeat( 'a', 301 ) ) ), 400, 'pib_bad_request', 'alt too long' );

		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => 'https://x.example/missing.png' ) ), 502, 'pib_media_failed', 'download 404' );

		$svg = 'https://x.example/logo.png';
		$GLOBALS['pibt']['downloads'][ $svg ] = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
		$e = pibt_call( 'media/sideload', array( 'imageUrl' => $svg ) );
		pibt_err( $e, 502, 'pib_media_failed', 'svg refused although it is called .png' );
		pibt_assert( false !== strpos( $e[1]['message'], 'jpeg, png, webp, gif or avif' ), 'message says why' );

		$html = 'https://x.example/page.jpg';
		$GLOBALS['pibt']['downloads'][ $html ] = '<html><body>not an image</body></html>';
		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => $html ) ), 502, 'pib_media_failed', 'html refused' );

		$big = 'https://x.example/big.png';
		$GLOBALS['pibt']['downloads'][ $big ] = base64_decode( PIBT_PNG_B64 ) . str_repeat( "\0", 10485760 );
		$e = pibt_call( 'media/sideload', array( 'imageUrl' => $big ) );
		pibt_err( $e, 502, 'pib_media_failed', 'over 10 MB refused' );
		pibt_assert( false !== strpos( $e[1]['message'], '10 MB' ), 'size message' );

		$empty = 'https://x.example/empty.png';
		$GLOBALS['pibt']['downloads'][ $empty ] = '';
		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => $empty ) ), 502, 'pib_media_failed', 'empty refused' );

		$ok = 'https://x.example/ok.png';
		$GLOBALS['pibt']['downloads'][ $ok ] = base64_decode( PIBT_PNG_B64 );
		$GLOBALS['pibt']['sideload_fail']    = true;
		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => $ok ) ), 502, 'pib_media_failed', 'import failure' );
		$GLOBALS['pibt']['sideload_fail'] = false;

		$attachments = array_filter( $GLOBALS['pibt']['posts'], function ( $p ) { return 'attachment' === $p->post_type; } );
		pibt_eq( 0, count( $attachments ), 'nothing was added by any refusal' );
		pibt_eq( array(), glob( WP_CONTENT_DIR . '/pibdl*' ), 'temporary downloads cleaned up' );

		$f            = PIB_Connector_Settings::features();
		$f['media']   = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'media/sideload', array( 'imageUrl' => $ok ) ), 403, 'pib_disabled', 'media switch off' );
		pibt_err( pibt_call( 'media/list' ), 403, 'pib_disabled', 'media/list off' );
		pibt_err( pibt_call( 'media/alt', array() ), 403, 'pib_disabled', 'media/alt off' );
		pibt_err( pibt_call( 'media/set-featured', array() ), 403, 'pib_disabled', 'media/set-featured off' );
	}
);

pibt_test(
	'media/set-featured: attachmentId, imageUrl with reuse, alt, undo',
	function () {
		pibt_m_setup();
		pibt_add_attachment( 70, 'kitchen.jpg' );
		pibt_add_attachment( 71, 'garden.jpg' );
		pibt_add_attachment( 72, 'brochure.pdf', 'application/pdf' );

		$r = pibt_ok( pibt_call( 'media/set-featured', array( 'postId' => 10, 'attachmentId' => 70, 'alt' => 'Kitchen', 'reason' => 'featured' ) ), 'set' );
		pibt_eq( array( 'attachmentId' => null ), $r['before'], 'before none' );
		pibt_eq( 70, $r['after']['attachmentId'], 'after id' );
		pibt_eq( 'https://example.test/wp-content/uploads/kitchen.jpg', $r['after']['url'], 'after url' );
		pibt_eq( 70, get_post_thumbnail_id( 10 ), 'thumbnail set' );
		pibt_eq( 'Kitchen', get_post_meta( 70, '_wp_attachment_image_alt', true ), 'alt applied' );

		$r2 = pibt_ok( pibt_call( 'media/set-featured', array( 'postId' => 10, 'attachmentId' => 71, 'reason' => 'change' ) ), 'change' );
		pibt_eq( array( 'attachmentId' => 70 ), $r2['before'], 'before is the old image' );

		pibt_ok( pibt_call( 'undo', array( 'changeId' => $r2['changeId'] ) ), 'undo change' );
		pibt_eq( 70, get_post_thumbnail_id( 10 ), 'previous featured image restored' );
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $r['changeId'] ) ), 'undo first' );
		pibt_eq( 0, get_post_thumbnail_id( 10 ), 'no featured image again' );
		pibt_assert( ! isset( $GLOBALS['pibt']['meta'][70]['_wp_attachment_image_alt'] ), 'alt set by the change is undone too' );

		// imageUrl: sideloaded once and reused.
		$url = 'https://cdn.example.test/hero.png';
		$GLOBALS['pibt']['downloads'][ $url ] = base64_decode( PIBT_PNG_B64 );
		$u = pibt_ok( pibt_call( 'media/set-featured', array( 'postId' => 11, 'imageUrl' => $url, 'alt' => 'Hero', 'title' => 'Hero image', 'reason' => 'hero' ) ), 'by url' );
		pibt_eq( false, $u['reused'], 'new' );
		pibt_eq( $u['after']['attachmentId'], get_post_thumbnail_id( 11 ), 'featured' );
		pibt_eq( 'Hero', get_post_meta( $u['after']['attachmentId'], '_wp_attachment_image_alt', true ), 'alt on new upload' );
		pibt_eq( 11, get_post( $u['after']['attachmentId'] )->post_parent, 'attached to the post' );
		$u2 = pibt_ok( pibt_call( 'media/set-featured', array( 'postId' => 10, 'imageUrl' => $url, 'reason' => 'reuse' ) ), 'reuse' );
		pibt_eq( true, $u2['reused'], 'reused' );
		pibt_eq( $u['after']['attachmentId'], $u2['after']['attachmentId'], 'same attachment' );
		pibt_eq( 1, count( $GLOBALS['pibt']['download_calls'] ), 'one download' );

		// Refusals.
		pibt_err( pibt_call( 'media/set-featured', array( 'postId' => 10, 'attachmentId' => 70 ) ), 400, 'pib_bad_request', 'reason required' );
		pibt_err( pibt_call( 'media/set-featured', array( 'postId' => 10, 'reason' => 'r' ) ), 400, 'pib_bad_request', 'neither' );
		pibt_err( pibt_call( 'media/set-featured', array( 'postId' => 10, 'attachmentId' => 70, 'imageUrl' => $url, 'reason' => 'r' ) ), 400, 'pib_bad_request', 'both' );
		pibt_err( pibt_call( 'media/set-featured', array( 'postId' => 10, 'attachmentId' => 72, 'reason' => 'r' ) ), 400, 'pib_bad_request', 'not an image' );
		pibt_err( pibt_call( 'media/set-featured', array( 'postId' => 10, 'attachmentId' => 999, 'reason' => 'r' ) ), 400, 'pib_bad_request', 'unknown attachment' );
		pibt_err( pibt_call( 'media/set-featured', array( 'postId' => 999, 'attachmentId' => 70, 'reason' => 'r' ) ), 422, 'pib_unsupported_target', 'unknown post' );
		pibt_err( pibt_call( 'media/set-featured', array( 'postId' => 70, 'attachmentId' => 71, 'reason' => 'r' ) ), 422, 'pib_unsupported_target', 'attachment as post' );
		pibt_err( pibt_call( 'media/set-featured', array( 'attachmentId' => 70, 'reason' => 'r' ) ), 400, 'pib_bad_request', 'postId required' );
		pibt_err( pibt_call( 'media/set-featured', array( 'postId' => 10, 'imageUrl' => 'http://x.example/a.png', 'reason' => 'r' ) ), 400, 'pib_bad_request', 'http imageUrl' );
	}
);
