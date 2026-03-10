# E2E User Journey Test — 2026-03-08

## Overview

Full end-to-end test simulating a new user: npm install → free tier → purchase via Lemon Squeezy → activate pro → deactivate.

- **Package**: @kiroku/cli@1.0.1 (published during this session)
- **CF Worker**: https://kiroku-api.twampd.workers.dev (premium prompt v1.1, 3872 chars)
- **LS Store**: kitoku (store_id: 309745, product_id: 876026, test mode)
- **Machine**: macOS Darwin 24.6.0, Node.js v22.21.1

---

## Test Steps & Results

### Step 1: Clean Slate

```bash
rm -rf ~/.kiroku/
npm uninstall -g @kiroku/cli
```

Result: **PASS** — All state removed.

### Step 2: npm install → init → free tier

```bash
npm install -g @kiroku/cli
kiroku init
kiroku status
kiroku doctor
```

Result: **PASS**

- `kiroku help` — All 12 commands listed
- `kiroku init` — Created ~/.kiroku/ directory structure + SQLite DB
- `kiroku status` — Proxy: STOPPED, Worker: STOPPED, MCP: NOT CONFIGURED, DB: 0 facts
- `kiroku doctor` — Config valid, sqlite-vec OK, DB readable, Machine ID: D9F96309BCCE54E5, Free tier
- `kiroku license` — "No license key found", Machine ID displayed

### Step 3: Create LS Discount Code (KIROKUBETA)

Created via LS REST API:

```
POST /v1/discounts
- code: KIROKUBETA
- amount: 100 (percent)
- duration: once
- max_redemptions: 10
- is_limited_to_products: true (variant 1379562)
```

Result: **PASS** — Discount ID: 968320, status: published, test_mode: true

### Step 4: Purchase with Discount ($0)

Created checkout via API with discount code pre-applied.

**First attempt failed**: "A processing error occurred" with Taiwan billing address ("326" as zip code).

**Second attempt succeeded**: Used US billing address (country: US, zip: 94105).

New license key: `7B64CD47-F33B-4345-BE8B-B58245E2E579`

Result: **PASS** (with workaround for billing address)

### Step 5: Activate Pro Tier

```bash
kiroku activate 7B64CD47-F33B-4345-BE8B-B58245E2E579
```

Output:
```
Activating license...
  Machine ID: D9F96309BCCE54E5
  Activated: pro tier
  Instance ID: 4fe9d4bb-7d9d-4967-aaae-49968e2bfd98
  Testing premium prompt access...
  Prompt: OK (3872 chars)
```

Verification:
- `kiroku license` → Tier: pro, Licensed: true, Embedding: enabled
- `kiroku doctor` → [OK] License valid (tier: pro)
- Premium prompt fetched from CF Worker (3872 chars)
- instanceId preserved in offline state after getLicenseState() call

Result: **PASS**

### Step 6: Deactivate → Free Tier

```bash
kiroku deactivate
```

Output:
```
Deactivating license...
  Deactivated, reverted to free tier
```

Verification:
- `kiroku license` → "No license key found"
- LS API validate: activation_usage=0/1 (properly deactivated on LS side)
- Local files cleaned: license.key, license-offline.json, prompt cache

Result: **PASS**

---

## Bugs Found & Fixed

### Bug 1: CLI Bundle Missing (Critical)

**Symptom**: `kiroku init` fails after `npm install -g` with:
```
Error: Cannot find module '.../src/shared/paths.js'
```

**Root Cause**: `bin/kiroku.js` uses lazy `import('../src/shared/paths.js')` etc., but npm pack excludes `src/` (only ships `dist/`). The CLI entry point was never bundled.

**Fix**:
- Added `bin/kiroku.js → dist/cli.cjs` as 4th esbuild entry in `build.mjs`
- Changed `package.json` bin to `"kiroku": "dist/cli.cjs"`
- Added CJS fallback for `import.meta.url` (undefined in CJS): uses `__filename` instead

### Bug 2: CJS import.meta.url Crash

**Symptom**: `node dist/cli.cjs` crashes with:
```
TypeError: The "path" argument must be of type string. Received undefined
```

**Root Cause**: `import.meta.url` is `undefined` in esbuild CJS output, causing `fileURLToPath(undefined)` to throw.

**Fix**: Replaced `const __dirname = dirname(fileURLToPath(import.meta.url))` with:
```javascript
const __curdir = (() => {
  try { if (import.meta.url) return dirname(fileURLToPath(import.meta.url)); } catch {}
  try { return dirname(__filename); } catch {}  // CJS fallback
  return process.cwd();
})();
```

### Bug 3: instanceId Overwritten by getLicenseState()

**Symptom**: `kiroku deactivate` sends `instance_id: "unknown"` to LS API because instanceId is missing from offline state.

**Root Cause**: `saveOfflineState()` in `license-state.js` overwrites the entire file. `cmdActivate` saves `{instanceId, ...}`, but `getLicenseState()` subsequently calls `saveOfflineState()` with a state object that doesn't include `instanceId`.

**Fix**: Changed `saveOfflineState()` to merge with existing state:
```javascript
function saveOfflineState(state) {
  const existing = loadOfflineState() || {};
  writeFileSync(OFFLINE_LICENSE_PATH, JSON.stringify({
    ...existing,  // preserves instanceId from activate
    ...state,
    validatedAt: Date.now(),
  }));
}
```

---

## LS Checkout Issue

**Symptom**: Test card `4242 4242 4242 4242` fails with "A processing error occurred" when billing address uses Taiwan/short zip code.

**Workaround**: Use US billing address with valid 5-digit zip (e.g., 94105).

**Analysis**: The product is a subscription ($9.99/month) with 100% one-time discount. Even though total is $0 now, Stripe still validates + stores the card for future charges. Taiwan billing address with 3-digit zip may not pass Stripe's address validation in test mode.

**Not a Kiroku code issue** — this is LS/Stripe platform behavior.

---

## Unit Test Suite

All 145 tests pass after the fixes:

```
 ✓ test/worker/prompt-loader.test.js (10 tests)
 ✓ test/shared/ids.test.js (18 tests)
 ✓ test/worker/prompt-crypto.test.js (10 tests)
 ✓ test/proxy/md-logger.test.js (4 tests)
 ✓ test/mcp/sql-sandbox.test.js (17 tests)
 ✓ test/shared/redact.test.js (12 tests)
 ✓ test/cli/transcript-converter.test.js (6 tests)
 ✓ test/integration/e2e.test.js (11 tests)
 ✓ test/shared/md-format.test.js (12 tests)
 ✓ test/license/license-state-ls.test.js (13 tests)
 ✓ test/proxy/classifier.test.js (11 tests)
 ✓ test/integration/build.test.js (21 tests)

Test Files  12 passed (12)
     Tests  145 passed (145)
  Duration  673ms
```

---

## Published Version

**@kiroku/cli@1.0.1** published to npm with all 3 fixes.

Commit: `6dc950f fix: CLI bundle for npm, preserve instanceId on license state save`

### Files Changed
- `bin/kiroku.js` — CJS-compatible __dirname derivation
- `build.mjs` — Added CLI as 4th esbuild entry
- `package.json` — bin → dist/cli.cjs, version 1.0.1
- `src/license/license-state.js` — saveOfflineState merges existing state

---

## Key Reference Data

| Item | Value |
|------|-------|
| Test license key (old) | BEA49944-B02B-41E9-A808-C12AD3A68BA6 |
| Test license key (new, from discount) | 7B64CD47-F33B-4345-BE8B-B58245E2E579 |
| Discount code | KIROKUBETA (100% off, 10 uses, ID: 968320) |
| Machine ID | D9F96309BCCE54E5 |
| CF Worker | kiroku-api.twampd.workers.dev |
| Premium prompt | 3872 chars (v1.1) |
| npm account | dawdle (@kiroku org) |
