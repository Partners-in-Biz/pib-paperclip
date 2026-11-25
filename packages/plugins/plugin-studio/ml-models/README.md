# Studio ML models (PAR-10126 D5b)

Vendored model files for the contained ML runner (`src/ml/runner.ts`, built to `dist/ml/runner.mjs`). The build copies
the `.onnx` files, their licences and `SHA256SUMS` to `dist/ml/models/`; `scripts/bundle-size-guard.mjs` fails the build
when a copied model's SHA-256 differs from `SHA256SUMS`. Models are executable data for a native runtime: they are
vendored and pinned here, never fetched at run time.

| File | Model | Upstream | Licence |
|---|---|---|---|
| `yunet.onnx` (232,589 bytes) | YuNet face detector, `face_detection_yunet_2023mar.onnx`, input `input` [1,3,640,640] | github.com/opencv/opencv_zoo `models/face_detection_yunet/` (same bytes at huggingface.co/opencv/face_detection_yunet) | MIT, `yunet.LICENSE` |
| `selfie-segmentation.onnx` (462,352 bytes) | MediaPipe selfie segmentation (general, 256x256), `onnx/model.onnx`, input `pixel_values` [n,3,256,256] | huggingface.co/onnx-community/mediapipe_selfie_segmentation, revision `be49485c8e027524be38591817fc5cd31bd9d00e` | Apache-2.0, `selfie-segmentation.LICENSE` |

The ONNX Runtime licence (`onnxruntime.LICENSE`, MIT) and its third-party notices
(`onnxruntime.ThirdPartyNotices.txt`, from the `v1.31.1` tag of github.com/microsoft/onnxruntime) are copied beside the
pruned runtime in `dist/ml/node_modules/onnxruntime-node/` and `dist/ml/node_modules/onnxruntime-common/`.

To change a model: replace the file, update `SHA256SUMS` (`sha256sum selfie-segmentation.onnx yunet.onnx > SHA256SUMS`),
this table and the licence, and say why in the PR.
