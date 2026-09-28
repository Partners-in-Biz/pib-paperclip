<?php
/**
 * `log` and `undo`.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Undo {

	/**
	 * Endpoint => [ feature, handler ] for undoable writes.
	 */
	public static function undoable() {
		return array(
			'seo/set'          => array( 'seo', array( 'PIB_Connector_SEO', 'undo' ) ),
			'schema/set'       => array( 'schema', array( 'PIB_Connector_Schema', 'undo' ) ),
			'redirects/set'    => array( 'redirects', array( 'PIB_Connector_Redirects', 'undo' ) ),
			'redirects/delete' => array( 'redirects', array( 'PIB_Connector_Redirects', 'undo' ) ),
			'robots/set'       => array( 'robots', array( 'PIB_Connector_Robots', 'undo' ) ),
			'sitemap/set'      => array( 'sitemap', array( 'PIB_Connector_Sitemap', 'undo' ) ),
		);
	}

	public static function endpoint_log( array $params ) {
		$limit = PIB_Connector_Log::CAP;
		if ( array_key_exists( 'limit', $params ) && null !== $params['limit'] ) {
			$limit = PIB_Connector_Util::positive_int( $params['limit'] );
			if ( null === $limit ) {
				return PIB_Connector_Util::bad_request( 'limit must be a positive integer.' );
			}
		}
		return array( 'changes' => PIB_Connector_Log::public_entries( $limit ) );
	}

	public static function endpoint_undo( array $params ) {
		$change_id = isset( $params['changeId'] ) ? $params['changeId'] : null;
		if ( ! is_string( $change_id ) || ! preg_match( '/^chg_[0-9a-f]{16}$/', $change_id ) ) {
			return PIB_Connector_Util::bad_request( 'changeId is not valid.' );
		}
		$entry = PIB_Connector_Log::find( $change_id );
		if ( null === $entry ) {
			return PIB_Connector_Util::error( 'pib_not_found', 'No change with that id in the last 200 changes.', 404 );
		}
		if ( ! empty( $entry['undone'] ) ) {
			return PIB_Connector_Util::error( 'pib_already_undone', 'That change was already undone.', 409 );
		}
		$endpoint = isset( $entry['endpoint'] ) ? $entry['endpoint'] : '';
		if ( 0 === strpos( $endpoint, 'plugins/' ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'Plugin installs are reverted with plugins/rollback.', 422 );
		}
		$map = self::undoable();
		if ( ! isset( $map[ $endpoint ] ) ) {
			return PIB_Connector_Util::error( 'pib_not_undoable', 'That change cannot be undone.', 422 );
		}
		list( $feature, $handler ) = $map[ $endpoint ];
		if ( ! PIB_Connector_Settings::feature_enabled( $feature ) ) {
			return PIB_Connector_Util::error( 'pib_disabled', sprintf( 'The %s feature is switched off in Settings → PiB Connector.', $feature ), 403 );
		}

		$result = call_user_func( $handler, $entry );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		list( $target, $before, $after, $warnings ) = $result;

		$new_id = PIB_Connector_Log::record(
			'undo',
			$feature,
			$target,
			PIB_Connector_Log::clean_reason( isset( $params['reason'] ) ? $params['reason'] : null ),
			$before,
			$after,
			array( 'undoOf' => $change_id )
		);
		PIB_Connector_Log::mark_undone( $change_id, $new_id );

		$out = array(
			'changeId' => $new_id,
			'undid'    => $change_id,
		);
		if ( ! empty( $warnings ) ) {
			$out['warnings'] = $warnings;
		}
		return $out;
	}
}
