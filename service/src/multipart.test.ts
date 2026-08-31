import busboy from 'busboy';
import { describe, expect, test } from 'bun:test';
import { MULTIPART_PARSE_OPTIONS } from './multipart';

const BOUNDARY = 'x-boundary';

/** Builds the exact bytes a client sends for one UTF-8-named file part. */
function multipartBody(filename: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n' +
      'payload\r\n' +
      `--${BOUNDARY}--\r\n`,
    'utf8',
  );
}

type ParseOptions = Readonly<Omit<busboy.BusboyConfig, 'headers'>>;

function parseFilename(body: Buffer, options: ParseOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      ...options,
    });
    bb.on('file', (_field, stream, info) => {
      stream.resume();
      resolve(info.filename);
    });
    bb.on('error', reject);
    bb.on('close', () => reject(new Error('no file part parsed')));
    bb.end(body);
  });
}

describe('MULTIPART_PARSE_OPTIONS', () => {
  const name = 'Báo cáo kết quả - Chợ số.docx';

  test('round-trips a UTF-8 filename unchanged', async () => {
    expect(await parseFilename(multipartBody(name), MULTIPART_PARSE_OPTIONS)).toBe(name);
  });

  test("busboy's own default mangles it, so the option is doing the work", async () => {
    const mangled = await parseFilename(multipartBody(name), { preservePath: true });
    expect(mangled).not.toBe(name);
    expect(mangled).toBe(Buffer.from(name, 'utf8').toString('latin1'));
  });

  test('keeps subdirectory components', async () => {
    expect(await parseFilename(multipartBody('pptx/editing.md'), MULTIPART_PARSE_OPTIONS)).toBe(
      'pptx/editing.md',
    );
  });
});
