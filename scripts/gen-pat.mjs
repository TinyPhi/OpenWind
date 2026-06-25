#!/usr/bin/env node
// gen-pat.mjs — runs inside the ow-zita-setup container.
//
// How it works:
//   Automates the Zitadel Login UI v1 form flow (the same steps a human takes in
//   a browser) to obtain an OAuth2 access token for the admin user, then uses the
//   Management API to create a Personal Access Token (PAT). No Docker socket,
//   no Sessions API auth chicken-and-egg problem.
//
//   Flow:
//   1. GET /ui/console/assets/environment.json → console clientId
//   2. PKCE code verifier + challenge
//   3. GET /oauth/v2/authorize → Login UI v1 loginname form (with cookies)
//   4. POST /ui/login/loginname  → password form
//   5. POST /ui/login/password   → intermediate pages handled in loop:
//        • MFA prompt (/ui/login/mfa/prompt) — skipped automatically
//        • Change password (/ui/login/password/change) — satisfied with same credential
//      → eventually 302 redirect to callback with ?code=...
//   6. POST /oauth/v2/token (authorization_code + code_verifier) → access_token
//   7. POST /management/v1/users/machine → create machine user (PATs are machine-user-only)
//   8. POST /admin/v1/members → grant IAM_OWNER to machine user
//   9. POST /management/v1/users/${machineUserId}/pats → PAT token
//  10. Write PAT to /app/output/pat.txt for the host setup script to read

import { request as nodeRequest }         from 'node:http'
import { createHash, randomBytes }        from 'node:crypto'
import { writeFileSync, mkdirSync }       from 'node:fs'

const ZITADEL_HOST   = 'zitadel'
const ZITADEL_PORT   = 8080
const HOST_HEADER    = process.env.ZITADEL_EXTERNALDOMAIN ?? 'localhost'
// When ExternalSecure=true the public URL is HTTPS on the standard port (443) via a
// reverse proxy — the redirect URI must match what Zitadel exposes to browsers.
const ZITADEL_SECURE = process.env.ZITADEL_EXTERNALSECURE === 'true'
const ADMIN_LOGIN    = 'owZitadelAdmin@openwind.local'
const ADMIN_PASS     = process.env.ZITADEL_ADMIN_PASSWORD ?? fail('ZITADEL_ADMIN_PASSWORD env var is required')
const PAT_EXPIRY     = '2030-01-01T00:00:00Z'
const REDIRECT_URI   = ZITADEL_SECURE
  ? `https://${HOST_HEADER}/ui/console/auth/callback`
  : `http://${HOST_HEADER}:${ZITADEL_PORT}/ui/console/auth/callback`

// ── ANSI colours ─────────────────────────────────────────────────────────────
const G = '\x1b[32m', C = '\x1b[36m', B = '\x1b[1m', R = '\x1b[0m', D = '\x1b[2m'
function log(msg)   { console.log(msg) }
function ok(msg)    { console.log(`  ${G}✓${R}  ${msg}`) }
function info(msg)  { console.log(`  ${D}→${R}  ${msg}`) }
function fail(msg)  { console.error(`\n  \x1b[31m✗\x1b[0m  ${msg}\n`); process.exit(1) }

// ── Cookie jar ────────────────────────────────────────────────────────────────

const cookies = new Map()   // name → value

function storeCookies(setCookieHeaders) {
  if (!setCookieHeaders) return
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]
  for (const header of list) {
    const parts = header.split(';')[0].trim()
    const eq = parts.indexOf('=')
    if (eq > 0) cookies.set(parts.slice(0, eq).trim(), parts.slice(eq + 1).trim())
  }
}

function cookieString() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function rawRequest(method, path, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body, 'utf8') : null
    const req = nodeRequest(
      {
        hostname: ZITADEL_HOST,
        port: ZITADEL_PORT,
        path,
        method,
        headers: {
          Host: HOST_HEADER,
          Cookie: cookieString(),
          ...extraHeaders,
          ...(bodyBuf ? { 'Content-Length': String(bodyBuf.length) } : {}),
        },
      },
      (res) => {
        const setCookieHdr = res.headers['set-cookie']
        storeCookies(setCookieHdr)
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }))
      }
    )
    req.setTimeout(20_000, () => req.destroy(new Error('Request timed out')))
    req.on('error', reject)
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}

// Follow redirects, but STOP and return the location when we hit the callback URI
async function followingRequest(method, path, extraHeaders, body, maxRedirects = 10) {
  let currentMethod = method
  let currentPath   = path
  let currentBody   = body
  let currentHeaders = extraHeaders
  let depth = 0

  while (depth < maxRedirects) {
    const res = await rawRequest(currentMethod, currentPath, currentHeaders, currentBody)
    if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307) {
      const location = res.headers['location'] ?? ''
      // If Zitadel is redirecting to the callback URI, we have the auth code — stop
      if (location.includes('/auth/callback') || location.includes('code=')) {
        return { ...res, callbackLocation: location }
      }
      // Follow the redirect (303 always becomes GET)
      currentMethod  = (res.status === 303 || res.status === 302) ? 'GET' : currentMethod
      currentBody    = (currentMethod === 'GET') ? null : currentBody
      currentHeaders = (currentMethod === 'GET') ? {} : currentHeaders
      currentPath    = location.startsWith('http') ? new URL(location).pathname + new URL(location).search
                                                    : location
      depth++
      continue
    }
    return res
  }
  throw new Error('Too many redirects')
}

function jsonPost(path, token, body) {
  return rawRequest('POST', path, {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, JSON.stringify(body))
}

function assertOk(res, label) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${label} — HTTP ${res.status}: ${res.text}`)
  }
  return JSON.parse(res.text)
}

// ── Health wait ───────────────────────────────────────────────────────────────

async function waitForHealth() {
  for (let i = 1; i <= 80; i++) {
    try {
      const res = await rawRequest('GET', '/healthz', {}, null)
      if (res.status < 500) return
    } catch { /* not ready yet */ }
    if (i % 5 === 0) log(`  Still waiting for Zitadel… (${i * 3}s elapsed)`)
    await sleep(3000)
  }
  fail('Zitadel did not become healthy after 4 minutes.')
}

// ── HTML parsing helpers ──────────────────────────────────────────────────────

function extractHtmlField(html, name) {
  const re = new RegExp(`name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+value="([^"]*)"`)
  const alt = new RegExp(`value="([^"]*)"[^>]*name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
  const m = re.exec(html) ?? alt.exec(html)
  return m ? m[1] : null
}

function extractAuthId(html) {
  const m = /authRequestID[="](\d+)/i.exec(html) ?? /authRequestID" value="(\d+)"/i.exec(html)
  return m ? m[1] : null
}

// ── PKCE ──────────────────────────────────────────────────────────────────────

function generatePKCE() {
  const verifier  = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function encodeForm(obj) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
${B}${C}  OpenWind — Zitadel Setup${R}
  ${'─'.repeat(40)}
`)

  // 1. Wait for Zitadel to be healthy
  log('  ⏳  Waiting for Zitadel to be healthy…')
  await waitForHealth()
  ok('Zitadel is up')
  info('Waiting 15s for first-boot internal setup to complete…')
  await sleep(15_000)
  console.log()

  // 2. Get console client ID (available without auth from the UI bundle)
  log('  ⏳  Fetching console client ID…')
  const envRes = await rawRequest('GET', '/ui/console/assets/environment.json', {}, null)
  if (envRes.status !== 200) fail(`Could not fetch environment.json — HTTP ${envRes.status}`)
  const { clientid } = JSON.parse(envRes.text)
  if (!clientid) fail('No clientid in environment.json')
  ok(`Console client ID: ${clientid}`)
  console.log()

  // 3. OIDC Authorization Code + PKCE flow
  log('  ⏳  Starting OIDC login flow…')
  const { verifier, challenge } = generatePKCE()
  const scope     = 'openid email urn:zitadel:iam:org:project:id:zitadel:aud'
  const authorizeQS = encodeForm({
    client_id:             clientid,
    response_type:         'code',
    redirect_uri:          REDIRECT_URI,
    scope,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    nonce:                 randomBytes(8).toString('hex'),
    state:                 randomBytes(8).toString('hex'),
  })

  const loginPageRes = await followingRequest('GET', `/oauth/v2/authorize?${authorizeQS}`, {}, null)
  if (!loginPageRes.text) fail('Could not reach Zitadel login page')

  const authRequestID = extractAuthId(loginPageRes.text)
  const csrf1         = extractHtmlField(loginPageRes.text, 'gorilla.csrf.Token')
  if (!authRequestID) fail(`Could not find authRequestID in login page HTML`)
  if (!csrf1)         fail(`Could not find CSRF token in login page HTML`)
  ok(`Login page loaded (authRequestID=${authRequestID})`)
  console.log()

  // 4. Submit login name
  log('  ⏳  Submitting login name…')
  const loginnameRes = await followingRequest(
    'POST', '/ui/login/loginname',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    encodeForm({ 'gorilla.csrf.Token': csrf1, authRequestID, loginName: ADMIN_LOGIN })
  )
  const csrf2 = extractHtmlField(loginnameRes.text ?? '', 'gorilla.csrf.Token')
  if (!csrf2) {
    const errMsg = (loginnameRes.text ?? '').match(/lgn-error-message">\s*([^<]+)/)?.[1]?.trim() ?? ''
    fail(`Password form not reached after loginname POST.${errMsg ? ` Error: ${errMsg}` : ''}\nFull URL: ${loginnameRes.headers?.['location'] ?? '(no redirect)'}`)
  }
  ok('Login name accepted')
  console.log()

  // 5. Submit password — then handle any intermediate pages Zitadel may show
  //    (MFA prompt on first login, forced password change on fresh admin user)
  log('  ⏳  Submitting password…')
  let loginRes = await followingRequest(
    'POST', '/ui/login/password',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    encodeForm({ 'gorilla.csrf.Token': csrf2, authRequestID, password: ADMIN_PASS })
  )

  for (let step = 0; step < 5; step++) {
    const pageText = loginRes.text ?? ''

    // Done — callback URI received
    if (loginRes.callbackLocation || /[?&]code=/.test(loginRes.headers?.['location'] ?? '')) break

    // MFA prompt — Zitadel offers 2FA setup on first login; skip it
    if (pageText.includes('/ui/login/mfa/prompt') || pageText.includes('mfa/prompt')) {
      const csrfMfa  = extractHtmlField(pageText, 'gorilla.csrf.Token')
      const authMfa  = extractAuthId(pageText) ?? authRequestID
      if (!csrfMfa) fail('MFA prompt page reached but no CSRF token found')
      info('Skipping MFA setup prompt…')
      loginRes = await followingRequest(
        'POST', '/ui/login/mfa/prompt',
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        encodeForm({ 'gorilla.csrf.Token': csrfMfa, authRequestID: authMfa, skip: 'true' })
      )
      continue
    }

    // Forced password change — Zitadel requires this for fresh admin users;
    // submit the same credential to satisfy the form without rotating the password
    if (pageText.includes('/ui/login/password/change') || pageText.includes('change-old-password')) {
      const csrfPw  = extractHtmlField(pageText, 'gorilla.csrf.Token')
      const authPw  = extractAuthId(pageText) ?? authRequestID
      if (!csrfPw) fail('Change-password page reached but no CSRF token found')
      info('Handling forced password change…')
      loginRes = await followingRequest(
        'POST', '/ui/login/password/change',
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        encodeForm({
          'gorilla.csrf.Token':        csrfPw,
          authRequestID:               authPw,
          'change-old-password':       ADMIN_PASS,
          'change-new-password':       ADMIN_PASS,
          'change-password-confirmation': ADMIN_PASS,
        })
      )
      continue
    }

    // Unknown intermediate page — bail with a useful diagnostic
    const title  = pageText.match(/<title>([^<]+)<\/title>/i)?.[1] ?? '(no title)'
    const errMsg = pageText.match(/lgn-error-message">\s*([^<]+)/)?.[1]?.trim() ?? ''
    fail(`Unexpected login page: "${title}"${errMsg ? ` — ${errMsg}` : ''}\nLocation: ${loginRes.headers?.['location'] ?? '(none)'}`)
  }

  const callbackLocation = loginRes.callbackLocation ?? loginRes.headers?.['location'] ?? ''
  const codeMatch = /[?&]code=([^&]+)/.exec(callbackLocation)
  if (!codeMatch) {
    const errMsg = (loginRes.text ?? '').match(/lgn-error-message">\s*([^<]+)/)?.[1]?.trim() ?? ''
    fail(`Auth code not found after login flow.${errMsg ? ` Error: ${errMsg}` : ''}\nLocation: ${callbackLocation}`)
  }
  const authCode = codeMatch[1]
  ok('Login complete, auth code received')
  console.log()

  // 6. Exchange code for access token
  log('  ⏳  Exchanging code for access token…')
  const tokenRes = await rawRequest(
    'POST', '/oauth/v2/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    encodeForm({
      grant_type:    'authorization_code',
      code:          authCode,
      redirect_uri:  REDIRECT_URI,
      client_id:     clientid,
      code_verifier: verifier,
    })
  )
  const { access_token: accessToken } = assertOk(tokenRes, 'Token exchange')
  ok('Access token obtained')
  console.log()

  // 7. Create a machine user — PATs can only be issued to machine users, not humans
  log('  ⏳  Creating machine user for API access…')
  const machineRes = await jsonPost('/management/v1/users/machine', accessToken, {
    userName:        'openwind-api-bot',
    name:            'OpenWind API Bot',
    accessTokenType: 'ACCESS_TOKEN_TYPE_BEARER',
  })
  const machineData = assertOk(machineRes, 'Create machine user')
  const machineUserId = machineData?.userId
  if (!machineUserId) fail(`No userId in machine user response: ${machineRes.text}`)
  ok(`Machine user created (ID: ${machineUserId})`)
  console.log()

  // 8. Grant IAM_OWNER at instance level so the machine user has full admin access
  log('  ⏳  Granting IAM_OWNER to machine user…')
  const memberRes = await jsonPost('/admin/v1/members', accessToken, {
    userId: machineUserId,
    roles:  ['IAM_OWNER'],
  })
  assertOk(memberRes, 'Grant IAM_OWNER')
  ok('IAM_OWNER granted')
  console.log()

  // 9. Create PAT for the machine user
  log('  ⏳  Creating Personal Access Token…')
  const patRes = await jsonPost(`/management/v1/users/${machineUserId}/pats`, accessToken, {
    expirationDate: PAT_EXPIRY,
  })
  const { token: pat } = assertOk(patRes, 'Create PAT')
  if (!pat) fail(`No token field in PAT response: ${patRes.text}`)
  ok('PAT created')
  console.log()

  // 10. Write PAT to output file — setup script reads it from the host
  mkdirSync('/app/output', { recursive: true })
  writeFileSync('/app/output/pat.txt', pat, { encoding: 'utf8' })
  ok('PAT written to output — handing control back to setup script…')
  console.log()
}

main().catch(err => {
  console.error(`\n  \x1b[31m✗\x1b[0m  ${err.message}\n`)
  process.exit(1)
})
