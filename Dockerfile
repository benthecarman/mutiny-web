# Use Node.js as a base image for building the site
FROM node:20-slim AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# This is the cooler way to run pnpm these days (no need to npm install it)
RUN corepack enable
COPY . /app
WORKDIR /app

# I think we need git be here because the vite build wants to look up the commit hash
RUN apt update && apt install -y git python3 make build-essential

# Add the ARG directives for build-time environment variables
ARG VITE_NETWORK="testnet4"
ARG VITE_PROXY="https://p.mutinywallet.com"
ARG VITE_PRIMAL="https://primal-cache.mutinywallet.com/api"
ARG VITE_ESPLORA="https://mempool.space/testnet4/api"
ARG VITE_SCORER="https://scorer.mutinywallet.com"
ARG VITE_LSP
ARG VITE_RGS="/_services/rgs/snapshot/"
ARG VITE_AUTH
ARG VITE_STORAGE="/_services/vss/v2"
ARG VITE_SELFHOSTED="true"
ARG VITE_COMMIT_HASH="testnet4-branch"

# Install dependencies
RUN pnpm install --frozen-lockfile

# IDK why but it gets mad if you don't do this
#RUN git config --global --add safe.directory /app

# Build the static site
RUN pnpm run build

# Now, use Nginx as a base image for serving the site
FROM nginx:alpine

# Copy the static assets from the builder stage to the Nginx default static serve directory
COPY --from=builder /app/dist/public /usr/share/nginx/html

# Copy the custom Nginx configuration file into the container
COPY default.conf /etc/nginx/conf.d/default.conf

# Expose the default Nginx port
EXPOSE 80

# Start Nginx when the container starts
CMD ["nginx", "-g", "daemon off;"]
