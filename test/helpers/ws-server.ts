/**
 * A small WebSocket server (RFC 6455) for the fake CDP endpoints in the
 * runtime tests, so the tests need no WebSocket package. It speaks what the
 * client under test uses: text and binary messages of any size (with
 * continuation frames), ping, and close. No extensions are negotiated.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class TestWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly OPEN = TestWebSocket.OPEN;
  readyState = TestWebSocket.OPEN;
  private buffered = Buffer.alloc(0);
  private fragments: Buffer[] = [];

  constructor(private readonly socket: Duplex) {
    super();
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    // An HTTP server socket stays half open after the peer's FIN, so the
    // peer going away shows as 'end' before (or instead of) 'close'.
    socket.on('end', () => { socket.end(); this.markClosed(); });
    socket.on('close', () => this.markClosed());
    socket.on('error', () => this.markClosed());
  }

  /** Send a text message (a string) or a binary one (a Buffer). */
  send(data: string | Buffer): void {
    if (this.readyState !== TestWebSocket.OPEN) return;
    const binary = Buffer.isBuffer(data);
    this.writeFrame(binary ? 0x2 : 0x1, binary ? data : Buffer.from(data, 'utf8'));
  }

  close(): void {
    if (this.readyState !== TestWebSocket.OPEN) return;
    this.writeFrame(0x8, Buffer.from([0x03, 0xe8]));
    this.socket.end();
    this.markClosed();
  }

  terminate(): void {
    this.socket.destroy();
    this.markClosed();
  }

  private markClosed(): void {
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.readyState = TestWebSocket.CLOSED;
    this.emit('close');
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private receive(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    for (;;) {
      if (this.buffered.length < 2) return;
      const first = this.buffered[0];
      const second = this.buffered[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffered.length < 4) return;
        length = this.buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffered.length < 10) return;
        length = Number(this.buffered.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffered.length < offset + length) return;
      const payload = Buffer.from(this.buffered.subarray(offset, offset + length));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= this.buffered[maskOffset + (i % 4)];
      }
      this.buffered = this.buffered.subarray(offset + length);
      this.handleFrame((first & 0x80) !== 0, first & 0x0f, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      if (this.readyState === TestWebSocket.OPEN) {
        this.writeFrame(0x8, payload.subarray(0, 2));
        this.socket.end();
      }
      this.markClosed();
      return;
    }
    if (opcode === 0x9) {
      this.writeFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;
    this.fragments.push(payload);
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    this.emit('message', message);
  }
}

export class TestWebSocketServer extends EventEmitter {
  private readonly clients = new Set<TestWebSocket>();

  /** Answer an HTTP upgrade request and hand the open socket to `done`. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, done: (webSocket: TestWebSocket) => void): void {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    const webSocket = new TestWebSocket(socket);
    this.clients.add(webSocket);
    webSocket.on('close', () => this.clients.delete(webSocket));
    if (head.length > 0) socket.unshift(head);
    done(webSocket);
  }

  close(done?: () => void): void {
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    done?.();
  }
}
