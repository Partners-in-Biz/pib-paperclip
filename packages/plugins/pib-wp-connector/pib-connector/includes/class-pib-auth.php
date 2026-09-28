<?php
/**
 * Request signature verification (HMAC-SHA256, see PROTOCOL.md).
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Auth {

	const MAX_SKEW      = 300;
	const NONCE_TTL     = 600;
	const NONCE_PREFIX  = 'pib_cn_';
	const ROUTE_PREFIX  = '/pib-connector/v1/';

	/**
	 * The exact string that gets signed.
	 *
	 * @param string $timestamp Unix seconds as sent.
	 * @param string $nonce     32 hex.
	 * @param string $route     `/pib-connector/v1/<endpoint>`.
	 * @param string $body      Raw request body.
	 * @return string
	 */
	public static function string_to_sign( $timestamp, $nonce, $route, $body ) {
		return implode(
			"\n",
			array(
				(string) $timestamp,
				(string) $nonce,
				'POST',
				(string) $route,
				hash( 'sha256', (string) $body ),
			)
		);
	}

	/**
	 * @return string lowercase hex HMAC-SHA256.
	 */
	public static function sign( $key, $timestamp, $nonce, $route, $body ) {
		return hash_hmac( 'sha256', self::string_to_sign( $timestamp, $nonce, $route, $body ), (string) $key );
	}

	/**
	 * Verify a signed request for a known endpoint.
	 *
	 * @param WP_REST_Request $request  Request.
	 * @param string          $endpoint Endpoint name, e.g. `seo/get`.
	 * @return true|WP_Error
	 */
	public static function verify( $request, $endpoint ) {
		$key = PIB_Connector_Settings::get_key();
		if ( null === $key ) {
			return new WP_Error( 'pib_not_paired', 'This site has no PiB Connector key yet.', array( 'status' => 401 ) );
		}

		$key_id    = strtolower( self::header( $request, 'X-PIB-Key-Id' ) );
		$timestamp = self::header( $request, 'X-PIB-Timestamp' );
		$nonce     = self::header( $request, 'X-PIB-Nonce' );
		$signature = strtolower( self::header( $request, 'X-PIB-Signature' ) );

		$bad = new WP_Error( 'pib_bad_signature', 'The key id or signature is wrong.', array( 'status' => 401 ) );

		if ( ! preg_match( '/^[0-9a-f]{12}$/', $key_id ) || ! hash_equals( PIB_Connector_Settings::key_id( $key ), $key_id ) ) {
			return $bad;
		}
		if ( ! preg_match( '/^[0-9]{1,12}$/', $timestamp ) || ! preg_match( '/^[0-9a-fA-F]{32}$/', $nonce ) || ! preg_match( '/^[0-9a-f]{64}$/', $signature ) ) {
			return $bad;
		}

		$route    = self::ROUTE_PREFIX . $endpoint;
		$body     = (string) $request->get_body();
		$expected = self::sign( $key, $timestamp, $nonce, $route, $body );
		if ( ! hash_equals( $expected, $signature ) ) {
			return $bad;
		}

		if ( abs( time() - (int) $timestamp ) > self::MAX_SKEW ) {
			return new WP_Error( 'pib_stale', 'The request timestamp is too far from the server clock.', array( 'status' => 401 ) );
		}

		$transient = self::NONCE_PREFIX . strtolower( $nonce );
		if ( false !== get_transient( $transient ) ) {
			return new WP_Error( 'pib_replay', 'This nonce was already used.', array( 'status' => 401 ) );
		}
		set_transient( $transient, 1, self::NONCE_TTL );

		return true;
	}

	/**
	 * Read a header as a trimmed string ('' when missing).
	 */
	private static function header( $request, $name ) {
		$value = $request->get_header( $name );
		if ( ! is_string( $value ) ) {
			return '';
		}
		return trim( $value );
	}

	/**
	 * Optional actor header, e.g. `agent:<id>` or `user:<id>`.
	 *
	 * @return string|null
	 */
	public static function actor( $request ) {
		$value = $request->get_header( 'X-PIB-Actor' );
		if ( ! is_string( $value ) ) {
			return null;
		}
		$value = preg_replace( '/[^A-Za-z0-9:_@.\-]/', '', $value );
		$value = substr( (string) $value, 0, 100 );
		return '' === $value ? null : $value;
	}
}
