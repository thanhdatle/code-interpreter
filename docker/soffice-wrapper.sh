#!/bin/sh
# Prepare LibreOffice's environment before handing off to the real binary.
#
# Two problems, both specific to running LibreOffice inside this sandbox, and
# both fixed here rather than by loosening a global limit for every job.
#
# 1. Profile. The guest root is read-only and HOME (/mnt/data) is a fresh
#    per-session bind, so LibreOffice would rebuild its user profile from
#    scratch on the first render of every session. Measured cost of that cold
#    start is ~7.5s versus ~3.6s warm, against a run timeout that must also
#    cover the document build, the rasterise and the text extraction. The
#    profile is baked into the image at /opt/lo-home and copied in (~0.5 MB).
#
# 2. Temporary files. LibreOffice's conversion temporaries default to /tmp,
#    which is a 20 MB tmpfs (api/config/sandbox.cfg). A document carrying images
#    can exhaust that and fail --convert-to outright. Point TMPDIR at the
#    disk-backed writable bind instead. The dot prefix matters: the output
#    walker skips hidden directories, so this never surfaces as a generated
#    file.
#
# Neither step may break a render that would otherwise work: a cold profile is
# slower, not broken, and a missing TMPDIR just falls back to /tmp. Every step
# degrades to plain soffice on failure.
set -u

home=${HOME:-/tmp}
baked=/opt/lo-home/.config/libreoffice

if [ ! -d "$home/.config/libreoffice" ] && [ -d "$baked" ]; then
    mkdir -p "$home/.config" 2>/dev/null \
        && cp -a "$baked" "$home/.config/" 2>/dev/null \
        || true
fi

if mkdir -p "$home/.lo-tmp" 2>/dev/null; then
    TMPDIR="$home/.lo-tmp"
    export TMPDIR
fi

exec /usr/bin/soffice "$@"
