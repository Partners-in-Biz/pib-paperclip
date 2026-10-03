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
		'termmeta'   => array(),
		'terms'      => array(),
		'taxonomies' => array(
			'category' => array( 'public' => true, 'prefix' => 'category' ),
			'post_tag' => array( 'public' => true, 'prefix' => 'tag' ),
			'product_cat' => array( 'public' => true, 'prefix' => 'product-category' ),
			'nav_menu' => array( 'public' => false, 'prefix' => 'nav' ),
		),
		'post_types' => array(
			'post'    => array( 'public' => true, 'has_archive' => false, 'name' => 'Posts' ),
			'page'    => array( 'public' => true, 'has_archive' => false, 'name' => 'Pages' ),
			'product' => array( 'public' => true, 'has_archive' => '/shop/', 'name' => 'Products' ),
			'book'    => array( 'public' => true, 'has_archive' => false, 'name' => 'Books' ),
		),
		'next_id'    => 1000,
		'downloads'  => array(),
		'download_calls' => array(),
		'sideload_fail' => false,
		'kses_active' => true,
		'kses_seen'  => array(),
		'shop_page'  => 0,
		'scan_plugins' => false,
		'upgrader_fail' => 0,
		'upgrader_calls' => array(),
		'trashed'    => array(),
	);
	pibt_clean_fs();
	if ( class_exists( 'PIB_Connector_Settings' ) ) {
		PIB_Connector_Settings::reset_file_cache();
	}
	if ( defined( 'WP_CONTENT_DIR' ) && is_file( WP_CONTENT_DIR . '/pib-connector-key.php' ) ) {
		unlink( WP_CONTENT_DIR . '/pib-connector-key.php' );
	}
}
function pibt_rrmdir( $dir ) {
	if ( ! is_dir( $dir ) ) {
		return;
	}
	$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST );
	foreach ( $it as $f ) {
		$f->isDir() && ! $f->isLink() ? rmdir( $f->getPathname() ) : unlink( $f->getPathname() );
	}
	rmdir( $dir );
}
function pibt_clean_fs() {
	foreach ( (array) glob( WP_CONTENT_DIR . '/pibdl*' ) as $f ) {
		unlink( $f );
	}
	pibt_rrmdir( WP_CONTENT_DIR . '/pib-connector-backups' );
	foreach ( (array) glob( WP_PLUGIN_DIR . '/*' ) as $p ) {
		is_dir( $p ) ? pibt_rrmdir( $p ) : unlink( $p );
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

/**
 * Mirrors the real WPSEO_Taxonomy_Meta write API (checked against Yoast 28.6):
 * set_values( $term_id, $taxonomy, $meta_values ) resets every key missing from
 * $meta_values to its default, and defaults are not stored.
 * set_value takes ( $term_id, $taxonomy, $meta_key, $meta_value ) (not used by the Connector).
 */
class WPSEO_Taxonomy_Meta {
	public static $defaults = array(
		'wpseo_title' => '', 'wpseo_desc' => '', 'wpseo_canonical' => '', 'wpseo_noindex' => 'default',
		'wpseo_focuskw' => '', 'wpseo_opengraph-title' => '', 'wpseo_opengraph-description' => '',
		'wpseo_opengraph-image' => '', 'wpseo_opengraph-image-id' => '',
	);
	public static function set_values( $term_id, $taxonomy, array $meta_values ) {
		$clean = self::$defaults;
		foreach ( $clean as $k => $v ) {
			if ( isset( $meta_values[ $k ] ) && is_string( $meta_values[ $k ] ) ) {
				$clean[ $k ] = $meta_values[ $k ];
			}
		}
		$clean = array_diff_assoc( $clean, self::$defaults );
		$opt   = get_option( 'wpseo_taxonomy_meta', array() );
		$opt   = is_array( $opt ) ? $opt : array();
		if ( $clean ) {
			$opt[ $taxonomy ][ $term_id ] = $clean;
		} else {
			unset( $opt[ $taxonomy ][ $term_id ] );
			if ( isset( $opt[ $taxonomy ] ) && ! $opt[ $taxonomy ] ) {
				unset( $opt[ $taxonomy ] );
			}
		}
		update_option( 'wpseo_taxonomy_meta', $opt );
	}
	public static function set_value( $term_id, $taxonomy, $meta_key, $meta_value ) {
		self::set_values( $term_id, $taxonomy, array( $meta_key => $meta_value ) );
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

function pibt_add_post( $id, $slug, $type = 'page', $status = 'publish', $title = null, array $extra = array() ) {
	$GLOBALS['pibt']['posts'][ $id ] = (object) array_merge(
		array(
			'ID'                => $id,
			'post_type'         => $type,
			'post_status'       => $status,
			'post_title'        => null === $title ? ucfirst( $slug ) : $title,
			'slug'              => $slug,
			'post_name'         => $slug,
			'post_content'      => '',
			'post_excerpt'      => '',
			'post_parent'       => 0,
			'post_author'       => 0,
			'post_mime_type'    => '',
			'post_modified_gmt' => '2026-03-01 10:00:00',
		),
		$extra
	);
}
function pibt_add_attachment( $id, $file, $mime = 'image/jpeg', $parent = 0, array $extra = array() ) {
	pibt_add_post( $id, $file, 'attachment', 'inherit', $file, array_merge( array( 'post_mime_type' => $mime, 'post_parent' => $parent ), $extra ) );
}
function pibt_next_id() {
	return ++$GLOBALS['pibt']['next_id'];
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
function home_url( $path = '' ) { return 'https://example.test' . ( isset( $GLOBALS['pibt']['home_prefix'] ) ? $GLOBALS['pibt']['home_prefix'] : '' ) . ( '' === $path ? '' : '/' . ltrim( $path, '/' ) ); }
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
	if ( ! empty( $GLOBALS['pibt']['scan_plugins'] ) ) {
		$out = array();
		foreach ( (array) glob( WP_PLUGIN_DIR . '/*', GLOB_ONLYDIR ) as $dir ) {
			foreach ( (array) glob( $dir . '/*.php' ) as $f ) {
				$head = (string) file_get_contents( $f, false, null, 0, 4096 );
				if ( preg_match( '/^[ \t\/*#@]*Plugin Name:\s*(.+)$/mi', $head, $n ) ) {
					preg_match( '/^[ \t\/*#@]*Version:\s*(\S+)/mi', $head, $v );
					$out[ basename( $dir ) . '/' . basename( $f ) ] = array( 'Name' => trim( $n[1] ), 'Version' => isset( $v[1] ) ? $v[1] : '' );
				}
			}
		}
		return $out;
	}
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


/* ---------- terms, taxonomies, post types ---------- */

function pibt_add_term( $id, $taxonomy, $slug, $name = null ) {
	$GLOBALS['pibt']['terms'][ $id ] = (object) array(
		'term_id'  => $id,
		'taxonomy' => $taxonomy,
		'slug'     => $slug,
		'name'     => null === $name ? ucfirst( $slug ) : $name,
	);
}
function taxonomy_exists( $t ) { return isset( $GLOBALS['pibt']['taxonomies'][ $t ] ); }
function get_taxonomy( $t ) {
	return isset( $GLOBALS['pibt']['taxonomies'][ $t ] ) ? (object) array( 'public' => $GLOBALS['pibt']['taxonomies'][ $t ]['public'] ) : false;
}
function get_taxonomies( $args = array(), $output = 'names' ) {
	$out = array();
	foreach ( $GLOBALS['pibt']['taxonomies'] as $name => $def ) {
		if ( isset( $args['public'] ) && $def['public'] !== $args['public'] ) {
			continue;
		}
		$out[ $name ] = $name;
	}
	return $out;
}
function get_term( $id, $taxonomy = '' ) {
	$t = isset( $GLOBALS['pibt']['terms'][ (int) $id ] ) ? $GLOBALS['pibt']['terms'][ (int) $id ] : null;
	if ( ! $t || ( '' !== $taxonomy && $t->taxonomy !== $taxonomy ) ) {
		return null;
	}
	return $t;
}
function get_terms( $args ) {
	$taxes = (array) $args['taxonomy'];
	$out   = array();
	foreach ( $GLOBALS['pibt']['terms'] as $t ) {
		if ( in_array( $t->taxonomy, $taxes, true ) && ( ! isset( $args['slug'] ) || $t->slug === $args['slug'] ) ) {
			$out[] = $t;
		}
	}
	return $out;
}
function get_term_link( $term ) {
	return home_url( '/' . $GLOBALS['pibt']['taxonomies'][ $term->taxonomy ]['prefix'] . '/' . $term->slug . '/' );
}
function get_term_meta( $id, $key = '', $single = false ) {
	return isset( $GLOBALS['pibt']['termmeta'][ $id ][ $key ] ) ? $GLOBALS['pibt']['termmeta'][ $id ][ $key ] : ( $single ? '' : array() );
}
function update_term_meta( $id, $key, $value ) {
	$GLOBALS['pibt']['termmeta'][ $id ][ $key ] = pibt_unslash_deep( $value );
	return true;
}
function delete_term_meta( $id, $key ) {
	unset( $GLOBALS['pibt']['termmeta'][ $id ][ $key ] );
	return true;
}
function post_type_exists( $t ) { return isset( $GLOBALS['pibt']['post_types'][ $t ] ); }
function post_type_supports( $t, $f ) { return 'attachment' !== $t; }
function get_post_type_object( $t ) {
	if ( ! isset( $GLOBALS['pibt']['post_types'][ $t ] ) ) {
		return null;
	}
	$d = $GLOBALS['pibt']['post_types'][ $t ];
	return (object) array( 'public' => $d['public'], 'has_archive' => $d['has_archive'], 'labels' => (object) array( 'name' => $d['name'] ) );
}
function get_post_types( $args = array(), $output = 'names' ) {
	$out = array();
	foreach ( $GLOBALS['pibt']['post_types'] as $name => $d ) {
		$out[ $name ] = $name;
	}
	return $out;
}
function get_post_type_archive_link( $t ) {
	$d = isset( $GLOBALS['pibt']['post_types'][ $t ] ) ? $GLOBALS['pibt']['post_types'][ $t ] : null;
	return ( $d && $d['has_archive'] ) ? home_url( $d['has_archive'] ) : false;
}
function is_post_type_archive() { return ! empty( $GLOBALS['pibt']['query']['archive'] ); }
function is_category() { return ! empty( $GLOBALS['pibt']['query']['term'] ); }
function is_tag() { return false; }
function is_tax() { return false; }
function get_queried_object() {
	$q = $GLOBALS['pibt']['query'];
	if ( ! empty( $q['archive'] ) ) {
		return (object) array( 'name' => $q['archive'] );
	}
	if ( ! empty( $q['term'] ) ) {
		return get_term( $q['term'] );
	}
	return null;
}

/* ---------- WP_Query, posts writes, attachments ---------- */

class WP_Query {
	public $posts       = array();
	public $found_posts = 0;
	public function __construct( $args = array() ) {
		$match = array();
		foreach ( $GLOBALS['pibt']['posts'] as $p ) {
			$types = isset( $args['post_type'] ) ? (array) $args['post_type'] : array( 'post' );
			if ( ! in_array( $p->post_type, $types, true ) ) {
				continue;
			}
			$status = isset( $args['post_status'] ) ? $args['post_status'] : 'publish';
			if ( 'any' === $status ? in_array( $p->post_status, array( 'trash', 'auto-draft' ), true ) : $p->post_status !== $status ) {
				continue;
			}
			if ( isset( $args['post_mime_type'] ) && 0 !== strpos( $p->post_mime_type, $args['post_mime_type'] ) ) {
				continue;
			}
			if ( isset( $args['post_parent'] ) && (int) $p->post_parent !== (int) $args['post_parent'] ) {
				continue;
			}
			if ( isset( $args['s'] ) && false === stripos( $p->post_title . ' ' . $p->slug, $args['s'] ) ) {
				continue;
			}
			if ( isset( $args['meta_key'] ) ) {
				$mv = isset( $GLOBALS['pibt']['meta'][ $p->ID ][ $args['meta_key'] ] ) ? $GLOBALS['pibt']['meta'][ $p->ID ][ $args['meta_key'] ] : null;
				if ( $mv !== $args['meta_value'] ) {
					continue;
				}
			}
			$match[] = $p->ID;
		}
		sort( $match );
		$this->found_posts = count( $match );
		$per               = isset( $args['posts_per_page'] ) ? (int) $args['posts_per_page'] : 10;
		$page              = isset( $args['paged'] ) ? (int) $args['paged'] : 1;
		$this->posts       = array_slice( $match, ( $page - 1 ) * $per, $per );
	}
}
function sanitize_title( $s ) { return trim( preg_replace( '/[^a-z0-9]+/', '-', strtolower( strip_tags( (string) $s ) ) ), '-' ); }
function wp_delete_file( $f ) { if ( is_file( $f ) ) { unlink( $f ); } }
function kses_remove_filters() { $GLOBALS['pibt']['kses_active'] = false; $GLOBALS['pibt']['kses_seen'][] = 'off'; }
function kses_init() { $GLOBALS['pibt']['kses_active'] = true; $GLOBALS['pibt']['kses_seen'][] = 'on'; }
function pibt_kses( $post ) {
	if ( $GLOBALS['pibt']['kses_active'] ) {
		$post['post_content'] = preg_replace( '#<(iframe|script)\b[^>]*>(.*?</\1>)?#is', '', $post['post_content'] );
	}
	return $post;
}
function wp_insert_post( $args, $wp_error = false ) {
	$args = pibt_unslash_deep( $args );
	$id   = pibt_next_id();
	$slug = ! empty( $args['post_name'] ) ? $args['post_name'] : sanitize_title( isset( $args['post_title'] ) ? $args['post_title'] : 'post' );
	pibt_add_post( $id, $slug, isset( $args['post_type'] ) ? $args['post_type'] : 'post', isset( $args['post_status'] ) ? $args['post_status'] : 'draft', isset( $args['post_title'] ) ? $args['post_title'] : '', array(
		'post_content' => isset( $args['post_content'] ) ? $args['post_content'] : '',
		'post_excerpt' => isset( $args['post_excerpt'] ) ? $args['post_excerpt'] : '',
		'post_parent'  => isset( $args['post_parent'] ) ? $args['post_parent'] : 0,
	) );
	$GLOBALS['pibt']['posts'][ $id ] = (object) pibt_kses( (array) $GLOBALS['pibt']['posts'][ $id ] );
	return $id;
}
function wp_update_post( $args, $wp_error = false ) {
	$args = pibt_unslash_deep( $args );
	$p    = get_post( (int) $args['ID'] );
	if ( ! $p ) {
		return $wp_error ? new WP_Error( 'invalid_post', 'Invalid post ID.' ) : 0;
	}
	$arr = (array) $p;
	foreach ( $args as $k => $v ) {
		if ( 'ID' !== $k ) {
			$arr[ $k ] = $v;
		}
	}
	if ( isset( $args['post_name'] ) ) {
		$arr['slug'] = $args['post_name'];
	}
	$arr['post_modified_gmt'] = gmdate( 'Y-m-d H:i:s' );
	$GLOBALS['pibt']['posts'][ $p->ID ] = (object) pibt_kses( $arr );
	return $p->ID;
}
function wp_trash_post( $id ) {
	$p = get_post( $id );
	if ( $p ) {
		$p->post_status = 'trash';
		$GLOBALS['pibt']['trashed'][] = $id;
	}
	return $p;
}
function get_post_thumbnail_id( $id ) { return (int) get_post_meta( $id, '_thumbnail_id', true ); }
function set_post_thumbnail( $id, $att ) { update_post_meta( $id, '_thumbnail_id', (int) $att ); return true; }
function delete_post_thumbnail( $id ) { delete_post_meta( $id, '_thumbnail_id' ); return true; }
function get_the_post_thumbnail_url( $id, $size = 'full' ) {
	$t = get_post_thumbnail_id( $id );
	return $t ? wp_get_attachment_url( $t ) : false;
}
function wp_get_attachment_url( $id ) {
	$p = get_post( $id );
	return $p ? home_url( '/wp-content/uploads/' . $p->slug ) : false;
}
function attachment_url_to_postid( $url ) {
	foreach ( $GLOBALS['pibt']['posts'] as $p ) {
		if ( 'attachment' === $p->post_type && wp_get_attachment_url( $p->ID ) === $url ) {
			return $p->ID;
		}
	}
	return 0;
}
function wp_get_attachment_metadata( $id ) {
	$m = get_post_meta( $id, '_wp_attachment_metadata', true );
	return is_array( $m ) ? $m : false;
}
function get_attached_file( $id ) { return false; }
function wp_get_image_mime( $file ) {
	$i = @getimagesize( $file );
	return $i && isset( $i['mime'] ) ? $i['mime'] : false;
}
function download_url( $url, $timeout = 300 ) {
	$GLOBALS['pibt']['download_calls'][] = $url;
	if ( ! isset( $GLOBALS['pibt']['downloads'][ $url ] ) ) {
		return new WP_Error( 'http_404', 'Not Found' );
	}
	$tmp = tempnam( WP_CONTENT_DIR, 'pibdl' );
	file_put_contents( $tmp, $GLOBALS['pibt']['downloads'][ $url ] );
	return $tmp;
}
function media_handle_sideload( $file, $post_id = 0, $desc = null ) {
	if ( $GLOBALS['pibt']['sideload_fail'] ) {
		return new WP_Error( 'upload_error', 'Sorry, you are not allowed to upload this file type.' );
	}
	$mime = PIB_Connector_Media::detect_mime( $file['tmp_name'] );
	$id   = pibt_next_id();
	pibt_add_attachment( $id, $file['name'], (string) $mime, $post_id, array( 'post_title' => null === $desc ? pathinfo( $file['name'], PATHINFO_FILENAME ) : $desc ) );
	$GLOBALS['pibt']['sideloaded'][ $id ] = $file['name'];
	if ( is_file( $file['tmp_name'] ) ) {
		unlink( $file['tmp_name'] );
	}
	return $id;
}
function remove_filter( $tag, $cb, $priority = 10 ) { return true; }

/* ---------- upgrader (plugins install / self update) ---------- */

function WP_Filesystem() { return true; }
function wp_mkdir_p( $dir ) { return is_dir( $dir ) || mkdir( $dir, 0777, true ); }
function wp_clean_plugins_cache( $clear = true ) {}
function activate_plugin( $file, $redirect = '', $network = false, $silent = false ) { return null; }
function show_message( $m ) {}
function unzip_file( $file, $to ) {
	$z = new ZipArchive();
	$z->open( $file );
	$z->extractTo( $to );
	$z->close();
	return true;
}
class WP_Ajax_Upgrader_Skin {
	public function get_errors() { return new WP_Error(); }
	public function get_error_messages() { return ''; }
}
class Plugin_Upgrader {
	public function __construct( $skin = null ) {}
	public function install( $package, $args = array() ) {
		$GLOBALS['pibt']['upgrader_calls'][] = basename( $package );
		$z = new ZipArchive();
		$z->open( $package );
		$tops = array();
		for ( $i = 0; $i < $z->numFiles; $i++ ) {
			$tops[ explode( '/', $z->getNameIndex( $i ) )[0] ] = true;
		}
		if ( $GLOBALS['pibt']['upgrader_fail'] > 0 ) {
			$GLOBALS['pibt']['upgrader_fail']--;
			// A failed overwrite install can leave the destination cleared.
			foreach ( array_keys( $tops ) as $t ) {
				pibt_rrmdir( WP_PLUGIN_DIR . '/' . $t );
			}
			$z->close();
			return new WP_Error( 'copy_failed', 'Could not copy file.' );
		}
		foreach ( array_keys( $tops ) as $t ) {
			pibt_rrmdir( WP_PLUGIN_DIR . '/' . $t );
		}
		$z->extractTo( WP_PLUGIN_DIR );
		$z->close();
		return true;
	}
}

/* ---------- load the plugin ---------- */

add_filter(
	'pib_connector_seo_plugin',
	function ( $detected ) {
		return $GLOBALS['pibt']['adapter'];
	}
);

add_filter(
	'pib_connector_self_dir',
	function () {
		return WP_PLUGIN_DIR . '/pib-connector';
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
