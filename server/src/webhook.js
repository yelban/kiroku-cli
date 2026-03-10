// POST /webhook/ls — Lemon Squeezy webhook handler
export async function handleWebhook(request, env) {
  const signature = request.headers.get('X-Signature');
  if (!signature) {
    return json({ error: 'Missing signature' }, 401);
  }

  const rawBody = await request.text();

  // Verify HMAC signature
  const valid = await verifySignature(rawBody, signature, env.LS_WEBHOOK_SECRET);
  if (!valid) {
    return json({ error: 'Invalid signature' }, 401);
  }

  const event = JSON.parse(rawBody);
  const eventName = event.meta?.event_name;

  // Log webhook event (optional — mainly for debugging)
  switch (eventName) {
    case 'subscription_payment_success':
    case 'subscription_created':
    case 'subscription_updated':
    case 'subscription_expired':
    case 'subscription_cancelled':
    case 'license_key_created': {
      // Invalidate cached license validation if we have the key
      const licenseKey = event.data?.attributes?.license_key
        || event.meta?.custom_data?.license_key;
      if (licenseKey) {
        await env.KV.delete(`license:${licenseKey}`);
      }
      break;
    }
    default:
      // Unknown event, just acknowledge
      break;
  }

  return json({ received: true });
}

async function verifySignature(payload, signature, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const computed = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return computed === signature;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
