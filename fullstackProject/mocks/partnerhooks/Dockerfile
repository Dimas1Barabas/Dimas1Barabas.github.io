# Мок партнёра-получателя вебхуков (этап 39): один server.js без
# зависимостей, поэтому без стадий сборки — копируем файл в node:22-alpine
# (тот же базовый образ, что у api-сервиса стенда)
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
EXPOSE 8103
CMD ["node", "server.js"]
