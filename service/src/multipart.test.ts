import { describe, expect, test } from 'bun:test';
import busboy from 'busboy';
import * as fs from 'fs';
import * as path from 'path';
import { createMultipartParser } from './multipart';

/**
 * The filename from the reported corruption. Its bytes are what matter:
 * `á` is `C3 A1` in UTF-8, and a Latin-1 read re-encodes it to `C3 83 C2 A1`
 * (`Ã¡`), which is the doubly-encoded name that reached object storage.
 */
const NON_ASCII_NAME = 'Báo_cáo_kết_quả.docx';
const BOUNDARY = 'codeapi-multipart-test-boundary';

interface ParsedPart {
  filename: string;
  body: string;
}

function multipartBody(filenames: string[]): Buffer {
  const parts = filenames.map((filename, i) => Buffer.from(
    `--${BOUNDARY}\r\n`
    + `Content-Disposition: form-data; name="file${i}"; filename="${filename}"\r\n`
    + 'Content-Type: application/octet-stream\r\n'
    + '\r\n'
    + `bytes-${i}\r\n`,
    'utf8',
  ));
  return Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8')]);
}

const MULTIPART_HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

function collect(parser: busboy.Busboy, body: Buffer): Promise<ParsedPart[]> {
  return new Promise((resolve, reject) => {
    const parsed: ParsedPart[] = [];
    parser.on('file', (_field, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        parsed.push({ filename: info.filename, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    parser.on('close', () => resolve(parsed));
    parser.on('error', reject);
    parser.end(body);
  });
}

function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

describe('createMultipartParser', () => {
  test('round-trips a UTF-8 non-ASCII filename byte-identically', async () => {
    const parsed = await collect(
      createMultipartParser(MULTIPART_HEADERS),
      multipartBody([NON_ASCII_NAME]),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0].filename).toBe(NON_ASCII_NAME);
    /* Byte-level assertion, not just string equality: the corruption is a
     * re-encoding, and a display-only comparison is exactly what let it hide. */
    expect(hex(parsed[0].filename)).toBe(hex(NON_ASCII_NAME));
    expect(hex(parsed[0].filename)).not.toContain('c383c2a1');
  });

  test('round-trips every filename in a batch body', async () => {
    const names = [NON_ASCII_NAME, 'Kết_luận.pdf', 'ascii.txt', '日本語.csv'];
    const parsed = await collect(
      createMultipartParser(MULTIPART_HEADERS, { fileSize: 1_000_000, files: 200 }),
      multipartBody(names),
    );

    expect(parsed.map(p => p.filename)).toEqual(names);
    expect(parsed.map(p => hex(p.filename))).toEqual(names.map(hex));
    expect(parsed.map(p => p.body)).toEqual(names.map((_, i) => `bytes-${i}`));
  });

  test('preserves subdirectory components in the filename', async () => {
    const parsed = await collect(
      createMultipartParser(MULTIPART_HEADERS),
      multipartBody(['pptx/tài_liệu/editing.md']),
    );

    expect(parsed[0].filename).toBe('pptx/tài_liệu/editing.md');
  });

  test('honours the caller-supplied limits', async () => {
    const parser = createMultipartParser(MULTIPART_HEADERS, { files: 1 });
    const limitReached = new Promise<boolean>(resolve => {
      parser.on('filesLimit', () => resolve(true));
    });
    const parsed = await collect(parser, multipartBody(['a.txt', 'b.txt']));

    expect(await limitReached).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  /**
   * Differential guard. Without this case the round-trip assertions above
   * would still pass against a parser that never had the bug, so this pins
   * down that the option set — not the test body — is what fixes it.
   */
  test('reproduces the corruption when defParamCharset is omitted', async () => {
    const parsed = await collect(
      busboy({ headers: MULTIPART_HEADERS, preservePath: true }),
      multipartBody([NON_ASCII_NAME]),
    );

    expect(parsed[0].filename).not.toBe(NON_ASCII_NAME);
    expect(parsed[0].filename).toBe('BÃ¡o_cÃ¡o_káº¿t_quáº£.docx');
    expect(hex(parsed[0].filename)).toContain('c383c2a1');
    /* The mojibake is recoverable, which is what proves it is a Latin-1
     * read of the original UTF-8 bytes rather than lost information. */
    expect(Buffer.from(parsed[0].filename, 'latin1').toString('utf8')).toBe(NON_ASCII_NAME);
  });

  /**
   * The bug was drift, not a missing option in one place: `/upload` and
   * `/upload/batch` built their own parsers while the file server set the
   * charset options, and nothing held the two in step. A multipart entry
   * point that cannot import busboy as a value cannot construct its own
   * parser, so this is the invariant that keeps them from drifting again.
   */
  test('no multipart entry point constructs busboy outside this factory', () => {
    const entryPoints = ['service/router.ts', 'file-server.ts'];
    for (const entryPoint of entryPoints) {
      const source = fs.readFileSync(path.join(__dirname, entryPoint), 'utf8');
      expect(source).toContain('createMultipartParser');
      /* A type-only import is fine (both need `FileInfo`); a value import
       * is not. */
      expect(source).not.toMatch(/^import (?!type )[\w*{][^\n]*from 'busboy'/m);
    }
  });
});
