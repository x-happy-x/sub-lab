# Node берём из официального образа на том же Alpine 3.16, что и subconverter:
# в репозиториях 3.16 лежит Node 16, у которого нет глобального fetch — на нём
# молча ломается загрузка подписок. Свой musl, openssl 1.1 и сам subconverter
# остаются на месте, переносится только бинарник Node.
FROM node:18-alpine3.16 AS node
FROM tindy2013/subconverter:latest

WORKDIR /app

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && if [ -f /base/pref.example.toml ]; then \
      cp /base/pref.example.toml /base/pref.toml; \
      sed -i 's/^listen = .*/listen = \"0.0.0.0\"/' /base/pref.toml; \
      sed -i 's/^port = .*/port = 8787/' /base/pref.toml; \
    fi

COPY app/package.json ./package.json
COPY app/package-lock.json ./package-lock.json
COPY app/node_modules ./node_modules
COPY app/*.js ./
# Нормализованная модель лежит в подкаталоге: `app/*.js` его не забирает.
COPY app/model ./model
COPY resources/ua-catalog.json /resources/ua-catalog.json
COPY resources/happ /resources/happ
COPY resources/admin.json /resources/admin.json
COPY resources/apps.yml /resources/apps.yml
COPY resources/app-guides /resources/app-guides
COPY frontend/dist /frontend-dist
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV APP_PORT=8788 \
    SUBCONVERTER_PORT=8787 \
    CONVERTER_URL=http://127.0.0.1:8787/sub \
    SOURCE_URL=http://127.0.0.1:8788/source.txt \
    ADMIN_SEED_PATH=/resources/admin.json \
    USE_CONVERTER=1

EXPOSE 8788 8787

ENTRYPOINT ["/entrypoint.sh"]
