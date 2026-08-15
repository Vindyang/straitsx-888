#!/bin/sh
set -eu

# Fargate bind mounts start as root:root 0755. Fix only the ephemeral /tmp
# mount, then irrevocably drop to the image's pwuser before application code.
chown 1001:1001 /tmp
chmod 0700 /tmp
exec setpriv --reuid=1001 --regid=1001 --init-groups "$@"
