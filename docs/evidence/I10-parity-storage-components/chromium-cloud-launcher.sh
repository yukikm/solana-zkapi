#!/bin/sh
export XDG_CONFIG_HOME=/workspace/work/chromium-config
export XDG_CACHE_HOME=/workspace/work/chromium-cache
exec /usr/bin/chromium --no-sandbox "$@"
