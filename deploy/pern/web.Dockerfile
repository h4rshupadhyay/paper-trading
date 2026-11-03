FROM node:24.22.2-bookworm-slim AS build
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend .
RUN npm run build
FROM nginx:1.29-alpine
ENV TRUSTED_INGRESS_CIDR=127.0.0.1/32
ENV NGINX_ENVSUBST_FILTER=^TRUSTED_INGRESS_CIDR$
COPY deploy/pern/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 deploy/pern/19-validate-ingress.sh /docker-entrypoint.d/19-validate-ingress.sh
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 80
