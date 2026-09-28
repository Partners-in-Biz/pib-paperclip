<?php
/**
 * Settings → PiB Connector.
 *
 * @package PiB_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class PIB_Connector_Admin {

	const PAGE   = 'pib-connector';
	const ACTION = 'pib_connector_save';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_post_' . self::ACTION, array( __CLASS__, 'save' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( PIB_CONNECTOR_FILE ), array( __CLASS__, 'action_links' ) );
	}

	public static function menu() {
		add_options_page(
			__( 'PiB Connector', 'pib-connector' ),
			__( 'PiB Connector', 'pib-connector' ),
			'manage_options',
			self::PAGE,
			array( __CLASS__, 'render' )
		);
	}

	public static function action_links( $links ) {
		$url = admin_url( 'options-general.php?page=' . self::PAGE );
		array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'pib-connector' ) . '</a>' );
		return $links;
	}

	private static function page_url( $msg = null ) {
		$url = admin_url( 'options-general.php?page=' . self::PAGE );
		if ( null !== $msg ) {
			$url = add_query_arg( 'pib_msg', $msg, $url );
		}
		return $url;
	}

	public static function save() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You are not allowed to change these settings.', 'pib-connector' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( self::ACTION );

		$msg = 'saved';

		// Key: blank keeps the current key.
		if ( ! empty( $_POST['pib_disconnect'] ) ) {
			PIB_Connector_Settings::delete_key();
			$msg = 'disconnected';
		} else {
			$raw = isset( $_POST['pib_key'] ) ? trim( sanitize_text_field( wp_unslash( $_POST['pib_key'] ) ) ) : '';
			if ( '' !== $raw ) {
				if ( PIB_Connector_Settings::is_valid_key( $raw ) ) {
					PIB_Connector_Settings::set_key( $raw );
					$msg = 'key_saved';
				} else {
					$msg = 'bad_key';
				}
			}
		}

		$posted   = ( isset( $_POST['pib_features'] ) && is_array( $_POST['pib_features'] ) ) ? wp_unslash( $_POST['pib_features'] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- only keys are read against a fixed list.
		$features = array();
		foreach ( array_keys( PIB_Connector_Settings::feature_defaults() ) as $feature ) {
			$features[ $feature ] = isset( $posted[ $feature ] ) && '1' === (string) $posted[ $feature ];
		}
		PIB_Connector_Settings::set_features( $features );

		wp_safe_redirect( self::page_url( $msg ) );
		exit;
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$key      = PIB_Connector_Settings::get_key();
		$source   = PIB_Connector_Settings::key_source();
		$features = PIB_Connector_Settings::features();
		$labels   = PIB_Connector_Settings::feature_labels();
		$msg      = isset( $_GET['pib_msg'] ) ? sanitize_key( wp_unslash( $_GET['pib_msg'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only.
		$notices  = array(
			'saved'        => array( 'success', __( 'Settings saved.', 'pib-connector' ) ),
			'key_saved'    => array( 'success', __( 'Key saved. Paperclip can now connect.', 'pib-connector' ) ),
			'disconnected' => array( 'warning', __( 'Key removed. Paperclip can no longer make changes.', 'pib-connector' ) ),
			'bad_key'      => array( 'error', __( 'That does not look like a PiB Connector key (it starts with pibc_ and has 48 characters). Nothing else was changed about the key.', 'pib-connector' ) ),
		);
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'PiB Connector', 'pib-connector' ); ?></h1>
			<?php if ( isset( $notices[ $msg ] ) ) : ?>
				<div class="notice notice-<?php echo esc_attr( $notices[ $msg ][0] ); ?> is-dismissible"><p><?php echo esc_html( $notices[ $msg ][1] ); ?></p></div>
			<?php endif; ?>

			<p><?php esc_html_e( 'Lets Partners in Biz make a short, fixed list of SEO and maintenance changes on this site. Every change is logged and can be undone.', 'pib-connector' ); ?></p>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="<?php echo esc_attr( self::ACTION ); ?>" />
				<?php wp_nonce_field( self::ACTION ); ?>

				<h2><?php esc_html_e( 'Connection', 'pib-connector' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Status', 'pib-connector' ); ?></th>
						<td>
							<?php if ( null === $key ) : ?>
								<strong><?php esc_html_e( 'Not connected', 'pib-connector' ); ?></strong>
							<?php else : ?>
								<strong><?php esc_html_e( 'Key set', 'pib-connector' ); ?></strong> —
								<?php esc_html_e( 'key id', 'pib-connector' ); ?> <code><?php echo esc_html( PIB_Connector_Settings::key_id( $key ) ); ?></code>
								<p><?php esc_html_e( 'Key source:', 'pib-connector' ); ?>
									<strong><?php echo 'file' === $source ? esc_html__( 'key file', 'pib-connector' ) : esc_html__( 'settings', 'pib-connector' ); ?></strong>
									<?php if ( 'file' === $source ) : ?>
										(<code>wp-content/pib-connector-key.php</code>)
									<?php endif; ?>
								</p>
								<p class="description"><?php esc_html_e( 'Paperclip shows the same key id when the keys match. A key saved here takes precedence over the key file.', 'pib-connector' ); ?></p>
							<?php endif; ?>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="pib_key"><?php echo null === $key ? esc_html__( 'Key', 'pib-connector' ) : esc_html__( 'Replace key', 'pib-connector' ); ?></label></th>
						<td>
							<input type="password" id="pib_key" name="pib_key" class="regular-text code" value="" autocomplete="off" spellcheck="false" placeholder="pibc_…" />
							<p class="description"><?php esc_html_e( 'Get the key from Paperclip → CRM → the client → Websites → Connect WordPress.', 'pib-connector' ); ?></p>
							<?php if ( null !== $key ) : ?>
								<p class="description"><?php esc_html_e( 'Leave blank to keep the current key.', 'pib-connector' ); ?></p>
								<?php if ( 'settings' === $source ) : ?>
									<p><label><input type="checkbox" name="pib_disconnect" value="1" /> <?php esc_html_e( 'Disconnect (remove the key saved here)', 'pib-connector' ); ?></label></p>
									<?php if ( null !== PIB_Connector_Settings::file_key() ) : ?>
										<p class="description"><?php esc_html_e( 'A key file also exists; after disconnecting, the key file is used.', 'pib-connector' ); ?></p>
									<?php endif; ?>
								<?php else : ?>
									<p class="description"><?php esc_html_e( 'To disconnect a key-file pairing, remove or rename wp-content/pib-connector-key.php.', 'pib-connector' ); ?></p>
								<?php endif; ?>
							<?php endif; ?>
						</td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'What Paperclip may change', 'pib-connector' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php foreach ( $labels as $feature => $label ) : ?>
						<tr>
							<th scope="row"><?php echo esc_html( $feature ); ?></th>
							<td>
								<label>
									<input type="checkbox" name="pib_features[<?php echo esc_attr( $feature ); ?>]" value="1" <?php checked( ! empty( $features[ $feature ] ) ); ?> />
									<?php echo esc_html( $label ); ?>
								</label>
								<?php if ( 'plugins' === $feature ) : ?>
									<p class="description"><?php esc_html_e( 'Only switch this on when Partners in Biz asks. Installs are checksum-verified and the old version is backed up first.', 'pib-connector' ); ?></p>
								<?php endif; ?>
							</td>
						</tr>
					<?php endforeach; ?>
				</table>

				<?php submit_button( __( 'Save', 'pib-connector' ) ); ?>
			</form>

			<h2><?php esc_html_e( 'Recent changes', 'pib-connector' ); ?></h2>
			<?php $entries = PIB_Connector_Log::public_entries( 20 ); ?>
			<?php if ( empty( $entries ) ) : ?>
				<p><?php esc_html_e( 'No changes yet.', 'pib-connector' ); ?></p>
			<?php else : ?>
				<table class="widefat striped">
					<thead>
						<tr>
							<th><?php esc_html_e( 'When (UTC)', 'pib-connector' ); ?></th>
							<th><?php esc_html_e( 'What', 'pib-connector' ); ?></th>
							<th><?php esc_html_e( 'Target', 'pib-connector' ); ?></th>
							<th><?php esc_html_e( 'Who', 'pib-connector' ); ?></th>
							<th><?php esc_html_e( 'Reason', 'pib-connector' ); ?></th>
							<th><?php esc_html_e( 'Undone', 'pib-connector' ); ?></th>
						</tr>
					</thead>
					<tbody>
						<?php foreach ( $entries as $e ) : ?>
							<tr>
								<td><code><?php echo esc_html( (string) $e['at'] ); ?></code></td>
								<td><?php echo esc_html( (string) $e['endpoint'] ); ?></td>
								<td><?php echo esc_html( self::describe_target( $e['target'] ) ); ?></td>
								<td><?php echo esc_html( (string) $e['actor'] ); ?></td>
								<td><?php echo esc_html( (string) $e['reason'] ); ?></td>
								<td><?php echo $e['undone'] ? esc_html__( 'yes', 'pib-connector' ) : ''; ?></td>
							</tr>
						<?php endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>
		<?php
	}

	private static function describe_target( $target ) {
		if ( ! is_array( $target ) ) {
			return '';
		}
		if ( isset( $target['url'] ) && is_string( $target['url'] ) ) {
			return $target['url'];
		}
		if ( isset( $target['from'] ) ) {
			return (string) $target['from'];
		}
		if ( isset( $target['slug'] ) ) {
			return (string) $target['slug'];
		}
		return implode( ', ', array_keys( $target ) );
	}
}
