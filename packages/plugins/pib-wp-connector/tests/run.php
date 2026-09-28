<?php
/**
 * PiB Connector test runner: `php tests/run.php`. Exits non-zero on any failure.
 */

require __DIR__ . '/bootstrap.php';
foreach ( glob( __DIR__ . '/test-*.php' ) as $pibt_file ) {
	require $pibt_file;
}

$pibt_pass = 0;
$pibt_fail = 0;
foreach ( $GLOBALS['pibt_tests'] as $pibt_case ) {
	list( $pibt_name, $pibt_fn ) = $pibt_case;
	pibt_reset();
	try {
		$pibt_fn();
		$pibt_pass++;
		echo "ok   - $pibt_name\n";
	} catch ( PIBT_Fail $e ) {
		$pibt_fail++;
		echo "FAIL - $pibt_name\n      " . $e->getMessage() . "\n";
	} catch ( Throwable $e ) {
		$pibt_fail++;
		echo "FAIL - $pibt_name\n      " . get_class( $e ) . ': ' . $e->getMessage() . ' @ ' . basename( $e->getFile() ) . ':' . $e->getLine() . "\n";
	}
}

// Clean the scratch WordPress dir.
$pibt_root = rtrim( ABSPATH, '/' );
if ( 0 === strpos( basename( $pibt_root ), 'pibc-tests-' ) && is_dir( $pibt_root ) ) {
	$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $pibt_root, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST );
	foreach ( $it as $f ) {
		$f->isDir() ? rmdir( $f->getPathname() ) : unlink( $f->getPathname() );
	}
	rmdir( $pibt_root );
}

echo "\n" . ( $pibt_pass + $pibt_fail ) . " tests, $pibt_pass passed, $pibt_fail failed\n";
exit( $pibt_fail > 0 ? 1 : 0 );
