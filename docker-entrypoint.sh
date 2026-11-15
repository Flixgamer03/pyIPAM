#!/bin/sh
# pyIPAM container entrypoint
#  - prepares /data (also works for bind mounts owned by another user)
#  - optionally enables HTTPS (own certificate or auto-generated self-signed one)
#  - drops root privileges and starts gunicorn (or a given command, e.g. app.py reset-password)
set -e

RUN_UID=1000
RUN_GID=1000
PORT="${IPAM_PORT:-8080}"
TLS_MODE="${IPAM_TLS:-auto}"                 # auto | self-signed | off
CERT="${IPAM_TLS_CERT:-/data/tls/cert.pem}"
KEY="${IPAM_TLS_KEY:-/data/tls/key.pem}"
TLS_RUN=/tmp/pyipam-tls

drop() { exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups "$@"; }

mkdir -p /data
if [ "$(stat -c %u /data)" != "$RUN_UID" ]; then
    echo "pyIPAM: setting owner of /data to $RUN_UID:$RUN_GID"
    chown -R "$RUN_UID:$RUN_GID" /data
fi

# Any other command (e.g. "python app.py reset-password admin") runs as the app user
if [ "$#" -gt 0 ]; then
    drop "$@"
fi

if [ "$TLS_MODE" = "self-signed" ] && { [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; }; then
    CN="${IPAM_TLS_HOSTNAME:-pyipam}"
    echo "pyIPAM: generating self-signed certificate for '$CN'"
    mkdir -p "$(dirname "$CERT")" "$(dirname "$KEY")"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$CN" \
        -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1" \
        -keyout "$KEY" -out "$CERT" 2>/dev/null
    chown "$RUN_UID:$RUN_GID" "$CERT" "$KEY"
    chmod 600 "$KEY"
fi

set -- gunicorn --chdir /app -w "${IPAM_WORKERS:-2}" --threads 4 --preload --timeout 90 \
    -b "0.0.0.0:$PORT" --access-logfile -

rm -rf "$TLS_RUN"
if [ "$TLS_MODE" != "off" ] && [ -f "$CERT" ] && [ -f "$KEY" ]; then
    # copy so the app user can read them, whatever their owner/permissions on the host
    install -d -o "$RUN_UID" -g "$RUN_GID" -m 700 "$TLS_RUN"
    install -o "$RUN_UID" -g "$RUN_GID" -m 600 "$CERT" "$TLS_RUN/cert.pem"
    install -o "$RUN_UID" -g "$RUN_GID" -m 600 "$KEY" "$TLS_RUN/key.pem"
    set -- "$@" --certfile "$TLS_RUN/cert.pem" --keyfile "$TLS_RUN/key.pem"
    echo "pyIPAM: HTTPS on port $PORT"
else
    echo "pyIPAM: HTTP on port $PORT (put a certificate into /data/tls/ or set IPAM_TLS=self-signed for HTTPS)"
fi

drop "$@" app:app
