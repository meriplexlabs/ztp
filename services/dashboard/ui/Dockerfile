# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

# ─── Runtime stage (nginx, non-root) ──────────────────────────────────────────
FROM nginx:1.27-alpine

# Remove default nginx user config; nginx will run as nobody
RUN sed -i 's/user\s*nginx;/user nobody;/' /etc/nginx/nginx.conf || true

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
