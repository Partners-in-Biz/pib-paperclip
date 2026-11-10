<?php
/**
 * 1.3.0 archive/get, archive/set, undo and the front-end intro on term archives.
 */

function pibt_a_setup() {
	pibt_pair();
	pibt_add_post( 10, 'about', 'page', 'publish', 'About' );
	pibt_add_term( 50, 'category', 'airgun', 'Airgun' );
	pibt_add_term( 52, 'category', 'rifle', 'Rifle' );
	$GLOBALS['pibt']['terms'][50]->count = 7;
	$GLOBALS['pibt']['terms'][52]->count = 0;
	PIB_Connector_Archive::$printed = false;
	$GLOBALS['pibt']['did']['wp_head'] = 1;
}

/**
 * A WP_Query stand-in for the loop hooks.
 */
class PIBT_Archive_Query {
	public $main;
	public $term;
	public $paged;
	public $kind;
	public function __construct( $term, $main = true, $paged = false, $kind = 'category' ) {
		$this->term  = $term;
		$this->main  = $main;
		$this->paged = $paged;
		$this->kind  = $kind;
	}
	public function is_main_query() { return $this->main; }
	public function is_category() { return 'category' === $this->kind; }
	public function is_tag() { return 'tag' === $this->kind; }
	public function is_tax() { return 'tax' === $this->kind; }
	public function is_paged() { return $this->paged; }
	public function is_feed() { return false; }
	public function get_queried_object() { return null === $this->term ? null : get_term( $this->term ); }
}

/**
 * Run loop_start and loop_end for a query the way WordPress does; return the output.
 */
function pibt_a_render( $query ) {
	ob_start();
	do_action( 'loop_start', $query );
	echo '[items]';
	do_action( 'loop_end', $query );
	return ob_get_clean();
}

const PIBT_INTRO = '<h1>Airguns for sale</h1><p>Air rifles and pistols.</p>';

pibt_test(
	'archive/set and archive/get: store, read, clear, log',
	function () {
		pibt_a_setup();
		$g = pibt_ok( pibt_call( 'archive/get', array( 'url' => '/category/airgun/' ) ), 'get empty' );
		pibt_eq( array( 50, 'category', 'https://example.test/category/airgun/', 'Airgun', 7, '', 'before' ), array( $g['termId'], $g['taxonomy'], $g['url'], $g['name'], $g['postCount'], $g['html'], $g['position'] ), 'empty get' );

		pibt_err( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => PIBT_INTRO ) ), 400, 'pib_bad_request', 'reason required' );
		pibt_err( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => PIBT_INTRO, 'position' => 'replace', 'reason' => 'x' ) ), 400, 'pib_bad_request', 'bad position' );
		pibt_err( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => str_repeat( 'é', 20001 ), 'reason' => 'x' ) ), 400, 'pib_bad_request', 'too long' );
		pibt_err( pibt_call( 'archive/set', array( 'termId' => 50, 'reason' => 'x' ) ), 400, 'pib_bad_request', 'html required' );

		$s = pibt_ok( pibt_call( 'archive/set', array( 'termId' => 50, 'taxonomy' => 'category', 'html' => PIBT_INTRO, 'reason' => 'approved preview' ) ), 'set' );
		pibt_assert( is_string( $s['changeId'] ), 'change id' );
		pibt_eq( array( 'html' => '', 'position' => 'before' ), $s['before'], 'before' );
		pibt_eq( array( 'html' => PIBT_INTRO, 'position' => 'before' ), $s['after'], 'after, position defaults to before' );
		pibt_eq( PIBT_INTRO, $GLOBALS['pibt']['termmeta'][50]['_pib_archive_intro'], 'stored in term meta' );
		pibt_eq( 'before', $GLOBALS['pibt']['termmeta'][50]['_pib_archive_intro_pos'], 'position stored' );
		pibt_assert( in_array( 50, $GLOBALS['pibt']['term_cache_cleared'], true ), 'term cache cleared' );

		$g = pibt_ok( pibt_call( 'archive/get', array( 'termId' => 50 ) ), 'get' );
		pibt_eq( PIBT_INTRO, $g['html'], 'html read back' );

		$log = pibt_ok( pibt_call( 'log', array( 'limit' => 1 ) ), 'log' );
		pibt_eq( 'archive/set', $log['changes'][0]['endpoint'], 'logged' );
		pibt_eq( PIBT_INTRO, $log['changes'][0]['after']['html'], 'log after' );

		$same = pibt_ok( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => PIBT_INTRO, 'reason' => 'x' ) ), 'same' );
		pibt_eq( null, $same['changeId'], 'no-op not logged' );

		$c = pibt_ok( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => '', 'reason' => 'clear' ) ), 'clear' );
		pibt_eq( '', $c['after']['html'], 'cleared' );
		pibt_assert( ! isset( $GLOBALS['pibt']['termmeta'][50]['_pib_archive_intro'] ), 'meta deleted' );
		pibt_assert( ! isset( $GLOBALS['pibt']['termmeta'][50]['_pib_archive_intro_pos'] ), 'pos deleted' );

		$w = pibt_ok( pibt_call( 'archive/set', array( 'termId' => 52, 'html' => PIBT_INTRO, 'reason' => 'x' ) ), 'empty term' );
		pibt_eq( 1, count( $w['warnings'] ), 'no-posts warning' );
		$GLOBALS['pibt']['block_theme'] = true;
		$b = pibt_ok( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => '<p>b</p>', 'reason' => 'x' ) ), 'block theme' );
		pibt_assert( false !== strpos( implode( ' ', $b['warnings'] ), 'block theme' ), 'block theme warning' );
	}
);

pibt_test(
	'archive/set: undo restores the previous value',
	function () {
		pibt_a_setup();
		pibt_ok( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => '<p>v1</p>', 'reason' => 'x' ) ), 'v1' );
		$s = pibt_ok( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => '<p>v2</p>', 'position' => 'after', 'reason' => 'x' ) ), 'v2' );
		$u = pibt_ok( pibt_call( 'undo', array( 'changeId' => $s['changeId'] ) ), 'undo' );
		pibt_eq( $s['changeId'], $u['undid'], 'undid' );
		$g = pibt_ok( pibt_call( 'archive/get', array( 'termId' => 50 ) ), 'get' );
		pibt_eq( array( '<p>v1</p>', 'before' ), array( $g['html'], $g['position'] ), 'v1 back' );
		pibt_err( pibt_call( 'undo', array( 'changeId' => $s['changeId'] ) ), 409, 'pib_already_undone', 'twice' );

		$first = PIB_Connector_Log::all()[2]['changeId'];
		pibt_ok( pibt_call( 'undo', array( 'changeId' => $first ) ), 'undo first' );
		pibt_assert( ! isset( $GLOBALS['pibt']['termmeta'][50]['_pib_archive_intro'] ), 'back to no intro' );
	}
);

pibt_test(
	'archive/*: refuses post, page, home and post type archive targets; feature switch',
	function () {
		pibt_a_setup();
		foreach ( array( array( 'postId' => 10 ), array( 'url' => '/about/' ), array( 'url' => '/' ), array( 'postTypeArchive' => 'product' ), array( 'url' => '/shop/' ) ) as $t ) {
			pibt_err( pibt_call( 'archive/get', $t ), 422, 'pib_unsupported_target', 'get ' . json_encode( $t ) );
			pibt_err( pibt_call( 'archive/set', $t + array( 'html' => '<p>x</p>', 'reason' => 'x' ) ), 422, 'pib_unsupported_target', 'set ' . json_encode( $t ) );
		}
		$f            = PIB_Connector_Settings::features();
		$f['content'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_err( pibt_call( 'archive/get', array( 'termId' => 50 ) ), 403, 'pib_disabled', 'content switch' );
	}
);

pibt_test(
	'archive/set: script, iframe and event handlers refused; render strips script',
	function () {
		pibt_a_setup();
		foreach ( array( '<p>x</p><script>alert(1)</script>', '<iframe src="https://e.example/"></iframe>', '<p onclick="x()">y</p>', '<a href="javascript:alert(1)">z</a>' ) as $bad ) {
			pibt_err( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => $bad, 'reason' => 'x' ) ), 422, 'pib_unsafe', $bad );
		}
		pibt_assert( ! isset( $GLOBALS['pibt']['termmeta'][50]['_pib_archive_intro'] ), 'nothing stored' );
		// A value that reached the meta another way is still filtered on output.
		update_term_meta( 50, '_pib_archive_intro', '<p>ok</p><script>alert(1)</script>' );
		$out = pibt_a_render( new PIBT_Archive_Query( 50 ) );
		pibt_assert( false !== strpos( $out, '<p>ok</p>' ) && false === strpos( $out, '<script' ), 'script stripped: ' . $out );
	}
);

pibt_test(
	'render: before and after, once, only that term, page 1, main query, feature on',
	function () {
		pibt_a_setup();
		pibt_ok( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => PIBT_INTRO, 'reason' => 'x' ) ), 'set' );
		$div = '<div class="pib-archive-intro">' . PIBT_INTRO . '</div>';

		pibt_eq( $div . '[items]', pibt_a_render( new PIBT_Archive_Query( 50 ) ), 'before the items' );
		pibt_eq( '[items]', pibt_a_render( new PIBT_Archive_Query( 50 ) ), 'once per request' );

		PIB_Connector_Archive::$printed = false;
		pibt_ok( pibt_call( 'archive/set', array( 'termId' => 50, 'html' => PIBT_INTRO, 'position' => 'after', 'reason' => 'x' ) ), 'after' );
		pibt_eq( '[items]' . $div, pibt_a_render( new PIBT_Archive_Query( 50 ) ), 'after the items' );

		$cases = array(
			'other term'      => new PIBT_Archive_Query( 52 ),
			'page 2'          => new PIBT_Archive_Query( 50, true, true ),
			'secondary query' => new PIBT_Archive_Query( 50, false ),
			'not an archive'  => new PIBT_Archive_Query( 50, true, false, 'page' ),
		);
		foreach ( $cases as $label => $q ) {
			PIB_Connector_Archive::$printed = false;
			pibt_eq( '[items]', pibt_a_render( $q ), $label );
		}
		PIB_Connector_Archive::$printed = false;
		pibt_eq( '[items]' . $div, pibt_a_render( new PIBT_Archive_Query( 50, true, false, 'tax' ) ), 'custom taxonomy archive' );

		PIB_Connector_Archive::$printed = false;
		$GLOBALS['pibt']['is_admin']    = true;
		pibt_eq( '[items]', pibt_a_render( new PIBT_Archive_Query( 50 ) ), 'not in admin' );
		$GLOBALS['pibt']['is_admin'] = false;

		// Block theme: the loop runs while the template is built, before wp_head. Nothing then.
		PIB_Connector_Archive::$printed       = false;
		$GLOBALS['pibt']['did']['wp_head'] = 0;
		pibt_eq( '[items]', pibt_a_render( new PIBT_Archive_Query( 50 ) ), 'not before wp_head' );
		$GLOBALS['pibt']['did']['wp_head'] = 1;

		$f            = PIB_Connector_Settings::features();
		$f['content'] = false;
		PIB_Connector_Settings::set_features( $f );
		pibt_eq( '[items]', pibt_a_render( new PIBT_Archive_Query( 50 ) ), 'feature off' );
	}
);
