FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend .
RUN npm run build
FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de
ENV TRUSTED_INGRESS_CIDR=127.0.0.1/32
ENV NGINX_ENVSUBST_FILTER=^TRUSTED_INGRESS_CIDR$
COPY deploy/pern/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 deploy/pern/19-validate-ingress.sh /docker-entrypoint.d/19-validate-ingress.sh
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 80
