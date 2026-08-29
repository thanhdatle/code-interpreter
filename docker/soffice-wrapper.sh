#!/bin/sh
# Seed LibreOffice's user profile from the image-baked copy on first use.
#
# The guest root is read-only and HOME (/mnt/data) is a fresh per-session bind,
# so LibreOffice would otherwise rebuild its profile from scratch on the first
# render of every session. Measured cost of that cold start is ~7.5s versus
# ~3.6s warm, against a hard 30s SANDBOX_RUN_TIMEOUT that must also cover the
# document build, the rasterise and the text extraction in the same execution.
# Copying ~0.5 MB is noise by comparison.
#
# Seeding must never break a render that would otherwise work: a cold profile is
# slower, not broken, so every step here degrades to plain soffice on failure.
set -u

home=${HOME:-/tmp}
baked=/opt/lo-home/.config/libreoffice

if [ ! -d "$home/.config/libreoffice" ] && [ -d "$baked" ]; then
    mkdir -p "$home/.config" 2>/dev/null \
        && cp -a "$baked" "$home/.config/" 2>/dev/null \
        || true
fi

exec /usr/bin/soffice "$@"
