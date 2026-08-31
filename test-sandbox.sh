#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

SANDBOX_URL="${SANDBOX_URL:-http://localhost:2000}"
CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY="${CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY:-MC4CAQAwBQYDK2VwBCIEIBoxzSJjQ5jTVyuohHtlD+uDGqv/tZ6hQS2CmxuOg2Wn}"
EXECUTION_MANIFEST_TTL_SECONDS="${EXECUTION_MANIFEST_TTL_SECONDS:-300}"
EXECUTION_MANIFEST_MAX_UPLOAD_BYTES="${EXECUTION_MANIFEST_MAX_UPLOAD_BYTES:-52428800}"
EXECUTION_MANIFEST_MAX_OUTPUT_FILES="${EXECUTION_MANIFEST_MAX_OUTPUT_FILES:-50}"
EXECUTION_MANIFEST_MAX_REQUESTS="${EXECUTION_MANIFEST_MAX_REQUESTS:-1000}"
EXEC_COUNTER=0

command -v jq >/dev/null || { log_error "jq is required"; exit 1; }
command -v node >/dev/null || { log_error "node is required to sign local execution manifests"; exit 1; }

prepare_execute_body() {
    local payload="$1"
    EXEC_COUNTER=$((EXEC_COUNTER + 1))
    PAYLOAD_JSON="$payload" \
    SESSION_ID="local-smoke-session-$(date +%s)-$EXEC_COUNTER" \
    EXECUTION_ID="local-smoke-exec-$(date +%s)-$EXEC_COUNTER" \
    NOW_SECONDS="$(date +%s)" \
    CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY="$CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY" \
    EXECUTION_MANIFEST_TTL_SECONDS="$EXECUTION_MANIFEST_TTL_SECONDS" \
    EXECUTION_MANIFEST_MAX_UPLOAD_BYTES="$EXECUTION_MANIFEST_MAX_UPLOAD_BYTES" \
    EXECUTION_MANIFEST_MAX_OUTPUT_FILES="$EXECUTION_MANIFEST_MAX_OUTPUT_FILES" \
    EXECUTION_MANIFEST_MAX_REQUESTS="$EXECUTION_MANIFEST_MAX_REQUESTS" \
    node <<'NODE'
const crypto = require('crypto');

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== undefined) {
    return `{${Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('unsupported manifest value');
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : fallback;
}

const payload = JSON.parse(process.env.PAYLOAD_JSON);
payload.session_id ||= process.env.SESSION_ID;

const inputFiles = (Array.isArray(payload.files) ? payload.files : [])
  .map((file, index) => {
    if (file == null || typeof file !== 'object' || typeof file.id !== 'string' || file.id === '') {
      return null;
    }
    const sessionId = typeof file.storage_session_id === 'string' && file.storage_session_id !== ''
      ? file.storage_session_id
      : payload.session_id;
    return {
      id: file.id,
      session_id: sessionId,
      name: typeof file.name === 'string' && file.name !== '' ? file.name : `file${index}.code`,
    };
  })
  .filter(Boolean)
  .sort((a, b) => (
    a.session_id.localeCompare(b.session_id) ||
    a.id.localeCompare(b.id) ||
    a.name.localeCompare(b.name)
  ));

const now = numberEnv('NOW_SECONDS', Math.floor(Date.now() / 1000));
const claims = {
  v: 1,
  exec_id: process.env.EXECUTION_ID,
  tenant_id: 'local-smoke-tenant',
  user_id: 'local-smoke-user',
  session_key: 'local-smoke-tenant:user:local-smoke-user',
  input_files: inputFiles,
  read_sessions: Array.from(new Set(inputFiles.map(file => file.session_id))).sort(),
  output_session_id: payload.session_id,
  max_upload_bytes: numberEnv('EXECUTION_MANIFEST_MAX_UPLOAD_BYTES', 52428800),
  max_output_files: numberEnv('EXECUTION_MANIFEST_MAX_OUTPUT_FILES', 50),
  max_requests: numberEnv('EXECUTION_MANIFEST_MAX_REQUESTS', 1000),
  iat: now,
  exp: now + numberEnv('EXECUTION_MANIFEST_TTL_SECONDS', 300),
  principal_source: 'local_sandbox_smoke',
};
const manifestPayload = canonicalJson(claims);
const rawPrivateKey = process.env.CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY.trim().replace(/\\n/g, '\n');
const key = rawPrivateKey.includes('BEGIN ')
  ? rawPrivateKey
  : crypto.createPrivateKey({
      key: Buffer.from(rawPrivateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
const signature = crypto.sign(null, Buffer.from(manifestPayload, 'utf8'), key);
payload.execution_manifest = `${Buffer.from(manifestPayload).toString('base64url')}.${signature.toString('base64url')}`;
process.stdout.write(JSON.stringify(payload));
NODE
}

execute_sandbox() {
    local payload="$1"
    local body
    body="$(prepare_execute_body "$payload")"
    curl -s "$SANDBOX_URL/api/v2/execute" \
        -H 'Content-Type: application/json' \
        -d "$body"
}

test_basic_python() {
    log_info "Testing basic Python execution..."
    result=$(execute_sandbox '{"language":"python","version":"3.14.4","files":[{"content":"print(42)"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "42"* ]]; then
        log_success "Basic Python: got '$stdout'"
        return 0
    else
        log_error "Basic Python: expected '42', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_numpy() {
    log_info "Testing numpy import..."
    result=$(execute_sandbox '{"language":"python","version":"3.14.4","files":[{"content":"import numpy as np\nprint(np.array([1,2,3]).sum())"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "6"* ]]; then
        log_success "Numpy: got '$stdout'"
        return 0
    else
        log_error "Numpy: expected '6', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_statsmodels() {
    log_info "Testing statsmodels import and STL decomposition..."
    result=$(execute_sandbox '{"language":"python","version":"3.14.4","files":[{"content":"import numpy as np\nfrom statsmodels.tsa.seasonal import STL\nseries = np.arange(24, dtype=float) + np.tile([0.0, 1.0, 0.0, -1.0], 6)\nfit = STL(series, period=4).fit()\nprint(round(float(fit.trend[-1]), 2))"}]}')

    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" =~ ^[0-9.-]+ ]]; then
        log_success "statsmodels: got '$stdout'"
        return 0
    else
        log_error "statsmodels: expected numeric STL trend output, got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_geospatial() {
    log_info "Testing geospatial stack import and reprojection..."
    result=$(execute_sandbox '{"language":"python","version":"3.14.4","files":[{"content":"import geopandas as gpd\nimport rasterio\nfrom shapely.geometry import Point\ngdf = gpd.GeoDataFrame(geometry=[Point(-74.006, 40.7128)], crs=\"EPSG:4326\").to_crs(\"EPSG:26918\")\nprint(round(float(gdf.geometry.iloc[0].x), 2))"}]}')

    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    code=$(echo "$result" | jq -r '.run.code // empty')
    easting=$(echo "$stdout" | head -1 | tr -d '\r')
    if [[ "$code" == "0" ]] && [[ "$easting" =~ ^[0-9]+(\.[0-9]+)?$ ]] &&
        awk -v e="$easting" 'BEGIN { exit !(e > 100000 && e < 900000) }'; then
        log_success "geospatial: UTM 18N easting '$easting'"
        return 0
    else
        log_error "geospatial: expected UTM 18N easting in 100000..900000 with exit 0, got code='$code' stdout='$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_chdb() {
    log_info "Testing chDB import and query..."
    result=$(execute_sandbox '{"language":"python","version":"3.14.4","files":[{"content":"import chdb\nprint(chdb.query(\"SELECT sum(number) FROM numbers(5)\", \"CSV\"))"}]}')

    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "10"* ]]; then
        log_success "chDB: got '$stdout'"
        return 0
    else
        log_error "chDB: expected '10', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_documents() {
    log_info "Testing document toolchain (LibreOffice, pandoc, poppler, fonts)..."
    # jq -n --arg does the JSON escaping; hand-escaping a program this size into
    # a JSON string is where this test would silently break.
    doc_code=$(cat <<'DOCPY'
import os, shutil, subprocess, sys

def fail(msg):
    print("DOCUMENTS_FAIL: " + msg)
    sys.exit(1)

for tool in ("soffice", "pandoc", "pdftoppm", "pdftotext", "pdffonts", "fc-match"):
    if not shutil.which(tool):
        fail("missing binary: " + tool)

try:
    import docx, openpyxl, pypdf
except ImportError as exc:
    fail("missing python package: %s" % exc)

# Having a font installed is not the same as fontconfig choosing it.
# 30-metric-aliases.conf is what maps Times New Roman onto Liberation Serif;
# without it the request falls through to DejaVu, which is installed alongside
# and is NOT metric-compatible.
matched = subprocess.run(["fc-match", "Times New Roman"],
                         capture_output=True, text=True).stdout.strip()
if "Liberation" not in matched and "Times" not in matched:
    fail("fontconfig resolves Times New Roman -> %s (need fontconfig-config)" % matched)

work = "/mnt/data"
src = os.path.join(work, "doctest.docx")
doc = docx.Document()
normal = doc.styles["Normal"]
normal.font.name = "Times New Roman"
normal.font.size = docx.shared.Pt(13)
for line in ("CONG HOA XA HOI CHU NGHIA VIET NAM",
             "Doc lap - Tu do - Hanh phuc",
             "KE HOACH",
             "Uy ban nhan dan",
             "Luu: VT."):
    doc.add_paragraph(line)
# Diacritics are the point of the round trip, so assert on a real one.
doc.add_paragraph("Ủy ban nhân dân — KẾ HOẠCH — Độc lập")
doc.save(src)

conv = subprocess.run(["soffice", "--headless", "--convert-to", "pdf",
                       "--outdir", work, src], capture_output=True, text=True)
pdf = os.path.join(work, "doctest.pdf")
if not os.path.exists(pdf):
    fail("soffice produced no PDF (rc=%s) %s" % (conv.returncode, conv.stderr[:200]))

fonts = subprocess.run(["pdffonts", pdf], capture_output=True, text=True).stdout
if "TimesNewRoman" not in fonts and "LiberationSerif" not in fonts:
    fail("no metric-compatible serif in the render:\n" + fonts)
for bad in ("DejaVu", "FreeSerif", "NotoSerif"):
    if bad in fonts:
        fail("non-metric-compatible substitution (%s); layout differs from Word" % bad)

subprocess.run(["pdftoppm", "-jpeg", "-r", "100", pdf, os.path.join(work, "page")],
               check=True, capture_output=True)
pages = [f for f in os.listdir(work) if f.startswith("page") and f.endswith(".jpg")]
if not pages:
    fail("pdftoppm produced no page images")
# The agent reads these back with read_file, which refuses anything over 1 MB.
for page in pages:
    size = os.path.getsize(os.path.join(work, page))
    if size > 1048576:
        fail("%s is %d bytes (>1MB): re-render at 72 dpi" % (page, size))

text = subprocess.run(["pdftotext", pdf, "-"], capture_output=True, text=True).stdout
for phrase in ("Ủy ban nhân dân", "KẾ HOẠCH", "Độc lập"):
    if phrase not in text:
        fail("lost text or diacritics: %r missing from the PDF" % phrase)

if subprocess.run(["pandoc", "-t", "markdown", src],
                  capture_output=True).returncode != 0:
    fail("pandoc could not read the generated docx")

# The case docDefaults does NOT cover. LibreOffice ignores a .docx's
# w:docDefaults inside a table cell, so a cell run that names no font falls
# through to the generic `serif` family. Without 58-generic-liberation.conf
# that resolves to DejaVu Serif -- metric-incompatible with Times New Roman,
# so line breaks and page count drift from Word, and nothing says so except
# pdffonts. Measured: this exact document rendered DejaVuSerif before the conf
# was added and LiberationSerif after. Built as raw XML because python-docx
# always writes an explicit w:rFonts and so cannot reproduce it.
import zipfile

NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
CELL = ('<w:tc><w:tcPr><w:tcW w:w="4590" w:type="dxa"/></w:tcPr>'
        '<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p></w:tc>')

fontless = os.path.join(work, "fontless.docx")
with zipfile.ZipFile(fontless, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
               '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
               '<Default Extension="xml" ContentType="application/xml"/>'
               '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
               '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
               '</Types>')
    z.writestr("_rels/.rels",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
               '</Relationships>')
    z.writestr("word/_rels/document.xml.rels",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
               '</Relationships>')
    # The font is declared ONLY here, never on a run. That is the whole point.
    z.writestr("word/styles.xml",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<w:styles %s><w:docDefaults><w:rPrDefault><w:rPr>'
               '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>'
               '<w:sz w:val="26"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>' % NS)
    z.writestr("word/document.xml",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<w:document %s><w:body>'
               '<w:tbl><w:tblPr><w:tblW w:w="9180" w:type="dxa"/></w:tblPr>'
               '<w:tblGrid><w:gridCol w:w="4590"/><w:gridCol w:w="4590"/></w:tblGrid>'
               '<w:tr>%s%s</w:tr></w:tbl>'
               '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
               '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1701" '
               'w:header="706" w:footer="706" w:gutter="0"/></w:sectPr>'
               '</w:body></w:document>'
               % (NS, CELL % "Noi nhan", CELL % "Ky ten"))

conv = subprocess.run(["soffice", "--headless", "--convert-to", "pdf",
                       "--outdir", work, fontless], capture_output=True, text=True)
fontless_pdf = os.path.join(work, "fontless.pdf")
if not os.path.exists(fontless_pdf):
    fail("fontless-run document would not convert (rc=%s) %s"
         % (conv.returncode, conv.stderr[:200]))
fl_fonts = subprocess.run(["pdffonts", fontless_pdf],
                          capture_output=True, text=True).stdout
for bad in ("DejaVu", "FreeSerif", "NotoSerif"):
    if bad in fl_fonts:
        fail("a run with no w:rFonts rendered in %s; generic serif is not "
             "metric-compatible (is 58-generic-liberation.conf installed?)\n%s"
             % (bad, fl_fonts))
if "LiberationSerif" not in fl_fonts and "TimesNewRoman" not in fl_fonts:
    fail("fontless run rendered in an unexpected face:\n" + fl_fonts)

print("DOCUMENTS_OK pages=%d fonts_ok=1 fontless_ok=1" % len(pages))
DOCPY
)
    payload=$(jq -n --arg code "$doc_code" \
        '{language:"python",version:"3.14.4",files:[{content:$code}]}')
    result=$(execute_sandbox "$payload")

    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == *"DOCUMENTS_OK"* ]]; then
        log_success "documents: $(echo "$stdout" | tr -d '\n')"
        return 0
    else
        log_error "documents: $stdout"
        echo "$result" | jq .
        return 1
    fi
}

test_file_write() {
    log_info "Testing file write in sandbox..."
    result=$(execute_sandbox '{"language":"python","version":"3.14.4","files":[{"content":"with open(\"/mnt/data/test.txt\", \"w\") as f:\n    f.write(\"hello\")\nwith open(\"/mnt/data/test.txt\") as f:\n    print(f.read())"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "hello"* ]]; then
        log_success "File write: got '$stdout'"
        return 0
    else
        log_error "File write: expected 'hello', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_network_blocked() {
    log_info "Testing network is blocked..."
    result=$(execute_sandbox '{"language":"python","version":"3.14.4","files":[{"content":"import socket\ntry:\n    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n    s.settimeout(2)\n    s.connect((\"8.8.8.8\", 53))\n    print(\"NETWORK_ALLOWED\")\nexcept Exception as e:\n    print(\"NETWORK_BLOCKED\")"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "NETWORK_BLOCKED"* ]]; then
        log_success "Network blocked: sandbox correctly isolated"
        return 0
    else
        log_error "Network NOT blocked: sandbox may be misconfigured"
        echo "$result" | jq .
        return 1
    fi
}

test_sched_setaffinity_blocked() {
    log_info "Testing sched_setaffinity is blocked with EPERM..."
    result=$(execute_sandbox '{"language":"python","version":"3.14.4","files":[{"content":"import ctypes, errno\nlibc = ctypes.CDLL(None, use_errno=True)\nmask = (ctypes.c_ulong * 16)()\nmask[0] = 1\nrc = libc.sched_setaffinity(0, ctypes.sizeof(mask), ctypes.byref(mask))\nerr = ctypes.get_errno()\nprint(f\"rc={rc} errno={err}\")\nif rc != -1 or err != errno.EPERM:\n    raise SystemExit(1)"}]}')

    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    code=$(echo "$result" | jq -r '.run.code // empty')
    if [[ "$stdout" == *"rc=-1 errno=1"* ]] && [[ "$code" == "0" ]]; then
        log_success "sched_setaffinity blocked with EPERM"
        return 0
    else
        log_error "sched_setaffinity was not blocked with EPERM"
        echo "$result" | jq .
        return 1
    fi
}

test_kernel_attack_surface_blocked() {
    log_info "Testing kernel attack-surface syscalls are blocked..."
    local probe_code payload
    probe_code=$(cat <<'PY'
import ctypes
import errno
import os
import platform
import signal
import socket
import subprocess

libc = ctypes.CDLL(None, use_errno=True)

subprocess.run(["/bin/sh", "-c", "echo subprocess_ok"], check=True)

def expect_socket_blocked(name, family, sock_type, proto=0):
    try:
        sock = socket.socket(family, sock_type, proto)
        sock.close()
        print(f"{name}=OK")
        raise SystemExit(1)
    except OSError as exc:
        print(f"{name}=errno:{exc.errno}")
        if exc.errno != errno.EPERM:
            raise SystemExit(1)

expect_socket_blocked("AF_KEY", getattr(socket, "AF_KEY", 15), socket.SOCK_RAW, 2)
expect_socket_blocked("AF_NETLINK", socket.AF_NETLINK, socket.SOCK_RAW, 0)
expect_socket_blocked("AF_RXRPC", getattr(socket, "AF_RXRPC", 33), socket.SOCK_DGRAM, 0)
expect_socket_blocked("AF_ALG", getattr(socket, "AF_ALG", 38), socket.SOCK_SEQPACKET, 0)

syscalls = {
    "x86_64": {"clone": 56, "clone3": 435, "vmsplice": 278},
    "amd64": {"clone": 56, "clone3": 435, "vmsplice": 278},
    "aarch64": {"clone": 220, "clone3": 435, "vmsplice": 75},
    "arm64": {"clone": 220, "clone3": 435, "vmsplice": 75},
}
arch = platform.machine().lower()
if arch not in syscalls:
    raise SystemExit(f"unsupported arch for syscall smoke test: {arch}")

CLONE_NEWUSER = 0x10000000
CLONE_NEWNET = 0x40000000

ctypes.set_errno(0)
rc = libc.syscall(syscalls[arch]["clone"], CLONE_NEWUSER | CLONE_NEWNET | signal.SIGCHLD, 0, 0, 0, 0)
err = ctypes.get_errno()
print(f"clone_namespace=rc:{rc}:errno:{err}")
if rc == 0:
    os._exit(1)
if rc > 0:
    os.waitpid(rc, 0)
    raise SystemExit(1)
if err != errno.EPERM:
    raise SystemExit(1)

class CloneArgs(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_ulonglong),
        ("pidfd", ctypes.c_ulonglong),
        ("child_tid", ctypes.c_ulonglong),
        ("parent_tid", ctypes.c_ulonglong),
        ("exit_signal", ctypes.c_ulonglong),
        ("stack", ctypes.c_ulonglong),
        ("stack_size", ctypes.c_ulonglong),
        ("tls", ctypes.c_ulonglong),
        ("set_tid", ctypes.c_ulonglong),
        ("set_tid_size", ctypes.c_ulonglong),
        ("cgroup", ctypes.c_ulonglong),
    ]

args = CloneArgs(flags=CLONE_NEWUSER | CLONE_NEWNET, exit_signal=signal.SIGCHLD)
ctypes.set_errno(0)
rc = libc.syscall(syscalls[arch]["clone3"], ctypes.byref(args), ctypes.sizeof(args))
err = ctypes.get_errno()
print(f"clone3=rc:{rc}:errno:{err}")
if rc == 0:
    os._exit(1)
if rc > 0:
    os.waitpid(rc, 0)
    raise SystemExit(1)
if err != errno.ENOSYS:
    raise SystemExit(1)

ctypes.set_errno(0)
rc = libc.syscall(syscalls[arch]["vmsplice"], -1, 0, 0, 0)
err = ctypes.get_errno()
print(f"vmsplice=rc:{rc}:errno:{err}")
if rc != -1 or err != errno.EPERM:
    raise SystemExit(1)
PY
)
    payload=$(jq -n --arg code "$probe_code" '{"language":"python","version":"3.14.4","files":[{"content":$code}]}')
    result=$(execute_sandbox "$payload")

    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    code=$(echo "$result" | jq -r '.run.code // empty')
    if [[ "$code" == "0" ]] \
        && [[ "$stdout" == *"subprocess_ok"* ]] \
        && [[ "$stdout" == *"AF_KEY=errno:1"* ]] \
        && [[ "$stdout" == *"AF_NETLINK=errno:1"* ]] \
        && [[ "$stdout" == *"AF_RXRPC=errno:1"* ]] \
        && [[ "$stdout" == *"AF_ALG=errno:1"* ]] \
        && [[ "$stdout" == *"clone_namespace=rc:-1:errno:1"* ]] \
        && [[ "$stdout" == *"clone3=rc:-1:errno:38"* ]] \
        && [[ "$stdout" == *"vmsplice=rc:-1:errno:1"* ]]; then
        log_success "Kernel attack-surface syscalls blocked"
        return 0
    else
        log_error "Kernel attack-surface syscall hardening failed"
        echo "$result" | jq .
        return 1
    fi
}

test_bun() {
    log_info "Testing Bun/JavaScript execution..."
    # Get available bun version dynamically
    bun_version=$(curl -s "$SANDBOX_URL/api/v2/runtimes" | jq -r '.[] | select(.runtime == "bun" and .language == "javascript") | .version' | head -1)
    if [ -z "$bun_version" ]; then
        log_warn "Bun runtime not available, skipping"
        return 0
    fi
    result=$(execute_sandbox "{\"language\":\"javascript\",\"version\":\"$bun_version\",\"runtime\":\"bun\",\"files\":[{\"content\":\"console.log(1 + 2)\"}]}")
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "3"* ]]; then
        log_success "Bun JS: got '$stdout'"
        return 0
    else
        log_error "Bun JS: expected '3', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_escape_attempt() {
    log_info "Testing escape attempt (should fail)..."
    result=$(execute_sandbox '{"language":"python","version":"3.14.4","files":[{"content":"import os\ntry:\n    os.system(\"cat /etc/shadow\")\n    print(\"ESCAPE_POSSIBLE\")\nexcept:\n    print(\"ESCAPE_BLOCKED\")"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    stderr=$(echo "$result" | jq -r '.run.stderr // empty')
    
    if [[ "$stdout" != *"root:"* ]] && [[ "$stderr" != *"root:"* ]]; then
        log_success "Escape blocked: /etc/shadow not readable"
        return 0
    else
        log_error "SECURITY ISSUE: /etc/shadow was readable!"
        echo "$result" | jq .
        return 1
    fi
}

echo "=============================================="
echo "  Sandbox Security Test Suite"
echo "=============================================="
echo "Target: $SANDBOX_URL"
echo ""

FAILED=0

test_basic_python || FAILED=$((FAILED + 1))
test_numpy || FAILED=$((FAILED + 1))
test_statsmodels || FAILED=$((FAILED + 1))
test_geospatial || FAILED=$((FAILED + 1))
test_chdb || FAILED=$((FAILED + 1))
test_documents || FAILED=$((FAILED + 1))
test_file_write || FAILED=$((FAILED + 1))
test_network_blocked || FAILED=$((FAILED + 1))
test_sched_setaffinity_blocked || FAILED=$((FAILED + 1))
test_kernel_attack_surface_blocked || FAILED=$((FAILED + 1))
test_bun || FAILED=$((FAILED + 1))
test_escape_attempt || FAILED=$((FAILED + 1))

echo ""
echo "=============================================="
if [[ $FAILED -eq 0 ]]; then
    log_success "All tests passed!"
    exit 0
else
    log_error "$FAILED test(s) failed"
    exit 1
fi
