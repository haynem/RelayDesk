import { type StreamsReader, type StreamsWriter } from './streams-transport.js';
import type { ImapTransport } from './types.js';
/** The part of a `cloudflare:sockets` Socket the transport uses */
export interface SocketsApiSocket {
    readable: {
        getReader(): StreamsReader;
    };
    writable: {
        getWriter(): StreamsWriter;
    };
    opened: Promise<{
        remoteAddress?: string | undefined;
        localAddress?: string | undefined;
    } | undefined>;
    closed: Promise<void>;
    close(): Promise<void>;
    startTls(): SocketsApiSocket;
}
/** The `connect()` function of the `cloudflare:sockets` API */
export type SocketsConnect = (address: {
    hostname: string;
    port: number;
}, options?: {
    secureTransport?: 'off' | 'on' | 'starttls' | undefined;
    allowHalfOpen?: boolean | undefined;
} | undefined) => SocketsApiSocket;
/**
 * Builds a transport for the `transport` option from the `connect()` of the `cloudflare:sockets`
 * API, for celld and other runtimes without `node:net` and `node:tls`:
 *
 * ```js
 * import { connect } from 'cloudflare:sockets';
 * const client = new ImapFlow({ host, port: 993, secure: true, auth, transport: createSocketsTransport(connect) });
 * ```
 *
 * The runtime verifies the server certificate against its own root store, so the transport
 * refuses `tls.rejectUnauthorized: false`, a custom `tls.ca`, client certificates and a
 * `servername` that differs from `host`. The socket carries no cipher details, so `client.tls`
 * stays `false` on a secure connection.
 *
 * @param connect - The `connect` export of `cloudflare:sockets`
 * @returns A transport for the `transport` option
 */
export declare function createSocketsTransport(connect: SocketsConnect): ImapTransport;
