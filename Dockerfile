FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY server.js ./

RUN mkdir -p /app/data /app/data/browser

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["npm", "start"]
