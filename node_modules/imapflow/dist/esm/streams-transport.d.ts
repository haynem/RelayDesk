import type { ImapTransport, ImapTransportConnectOptions, ImapTransportOptions } from './types.js';
/** The reader of {@link StreamsSocketInfo.readable} */
export interface StreamsReader {
    read(): Promise<{
        done: boolean;
        value?: Uint8Array | undefined;
    }>;
    releaseLock(): void;
}
/** The writer of {@link StreamsSocketInfo.writable} */
export interface StreamsWriter {
    write(chunk: Uint8Array): Promise<void>;
    releaseLock(): void;
}
/** What a {@link StreamsSocket} resolves with once it is open */
export interface StreamsSocketInfo {
    /** Bytes from the server, a ReadableStream of Uint8Array */
    readable: {
        getReader(): StreamsReader;
    };
    /** Bytes to the server, a WritableStream of Uint8Array */
    writable: {
        getWriter(): StreamsWriter;
    };
    remoteAddress?: string | undefined;
    remotePort?: number | undefined;
    localAddress?: string | undefined;
    localPort?: number | undefined;
    /** Details of a TLS connection, reported as `client.tls`. Left out when the API has none */
    tls?: StreamsTlsInfo | undefined;
}
/** What a socket API knows about a TLS connection */
export interface StreamsTlsInfo {
    /** Whether the server certificate was verified */
    authorized: boolean;
    /** Cipher name, e.g. `TLS_AES_256_GCM_SHA384` */
    name?: string | undefined;
    standardName?: string | undefined;
    /** Protocol version, e.g. `TLSv1.3` */
    version?: string | undefined;
}
/** A connection of a web streams socket API, as {@link StreamsTransportApi} opens it */
export interface StreamsSocket {
    /** Resolves once the connection (and the TLS handshake, if any) is established, rejects if it fails */
    opened: Promise<StreamsSocketInfo>;
    /** Rejects if the connection fails after it was opened */
    closed?: Promise<unknown> | undefined;
    /** Closes the connection */
    close(): unknown;
}
/** The socket API that {@link createStreamsTransport} drives */
export interface StreamsTransportApi<S extends StreamsSocket = StreamsSocket> {
    /**
     * Opens a connection, cleartext or TLS as `options.secure` says. Throws to refuse it, for
     * example with an `UnsupportedTransportOption` error for TLS options the API can not honor.
     */
    open(options: ImapTransportConnectOptions): S;
    /**
     * Starts TLS on an open cleartext connection after STARTTLS and returns the TLS connection,
     * the old one stays open as its transport. Throws to refuse the upgrade. Leave it out when
     * the API can not upgrade a connection: ImapFlow then does not try STARTTLS.
     */
    upgrade?: ((socket: S, options: ImapTransportOptions) => S) | undefined;
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
export declare function createStreamsTransport<S extends StreamsSocket>(api: StreamsTransportApi<S>): ImapTransport;
