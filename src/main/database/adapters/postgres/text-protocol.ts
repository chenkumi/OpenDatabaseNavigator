import pg from 'pg';
import iconv from 'iconv-lite';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { POSTGRES_ENCODINGS } from '../../../../shared/client-encodings';

const MAX_FRAME = 64 * 1024 * 1024;
const int32 = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value);
  return b;
};
function frame(code: number, body: Buffer) {
  if (body.length + 5 > MAX_FRAME)
    throw new Error('Converted PostgreSQL frame exceeds the 64 MiB limit.');
  return Buffer.concat([Buffer.from([code]), int32(body.length + 4), body]);
}

class Fields {
  offset = 0;
  readonly parts: Buffer[] = [];
  constructor(
    readonly body: Buffer,
    readonly convert: (value: Buffer) => Buffer,
  ) {}
  take(size: number) {
    if (size < 0 || this.offset + size > this.body.length)
      throw new Error('Invalid PostgreSQL protocol field length.');
    const value = this.body.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  copy(size: number) {
    const b = this.take(size);
    this.parts.push(b);
    return b;
  }
  short() {
    return this.copy(2).readUInt16BE();
  }
  string() {
    const end = this.body.indexOf(0, this.offset);
    if (end < 0) throw new Error('Unterminated PostgreSQL protocol string.');
    const value = this.convert(this.take(end - this.offset));
    this.take(1);
    this.parts.push(value, Buffer.from([0]));
    return value;
  }
  sized(text: boolean) {
    const length = this.take(4).readInt32BE();
    if (length === -1) {
      this.parts.push(int32(-1));
      return;
    }
    const value = this.take(length),
      converted = text ? this.convert(value) : value;
    this.parts.push(int32(converted.length), converted);
  }
  finish() {
    if (this.offset !== this.body.length) throw new Error('Unexpected PostgreSQL protocol fields.');
    return Buffer.concat(this.parts);
  }
}

/** pg serializes/parses UTF-8 only. Translate complete protocol text fields at
 * its Connection boundary, after TLS decryption, retaining the original socket
 * for authentication, TLS verification, backpressure and I/O deadlines. */
export class PostgresTextProtocol {
  private readonly header = Buffer.alloc(5);
  private headerBytes = 0;
  private packet?: Buffer;
  private packetBytes = 0;
  private formats: number[] = [];
  readonly encoding;
  constructor(charset: string) {
    const encoding = POSTGRES_ENCODINGS.find((entry) => entry.value === charset);
    if (!encoding) throw new Error('Unsupported PostgreSQL client character set.');
    this.encoding = encoding;
  }
  private encode = (value: Buffer) => {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    const bytes = iconv.encode(text, this.encoding.codec);
    if (iconv.decode(bytes, this.encoding.codec, { stripBOM: false }) !== text)
      throw new Error(
        `Text cannot be represented losslessly in ${this.encoding.value}. Change the connection character set.`,
      );
    return bytes;
  };
  private decode = (value: Buffer) => {
    const text = iconv.decode(value, this.encoding.codec, { stripBOM: false });
    if (!iconv.encode(text, this.encoding.codec).equals(value))
      throw new Error(`PostgreSQL text cannot be decoded losslessly as ${this.encoding.value}.`);
    return Buffer.from(text, 'utf8');
  };
  startup(config: Record<string, string>) {
    // Startup names and authentication remain pg's UTF-8 path; the server's
    // client_encoding GUC controls SQL text after startup.
    const parts = [int32(196608)];
    for (const [key, value] of Object.entries({
      ...config,
      client_encoding: this.encoding.value,
    })) {
      if (key.includes('\0') || typeof value !== 'string' || value.includes('\0'))
        throw new Error('Invalid PostgreSQL startup parameter.');
      parts.push(Buffer.from(key + '\0' + value + '\0', 'utf8'));
    }
    parts.push(Buffer.from([0]));
    const body = Buffer.concat(parts);
    return Buffer.concat([int32(body.length + 4), body]);
  }
  outgoing(message: Buffer) {
    if (
      message.length < 5 ||
      message.readInt32BE(1) !== message.length - 1 ||
      message.length > MAX_FRAME
    )
      throw new Error('Invalid PostgreSQL outgoing frame.');
    const code = String.fromCharCode(message[0]);
    const f = new Fields(message.subarray(5), this.encode);
    switch (code) {
      case 'Q':
      case 'f':
        f.string();
        break;
      case 'P':
        f.string();
        f.string();
        f.copy(f.body.length - f.offset);
        break;
      case 'D':
      case 'C':
        f.copy(1);
        f.string();
        break;
      case 'E':
        f.string();
        f.copy(4);
        break;
      case 'B': {
        f.string();
        f.string();
        const count = f.short(),
          formats: number[] = [];
        for (let i = 0; i < count; i++) formats.push(f.short());
        const values = f.short();
        if (count !== 0 && count !== 1 && count !== values)
          throw new Error('Invalid PostgreSQL Bind format count.');
        for (let i = 0; i < values; i++) {
          const format = formats[count === 1 ? 0 : i] ?? 0;
          if (format !== 0 && format !== 1) throw new Error('Invalid PostgreSQL parameter format.');
          f.sized(format === 0);
        }
        const results = f.short();
        for (let i = 0; i < results; i++)
          if (f.short() !== 0)
            throw new Error('Binary PostgreSQL result format is not supported by the text driver.');
        break;
      }
      default:
        return message; // Authentication, binary COPY and control frames.
    }
    return frame(message[0], f.finish());
  }
  private incoming(message: Buffer) {
    const code = String.fromCharCode(message[0]);
    const f = new Fields(message.subarray(5), this.decode);
    switch (code) {
      case 'T': {
        const count = f.short();
        this.formats = [];
        for (let i = 0; i < count; i++) {
          f.string();
          f.copy(16);
          const format = f.short();
          if (format !== 0) throw new Error('Binary PostgreSQL results are unsupported.');
          this.formats.push(format);
        }
        break;
      }
      case 'D': {
        const count = f.short();
        if (count !== this.formats.length)
          throw new Error('PostgreSQL result field count changed.');
        for (let i = 0; i < count; i++) f.sized(true);
        break;
      }
      case 'S': {
        const key = f.string().toString('utf8'),
          value = f.string().toString('utf8');
        if (key === 'client_encoding' && value !== this.encoding.value)
          throw new Error(
            'Changing client_encoding inside SQL is not supported. Change the connection character set and reconnect.',
          );
        break;
      }
      case 'E':
      case 'N':
        while (f.copy(1)[0] !== 0) f.string();
        break;
      case 'A':
        f.copy(4);
        f.string();
        f.string();
        break;
      case 'C':
        f.string();
        break;
      default:
        return message;
    }
    return frame(message[0], f.finish());
  }
  receive(chunk: Buffer, deliver: (frame: Buffer) => void) {
    // Copy each byte once; repeated concat would become quadratic for a large
    // field fragmented across many TCP packets.
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.packet) {
        const count = Math.min(5 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        offset += count;
        this.headerBytes += count;
        if (this.headerBytes < 5) return;
        const size = this.header.readInt32BE(1) + 1;
        if (size < 5 || size > MAX_FRAME)
          throw new Error('PostgreSQL frame exceeds the 64 MiB limit or is invalid.');
        this.packet = Buffer.allocUnsafe(size);
        this.header.copy(this.packet);
        this.packetBytes = 5;
        this.headerBytes = 0;
      }
      const count = Math.min(this.packet.length - this.packetBytes, chunk.length - offset);
      chunk.copy(this.packet, this.packetBytes, offset, offset + count);
      offset += count;
      this.packetBytes += count;
      if (this.packetBytes === this.packet.length) {
        const message = this.packet;
        this.packet = undefined;
        this.packetBytes = 0;
        deliver(this.incoming(message));
      }
    }
  }
  clear() {
    this.packet = undefined;
    this.packetBytes = this.headerBytes = 0;
  }
}

// These Connection hooks are pg 8.x internals. Keep them localized and cover the
// actual installed driver, including TLS and prepared/binary parameters.
type ProtocolConnection = EventEmitter & {
  stream: Socket;
  _send(buffer: Buffer): boolean;
  attachListeners(stream: EventEmitter): void;
};
const BaseConnection = (pg as unknown as { Connection: new (config: object) => ProtocolConnection })
  .Connection;
export function postgresEncodingClient(charset: string) {
  class EncodedConnection extends BaseConnection {
    private codec = new PostgresTextProtocol(charset);
    startup(config: Record<string, string>) {
      try {
        this.stream.write(this.codec.startup(config));
      } catch (error) {
        this.stream.destroy(error as Error);
      }
    }
    override _send(buffer: Buffer) {
      if (!this.stream.writable) return false;
      try {
        return super._send(this.codec.outgoing(buffer));
      } catch (error) {
        this.stream.destroy(error as Error);
        return false;
      }
    }
    override attachListeners(stream: Socket) {
      const decoded = new EventEmitter();
      super.attachListeners(decoded);
      stream.on('data', (chunk: Buffer) => {
        try {
          this.codec.receive(chunk, (message) => decoded.emit('data', message));
        } catch (error) {
          stream.destroy(
            new Error(
              (error as Error).message +
                ' The statement may already have executed; do not retry writes blindly.',
            ),
          );
        }
      });
      stream.once('end', () => decoded.emit('end'));
      stream.once('close', () => this.codec.clear());
    }
  }
  return class EncodedClient extends pg.Client {
    constructor(config?: pg.ClientConfig) {
      // pg-pool deliberately makes password non-enumerable; spreading options
      // alone silently drops it, including async password providers.
      super({
        ...config,
        password: config?.password,
        connection: new EncodedConnection({ ssl: config?.ssl }),
      } as pg.ClientConfig);
    }
  };
}
