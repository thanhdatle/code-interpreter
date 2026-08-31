/**
 * Parser options every multipart route must share.
 *
 * `defParamCharset` is the load-bearing one. Busboy 1.x defaults it to
 * `latin1`, so a UTF-8 `Content-Disposition` filename is decoded byte-per-code
 * point: `Báo` arrives as `BÃ¡o`, one mojibake generation per pass. The mangled
 * string is what gets stored, so it comes back as the download's
 * `Content-Disposition`, becomes the sandbox destination, and two refs for one
 * file then collide in `reserveInputDestination` — rejecting the whole exec.
 *
 * `preservePath` keeps subdirectory components in the filename (e.g.
 * `pptx/editing.md`); the busboy default strips to basename, which collapses
 * skill-file paths and breaks the caller's filename lookups.
 */
export const MULTIPART_PARSE_OPTIONS = {
  defCharset: 'utf8',
  defParamCharset: 'utf8',
  preservePath: true,
} as const;
