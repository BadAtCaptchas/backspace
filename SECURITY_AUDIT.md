# Security Audit — Backspace

Date: 2026-07-06
Scope: static review of the Node/Fastify server, React/Vite web app, Electron desktop shell, Docker runtime, and dependency manifests in this repository. This was not a penetration test and did not include a live production deployment review.

## Executive summary

Backspace has several good security foundations: password hashes use bcrypt, JWT verification pins HS256, deleted users and password-change token revocation are checked centrally, Electron disables Node integration and enables context isolation/sandboxing, and uploaded files are served with `nosniff`, a restrictive per-file CSP, and forced download for SVG/non-media files.

The highest-risk items found are configuration and hardening gaps rather than an obvious unauthenticated remote-code-execution bug. The most important remediation is tightening cross-origin API access for browser clients and adding global browser security headers for the API and SPA. The second priority is making upload range handling robust against malformed ranges so attackers cannot cheaply trigger stream errors or expensive invalid reads.

## Findings

### 1. Permissive CORS reflects every Origin while credentials are enabled

**Severity:** Medium  
**Area:** Server startup / API exposure  
**Evidence:** `packages/server/src/index.ts` registers `@fastify/cors` with `origin: true` and `credentials: true` for all API routes.

**Why this matters:** Any website can issue cross-origin requests to a Backspace instance and receive readable responses if it can provide a bearer token. The app stores bearer tokens in browser storage, so normal browser same-origin rules prevent a random site from reading the token directly. However, permissive readable CORS still reduces defense-in-depth, increases impact if a token is leaked through any XSS/browser-extension/referrer/logging path, and makes it easier for malicious sites to interact with self-hosted instances from victims' browsers.

**Recommendation:** Add a configurable allowlist, for example `CORS_ALLOWED_ORIGINS`, and default production deployments to the instance origin plus explicitly configured federation/client origins. If fully open CORS is required for federation endpoints, scope it narrowly to the Tus/federation routes instead of all routes.

### 2. No global security headers for API and SPA responses

**Severity:** Medium  
**Area:** Server startup / browser hardening  
**Evidence:** Uploaded files receive security headers in `packages/server/src/routes/uploads.ts`, but the Fastify app does not register global security headers for normal API responses or the built SPA in `packages/server/src/index.ts`.

**Why this matters:** Without headers such as `Content-Security-Policy`, `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors`, and cross-origin isolation/resource policies where appropriate, the deployed web client has weaker protection against XSS impact, clickjacking, MIME confusion, and information leakage through referrers.

**Recommendation:** Register a centralized security-header hook or `@fastify/helmet`. Start with a report-only CSP if the current frontend needs tuning, then enforce it. At minimum, set `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` or `strict-origin-when-cross-origin`, `X-Frame-Options: DENY` or CSP `frame-ancestors 'none'`, and a production CSP matching the Vite bundle's actual asset needs.

### 3. Uploaded-file Range requests are not validated before streaming

**Severity:** Low to Medium  
**Area:** Upload serving  
**Evidence:** `packages/server/src/routes/uploads.ts` parses `Range` by splitting and `parseInt`, then directly sets response headers and creates a read stream using the parsed `start` and `end` values.

**Why this matters:** Malformed, negative, non-numeric, inverted, or out-of-bounds ranges can produce incorrect `206` responses, create stream errors, or cause unnecessary work. While this is not a direct data exposure because paths are basenamed and files remain inside the upload directory, it is a robustness and denial-of-service hardening issue on a public file-serving route.

**Recommendation:** Validate ranges according to RFC 9110 semantics. Reject invalid ranges with `416 Range Not Satisfiable` and `Content-Range: bytes */<size>`. Clamp open-ended ranges to the file size and reject multiple ranges unless explicitly supported.

### 4. JWT lifetime defaults to 30 days for bearer tokens kept in browser storage

**Severity:** Low to Medium  
**Area:** Authentication/session management  
**Evidence:** `packages/server/src/config.ts` defaults `JWT_EXPIRES_IN` to `30d`, and the web client stores/removes `backspace_token` in `localStorage` from `packages/web/src/api/client.ts`.

**Why this matters:** A 30-day bearer token in `localStorage` increases persistence if a token is stolen via XSS, malicious extension, local malware, backup leakage, or copied browser profile. The server does revoke tokens issued before a password change, which helps, but normal logout cannot invalidate already copied JWTs unless additional server-side session state exists.

**Recommendation:** Consider shorter access-token lifetimes with refresh-token rotation stored in `HttpOnly; Secure; SameSite` cookies, or add server-side session IDs/JWT IDs that can be revoked on logout. If keeping stateless JWTs, document the risk and recommend a shorter `JWT_EXPIRES_IN` for exposed deployments.

### 5. Electron opens arbitrary HTTP(S) links externally from untrusted renderer content

**Severity:** Low  
**Area:** Desktop shell  
**Evidence:** `packages/desktop/src/main.ts` routes `http://` and `https://` window-open/navigation URLs to `shell.openExternal`.

**Why this matters:** Opening untrusted links in the system browser is safer than loading them inside Electron, but it can still enable phishing or platform URL-handler abuse if users are tricked into clicking attacker-controlled links. The current code restricts to HTTP(S), which avoids the most dangerous custom-protocol cases.

**Recommendation:** Keep the HTTP(S)-only restriction, add explicit user confirmation for less-trusted origins if feasible, and ensure internal app/deep-link routing cannot be confused with attacker-controlled origins.

## Positive controls observed

- Password hashing uses bcrypt with 12 salt rounds.
- JWT verification pins HS256 and checks user existence/deletion and password-change revocation.
- Admin-only authorization is centralized through `requireAdmin`.
- Electron renderer hardening is enabled with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Upload serving basenames requested paths, sets `X-Content-Type-Options: nosniff`, applies a restrictive uploaded-file CSP, and forces download for SVG and non-media files.
- `JWT_SECRET` must be at least 32 characters at startup.

## Checks performed

- Reviewed security-sensitive patterns: auth, JWTs, uploads, CORS, Electron `webPreferences`, IPC, external URL opening, local/session storage, and dangerous DOM APIs.
- Reviewed dependency manifests and attempted a production dependency audit. The registry audit endpoint returned 403 in this environment, so dependency vulnerability status remains unresolved.

## Suggested next steps

1. Implement configurable CORS allowlisting and route-scoped exceptions for federation/Tus if required.
2. Add global security headers and tune an enforceable CSP for the SPA.
3. Harden upload range handling with explicit 416 responses for invalid ranges.
4. Re-run dependency audit in CI or an environment with registry audit access.
5. Consider moving auth sessions away from long-lived localStorage bearer tokens.
