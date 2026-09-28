<?php
/**
 * Small shared helpers.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Util {

	/**
	 * @return WP_Error
	 */
	public static function error( $code, $message, $status ) {
		return new WP_Error( $code, $message, array( 'status' => (int) $status ) );
	}

	public static function bad_request( $message ) {
		return self::error( 'pib_bad_request', $message, 400 );
	}

	/**
	 * Optional string field: absent => $absent marker, null/'' => null, string => trimmed.
	 * Returns WP_Error when the value has the wrong type or is too long.
	 */
	public static function optional_string( array $params, $key, $max_len, $absent = null ) {
		if ( ! array_key_exists( $key, $params ) ) {
			return $absent;
		}
		$value = $params[ $key ];
		if ( null === $value ) {
			return null;
		}
		if ( ! is_string( $value ) ) {
			return self::bad_request( sprintf( '%s must be a string or null.', $key ) );
		}
		$value = trim( $value );
		if ( '' === $value ) {
			return null;
		}
		if ( self::strlen( $value ) > $max_len ) {
			return self::bad_request( sprintf( '%s is longer than %d characters.', $key, $max_len ) );
		}
		if ( preg_match( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $value ) ) {
			return self::bad_request( sprintf( '%s contains control characters.', $key ) );
		}
		return $value;
	}

	/**
	 * Plain single-line text: tags stripped, whitespace collapsed, invalid UTF-8 removed.
	 * Unlike sanitize_text_field() it keeps %xx sequences, so Yoast/RankMath variables
	 * such as %%category%% survive.
	 */
	public static function clean_text( $value ) {
		$value = wp_check_invalid_utf8( (string) $value, true );
		$value = wp_strip_all_tags( $value, true );
		$value = preg_replace( '/[\x00-\x1F\x7F]+/', ' ', $value );
		$value = preg_replace( '/ {2,}/', ' ', $value );
		return trim( $value );
	}

	public static function strlen( $value ) {
		return function_exists( 'mb_strlen' ) ? mb_strlen( $value, 'UTF-8' ) : strlen( $value );
	}

	/**
	 * Host of the site's home URL, lower-cased.
	 */
	public static function home_host() {
		$parts = wp_parse_url( home_url( '/' ) );
		return isset( $parts['host'] ) ? strtolower( $parts['host'] ) : '';
	}

	/**
	 * Is an absolute URL on this site's host?
	 */
	public static function is_same_host( $host ) {
		$host = strtolower( (string) $host );
		$home = self::home_host();
		if ( $host === $home ) {
			return true;
		}
		// Treat www and the bare domain as the same site.
		return preg_replace( '/^www\./', '', $host ) === preg_replace( '/^www\./', '', $home );
	}

	/**
	 * Positive int from an int or a digit string, else null.
	 */
	public static function positive_int( $value ) {
		if ( is_int( $value ) && $value > 0 ) {
			return $value;
		}
		if ( is_string( $value ) && preg_match( '/^[1-9][0-9]{0,18}$/', $value ) ) {
			return (int) $value;
		}
		if ( is_float( $value ) && $value > 0 && floor( $value ) === $value && $value < PHP_INT_MAX ) {
			return (int) $value;
		}
		return null;
	}
}
