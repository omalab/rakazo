FROM debian:bookworm-slim AS capture-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libx11-dev \
    libxdamage-dev \
    libxext-dev \
    libxfixes-dev \
    libxtst-dev \
    libpng-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY xcapture.c .
RUN cc -O3 -fPIC -shared -Wall -Wextra -Werror -o librakazo-xcapture.so xcapture.c \
    -lX11 -lXext -lXdamage -lXfixes -lXtst -lpng

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun
FROM dolthub/dolt:2.3.2@sha256:9a077bc9c8cb6604a6d458c734096b482735f640144e5665b36161d560f14861 AS dolt
FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv

FROM debian:bookworm-slim AS composio
ARG TARGETARCH
ARG COMPOSIO_CLI_VERSION=0.4.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && case "$TARGETARCH" in \
    amd64) composio_arch=x64; checksum=86ca56e483b931559a02e90ec8a62ab132c20d94e5822c1dab1b3bf85eabfd01 ;; \
    arm64) composio_arch=aarch64; checksum=16899e207852f308e238e985a82950f7c83de67fab72ff7e180dc86cb32c32e5 ;; \
    *) printf 'unsupported Composio architecture: %s\n' "$TARGETARCH" >&2; exit 1 ;; \
  esac \
  && archive="composio-linux-${composio_arch}.zip" \
  && curl -fsSL \
    "https://github.com/ComposioHQ/composio/releases/download/%40composio/cli%40${COMPOSIO_CLI_VERSION}/${archive}" \
    -o "/tmp/${archive}" \
  && printf '%s  %s\n' "$checksum" "/tmp/${archive}" | sha256sum -c - \
  && unzip -q "/tmp/${archive}" -d /tmp/composio \
  && mkdir -p /opt/composio \
  && cp -a "/tmp/composio/composio-linux-${composio_arch}/." /opt/composio/ \
  && test -x /opt/composio/composio

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    xterm \
    xdotool \
    x11-utils \
    x11-xserver-utils \
    imagemagick \
    novnc \
    websockify \
    python3 \
    curl \
    ca-certificates \
    git \
    gh \
    openssh-client \
    procps \
    bash \
    locales \
    chromium \
    pcmanfm \
    tint2 \
    fonts-liberation \
    fonts-dejavu-core \
    dbus-x11 \
    xdg-utils \
  && sed -i 's/^# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
  && locale-gen en_US.UTF-8 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --omit=dev \
    @beads/bd@1.2.2 \
    @openai/codex@0.153.4 \
    @anthropic-ai/claude-code@2.1.263 \
  && npm cache clean --force \
  && usermod --login rakazo --home /home/rakazo --move-home --shell /bin/bash node \
  && groupmod --new-name rakazo node \
  && mkdir -p /home/rakazo/.local/bin /home/rakazo/.bun/bin \
  && printf '%s\n' '# Keep user-installed agent tools available even when /home is bind-mounted.' \
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' \
    > /etc/profile.d/rakazo-path.sh \
  && chmod 644 /etc/profile.d/rakazo-path.sh \
  && chown -R 1000:1000 /home/rakazo/.local /home/rakazo/.bun \
  && mkdir -p /etc/rakazo/fluxbox \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=dolt /usr/local/bin/dolt /usr/local/bin/dolt
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=composio /opt/composio /opt/composio
RUN ln -s /opt/composio/composio /usr/local/bin/composio
RUN command -v node \
  && test "$(node -p 'Number(process.versions.node.split(".")[0]) >= 18')" = "true" \
  && command -v git \
  && command -v gh \
  && command -v bd \
  && command -v dolt \
  && command -v uv \
  && command -v bun \
  && command -v composio \
  && composio --version \
  && command -v codex \
  && codex --version \
  && command -v claude \
  && claude --version \
  && command -v chromium \
  && command -v python3 \
  && command -v curl
ENV DISPLAY=:1
ENV HOME=/home/rakazo
ENV PATH=/home/rakazo/.local/bin:/home/rakazo/.bun/bin:$PATH
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8
WORKDIR /home/rakazo
# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 start.sh /usr/local/bin/rakazo-computer
COPY --chmod=755 control.py /usr/local/bin/rakazo-computer-control
COPY --from=capture-builder /build/librakazo-xcapture.so /usr/local/lib/librakazo-xcapture.so
COPY --chmod=755 rakazo-browser /usr/local/bin/rakazo-browser
COPY --chmod=755 rakazo-desktop-panel /usr/local/bin/rakazo-desktop-panel
COPY --chmod=644 rakazo-browser.desktop /usr/share/applications/rakazo-browser.desktop
COPY --chmod=644 rakazo-files.desktop /usr/share/applications/rakazo-files.desktop
COPY --chmod=644 rakazo-terminal.desktop /usr/share/applications/rakazo-terminal.desktop
COPY --chmod=644 fluxbox.init /etc/rakazo/fluxbox/init
COPY --chmod=644 fluxbox.apps /etc/rakazo/fluxbox/apps
COPY --chmod=644 fluxbox.menu /etc/rakazo/fluxbox/menu
COPY --chmod=644 tint2rc /etc/rakazo/tint2rc
COPY --chmod=644 embed.html /usr/share/novnc/embed.html
COPY --chmod=644 clipboard-bridge.js /usr/share/novnc/clipboard-bridge.js
# Strip CR so shebangs work even if the build context came from a CRLF checkout.
RUN ldconfig \
  && sed -i 's/\r$//' /usr/local/bin/rakazo-computer /usr/local/bin/rakazo-computer-control /usr/local/bin/rakazo-browser \
    /usr/local/bin/rakazo-desktop-panel \
    /etc/rakazo/fluxbox/init /etc/rakazo/fluxbox/apps /etc/rakazo/fluxbox/menu
EXPOSE 7070 6080 6081 6082 6083 6084 6085 6086 6087 6088 6089 6090 6091 6092 6093 6094 6095
USER 1000:1000
CMD ["/usr/local/bin/rakazo-computer"]
