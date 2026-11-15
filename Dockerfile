FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    IPAM_DATA_DIR=/data \
    IPAM_PORT=8080 \
    IPAM_TRUSTED_PROXIES=0 \
    TZ=Etc/UTC

# ping for the subnet scan, openssl for self-signed certificates, tzdata for local timestamps
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping openssl tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The entrypoint starts as root only to fix /data ownership, then drops to this user
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
 && useradd -r -u 1000 -d /app pyipam \
 && mkdir -p /data && chown pyipam:pyipam /data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s CMD python -c "import os,ssl,urllib.request as u; \
s='https' if os.path.isdir('/tmp/pyipam-tls') else 'http'; \
u.urlopen(s+'://127.0.0.1:'+os.environ.get('IPAM_PORT','8080')+'/healthz', context=ssl._create_unverified_context(), timeout=4)" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
