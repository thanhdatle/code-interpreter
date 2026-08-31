#!/bin/sh
# Keep LibreOffice's conversion temporaries off the sandbox's small /tmp.
#
# /tmp is a 20 MB tmpfs (api/config/sandbox.cfg). When it is close to full,
# LibreOffice does not fail -- it exits 0 and silently drops content. Measured
# in this image against a 40-page document carrying 8.7 MB of JPEG, with /tmp
# holding 280 KB free:
#
#     TMPDIR=/tmp          rc=0   25 KB PDF   40 pages    0 images
#     TMPDIR=$HOME/.lo-tmp rc=0  762 KB PDF   40 pages   40 images
#
# A render that quietly loses its images is precisely the output this project
# exists to prevent, and no exit status reports it. LibreOffice's own peak
# demand is small -- 952 KB for that document -- so the redirect costs nothing;
# it is the other occupants of the 20 MB tmpfs that make the hazard real.
#
# The dot prefix matters: the generated-output walker skips hidden directories,
# so this never surfaces as a file the agent produced. Every step degrades to
# plain soffice: a missing or unwritable HOME just leaves TMPDIR alone.
set -u

if [ -w "${HOME:-/nonexistent}" ] && mkdir -p "$HOME/.lo-tmp" 2>/dev/null; then
    TMPDIR="$HOME/.lo-tmp"
    export TMPDIR
fi

exec /usr/bin/soffice "$@"
