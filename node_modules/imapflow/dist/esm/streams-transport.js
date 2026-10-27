// The `transport` option over a socket API built on web streams: the socket opens with a promise
// that resolves to a ReadableStream and a WritableStream of bytes. `cloudflare:sockets` (celld,
// Cloudflare Workers) is one, see sockets-transport.ts; Chrome's Direct Sockets and in-memory
// connections fit the same shape. The streams are wrapped into a Duplex that behaves like the
// net.Socket ImapFlow drives.
import { Duplex } from 'node:stream';
import { clearTimer, noop, unrefTimer } from './tools.js';
function closeQuietly(socket) {
    try {
        Promise.resolve(socket.close()).catch(noop);
    }
    catch {
        // already closed
    }
}
class StreamsDuplex extends Duplex {
    constructor(api, socket, onConnect, plain) {
        super({ allowHalfOpen: false });
        // Taken once the socket is open: locking the streams of a socket returned by startTls()
        // before its handshake completes stalls the handshake on celld
        this._reader = null;
        this._writer = null;
        this._pumping = false;
        this._readRequested = false;
        // A runtime may only start TLS on a socket without a read in flight (with one, celld never
        // completes the handshake), while the read loop always keeps one. So once the client
        // announced a STARTTLS (holdAfterStarttls), reading stops after the tagged line that answers
        // it, the only command in flight then, and resumes only when that line is not an OK.
        this._awaitingStarttls = false;
        this._lineTail = '';
        // Set when the partial line got too long to be the one looked for and was dropped: the rest
        // of it, up to the next line break, is skipped too
        this._tailDropped = false;
        this._readsHeld = false;
        // Set once startTls() handed the connection to a TLS socket: the read that ends then is not
        // the end of the connection, and closing this socket would close the TLS one
        this._upgraded = false;
        this._timeout = 0;
        this._timer = null;
        // Traffic only records the time, the one timer re-arms itself for the rest of the idle period
        this._lastActivity = 0;
        this._api = api;
        this._socket = socket;
        this._plain = plain || null;
        socket.opened.then(info => {
            if (this.destroyed) {
                return;
            }
            try {
                this._reader = info.readable.getReader();
                this._writer = info.writable.getWriter();
            }
            catch (err) {
                // streams already locked by someone else
                this.destroy(err);
                return;
            }
            this.remoteAddress = info.remoteAddress;
            this.remotePort = info.remotePort;
            this.localAddress = info.localAddress;
            this.localPort = info.localPort;
            const tls = info.tls;
            if (tls) {
                this.authorized = tls.authorized;
                this.getCipher = () => ({ name: tls.name || '', standardName: tls.standardName || tls.name || '', version: tls.version || '' });
            }
            this._touch();
            onConnect();
            if (this._readRequested) {
                void this._pump();
            }
        }, (err) => this.destroy(err));
        socket.closed?.catch((err) => {
            if (!this._upgraded) {
                this.destroy(err);
            }
        });
    }
    _read() {
        if (this._readsHeld) {
            return;
        }
        if (!this._reader) {
            this._readRequested = true;
        }
        else if (!this._pumping) {
            void this._pump();
        }
    }
    async _pump() {
        const reader = this._reader;
        this._pumping = true;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (this._upgraded || this.destroyed) {
                    return;
                }
                if (done || !value) {
                    this.push(null);
                    return;
                }
                this._touch();
                const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                const pushed = this.push(chunk);
                if (this._awaitingStarttls && this._starttlsCompleted(chunk)) {
                    this._readsHeld = true;
                    return;
                }
                if (!pushed) {
                    return;
                }
            }
        }
        catch (err) {
            if (!this._upgraded) {
                this.destroy(err);
            }
        }
        finally {
            this._pumping = false;
        }
    }
    // Whether the chunk holds the tagged response of the STARTTLS command and it is an OK. Lines
    // end with LF, CR is optional, as for the parser
    _starttlsCompleted(chunk) {
        const skipFirst = this._tailDropped;
        const lines = (this._lineTail + chunk.toString('latin1')).split('\n');
        const tail = lines.pop();
        if (skipFirst && !lines.length) {
            // still inside the dropped line
            return false;
        }
        this._tailDropped = tail.length > 1024;
        this._lineTail = this._tailDropped ? '' : tail;
        for (let i = skipFirst ? 1 : 0; i < lines.length; i++) {
            const tagged = /^(?![*+] )\S+ (OK|NO|BAD)\b/i.exec(lines[i]);
            if (tagged) {
                this._awaitingStarttls = false;
                return tagged[1].toUpperCase() === 'OK';
            }
        }
        return false;
    }
    /** Stops reading after the tagged response of the STARTTLS command about to be sent, if it is an OK */
    holdAfterStarttls() {
        this._awaitingStarttls = true;
        this._lineTail = '';
        this._tailDropped = false;
    }
    _write(chunk, _encoding, callback) {
        if (!this._writer) {
            // ImapFlow writes only after onConnect, this is a misuse
            callback(new Error('Socket is not open yet'));
            return;
        }
        this._touch();
        this._writer.write(chunk).then(() => callback(), callback);
    }
    _destroy(err, callback) {
        this._clearTimer();
        if (!this._upgraded) {
            this._close();
        }
        if (this._plain) {
            // the plain connection went with the TLS one, unless the API keeps it open
            this._plain._close();
            this._plain.destroy();
        }
        callback(err);
    }
    // Closes the connection. An API that refuses to close while its streams are locked (Direct
    // Sockets) gets a second attempt with the locks released; releasing them right away would
    // fail the read in flight, which ends the request on celld
    _close() {
        const retry = () => {
            for (const stream of [this._reader, this._writer]) {
                try {
                    stream?.releaseLock();
                }
                catch {
                    // an older streams implementation refuses with a read in flight
                }
            }
            closeQuietly(this._socket);
        };
        try {
            const closing = this._socket.close();
            if (typeof closing?.then === 'function') {
                closing.then(undefined, retry);
            }
        }
        catch {
            retry();
        }
    }
    /** Like net.Socket#setTimeout(): emits 'timeout' after `ms` without traffic, 0 disables */
    setTimeout(ms) {
        this._timeout = ms;
        this._clearTimer();
        this._touch();
        return this;
    }
    setKeepAlive() {
        return this;
    }
    /** Hands the connection over to a TLS socket, this one only stays as its transport */
    startTls(options, onSecure) {
        this._upgraded = true;
        this._clearTimer();
        // workerd refuses to start TLS while the streams are locked, nothing is in flight on them
        this._reader?.releaseLock();
        this._writer?.releaseLock();
        let tlsSocket;
        try {
            tlsSocket = this._api.upgrade(this._socket, options);
        }
        catch (err) {
            // refused before any handshake, the connection is closed with this socket
            this._upgraded = false;
            throw err;
        }
        return new StreamsDuplex(this._api, tlsSocket, onSecure, this);
    }
    _touch() {
        this._lastActivity = Date.now();
        if (!this._timer) {
            this._arm(this._timeout);
        }
    }
    _arm(ms) {
        if (this._timeout > 0 && !this.destroyed && !this._upgraded) {
            this._timer = unrefTimer(setTimeout(() => {
                this._timer = null;
                const idle = Date.now() - this._lastActivity;
                if (idle >= this._timeout) {
                    this.emit('timeout');
                }
                else {
                    this._arm(this._timeout - idle);
                }
            }, ms));
        }
    }
    _clearTimer() {
        clearTimer(this._timer);
        this._timer = null;
    }
}
/**
 * Builds a transport for the `transport` option over a socket API built on web streams. A new
 * API needs only `open()`, and `upgrade()` if it can start TLS on an open connection:
 *
 * ```js
 * const transport = createStreamsTransport({
 *     open: ({ host, port, secure }) => {
 *         const socket = openSomeSocket(host, port, secure);
 *         return { opened: socket.ready.then(() => ({ readable: socket.readable, writable: socket.writable })), close: () => socket.close() };
 *     }
 * });
 * ```
 *
 * The transport stops reading once the server accepted a STARTTLS, so the API never has to start
 * TLS with a read in flight, and releases the stream locks before `upgrade()` is called.
 *
 * @param api - Opens (and upgrades) connections
 * @returns A transport for the `transport` option
 */
export function createStreamsTransport(api) {
    const transport = {
        connect: (options, onConnect) => new StreamsDuplex(api, api.open(options), onConnect)
    };
    if (api.upgrade) {
        transport.prepareUpgrade = socket => socket.holdAfterStarttls();
        transport.upgrade = (socket, options, onSecure) => socket.startTls(options, onSecure);
    }
    return transport;
}
