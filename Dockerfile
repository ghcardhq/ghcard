# Runs `ghcard mcp`, the GitHubCard MCP server, over stdio.
#
#   docker build -t ghcard .
#   docker run -i --rm -e GHCARD_API_KEY ghcard
#
# Listing tools and templates needs no key; creating cards needs
# GHCARD_API_KEY (create one at https://githubcard.com/dashboard).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["mcp"]
