FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies cleanly
COPY package.json package-lock.json ./
RUN npm ci

# Copy application source, SQL migrations, and local MediaPipe AI assets
COPY .env.production index.html postcss.config.js tailwind.config.js tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY supabase ./supabase

# Build optimized Vite frontend bundle into /app/dist
RUN npm run build

# Prune devDependencies to keep runtime image lean
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV DATA_DIR=/app/.smartexam-db
EXPOSE 8080

CMD ["npm", "start"]
