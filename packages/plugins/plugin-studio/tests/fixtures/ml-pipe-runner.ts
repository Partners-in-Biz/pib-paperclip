/**
 * A stand-in for `dist/ml/runner.mjs` in the process tests (tests/ml-containment.spec.ts bundles it with esbuild): starts a
 * decoder and an encoder through `src/ml/io.ts` and pipes raw frames from one to the other until it is killed.
 *
 *   node ml-pipe-runner.mjs <workdir>
 */
import { startFfmpeg } from "../../src/ml/io.js";

const decoder = startFfmpeg(["-nostdin", "-re", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdout: true });
const encoder = startFfmpeg(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "320x240", "-r", "25", "-i", "pipe:0", "-f", "null", "-"], { stdin: true });
decoder.stdout!.pipe(encoder.stdin!);
process.stderr.write(`children ${decoder.pid} ${encoder.pid} workdir ${process.argv[2] ?? "-"}\n`);
const [d, e] = await Promise.all([decoder.done, encoder.done]);
process.stdout.write(`${JSON.stringify({ decoder: d.exitCode, encoder: e.exitCode })}\n`);
