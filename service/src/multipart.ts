import busboy from 'busboy';
import type { IncomingHttpHeaders } from 'http';

/**
 * Single source of truth for how every multipart entry point parses an
 * upload. The option set is deliberately not repeated at the call sites:
 * `/upload` and `/upload/batch` had drifted from the file server and omitted
 * the charset options, which is what corrupted non-ASCII filenames.
 *
 * `defParamCharset` is the load-bearing one. Busboy 1.x falls back to a null
 * decoder when it is unset, so a UTF-8 `filename=` parameter is read as
 * Latin-1 and re-encoded on the way out — `Báo_cáo.docx` (`C3 A1`) is stored
 * as `BÃ¡o_cÃ¡o.docx` (`C3 83 C2 A1`). The doubly-encoded name then travels to
 * the sandbox, where it no longer matches the name the caller asked for.
 *
 * `preservePath` keeps subdirectory components in the multipart filename
 * (e.g. `pptx/editing.md`). The busboy 1.x default strips to basename, which
 * collapses skill-file paths and breaks the caller's filename lookups (skill
 * files look "missing" even when uploaded).
 */
export function createMultipartParser(
  headers: IncomingHttpHeaders,
  limits?: busboy.Limits,
): busboy.Busboy {
  return busboy({
    headers,
    defCharset: 'utf8',
    defParamCharset: 'utf8',
    preservePath: true,
    ...(limits === undefined ? {} : { limits }),
  });
}
