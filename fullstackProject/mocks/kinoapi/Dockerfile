# Мок внешнего кино-справочника (этап 37): один server.js без зависимостей,
# поэтому без стадий сборки — просто копируем файл в node:22-alpine (тот же
# базовый образ, что у api-сервиса стенда)
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
EXPOSE 8100
CMD ["node", "server.js"]
