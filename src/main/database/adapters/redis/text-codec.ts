import iconv from 'iconv-lite';
import { REDIS_ENCODINGS } from '../../../../shared/client-encodings';

export class RedisTextCodec {
  readonly charset: string;
  constructor(charset = 'utf8') {
    if (!REDIS_ENCODINGS.some((encoding) => encoding.value === charset))
      throw new Error('Unsupported Redis client character set.');
    this.charset = charset;
  }
  private encode(text: string, charset = this.charset) {
    const bytes = iconv.encode(text, charset);
    if (iconv.decode(bytes, charset, { stripBOM: false }) !== text)
      throw new Error(
        `Text cannot be represented losslessly in ${charset}. Choose another client character set.`,
      );
    return bytes;
  }
  private pattern(text: string) {
    return Buffer.concat(
      [...text].map((character) => {
        const bytes = this.encode(character);
        if (character.codePointAt(0)! < 128) return bytes;
        // A Big5/Shift JIS trailing byte can be a Redis glob metacharacter.
        // Escape bytes belonging to literal non-ASCII characters while keeping
        // the user's ASCII glob operators intact (Redis glob is byte-oriented).
        const escaped: number[] = [];
        for (const byte of bytes) {
          if ([42, 63, 91, 93, 92, 94, 45].includes(byte)) escaped.push(92);
          escaped.push(byte);
        }
        return Buffer.from(escaped);
      }),
    );
  }
  arguments(command: string, args: string[]) {
    return [
      command,
      ...args.map((value, index) => {
        // JSON syntax, paths and serialized documents are always UTF-8. Its key
        // remains an ordinary Redis byte key in the selected client encoding.
        if (command.startsWith('JSON.') && index > 0) return this.encode(value, 'utf8');
        if (command === 'SCAN' && args[index - 1]?.toUpperCase() === 'MATCH')
          return this.pattern(value);
        return this.encode(value);
      }),
    ];
  }
  reply(command: string, value: unknown): any {
    if (Buffer.isBuffer(value)) {
      const charset =
        command.startsWith('JSON.') || command === 'INFO' || command === 'CONFIG'
          ? 'utf8'
          : this.charset;
      const text = iconv.decode(value, charset, { stripBOM: false });
      if (!iconv.encode(text, charset).equals(value))
        throw new Error(
          `Redis bytes cannot be decoded losslessly as ${charset}. Choose the matching client character set.`,
        );
      return text;
    }
    if (Array.isArray(value)) return value.map((item) => this.reply(command, item));
    return value;
  }
}
