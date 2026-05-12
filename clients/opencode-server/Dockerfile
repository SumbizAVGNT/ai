FROM node:24-alpine
RUN npm install -g opencode-ai
WORKDIR /workspace
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
