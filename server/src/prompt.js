const LS_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const VALIDATE_CACHE_TTL = 5 * 60; // 5 minutes (seconds)

// Security: reject keys from other LS products (LS official requirement)
const EXPECTED_STORE_ID = 309745;
const EXPECTED_PRODUCT_ID = 876026;

// Slot router: ?slot=<name> picks which prompt to serve. Defaults to
// 'default' for backward compatibility with pre-1.7.16 clients.
const VALID_SLOTS = new Set(['default', 'batch']);
const LEGACY_KEY = 'prompt:latest';
const slotKey = (slot) => `prompt:${slot}`;

// GET /prompt[?slot=default|batch] — validate license, return prompt for slot
export async function handlePromptGet(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return json({ error: 'Missing license key' }, 401);
  }
  const licenseKey = auth.slice(7);

  // Validate license via Lemon Squeezy
  const valid = await validateLicense(licenseKey, env);
  if (!valid) {
    return json({ error: 'Invalid or expired license' }, 403);
  }

  const url = new URL(request.url);
  const slot = url.searchParams.get('slot') || 'default';
  if (!VALID_SLOTS.has(slot)) {
    return json({ error: `Invalid slot: ${slot}` }, 400);
  }

  // Read slot-keyed entry first; for default, fall back to the legacy
  // `prompt:latest` key so existing KV data keeps working until a new
  // /prompt/update arrives.
  let promptData = await env.KV.get(slotKey(slot), { type: 'json' });
  if (!promptData && slot === 'default') {
    promptData = await env.KV.get(LEGACY_KEY, { type: 'json' });
  }
  if (!promptData) {
    return json({ error: `No prompt available for slot: ${slot}` }, 404);
  }

  // ETag check
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch === `"${promptData.etag}"`) {
    return new Response(null, { status: 304 });
  }

  return new Response(JSON.stringify({
    content: promptData.content,
    version: promptData.version,
    slot,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'ETag': `"${promptData.etag}"`,
      'X-Prompt-Slot': slot,
      'Cache-Control': 'private, no-cache',
    },
  });
}

// POST /prompt/update[?slot=default|batch] — admin endpoint to update prompt content for slot
export async function handlePromptUpdate(request, env) {
  const adminKey = request.headers.get('Authorization');
  if (adminKey !== `Bearer ${env.PROMPT_ADMIN_KEY}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const slot = url.searchParams.get('slot') || 'default';
  if (!VALID_SLOTS.has(slot)) {
    return json({ error: `Invalid slot: ${slot}` }, 400);
  }

  const { content, version } = await request.json();
  if (!content || !version) {
    return json({ error: 'Missing content or version' }, 400);
  }

  const etag = await computeEtag(content);
  const promptData = {
    content,
    version,
    etag,
    slot,
    updatedAt: new Date().toISOString(),
  };

  await env.KV.put(slotKey(slot), JSON.stringify(promptData));
  // Mirror default writes to the legacy key so a rolled-back server can
  // still serve the old `prompt:latest` route without a re-deploy.
  if (slot === 'default') {
    await env.KV.put(LEGACY_KEY, JSON.stringify(promptData));
  }
  return json({ ok: true, slot, version, etag });
}

// Validate license key via Lemon Squeezy API (with short cache)
async function validateLicense(licenseKey, env) {
  // Check cache first
  const cacheKey = `license:${licenseKey}`;
  const cached = await env.KV.get(cacheKey, { type: 'json' });
  if (cached && Date.now() / 1000 - cached.validatedAt < VALIDATE_CACHE_TTL) {
    return cached.valid;
  }

  try {
    const res = await fetch(LS_VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ license_key: licenseKey }),
    });

    const data = await res.json();

    // Verify store_id and product_id to prevent cross-product key abuse
    if (data.meta?.store_id !== EXPECTED_STORE_ID || data.meta?.product_id !== EXPECTED_PRODUCT_ID) {
      await env.KV.put(cacheKey, JSON.stringify({
        valid: false,
        validatedAt: Date.now() / 1000,
      }), { expirationTtl: VALIDATE_CACHE_TTL * 2 });
      return false;
    }

    const valid = data.valid === true;

    // Cache result for 5 minutes
    await env.KV.put(cacheKey, JSON.stringify({
      valid,
      validatedAt: Date.now() / 1000,
    }), { expirationTtl: VALIDATE_CACHE_TTL * 2 });

    return valid;
  } catch {
    // On error, check if we have a cached result (even stale)
    if (cached) return cached.valid;
    return false;
  }
}

async function computeEtag(content) {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const arr = new Uint8Array(hash);
  return Array.from(arr.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
