# Dockerfile for Glama MCP server evaluation
# Starts the OrangePro MCP server in stdio mode for introspection
FROM node:22-slim

# Install the published package globally (pulls both @orangepro/mcp-server
# and its dependency @orangepro/orangepro-mcp)
RUN npm install -g @orangepro/mcp-server@latest

# Glama sends MCP introspection requests over stdio
# The entrypoint must start the server in MCP (stdio) mode
ENTRYPOINT ["mcp-server", "mcp"]
