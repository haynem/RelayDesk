"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JPDecoder = void 0;
exports.toJapaneseEncoding = toJapaneseEncoding;
const node_stream_1 = require("node:stream");
const encoding_japanese_1 = __importDefault(require("encoding-japanese"));
const limited_passthrough_js_1 = require("./limited-passthrough.js");
const ENCODING_NAMES = new Set([
    'UTF32',
    'UTF16',
    'UTF16BE',
    'UTF16LE',
    'BINARY',
    'ASCII',
    'JIS',
    'UTF8',
    'EUCJP',
    'SJIS',
    'UNICODE'
]);
/**
 * Maps a MIME charset label onto the encoding name encoding-japanese expects.
 *
 * getDecoder() routes the ISO-2022-JP, JIS and EUC-JP families here, including variant labels such
 * as "iso-2022-jp-2" or "euc-jp-ms", and each family maps to the one decoder the library has for it.
 * Shift_JIS labels are mapped too, so the class stays usable on its own. Anything else is left for
 * the library to detect from the bytes.
 *
 * @internal
 */
function toJapaneseEncoding(charset) {
    const name = charset.toUpperCase().replace(/[^A-Z0-9]+/g, '');
    if (ENCODING_NAMES.has(name)) {
        return name;
    }
    if (/^EUC/.test(name)) {
        return 'EUCJP';
    }
    if (/^(JIS|ISO2022JP)/.test(name)) {
        return 'JIS';
    }
    if (/^(SHIFTJIS|XSJIS|CP932|MSKANJI|WINDOWS31J)/.test(name)) {
        return 'SJIS';
    }
    return 'AUTO';
}
// A Transform stream for decoding Japanese character sets (Shift_JIS, EUC-JP, ISO-2022-JP).
// Unlike iconv-lite which can decode incrementally, encoding-japanese requires the complete
// input buffer for accurate charset detection and stateful decoding (especially ISO-2022-JP
// which uses escape sequences to switch between ASCII and multi-byte modes). Therefore,
// this stream buffers all input during _transform and performs the actual decoding in _flush.
class JPDecoder extends node_stream_1.Transform {
    constructor(charset, maxBytes) {
        super();
        this.charset = charset;
        this.chunks = [];
        this.chunklen = 0;
        // Upper bound for the buffered bytes, normalized the same way LimitedPassthrough
        // normalizes its own. The whole-input buffering defeats a downstream maxBytes limiter
        // (nothing is emitted until _flush), so without an internal bound a server could force
        // unbounded memory use through a caller that asked for a limited download. Excess input
        // is truncated, mirroring the truncation a maxBytes download applies anyway.
        this.maxBytes = (0, limited_passthrough_js_1.normalizeByteLimit)(maxBytes);
        // Also mirroring LimitedPassthrough: true once the bound is reached and every further
        // chunk is being discarded. The download loop reads this to stop pulling from the
        // server, which the limiter at the tail of the pipeline cannot tell it, because nothing
        // is emitted from here until _flush().
        this.limited = false;
    }
    // Buffer all incoming chunks (up to maxBytes); no decoding happens here because
    // Japanese charsets require the complete input for accurate conversion.
    _transform(chunk, encoding, done) {
        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding);
        }
        if (this.chunklen + chunk.length > this.maxBytes) {
            chunk = chunk.subarray(0, Math.max(0, this.maxBytes - this.chunklen));
        }
        if (chunk.length) {
            this.chunks.push(chunk);
            this.chunklen += chunk.length;
        }
        if (this.chunklen >= this.maxBytes) {
            this.limited = true;
        }
        done();
    }
    // Perform the actual charset conversion once all input has been received.
    // Uses the encoding-japanese library to convert from the source charset to Unicode.
    // On failure (corrupt or unrecognizable data), passes through the raw bytes unchanged.
    _flush(done) {
        let input = Buffer.concat(this.chunks, this.chunklen);
        try {
            let output = encoding_japanese_1.default.convert(input, {
                to: 'UNICODE', // to_encoding
                from: toJapaneseEncoding(this.charset), // from_encoding
                type: 'string'
            });
            this.push(Buffer.from(output));
        }
        catch {
            // keep as is on errors
            this.push(input);
        }
        done();
    }
    _destroy(err, callback) {
        this.chunks = [];
        this.chunklen = 0;
        callback(err);
    }
}
exports.JPDecoder = JPDecoder;
