# Chalk Talk in a container, for running on a server. See "Run it on a server" in README.md.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Download the Kokoro voice model now, so the server doesn't fetch it on first start.
RUN node -e "import('kokoro-js').then(({ KokoroTTS }) => KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' })).then(() => console.log('Voice model ready'))"

COPY . .
RUN mkdir -p lessons && chown node:node lessons
USER node

EXPOSE 3000
CMD ["node", "server.js"]
