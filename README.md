# PreyReach for n8n

Build workflows with the [PreyReach](https://preyreach.com) REST API. This community node sends ordinary HTTP resource requests and returns JSON responses. It does not connect to an MCP server or use JSON-RPC.

## Installation

Install `n8n-nodes-preyreach` from **Settings → Community nodes** in your n8n instance. You can also install the npm package in a self-hosted n8n installation.

## Authentication

Create a PreyReach API key in your account and paste it into the **PreyReach API** credential. The key is sent only to `https://api.preyreach.com` as a Bearer header. Credentials can be tested with the account endpoint.

**Upgrading from 1.x:** replace the OAuth credential with an API key. Version 2 uses the public REST API's search records and allowance, separately from older MCP searches. Saved-lead operations are not available in this API-key integration. Review existing workflows before running searches.

## Operations

| Operation | HTTP request |
| --- | --- |
| Account | `GET /v1/account` |
| Submit search | `POST /v1/searches` |
| Get search | `GET /v1/searches/:searchId` |
| Enrich completed search | `POST /v1/searches/:searchId/enrich` |

Search submission returns `id`, `status`, and `pollUrl`. Pass that `id` to Get Search. Use n8n's Wait node between checks while a search is queued or running. Enrichment requires a completed search belonging to the same API key.

## Workflow behavior

Each input item makes one API request and produces one linked output item. Optional pagination fields can be passed through the node's options; list responses retain their next-page cursor or offset. Write operations require the node's explicit confirmation switch. Failed requests stop the workflow unless **Continue On Fail** is enabled. HTTP errors are summarized without including credentials or raw request headers.

Requests use the fixed product API origin, encode resource identifiers, and do not follow redirects. Use a dedicated account for automation when you want separate access and data. Account ownership, workspace permissions, billing limits, and entitlement checks are enforced by the product API.

## Development and support

Run `npm ci`, `npm run lint`, and `npm test` to build and validate the package with the n8n node CLI. Source and release automation: [preyreach/n8n-nodes-preyreach](https://github.com/preyreach/n8n-nodes-preyreach). Report node issues in [GitHub Issues](https://github.com/preyreach/n8n-nodes-preyreach/issues).

Product: [PreyReach](https://preyreach.com) · [Privacy](https://preyreach.com/privacy/) · [Agent skill](https://github.com/preyreach/agent-skill) · [MCP integration](https://github.com/preyreach/mcp-server)

MIT license.
