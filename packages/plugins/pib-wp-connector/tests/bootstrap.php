<?php
/**
 * Minimal WordPress stubs for the PiB Connector test harness.
 * Only what the Connector touches; state lives in $GLOBALS['pibt'].
 */

error_reporting( E_ALL );
ini_set( 'display_errors', '1' );

$pibt_tmp = sys_get_temp_dir() . '/pibc-tests-' . getmypid();
if ( ! is_dir( $pibt_tmp . '/wp-content/plugins' ) ) {
	mkdir( $pibt_tmp . '/wp-content/plugins', 0777, true );
}
define( 'ABSPATH', $pibt_tmp . '/' );
define( 'WP_CONTENT_DIR', $pibt_tmp . '/wp-content' );
define( 'WP_PLUGIN_DIR', $pibt_tmp . '/wp-content/plugins' );
$GLOBALS['wp_version'] = '6.8.1';

function pibt_reset() {
	$GLOBALS['pibt'] = array(
		'options'    => array(
			'blog_public'         => '1',
			'show_on_front'       => 'posts',
			'page_on_front'       => 0,
			'permalink_structure' => '/%postname%/',
			'blogname'            => 'Hunt and Gun',
		),
		'transients' => array(),
		'meta'       => array(),
		'posts'      => array(),
		'adapter'    => 'none',
		'query'      => array(
			'front_page' => false,
			'home'       => false,
			'singular'   => false,
			'id'         => 0,
		),
		'is_admin'   => false,
	);
	if ( class_exists( 'PIB_Connector_Settings' ) ) {
		PIB_Connector_Settings::reset_file_cache();
	}
	if ( defined( 'WP_CONTENT_DIR' ) && is_file( WP_CONTENT_DIR . '/pib-connector-key.php' ) ) {
		unlink( WP_CONTENT_DIR . '/pib-connector-key.php' );
	}
}
pibt_reset();

/* ---------- core classes ---------- */

class WP_Error {
	public $errors     = array();
	public $error_data = array();
	public function __construct( $code = '', $message = '', $data = '' ) {
		if ( '' !== $code ) {
			$this->errors[ $code ][] = $message;
			if ( '' !== $data ) {
				$this->error_data[ $code ] = $data;
			}
		}
	}
	public function get_error_code() {
		$codes = array_keys( $this->errors );
		return empty( $codes ) ? '' : $codes[0];
	}
	public function get_error_message() {
		$code = $this->get_error_code();
		return isset( $this->errors[ $code ][0] ) ? $this->errors[ $code ][0] : '';
	}
	public function get_error_data() {
		$code = $this->get_error_code();
		return isset( $this->error_data[ $code ] ) ? $this->error_data[ $code ] : null;
	}
	public function has_errors() {
		return ! empty( $this->errors );
	}
}

class WP_REST_Request {
	private $headers = array();
	private $body    = '';
	private $route   = '';
	public function __construct( $method = 'POST', $route = '' ) {
		$this->route = $route;
	}
	public static function canonical( $key ) {
		return str_replace( '-', '_', strtolower( $key ) );
	}
	public function set_header( $key, $value ) {
		$this->headers[ self::canonical( $key ) ] = array( $value );
	}
	public function get_header( $key ) {
		$k = self::canonical( $key );
		return isset( $this->headers[ $k ] ) ? implode( ',', $this->headers[ $k ] ) : null;
	}
	public function set_body( $body ) {
		$this->body = $body;
	}
	public function get_body() {
		return $this->body;
	}
	public function get_route() {
		return $this->route;
	}
}

class WP_REST_Response {
	public $data;
	public $status  = 200;
	public $headers = array();
	public function __construct( $data = null, $status = 200 ) {
		$this->data   = $data;
		$this->status = $status;
	}
	public function header( $k, $v ) {
		$this->headers[ $k ] = $v;
	}
	public function get_data() {
		return $this->data;
	}
}

class WPSEO_Options {
	public static function get( $key ) {
		$wpseo = get_option( 'wpseo', array() );
		if ( is_array( $wpseo ) && array_key_exists( $key, $wpseo ) ) {
			return $wpseo[ $key ];
		}
		$titles = get_option( 'wpseo_titles', array() );
		return ( is_array( $titles ) && array_key_exists( $key, $titles ) ) ? $titles[ $key ] : null;
	}
	public static function set( $key, $value ) {
		$name         = 'enable_xml_sitemap' === $key ? 'wpseo' : 'wpseo_titles';
		$opt          = get_option( $name, array() );
		$opt          = is_array( $opt ) ? $opt : array();
		$opt[ $key ]  = $value;
		update_option( $name, $opt );
		return true;
	}
}

/* ---------- hooks ---------- */

$GLOBALS['pibt_hooks'] = array();
function add_filter( $tag, $cb, $priority = 10, $args = 1 ) {
	$GLOBALS['pibt_hooks'][ $tag ][ $priority ][] = array( $cb, $args );
	return true;
}
function add_action( $tag, $cb, $priority = 10, $args = 1 ) {
	return add_filter( $tag, $cb, $priority, $args );
}
function remove_action( $tag, $cb, $priority = 10 ) {
	$GLOBALS['pibt_removed'][ $tag ][] = $cb;
	return true;
}
function apply_filters( $tag, $value ) {
	$args = func_get_args();
	array_shift( $args );
	if ( empty( $GLOBALS['pibt_hooks'][ $tag ] ) ) {
		return $value;
	}
	ksort( $GLOBALS['pibt_hooks'][ $tag ] );
	foreach ( $GLOBALS['pibt_hooks'][ $tag ] as $cbs ) {
		foreach ( $cbs as $pair ) {
			$args[0] = call_user_func_array( $pair[0], array_slice( $args, 0, max( 1, $pair[1] ) ) );
		}
	}
	return $args[0];
}
function do_action( $tag ) {
	$args = func_get_args();
	array_shift( $args );
	if ( empty( $GLOBALS['pibt_hooks'][ $tag ] ) ) {
		return;
	}
	ksort( $GLOBALS['pibt_hooks'][ $tag ] );
	foreach ( $GLOBALS['pibt_hooks'][ $tag ] as $cbs ) {
		foreach ( $cbs as $pair ) {
			call_user_func_array( $pair[0], array_slice( $args, 0, $pair[1] ) );
		}
	}
}

/* ---------- i18n / escaping ---------- */

function __( $t, $d = null ) { return $t; }
function esc_html__( $t, $d = null ) { return htmlspecialchars( $t, ENT_QUOTES ); }
function esc_html_e( $t, $d = null ) { echo htmlspecialchars( $t, ENT_QUOTES ); }
function esc_html( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES ); }
function esc_attr( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES ); }
function esc_url( $u ) { return htmlspecialchars( (string) $u, ENT_QUOTES ); }
function esc_url_raw( $u, $protocols = null ) { return false === filter_var( $u, FILTER_VALIDATE_URL ) ? '' : $u; }
function sanitize_text_field( $s ) { return trim( preg_replace( '/[\r\n\t ]+/', ' ', strip_tags( (string) $s ) ) ); }
function wp_strip_all_tags( $s, $remove_breaks = false ) {
	$s = preg_replace( '@<(script|style)[^>]*?>.*?</\\1>@si', '', (string) $s );
	$s = strip_tags( $s );
	if ( $remove_breaks ) {
		$s = preg_replace( '/[\r\n\t ]+/', ' ', $s );
	}
	return trim( $s );
}
function wp_check_invalid_utf8( $s, $strip = false ) {
	return preg_match( '//u', $s ) ? $s : ( $strip ? mb_convert_encoding( $s, 'UTF-8', 'UTF-8' ) : '' );
}
function sanitize_key( $k ) { return preg_replace( '/[^a-z0-9_\-]/', '', strtolower( (string) $k ) ); }
function wp_unslash( $v ) { return is_string( $v ) ? stripslashes( $v ) : $v; }
function wp_slash( $v ) {
	if ( is_array( $v ) ) {
		return array_map( 'wp_slash', $v );
	}
	return is_string( $v ) ? addslashes( $v ) : $v;
}
function pibt_unslash_deep( $v ) {
	if ( is_array( $v ) ) {
		return array_map( 'pibt_unslash_deep', $v );
	}
	return is_string( $v ) ? stripslashes( $v ) : $v;
}

/* ---------- options / transients / meta ---------- */

function get_option( $name, $default = false ) {
	return array_key_exists( $name, $GLOBALS['pibt']['options'] ) ? $GLOBALS['pibt']['options'][ $name ] : $default;
}
function update_option( $name, $value, $autoload = null ) {
	$GLOBALS['pibt']['options'][ $name ] = $value;
	if ( null !== $autoload ) {
		$GLOBALS['pibt']['autoload'][ $name ] = $autoload;
	}
	return true;
}
function add_option( $name, $value = '', $deprecated = '', $autoload = 'yes' ) {
	if ( array_key_exists( $name, $GLOBALS['pibt']['options'] ) ) {
		return false;
	}
	$GLOBALS['pibt']['options'][ $name ]  = $value;
	$GLOBALS['pibt']['autoload'][ $name ] = $autoload;
	return true;
}
function delete_option( $name ) {
	unset( $GLOBALS['pibt']['options'][ $name ] );
	return true;
}
function get_transient( $k ) {
	return isset( $GLOBALS['pibt']['transients'][ $k ] ) ? $GLOBALS['pibt']['transients'][ $k ] : false;
}
function set_transient( $k, $v, $ttl = 0 ) {
	$GLOBALS['pibt']['transients'][ $k ] = $v;
	return true;
}
function delete_transient( $k ) {
	unset( $GLOBALS['pibt']['transients'][ $k ] );
	return true;
}
function get_site_transient( $k ) { return false; }
function get_post_meta( $id, $key = '', $single = false ) {
	if ( ! isset( $GLOBALS['pibt']['meta'][ $id ][ $key ] ) ) {
		return $single ? '' : array();
	}
	return $GLOBALS['pibt']['meta'][ $id ][ $key ];
}
function update_post_meta( $id, $key, $value ) {
	$GLOBALS['pibt']['meta'][ $id ][ $key ] = pibt_unslash_deep( $value );
	return true;
}
function delete_post_meta( $id, $key ) {
	unset( $GLOBALS['pibt']['meta'][ $id ][ $key ] );
	return true;
}
function clean_post_cache( $id ) {}

/* ---------- posts / urls ---------- */

function pibt_add_post( $id, $slug, $type = 'page', $status = 'publish', $title = null ) {
	$GLOBALS['pibt']['posts'][ $id ] = (object) array(
		'ID'          => $id,
		'post_type'   => $type,
		'post_status' => $status,
		'post_title'  => null === $title ? ucfirst( $slug ) : $title,
		'slug'        => $slug,
	);
}
function get_post( $id ) {
	$id = is_object( $id ) ? $id->ID : (int) $id;
	return isset( $GLOBALS['pibt']['posts'][ $id ] ) ? $GLOBALS['pibt']['posts'][ $id ] : null;
}
function get_permalink( $post ) {
	$post = get_post( $post );
	return $post ? home_url( '/' . $post->slug . '/' ) : false;
}
function get_the_title( $post ) {
	$post = get_post( $post );
	return $post ? $post->post_title : '';
}
function url_to_postid( $url ) {
	$path = trim( (string) parse_url( $url, PHP_URL_PATH ), '/' );
	foreach ( $GLOBALS['pibt']['posts'] as $p ) {
		if ( $p->slug === $path ) {
			return $p->ID;
		}
	}
	return 0;
}
function is_post_type_viewable( $type ) { return in_array( $type, array( 'post', 'page', 'product' ), true ); }
function home_url( $path = '' ) { return 'https://example.test' . ( '' === $path ? '' : '/' . ltrim( $path, '/' ) ); }
function site_url( $path = '' ) { return home_url( $path ); }
function admin_url( $path = '' ) { return home_url( '/wp-admin/' . $path ); }
function add_query_arg( $k, $v, $url ) { return $url . ( false === strpos( $url, '?' ) ? '?' : '&' ) . $k . '=' . rawurlencode( $v ); }
function plugin_basename( $file ) { return 'pib-connector/' . basename( $file ); }
function get_bloginfo( $what = '' ) { return 'name' === $what ? get_option( 'blogname' ) : ''; }
function wp_parse_url( $url, $component = -1 ) { return parse_url( $url, $component ); }
function wp_json_encode( $data, $flags = 0, $depth = 512 ) { return json_encode( $data, $flags, $depth ); }
function wp_http_validate_url( $url ) { return false !== filter_var( $url, FILTER_VALIDATE_URL ) ? $url : false; }
function is_wp_error( $thing ) { return $thing instanceof WP_Error; }
function rest_ensure_response( $data ) { return $data instanceof WP_REST_Response ? $data : new WP_REST_Response( $data ); }
function trailingslashit( $s ) { return rtrim( $s, '/\\' ) . '/'; }

/* ---------- query conditionals ---------- */

function is_front_page() { return $GLOBALS['pibt']['query']['front_page']; }
function is_home() { return $GLOBALS['pibt']['query']['home']; }
function is_singular() { return $GLOBALS['pibt']['query']['singular']; }
function get_queried_object_id() { return $GLOBALS['pibt']['query']['id']; }
function is_admin() { return $GLOBALS['pibt']['is_admin']; }
function wp_doing_cron() { return false; }
function wp_doing_ajax() { return false; }

/* ---------- robots / plugins / env ---------- */

function do_robots() {
	$public = get_option( 'blog_public' );
	$out    = "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n";
	echo apply_filters( 'robots_txt', $out, $public );
}
function get_plugins() {
	return array(
		'pib-connector/pib-connector.php' => array( 'Name' => 'PiB Connector', 'Version' => '1.0.0' ),
		'wordpress-seo/wp-seo.php'        => array( 'Name' => 'Yoast SEO', 'Version' => '27.1' ),
	);
}
function get_mu_plugins() { return array(); }
function is_plugin_active( $file ) { return true; }
function is_multisite() { return false; }
function get_locale() { return 'en_ZA'; }
function wp_timezone_string() { return 'Africa/Johannesburg'; }
function wp_get_theme() { return null; }
function register_rest_route( $ns, $route, $args ) {
	$GLOBALS['pibt_routes'][ '/' . $ns . $route ] = $args;
	return true;
}

/* ---------- load the plugin ---------- */

add_filter(
	'pib_connector_seo_plugin',
	function ( $detected ) {
		return $GLOBALS['pibt']['adapter'];
	}
);

require dirname( __DIR__ ) . '/pib-connector/pib-connector.php';
do_action( 'rest_api_init' );

/* ---------- test helpers ---------- */

const PIBT_KEY = 'pibc_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

function pibt_pair( $key = PIBT_KEY ) {
	update_option( 'pib_connector_key', $key, false );
}

/**
 * Build a signed request and dispatch it the way WP_REST_Server does.
 *
 * @return array [ status, body(array) ]
 */
function pibt_call( $endpoint, $params = array(), array $opts = array() ) {
	$route = '/pib-connector/v1/' . $endpoint;
	$body  = isset( $opts['body'] ) ? $opts['body'] : ( empty( $params ) ? '{}' : json_encode( $params ) );
	$key   = isset( $opts['key'] ) ? $opts['key'] : PIBT_KEY;
	$ts    = isset( $opts['ts'] ) ? (string) $opts['ts'] : (string) time();
	$nonce = isset( $opts['nonce'] ) ? $opts['nonce'] : bin2hex( random_bytes( 16 ) );
	$sign_route = isset( $opts['sign_route'] ) ? $opts['sign_route'] : $route;
	$sig   = PIB_Connector_Auth::sign( $key, $ts, $nonce, $sign_route, $body );
	if ( isset( $opts['sig'] ) ) {
		$sig = $opts['sig'];
	}

	$req = new WP_REST_Request( 'POST', $route );
	$req->set_body( $body );
	$req->set_header( 'Content-Type', 'application/json' );
	$req->set_header( 'X-PIB-Key-Id', isset( $opts['key_id'] ) ? $opts['key_id'] : substr( hash( 'sha256', $key ), 0, 12 ) );
	$req->set_header( 'X-PIB-Timestamp', $ts );
	$req->set_header( 'X-PIB-Nonce', $nonce );
	$req->set_header( 'X-PIB-Signature', $sig );
	$req->set_header( 'X-PIB-Actor', isset( $opts['actor'] ) ? $opts['actor'] : 'agent:test' );

	if ( ! isset( $GLOBALS['pibt_routes'][ $route ] ) ) {
		return array( 404, array( 'code' => 'rest_no_route' ) );
	}
	$def  = $GLOBALS['pibt_routes'][ $route ];
	$perm = call_user_func( $def['permission_callback'], $req );
	if ( is_wp_error( $perm ) ) {
		return pibt_error_response( $perm );
	}
	$res = call_user_func( $def['callback'], $req );
	if ( is_wp_error( $res ) ) {
		return pibt_error_response( $res );
	}
	return array( $res->status, json_decode( json_encode( $res->get_data() ), true ) );
}

function pibt_error_response( WP_Error $e ) {
	$data = $e->get_error_data();
	return array(
		isset( $data['status'] ) ? $data['status'] : 500,
		array(
			'code'    => $e->get_error_code(),
			'message' => $e->get_error_message(),
			'data'    => $data,
		),
	);
}

/* ---------- tiny test framework ---------- */

$GLOBALS['pibt_tests'] = array();
function pibt_test( $name, $fn ) {
	$GLOBALS['pibt_tests'][] = array( $name, $fn );
}
class PIBT_Fail extends Exception {}
function pibt_assert( $cond, $msg ) {
	if ( ! $cond ) {
		throw new PIBT_Fail( $msg );
	}
}
function pibt_eq( $expected, $actual, $msg ) {
	if ( $expected !== $actual ) {
		throw new PIBT_Fail( $msg . "\n      expected: " . var_export( $expected, true ) . "\n      actual:   " . var_export( $actual, true ) );
	}
}
function pibt_ok( array $res, $msg ) {
	if ( 200 !== $res[0] || empty( $res[1]['ok'] ) ) {
		throw new PIBT_Fail( $msg . ' — expected 200 ok, got ' . $res[0] . ' ' . json_encode( $res[1] ) );
	}
	return $res[1]['data'];
}
function pibt_err( array $res, $status, $code, $msg ) {
	if ( $status !== $res[0] || ! isset( $res[1]['code'] ) || $code !== $res[1]['code'] ) {
		throw new PIBT_Fail( $msg . " — expected $status $code, got " . $res[0] . ' ' . json_encode( $res[1] ) );
	}
}
