#!/usr/bin/env bash
# Канареечная проверка трафика (k8s-джоба): после смены весов HTTPRoute
# все ответы /api/health через шлюз обязаны приходить от ожидаемой
# build-метки (поле version в JSON ответа).
#
# Перекладка трафика в Envoy не мгновенна (контроллер → xDS → живые
# соединения), поэтому меряем СЕРИЮ целиком и при чужой версии ждём и
# повторяем: первые попытки могут видеть старую раскладку. Сбой curl
# (перезвон Envoy) считается чужим ответом — серия честно перезапустится.
#
# Использование: expect-version.sh <stable|canary> <base-url>
set -euo pipefail

want="$1"
base="$2"

# 15 попыток × (пауза 2с + серия 25) — с запасом на пересборку Envoy
for attempt in $(seq 1 15); do
  foreign=0
  for _ in $(seq 1 25); do
    version=$(curl -fsS --max-time 10 "$base/health" 2>/dev/null \
      | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' || true)
    if [ "$version" != "$want" ]; then
      foreign=$((foreign + 1))
    fi
  done

  if [ "$foreign" -eq 0 ]; then
    echo "все 25 ответов серии от версии $want (попытка $attempt)"
    exit 0
  fi
  echo "попытка $attempt: $foreign/25 ответов не от $want — ждём перекладку Envoy"
  sleep 2
done

echo "::error::title=canary weights::~60с после смены весов — $foreign/25 ответов health всё ещё не от версии $want"
exit 1
