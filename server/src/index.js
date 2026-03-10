import { handlePromptGet, handlePromptUpdate } from './prompt.js';
import { handleWebhook } from './webhook.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match',
        },
      });
    }

    try {
      if (pathname === '/prompt' && request.method === 'GET') {
        return await handlePromptGet(request, env);
      }

      if (pathname === '/prompt/update' && request.method === 'POST') {
        return await handlePromptUpdate(request, env);
      }

      if (pathname === '/webhook/ls' && request.method === 'POST') {
        return await handleWebhook(request, env);
      }

      if (pathname === '/health') {
        return json({ status: 'ok' });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Internal server error' }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
