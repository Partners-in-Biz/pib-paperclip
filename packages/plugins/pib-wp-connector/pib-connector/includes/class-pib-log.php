<?php
/**
 * Change log: the last 200 writes, newest first, in the option `pib_connector_log`.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Log {

	const OPTION = 'pib_connector_log';
	const CAP    = 200;

	/**
	 * Current request context (actor), set by the router.
	 *
	 * @var string|null
	 */
	public static $actor = null;

	/**
	 * @return array Raw entries, newest first.
	 */
	public static function all() {
		$log = get_option( self::OPTION, array() );
		return is_array( $log ) ? array_values( $log ) : array();
	}

	private static function save( array $log ) {
		$log = array_slice( array_values( $log ), 0, self::CAP );
		if ( false === get_option( self::OPTION, false ) ) {
			add_option( self::OPTION, $log, '', false );
		} else {
			update_option( self::OPTION, $log, false );
		}
	}

	public static function new_id() {
		return 'chg_' . bin2hex( random_bytes( 8 ) );
	}

	/**
	 * Record a write.
	 *
	 * @param string      $endpoint Endpoint, e.g. `seo/set`.
	 * @param string      $feature  Feature the write belongs to.
	 * @param mixed       $target   Target description.
	 * @param string|null $reason   Reason given by the caller.
	 * @param mixed       $before   State before.
	 * @param mixed       $after    State after.
	 * @param array       $extra    Extra internal fields.
	 * @return string changeId
	 */
	public static function record( $endpoint, $feature, $target, $reason, $before, $after, array $extra = array() ) {
		$entry = array_merge(
			array(
				'changeId' => self::new_id(),
				'at'       => gmdate( 'Y-m-d\TH:i:s\Z' ),
				'actor'    => self::$actor,
				'endpoint' => $endpoint,
				'feature'  => $feature,
				'target'   => $target,
				'reason'   => $reason,
				'before'   => $before,
				'after'    => $after,
				'undone'   => false,
			),
			$extra
		);
		$log = self::all();
		array_unshift( $log, $entry );
		self::save( $log );
		return $entry['changeId'];
	}

	/**
	 * @return array|null
	 */
	public static function find( $change_id ) {
		foreach ( self::all() as $entry ) {
			if ( isset( $entry['changeId'] ) && $entry['changeId'] === $change_id ) {
				return $entry;
			}
		}
		return null;
	}

	public static function mark_undone( $change_id, $by ) {
		$log = self::all();
		foreach ( $log as $i => $entry ) {
			if ( isset( $entry['changeId'] ) && $entry['changeId'] === $change_id ) {
				$log[ $i ]['undone']   = true;
				$log[ $i ]['undoneBy'] = $by;
			}
		}
		self::save( $log );
	}

	/**
	 * Entries in the public shape.
	 *
	 * @param int $limit 1..200.
	 * @return array
	 */
	public static function public_entries( $limit = self::CAP ) {
		$limit = max( 1, min( self::CAP, (int) $limit ) );
		$out   = array();
		foreach ( array_slice( self::all(), 0, $limit ) as $entry ) {
			$out[] = array(
				'changeId' => isset( $entry['changeId'] ) ? $entry['changeId'] : null,
				'at'       => isset( $entry['at'] ) ? $entry['at'] : null,
				'actor'    => isset( $entry['actor'] ) ? $entry['actor'] : null,
				'endpoint' => isset( $entry['endpoint'] ) ? $entry['endpoint'] : null,
				'target'   => isset( $entry['target'] ) ? $entry['target'] : null,
				'reason'   => isset( $entry['reason'] ) ? $entry['reason'] : null,
				'before'   => isset( $entry['before'] ) ? $entry['before'] : null,
				'after'    => isset( $entry['after'] ) ? $entry['after'] : null,
				'undone'   => ! empty( $entry['undone'] ),
			);
		}
		return $out;
	}

	/**
	 * Clean a caller-supplied reason.
	 *
	 * @return string|null
	 */
	public static function clean_reason( $reason ) {
		if ( ! is_string( $reason ) ) {
			return null;
		}
		$reason = sanitize_text_field( $reason );
		if ( function_exists( 'mb_substr' ) ) {
			$reason = mb_substr( $reason, 0, 500 );
		} else {
			$reason = substr( $reason, 0, 500 );
		}
		return '' === $reason ? null : $reason;
	}
}
