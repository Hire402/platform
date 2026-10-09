import * as readline from 'node:readline';

/**
 * Hire402 MCP server (Phase 2 onboarding) — Model Context Protocol over
 * stdio (JSON-RPC 2.0, line-delimited). Any framework agent that speaks MCP
 * can onboard to the Hire402 economy in minutes: search services, inspect
 * agents, check quotes. Hand-rolled protocol — no external SDK dependency.
 *
 *   REGISTRY_URL=http://127.0.0.1:4010 npx tsx examples/mcp-server/src/index.ts
 */
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const tools: Tool[] = [
  {
    name: 'hire402_search_services',
    description: 'Search the Hire402 directory for services by standardized unit (e.g. task:research, task:code, gpu-hour).',
    inputSchema: {
      type: 'object',
      properties: { unit: { type: 'string', description: 'Standardized unit to filter by (optional)' } },
    },
    handler: async (args) => {
      const unit = typeof args.unit === 'string' ? `?unit=${encodeURIComponent(args.unit)}` : '';
      return fetchJson(`/v1/listings${unit}`);
    },
  },
  {
    name: 'hire402_agent_metabolic',
    description: 'Get an agent\'s metabolic account: income, burn, runway, solvency status (spec §7).',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'Agent wallet address' } },
      required: ['address'],
    },
    handler: async (args) => fetchJson(`/v1/agents/${args.address}/metabolic`),
  },
  {
    name: 'hire402_agent_reputation',
    description: 'Get an agent\'s reputation: completed jobs, disputes, SLA hit-rate.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'Agent wallet address' } },
      required: ['address'],
    },
    handler: async (args) => fetchJson(`/v1/reputation/${args.address}`),
  },
  {
    name: 'hire402_market_quote',
    description: 'Get the best indicative quote for a unit from the market\'s listings.',
    inputSchema: {
      type: 'object',
      properties: { unit: { type: 'string', description: 'Standardized unit to quote' } },
      required: ['unit'],
    },
    handler: async (args) => fetchJson(`/v1/market/quotes?unit=${encodeURIComponent(String(args.unit))}`),
  },
  {
    name: 'hire402_agent_lookup',
    description: 'Fetch an agent\'s full record: identity, listings, metabolic, reputation.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'Agent wallet address' } },
      required: ['address'],
    },
    handler: async (args) => fetchJson(`/v1/agents/${args.address}`),
  },
];

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${REGISTRY_URL}${path}`);
  if (!res.ok) return { error: `registry ${res.status}: ${await res.text()}` };
  return res.json();
}

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(line: string): Promise<void> {
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return; // ignore malformed lines
  }
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hire402-mcp', version: '0.1.0' },
      });
      return;
    case 'notifications/initialized':
      return; // notification — no response
    case 'tools/list':
      respond(id, {
        tools: tools.map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
        })),
      });
      return;
    case 'tools/call': {
      const name = (params as { name?: string } | undefined)?.name;
      const args = ((params as { arguments?: Record<string, unknown> } | undefined)?.arguments) ?? {};
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        respondError(id, -32602, `unknown tool: ${name}`);
        return;
      }
      try {
        const result = await tool.handler(args);
        respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        respondError(id, -32000, String(e));
      }
      return;
    }
    default:
      if (id !== undefined) respondError(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  void handle(line);
});
console.error('[mcp    ] hire402-mcp ready on stdio (registry %s)', REGISTRY_URL);
