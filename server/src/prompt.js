const LS_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const VALIDATE_CACHE_TTL = 5 * 60; // 5 minutes (seconds)

// Security: reject keys from other LS products (LS official requirement)
const EXPECTED_STORE_ID = 309745;
const EXPECTED_PRODUCT_ID = 876026;

// GET /prompt — validate license via LS, return premium prompt
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

  // Get prompt from KV
  const promptData = await env.KV.get('prompt:latest', { type: 'json' });
  if (!promptData) {
    return json({ error: 'No prompt available' }, 404);
  }

  // ETag check
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch === `"${promptData.etag}"`) {
    return new Response(null, { status: 304 });
  }

  return new Response(JSON.stringify({
    content: promptData.content,
    version: promptData.version,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'ETag': `"${promptData.etag}"`,
      'Cache-Control': 'private, no-cache',
    },
  });
}

// POST /prompt/update — admin endpoint to update prompt content
export async function handlePromptUpdate(request, env) {
  const adminKey = request.headers.get('Authorization');
  if (adminKey !== `Bearer ${env.PROMPT_ADMIN_KEY}`) {
    return json({ error: 'Unauthorized' }, 401);
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
    updatedAt: new Date().toISOString(),
  };

  await env.KV.put('prompt:latest', JSON.stringify(promptData));
  return json({ ok: true, version, etag });
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
