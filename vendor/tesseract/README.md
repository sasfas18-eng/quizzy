Vendored OCR engine (no network needed at run time):
- tesseract.min.js, worker.min.js — tesseract.js 7.0.0 (Apache-2.0)
- tesseract-core-simd-lstm.wasm.js — tesseract.js-core 6.1.2 (Apache-2.0), the SIMD + LSTM build
- lang/eng.traineddata.gz, lang/ara.traineddata.gz — @tesseract.js-data 1.0.0 (tessdata_best, integer model; Apache-2.0)
Loaded lazily by shared/reader.js only when a lecture has image-only pages or pictures.
