import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { Client } from '../src/api.js';
import { createServer } from '../src/mcp/server.js';
import { BASE, CARD, CREATED, KEY, fakeApi, json, ok, type Route } from './helpers.js';

async function connect(routes: Record<string, Route>, options: { apiKey?: string; allowFileWrites?: boolean } = {}) {
  const api = fakeApi(routes);
  const server = createServer({
    client: new Client({ baseUrl: BASE, apiKey: options.apiKey ?? KEY, fetch: api.fetch }),
    version: 'test',
    allowFileWrites: options.allowFileWrites,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new McpClient({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return { client, api };
}

function errorBody(result: unknown): Record<string, any> {
  const [first] = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(first!.text);
}

describe('MCP server', () => {
  it('lists the 10 tools; update_readme only with file writes allowed', async () => {
    const { client } = await connect({});
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual([
      'create_card',
      'delete_card',
      'get_card_design',
      'get_template_design',
      'get_usage',
      'list_cards',
      'list_components',
      'list_palettes',
      'list_templates',
      'validate_card',
    ]);
    const withWrites = await connect({}, { allowFileWrites: true });
    expect((await withWrites.client.listTools()).tools.map(t => t.name)).toContain('update_readme');
    expect((await client.getServerVersion())?.name).toBe('githubcard');
    expect(client.getInstructions()).toContain('GitHubCard turns a GitHub user or repository');
  });

  it('create_card turns a URL subject into a repo request', async () => {
    const { client, api } = await connect({ 'POST /cards': () => ok(CREATED) });
    const result = await client.callTool({
      name: 'create_card',
      arguments: { subject: 'https://github.com/octocat/hello-world' },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { id: string }).id).toBe(CARD.id);
    expect(api.requests[0]!.body).toEqual({ type: 'repo', username: 'octocat', repo: 'hello-world' });
  });

  it('returns API errors as isError with a hint', async () => {
    const { client } = await connect({
      'POST /cards': () => json({ code: 'UNKNOWN_TEMPLATE', message: 'Unknown template' }, { status: 400 }),
    });
    const result = await client.callTool({ name: 'create_card', arguments: { subject: 'octocat', template: 'x' } });
    expect(result.isError).toBe(true);
    const body = errorBody(result);
    expect(body.code).toBe('UNKNOWN_TEMPLATE');
    expect(body.hint).toContain('list_templates');
  });

  it('get_usage without a key sends nothing and explains how to add one', async () => {
    const { client, api } = await connect({}, { apiKey: '' });
    const result = await client.callTool({ name: 'get_usage', arguments: {} });
    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe('NO_API_KEY');
    expect(errorBody(result).hint).toContain('GHCARD_API_KEY');
    expect(api.requests).toHaveLength(0);
  });

  it('round-trips a design, and keeps features on PRO_FEATURE', async () => {
    const design = { version: 1, artboard: { width: 1200, height: 630 }, layers: [] };
    const { client, api } = await connect({
      'GET /templates/repo-og-compact/design': () => ok(design),
      'POST /cards': () =>
        json({ code: 'PRO_FEATURE', message: 'Pro font', features: [{ path: 'artboard.style.fontFamily' }] }, { status: 403 }),
    });
    const got = await client.callTool({
      name: 'get_template_design',
      arguments: { template: 'repo-og-compact', subject: 'octocat/hello-world' },
    });
    expect((got.structuredContent as { design: unknown }).design).toEqual(design);
    expect(api.requests[0]!.search.get('repo')).toBe('hello-world');

    const failed = await client.callTool({ name: 'create_card', arguments: { subject: 'octocat', design } });
    expect(api.requests[1]!.body).toEqual({ username: 'octocat', design });
    const body = errorBody(failed);
    expect(body.hint).toContain('free ones');
    expect(body.details.features).toHaveLength(1);
  });

  it('rejects design together with template', async () => {
    const { client, api } = await connect({});
    const result = await client.callTool({
      name: 'validate_card',
      arguments: { subject: 'octocat', template: 'social', design: {} },
    });
    expect(errorBody(result).message).toBe('pass either design or template/palette, not both');
    expect(api.requests).toHaveLength(0);
  });

  it('validate_card posts to /cards/validate', async () => {
    const { client, api } = await connect({ 'POST /cards/validate': () => ok({ valid: true, warnings: [] }) });
    const result = await client.callTool({ name: 'validate_card', arguments: { subject: 'octocat' } });
    expect((result.structuredContent as { valid: boolean }).valid).toBe(true);
    expect(api.requests[0]!.path).toBe('/cards/validate');
  });

  it('update_readme writes Markdown files only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghcard-mcp-'));
    const { client } = await connect({}, { allowFileWrites: true });
    const path = join(dir, 'README.md');
    const done = await client.callTool({
      name: 'update_readme',
      arguments: { path, subject: 'octocat', snippet: CARD.embed.markdown },
    });
    expect((done.structuredContent as { edit: string }).edit).toBe('created');
    expect(await readFile(path, 'utf8')).toContain('<!-- ghcard:octocat -->');

    const refused = await client.callTool({
      name: 'update_readme',
      arguments: { path: join(dir, 'notes.txt'), subject: 'octocat', snippet: 'x' },
    });
    expect(errorBody(refused).message).toBe('only Markdown (.md) files can be edited');
  });
});
