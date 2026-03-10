import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../shared/config.js';
import { initDb, getDb, runMigrations } from '../shared/db.js';
import { createLogger } from '../shared/logger.js';
import { memorySearch } from './memory-search.js';
import { memorySave, memoryForget } from './memory-write.js';
import { sqlReadonly } from './sql-sandbox.js';
import { healthStatus } from './health-status.js';
import { getProjectBrief } from './project-brief.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIROKU_ROOT } from '../shared/paths.js';

const log = createLogger('mcp');

async function main() {
  const config = loadConfig();

  await initDb();
  runMigrations();

  const projectId = process.env.KIROKU_PROJECT_ID || 'default';
  log.info({ projectId }, 'MCP gateway starting');

  const server = new McpServer({
    name: config.mcp.serverName,
    version: config.mcp.serverVersion,
  });

  server.tool(
    'memory_search',
    `Search project memory for past decisions, architecture choices, bug fixes, user preferences, and development context. Use this tool AUTOMATICALLY when:
- Starting work on a topic that may have prior history
- The user references something discussed before
- You need context about project conventions or past decisions
- The user asks about their preferences, habits, or past choices
- The user asks "what did we decide about X" or "how did we handle Y"
- Resuming or continuing work from a previous session

By default searches both project-scoped and global (cross-project) facts.`,
    {
      query: z.string().describe('Search query text'),
      project_id: z.string().optional().describe('Project ID (defaults to current project)'),
      top_k: z.number().optional().describe('Number of results (default 10, max 50)'),
      fact_types: z.array(z.string()).optional().describe('Filter by fact_type'),
      time_from: z.string().optional().describe('ISO 8601 start time'),
      time_to: z.string().optional().describe('ISO 8601 end time'),
      status: z.string().optional().describe('Fact status (default: active)'),
      scope: z.enum(['project', 'global', 'all']).optional()
        .describe("Scope filter: 'project' (current only), 'global' (cross-project), 'all' (both, default)"),
    },
    async (params) => {
      try {
        const result = await memorySearch({ ...params, project_id: params.project_id || projectId });
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        log.error({ err: err.message }, 'memory_search error');
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sql_readonly',
    `Execute read-only SQL queries against the memory database. Use for cross-project statistics, complex JOINs, timeline analysis. Read kiroku://schema/memory resource first.`,
    {
      sql: z.string().describe('SQL query (SELECT/WITH/EXPLAIN only)'),
      project_id: z.string().optional().describe('Auto-add project filter'),
    },
    async (params) => {
      try {
        const result = sqlReadonly({ ...params, project_id: params.project_id || projectId }, config.mcp.sqlSandbox);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        log.error({ err: err.message }, 'sql_readonly error');
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'memory_save',
    `Save a fact to project memory. Use when the user says "remember this", states a decision, explicitly asks to store information, or reaches an important conclusion worth preserving. Use scope='global' for cross-project preferences like "always use bun" or personal info.`,
    {
      subject: z.string().describe('Subject entity name'),
      predicate: z.string().describe('Verb phrase'),
      object: z.string().describe('Value or description'),
      detail: z.string().optional().describe('Optional elaboration (1-2 sentences)'),
      fact_type: z.string().optional().describe('semantic/episodic/preference/task/state'),
      project_id: z.string().optional().describe('Project ID'),
      scope: z.enum(['project', 'global']).optional()
        .describe("Memory scope: 'project' (default) or 'global' (cross-project, e.g. user preferences)"),
    },
    async (params) => {
      try {
        const result = await memorySave({ ...params, project_id: params.project_id || projectId });
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        log.error({ err: err.message }, 'memory_save error');
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'memory_forget',
    `Archive facts from memory. Use when the user says "forget this" or information is outdated.`,
    {
      fact_id: z.string().optional().describe('Exact fact ID'),
      subject: z.string().optional().describe('Subject (fuzzy)'),
      predicate: z.string().optional().describe('Predicate (fuzzy)'),
      project_id: z.string().optional().describe('Project ID'),
    },
    async (params) => {
      try {
        const result = memoryForget({ ...params, project_id: params.project_id || projectId });
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        log.error({ err: err.message }, 'memory_forget error');
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  if (config.mcp.projectBrief.enabled) {
    server.tool(
      'project_context',
      `Load project memory context. Call this tool AUTOMATICALLY at the START of every conversation to understand the current project's architecture, preferences, decisions, and state. No parameters needed — it returns the most important facts ranked by type and relevance.`,
      {},
      async () => {
        try {
          const brief = getProjectBrief(getDb(), projectId, config.mcp.projectBrief.maxFacts);
          return { content: [{ type: 'text', text: brief }] };
        } catch (err) {
          log.error({ err: err.message }, 'project_context error');
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      }
    );
  }

  server.tool(
    'health_status',
    'Check Kiroku system health: database stats, queue depth, embedding coverage, extraction key, license tier.',
    {},
    async () => {
      try {
        const result = await healthStatus(config);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        log.error({ err: err.message }, 'health_status error');
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.resource(
    'memory-schema',
    'kiroku://schema/memory',
    { mimeType: 'text/plain', description: 'Kiroku memory DB schema' },
    async () => {
      const schema = readFileSync(join(KIROKU_ROOT, 'migrations', '001_init.sql'), 'utf8');
      const vecSchema = readFileSync(join(KIROKU_ROOT, 'migrations', '002_vec.sql'), 'utf8');
      const text = `# Kiroku Memory Schema\n\n## Tables\n- projects (id, name)\n- conversations (id, project_id, auth_mode, system_hash, started_at)\n- turns (id, conversation_id, project_id, turn_index, role, text, model, usage columns)\n- entities (id, canonical_name, entity_type, aliases_json)\n- facts (id, project_id, subject_entity_id, predicate, object_text, fact_type, confidence, heat, decay_bucket, scope, status, source_turn_id)\n- extraction_jobs (id, queue_file, status)\n- fact_embeddings (fact_id PK, project_id, scope, fact_type, status, embedding float[1024])\n- audit_logs (id, project_id, action[save|forget|extract|evict], target_type, target_id, detail_json, created_at)\n\n## Scope\n- 'project': project-specific facts (default)\n- 'global': cross-project facts (preferences, personal info)\n\n## Full DDL\n${schema}\n\n${vecSchema}`;
      return { contents: [{ uri: 'kiroku://schema/memory', text, mimeType: 'text/plain' }] };
    }
  );

  if (config.mcp.projectBrief.enabled) {
    server.resource(
      'project-brief',
      'kiroku://context/project-brief',
      { mimeType: 'text/plain', description: 'Auto-injected project context from memory' },
      async () => {
        const brief = getProjectBrief(getDb(), projectId, config.mcp.projectBrief.maxFacts);
        return { contents: [{ uri: 'kiroku://context/project-brief', text: brief, mimeType: 'text/plain' }] };
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP gateway connected');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
