/**
 * SOCIAL PHIX — SELF-HOSTED WAITLIST
 * ===============================================================
 * Signup, email verification, referral codes, referral counting
 * and spam prevention. No LaunchList, no automation limits.
 *
 *   Cloudflare KV   stores everyone (free)
 *   Resend          sends the two emails (free: 3,000/month)
 *   Kit             optional — keeps your list for broadcasts later
 *
 * The emails are written and sent by this worker, so they carry
 * no third-party branding and match your site exactly.
 *
 * ---------------------------------------------------------------
 * WHAT TO SET UP IN CLOUDFLARE (see SETUP-GUIDE.md)
 *
 *   KV namespace bound as:  DB
 *
 *   Secrets:
 *     RESEND_API_KEY   resend.com -> API Keys
 *     SHARED_SECRET    any long random string you invent
 *     KIT_API_KEY      optional. Leave unset to skip Kit entirely.
 *
 * ---------------------------------------------------------------
 * URLS THIS WORKER ANSWERS
 *
 *   POST /signup                  your form posts here
 *   GET  /verify?t=TOKEN          the link in the confirmation email
 *   GET  /stats?code=CODE         live referral count for the tracker
 *   GET  /admin?token=SECRET      your signup numbers
 *   GET  /setup?token=SECRET      optional, only if you use Kit
 *
 * ---------------------------------------------------------------
 * HOW A SIGNUP FLOWS
 *
 *   1. Form posts to /signup
 *   2. Worker checks it isn't spam, saves them,
 *      and emails them a confirmation link
 *   3. They click it -> /verify
 *   4. Worker verifies them, issues a referral code,
 *      credits whoever referred them, emails them the welcome
 *   5. Redirects to your tracker page
 */

// Bump this whenever you paste in new code, so /  tells you at a glance
// whether what's deployed is what you think is deployed.
const VERSION = "2026-07-25.d";

// Pasted secrets often pick up a trailing space or newline that you
// can't see in the dashboard. Trim before use.
const trim = v => (typeof v === "string" ? v.trim() : v);

const SITE = "https://www.socialphix.com";
const KIT  = "https://api.kit.com/v4";
const RESEND = "https://api.resend.com/emails";

// Change this once your domain is verified in Resend.
// Until then Resend only allows sending to your own address.
const FROM = "Shady at Social Phix <shady@socialphix.com>";
const REPLY_TO = "shady@socialphix.com";

const TAG_PENDING  = "waitlist-pending";
const TAG_VERIFIED = "waitlist-verified";

const MAX_SIGNUPS_PER_IP_PER_HOUR = 3;
const PENDING_TTL_SECONDS = 60 * 60 * 24 * 7; // unconfirmed signups expire after 7 days

// Kit converts each label to a lowercase underscored key.
const FIELD_LABELS = [
  "Referral Code", "Verify Url", "Users Referred", "Email Verified",
  "Referred By Code", "Selected Pack", "Use Case",
  "Price Reaction", "Utm Source", "Utm Medium", "Utm Campaign",
  "Country Code", "City",
];

// Throwaway inbox providers. Signups from these are rejected outright.
const DISPOSABLE = new Set([
  "mailinator.com","guerrillamail.com","10minutemail.com","tempmail.com",
  "temp-mail.org","throwawaymail.com","yopmail.com","trashmail.com",
  "sharklasers.com","getnada.com","dispostable.com","fakeinbox.com",
  "maildrop.cc","mytemp.email","tempinbox.com","spamgourmet.com",
  "mailnesia.com","emailondeck.com","burnermail.io","tempr.email",
  "moakt.com","luxusmail.org","inboxkitten.com","mohmal.com",
]);

let tagCache = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    try {
      if (path === "/signup" && request.method === "POST") return cors(await signup(request, env));
      if (path === "/verify") return await verify(url, env);
      if (path === "/stats")  return cors(await stats(url, env));

      // Protected routes
      if (path === "/setup" || path === "/admin" || path === "/test-email" || path === "/health") {
        if (url.searchParams.get("token") !== trim(env.SHARED_SECRET) || !env.SHARED_SECRET) {
          return new Response("Unauthorized. Check your token.", { status: 401 });
        }
        if (path === "/setup")  return runSetup(env);
        if (path === "/admin")  return adminView(env);
        if (path === "/health") return healthCheck(env);
        return testEmail(url, env);
      }

      return indexPage(url);
    } catch (err) {
      console.error("ERROR:", err.stack || err.message);
      const friendly = /Resend/i.test(err.message)
        ? "We couldn't send your confirmation email. Please try again shortly."
        : "Something went wrong on our end.";
      return cors(json({ ok: false, error: friendly, detail: err.message }, 500));
    }
  },
};

/* ==================== 1. SIGNUP ==================== */

async function signup(request, env) {
  const form = await readBody(request);

  const email = String(form.email || "").trim().toLowerCase();
  const name  = titleCase(form.name || "");
  const ref   = String(form.ref   || "").trim().toUpperCase();

  // --- Validation -------------------------------------------------
  if (!isEmail(email)) {
    return json({ ok: false, error: "That doesn't look like a valid email address." }, 400);
  }

  const domain = email.split("@")[1];
  if (DISPOSABLE.has(domain)) {
    console.log("blocked disposable:", email);
    return json({ ok: false, error: "Please use a permanent email address." }, 400);
  }

  // --- Rate limit by IP -------------------------------------------
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = `rate:${ip}`;
  const attempts = parseInt(await env.DB.get(rateKey), 10) || 0;

  if (attempts >= MAX_SIGNUPS_PER_IP_PER_HOUR) {
    console.log("rate limited:", ip);
    return json({ ok: false, error: "Too many signups from this connection. Try again later." }, 429);
  }
  await env.DB.put(rateKey, String(attempts + 1), { expirationTtl: 3600 });

  // --- Already known? ---------------------------------------------
  const existingRaw = await env.DB.get(`sub:${email}`);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    if (existing.verified) {
      // Already confirmed — just hand back their code.
      return json({ ok: true, alreadyVerified: true, code: existing.code });
    }
    // Signed up but never confirmed. Send a fresh link rather than a duplicate record.
    const token = newToken();
    await env.DB.put(`pending:${token}`, email, { expirationTtl: PENDING_TTL_SECONDS });

    const link = verifyUrl(request, token);
    await sendEmail(env, { to: email, ...confirmationEmail(existing.name, link) });
    await pushToKit(env, email, existing.name, { verify_url: link }, TAG_PENDING);

    return json({ ok: true, resent: true });
  }

  // --- New signup --------------------------------------------------
  const record = {
    email,
    name,
    verified: false,
    referrals: 0,
    referredBy: ref || null,
    signupIp: ip,
    createdAt: new Date().toISOString(),
    selectedPack:  form.selectedPack  || null,
    useCase:       form.useCase       || null,
    priceReaction: form.priceReaction || null,
    country: request.cf?.country || null,
    city:    request.cf?.city    || null,
    utmSource:   form.utm_source   || null,
    utmMedium:   form.utm_medium   || null,
    utmCampaign: form.utm_campaign || null,
  };

  const token = newToken();
  await env.DB.put(`sub:${email}`, JSON.stringify(record));
  await env.DB.put(`pending:${token}`, email, { expirationTtl: PENDING_TTL_SECONDS });

  const link = verifyUrl(request, token);

  // Send the confirmation before anything optional, so a Kit problem
  // can never stop someone from being able to confirm.
  await sendEmail(env, { to: email, ...confirmationEmail(name, link) });

  await pushToKit(env, email, name, {
    verify_url:     link,
    email_verified: "false",
    users_referred: "0",
    referred_by_code: ref || "",
    selected_pack:  record.selectedPack  || "",
    use_case:       record.useCase       || "",
    price_reaction: record.priceReaction || "",
    utm_source:     record.utmSource     || "",
    utm_medium:     record.utmMedium     || "",
    utm_campaign:   record.utmCampaign   || "",
    country_code:   record.country       || "",
    city:           record.city          || "",
  }, TAG_PENDING);

  console.log("signup:", email, ref ? `(referred by ${ref})` : "");
  return json({ ok: true });
}

/* ==================== 2. VERIFY ==================== */

async function verify(url, env) {
  const token = url.searchParams.get("t");
  if (!token) return redirect(`${SITE}/success.html?error=missing`);

  const email = await env.DB.get(`pending:${token}`);
  if (!email) {
    // Expired, already used, or made up.
    return redirect(`${SITE}/success.html?error=expired`);
  }

  const raw = await env.DB.get(`sub:${email}`);
  if (!raw) return redirect(`${SITE}/success.html?error=notfound`);

  const sub = JSON.parse(raw);

  // Already verified? Send them straight to their tracker.
  if (sub.verified && sub.code) {
    await env.DB.delete(`pending:${token}`);
    return redirect(`${SITE}/success.html?ref=${sub.code}`);
  }

  // --- Issue their referral code ----------------------------------
  const code = await uniqueCode(env);
  sub.verified   = true;
  sub.code       = code;
  sub.verifiedAt = new Date().toISOString();

  await env.DB.put(`sub:${email}`, JSON.stringify(sub));
  await env.DB.put(`code:${code}`, email);
  await env.DB.delete(`pending:${token}`);

  // --- Credit whoever referred them -------------------------------
  if (sub.referredBy) {
    await creditReferrer(env, sub.referredBy, email, sub.signupIp);
  }

  // Welcome email carries their referral link.
  try {
    await sendEmail(env, { to: email, ...welcomeEmail(sub.name, code) });
  } catch (err) {
    // Don't block the redirect — they still land on the tracker,
    // which shows the same link.
    console.error("welcome email failed:", err.message);
  }

  await pushToKit(env, email, sub.name, {
    referral_code:  code,
    email_verified: "true",
  }, TAG_VERIFIED);

  console.log("verified:", email, "code:", code);
  return redirect(`${SITE}/success.html?ref=${code}`);
}

async function creditReferrer(env, refCode, newEmail, newIp) {
  const referrerEmail = await env.DB.get(`code:${refCode}`);
  if (!referrerEmail) return;

  // Don't let people refer themselves.
  if (referrerEmail === newEmail) {
    console.log("self-referral blocked:", newEmail);
    return;
  }

  const raw = await env.DB.get(`sub:${referrerEmail}`);
  if (!raw) return;

  const referrer = JSON.parse(raw);

  // Same machine signing up twice doesn't count either.
  if (referrer.signupIp && newIp && referrer.signupIp === newIp) {
    console.log("same-IP referral blocked:", referrerEmail, "->", newEmail);
    return;
  }

  referrer.referrals = (referrer.referrals || 0) + 1;
  await env.DB.put(`sub:${referrerEmail}`, JSON.stringify(referrer));

  // Push the new count to Kit so milestone automations can fire.
  await pushToKit(env, referrerEmail, referrer.name, {
    users_referred: String(referrer.referrals),
  });

  console.log("credited:", referrerEmail, "now at", referrer.referrals);
}

/* ==================== 3. LIVE STATS ==================== */

async function stats(url, env) {
  const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return json({ ok: false, error: "no code" }, 400);

  const email = await env.DB.get(`code:${code}`);
  if (!email) return json({ ok: false, error: "unknown code" }, 404);

  const raw = await env.DB.get(`sub:${email}`);
  if (!raw) return json({ ok: false, error: "unknown code" }, 404);

  const sub = JSON.parse(raw);
  return json({
    ok: true,
    referrals: sub.referrals || 0,
    firstName: firstNameOf(sub.name),
  });
}

/* ==================== 4. KIT ==================== */

async function pushToKit(env, email, name, fields, tagName) {
  // Kit is optional. If no key is set, or the call fails, we carry on —
  // the waitlist itself doesn't depend on it.
  if (!env.KIT_API_KEY) return;

  try {
    const clean = Object.fromEntries(
      Object.entries(fields || {})
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => [k, String(v)])
    );

    const res = await kit("POST", "/subscribers", env, {
      email_address: email,
      first_name: firstNameOf(name) || undefined,
      state: "active",
      fields: clean,
    });

    if (res.warnings?.length) {
      console.warn("Kit ignored fields:", res.warnings.join(", "), "— run /setup");
    }

    if (tagName) await applyTag(env, tagName, email);
  } catch (err) {
    console.warn("Kit sync failed (continuing anyway):", err.message);
  }
}

async function kit(method, path, env, body) {
  if (!env.KIT_API_KEY) throw new Error("KIT_API_KEY secret is not set");

  const res = await fetch(KIT + path, {
    method,
    headers: {
      "X-Kit-Api-Key": trim(env.KIT_API_KEY),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Kit ${path} ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return {}; }
}

async function applyTag(env, tagName, email) {
  if (!tagCache) {
    const res = await kit("GET", "/tags", env);
    tagCache = {};
    for (const t of res.tags || []) tagCache[t.name] = t.id;
  }
  const id = tagCache[tagName];
  if (!id) {
    console.warn(`Tag "${tagName}" missing in Kit — run /setup`);
    return;
  }
  return kit("POST", `/tags/${id}/subscribers`, env, { email_address: email });
}

/* ==================== 5. SETUP ==================== */

async function runSetup(env) {
  const made = [], problems = [];

  for (const label of FIELD_LABELS) {
    try {
      const r = await kit("POST", "/custom_fields", env, { label });
      made.push([label, r.custom_field?.key || "?"]);
    } catch (e) { problems.push(`Field "${label}": ${e.message}`); }
  }

  for (const name of [TAG_PENDING, TAG_VERIFIED]) {
    try {
      await kit("POST", "/tags", env, { name });
      made.push([`Tag: ${name}`, "created"]);
    } catch (e) {
      if (/exist|taken|already/i.test(e.message)) made.push([`Tag: ${name}`, "already there"]);
      else problems.push(`Tag "${name}": ${e.message}`);
    }
  }

  tagCache = null;

  return html(`
    <h1>Kit setup complete</h1>
    ${problems.length
      ? `<h2 class="bad">Problems</h2><ul>${problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>`
      : `<p class="good">No problems. Everything is ready.</p>`}
    <h2>Created in Kit</h2>
    <table>${made.map(([a, b]) => `<tr><td>${esc(a)}</td><td><code>${esc(b)}</code></td></tr>`).join("")}</table>
    <div class="note"><strong>Done here.</strong> Next: build your two Kit automations
    (see <code>emails.md</code>), then test a real signup.</div>
  `);
}

/* ==================== 6. ADMIN ==================== */

async function adminView(env) {
  const list = await env.DB.list({ prefix: "sub:" });

  let verified = 0, pending = 0, referred = 0;
  const top = [];
  const packs = {}, prices = {};

  for (const key of list.keys) {
    const raw = await env.DB.get(key.name);
    if (!raw) continue;
    const s = JSON.parse(raw);

    if (s.verified) verified++; else pending++;
    if (s.referredBy) referred++;
    if (s.referrals > 0) top.push([s.email, s.referrals]);

    if (s.selectedPack)  packs[s.selectedPack]   = (packs[s.selectedPack] || 0) + 1;
    if (s.priceReaction) prices[s.priceReaction] = (prices[s.priceReaction] || 0) + 1;
  }

  top.sort((a, b) => b[1] - a[1]);
  const total = verified + pending;
  const rate = total ? Math.round((verified / total) * 100) : 0;

  const breakdown = (title, obj) => {
    const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return "";
    return `<h2>${title}</h2><table>${rows
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td><strong>${v}</strong></td></tr>`).join("")}</table>`;
  };

  return html(`
    <h1>Waitlist</h1>
    <table>
      <tr><td>Confirmed</td><td><strong>${verified}</strong></td></tr>
      <tr><td>Awaiting confirmation</td><td><strong>${pending}</strong></td></tr>
      <tr><td>Confirmation rate</td><td><strong>${rate}%</strong></td></tr>
      <tr><td>Came via a referral</td><td><strong>${referred}</strong></td></tr>
    </table>
    ${breakdown("Pack chosen", packs)}
    ${breakdown("Reaction to $7 a bottle", prices)}
    ${top.length ? `<h2>Top referrers</h2><table>${top.slice(0, 20)
      .map(([e, n]) => `<tr><td>${esc(e)}</td><td><strong>${n}</strong></td></tr>`).join("")}</table>` : ""}
    <div class="note">Watch the pack split and the price reaction — those two tell you
    whether $56 is the right ask.</div>
  `);
}

/* ==================== INDEX ==================== */

/**
 * The catch-all. Shows which version is deployed and every route
 * available, so an unknown path never looks like a mystery.
 */
function indexPage(url) {
  const token = url.searchParams.get("token") || "YOUR_SECRET";
  const base = url.origin;
  const link = p => `${base}${p}`.replace("YOUR_SECRET", token);

  const routes = [
    ["/health?token=" + token,     "Check everything at once", true],
    ["/test-email?token=" + token + "&to=you@example.com", "Send one test email", true],
    ["/admin?token=" + token,      "Your signup numbers", true],
    ["/setup?token=" + token,      "Create Kit fields (only if using Kit)", true],
    ["/signup",                    "POST only — your form posts here", false],
    ["/verify?t=TOKEN",            "The link in the confirmation email", false],
    ["/stats?code=CODE",           "Referral count for the tracker", false],
  ];

  const rows = routes.map(([p, desc, clickable]) => {
    const cell = clickable
      ? `<a href="${esc(link(p))}"><code>${esc(p.split("?")[0])}</code></a>`
      : `<code>${esc(p.split("?")[0])}</code>`;
    return `<tr><td>${cell}</td><td style="font-size:13px;color:#475569;">${esc(desc)}</td></tr>`;
  }).join("");

  return html(`
    <h1>Social Phix waitlist worker</h1>
    <p>Deployed version <code>${esc(VERSION)}</code></p>
    <div class="note">
      <strong>Seeing this page when you expected something else?</strong>
      The path you asked for isn't in the deployed code. Re-paste
      <code>waitlist-worker.js</code> in the Cloudflare editor and click
      <strong>Deploy</strong> — pasting alone doesn't publish it.
    </div>
    <h2>Routes</h2>
    <table>${rows}</table>
    ${url.searchParams.get("token")
      ? `<p style="font-size:13px;color:#475569;">Links above include your token.</p>`
      : `<p style="font-size:13px;color:#475569;">Add <code>?token=YOUR_SECRET</code> to this URL to get clickable links.</p>`}
  `);
}

/* ==================== HEALTH CHECK ==================== */

/**
 * Checks everything at once and says what's wrong.
 *   /health?token=SECRET
 *
 * The important one is the FROM-vs-verified-domain check: a domain
 * can show "verified" in Resend while your FROM address still points
 * at a different one.
 */
async function healthCheck(env) {
  const rows = [];
  const problems = [];

  const ok  = (label, detail = "") => rows.push([label, "pass", detail]);
  const bad = (label, detail) => { rows.push([label, "FAIL", detail]); problems.push(detail); };

  /* --- Worker version --- */
  ok("Worker code", "This endpoint exists, so you're running the current version");

  /* --- KV --- */
  if (!env.DB) {
    bad("KV database", "No binding called DB. Settings &rarr; Bindings &rarr; add a KV namespace named exactly DB.");
  } else {
    try {
      await env.DB.put("health:ping", "1", { expirationTtl: 60 });
      const back = await env.DB.get("health:ping");
      back === "1" ? ok("KV database", "Readable and writable")
                   : bad("KV database", "Bound but not returning data.");
    } catch (e) {
      bad("KV database", "Bound but erroring: " + esc(e.message));
    }
  }

  /* --- Secrets --- */
  env.SHARED_SECRET ? ok("SHARED_SECRET", "Set")
                    : bad("SHARED_SECRET", "Missing.");

  if (!env.RESEND_API_KEY) {
    bad("RESEND_API_KEY", "Missing. Settings &rarr; Variables and Secrets &rarr; add as a Secret.");
  } else {
    ok("RESEND_API_KEY", "Set");

    /* --- Ask Resend which domains are actually verified --- */
    try {
      const res = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${trim(env.RESEND_API_KEY)}` },
      });

      if (res.status === 401 || res.status === 403) {
        // A "Sending access" key can send mail but can't read the domain
        // list, so this is not necessarily a broken key.
        rows.push(["Resend key reads domains", "info",
          `Resend returned ${res.status} for the domain list. ` +
          `That's expected if you created a <strong>Sending access</strong> key rather than Full access — ` +
          `it can still send email fine. ` +
          `<br><br>Confirm which by running <code>/test-email</code>: if an email arrives, your key is good and you can ignore this row. ` +
          `If that also fails with 401, the key really is wrong — re-copy it from resend.com &rarr; API Keys ` +
          `(the value is only shown once, so a half-copied key is easy to end up with).`]);
        rows.push(["Verified domain", "info",
          "Can't check this without domain-read permission. <code>/test-email</code> will tell you instead."]);
      } else if (!res.ok) {
        bad("Resend API key valid", `Resend returned HTTP ${res.status}.`);
      } else {
        ok("Resend API key valid", "Accepted");

        const data = await res.json();
        const domains = data.data || [];

        if (!domains.length) {
          bad("Verified domain", "No domains on this Resend account at all. Add socialphix.com under Domains.");
        } else {
          const list = domains.map(d => `${d.name} (${d.status})`).join(", ");
          rows.push(["Domains on this account", "info", esc(list)]);

          const verified = domains.filter(d => d.status === "verified").map(d => d.name);

          // Pull the domain out of the FROM header.
          const m = FROM.match(/<([^>]+)>/);
          const fromAddr = m ? m[1] : FROM;
          const fromDomain = (fromAddr.split("@")[1] || "").toLowerCase();

          rows.push(["Sending as", "info", esc(fromAddr)]);

          if (!verified.length) {
            bad("FROM domain verified",
              `No verified domains yet. Yours show as: ${esc(list)}. Resend will only deliver to your own address until one is verified.`);
          } else if (verified.includes(fromDomain)) {
            ok("FROM domain verified", `${esc(fromDomain)} is verified`);
          } else {
            bad("FROM domain verified",
              `You're sending from <code>${esc(fromDomain)}</code> but the verified domain(s) are <code>${esc(verified.join(", "))}</code>. ` +
              `Edit <code>FROM</code> near the top of the worker so the address sits on a verified domain.`);
          }
        }
      }
    } catch (e) {
      bad("Resend reachable", "Couldn't reach Resend: " + esc(e.message));
    }
  }

  /* --- Kit (optional) --- */
  rows.push(["Kit sync", "info",
    env.KIT_API_KEY ? "Enabled" : "Skipped — optional, nothing depends on it"]);

  /* --- How many signups so far --- */
  if (env.DB) {
    try {
      const list = await env.DB.list({ prefix: "sub:", limit: 1000 });
      rows.push(["Signups stored", "info", String(list.keys.length)]);
    } catch (e) { /* already reported above */ }
  }

  const body = rows.map(([label, state, detail]) => {
    const badge = state === "pass" ? '<span class="good">PASS</span>'
                : state === "FAIL" ? '<span class="bad">FAIL</span>'
                : '<span style="color:#64748b;">—</span>';
    return `<tr><td>${label}</td><td style="text-align:center;">${badge}</td><td style="font-size:13px;color:#475569;">${detail}</td></tr>`;
  }).join("");

  // Note: rows marked "info" are not failures.
  const verdict = problems.length
    ? `<p class="bad" style="font-size:16px;">${problems.length} problem${problems.length > 1 ? "s" : ""} found — see the FAIL rows.</p>`
    : `<p class="good" style="font-size:16px;">No failures. Next step is <code>/test-email</code> — that's the only check that proves email actually sends.</p>`;

  return html(`
    <h1>Health check</h1>
    ${verdict}
    <table>${body}</table>
    <div class="note">
      Next: <code>/test-email?token=YOUR_SECRET&amp;to=you@example.com</code> actually sends one.
    </div>
  `);
}

/* ==================== EMAIL TEST ==================== */

/**
 * Isolates email sending from everything else.
 *   /test-email?token=SECRET&to=you@example.com
 * Tells you exactly what Resend said, in plain language.
 */
async function testEmail(url, env) {
  const to = (url.searchParams.get("to") || "").trim();

  if (!to) {
    return html(`<h1>Email test</h1>
      <p>Add an address to send to:</p>
      <p><code>/test-email?token=YOUR_SECRET&amp;to=you@example.com</code></p>`);
  }

  const checks = [];
  checks.push(["RESEND_API_KEY set", env.RESEND_API_KEY ? "yes" : "NO — this is your problem"]);
  checks.push(["Sending from", esc(FROM)]);
  checks.push(["Sending to", esc(to)]);

  let result, detail = "";
  try {
    const mail = confirmationEmail("Test", `${url.origin}/verify?t=TESTTOKEN`);
    const res = await fetch(RESEND, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trim(env.RESEND_API_KEY)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM, reply_to: REPLY_TO, to: [to],
        subject: "[TEST] " + mail.subject,
        html: mail.html, text: mail.text,
      }),
    });

    const bodyText = await res.text();

    if (res.ok) {
      result = "sent";
      detail = `<p class="good">Resend accepted it. Check that inbox — and the spam folder.</p>
        <p style="font-size:13px;color:#475569;">Resend's own dashboard shows delivery status for this message.</p>`;
    } else {
      result = "failed";
      let hint = "";
      if (res.status === 403 && /domain|verif/i.test(bodyText)) {
        hint = `<p><strong>Your domain isn't verified yet.</strong> Until it is, Resend only lets you
          email the address you signed up with. Go to resend.com &rarr; Domains &rarr; add
          <code>socialphix.com</code> and complete the DNS records.</p>`;
      } else if (res.status === 422) {
        hint = `<p><strong>The From address is rejected.</strong> <code>${esc(FROM)}</code> must be on a
          domain you've verified in Resend. Edit <code>FROM</code> near the top of the worker.</p>`;
      } else if (res.status === 401) {
        hint = `<p><strong>Bad API key.</strong> Re-copy it from resend.com &rarr; API Keys and re-add it
          in Cloudflare as a <em>Secret</em>.</p>`;
      }
      detail = `<p class="bad">Resend rejected it (HTTP ${res.status}).</p>${hint}
        <h2>What Resend said</h2><pre>${esc(bodyText)}</pre>`;
    }
  } catch (err) {
    result = "error";
    detail = `<p class="bad">Couldn't reach Resend at all.</p><pre>${esc(err.message)}</pre>`;
  }

  checks.push(["Result", result]);

  return html(`
    <h1>Email test</h1>
    <table>${checks.map(([k, v]) => `<tr><td>${k}</td><td><code>${v}</code></td></tr>`).join("")}</table>
    ${detail}
  `);
}

/* ==================== EMAIL (Resend) ==================== */

async function sendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY not set — no email sent to", to);
    return;
  }

  const res = await fetch(RESEND, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${trim(env.RESEND_API_KEY)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      reply_to: REPLY_TO,
      to: [to],
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
  console.log("emailed:", to, "|", subject);
}

/* ---- Shared shell so both emails look like the site ---- */

function shell(innerHtml) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background-color:#050B14;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#050B14;">
<tr><td align="center" style="padding:32px 16px;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

  <tr><td style="padding-bottom:28px;">
    <span style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;letter-spacing:-0.4px;color:#ffffff;">SOCIAL</span><span style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;letter-spacing:-0.4px;color:#FF5722;">PHIX</span>
  </td></tr>

  <tr><td style="background-color:#112240;border:1px solid #1e3a5f;border-radius:14px;padding:36px 32px;">
    ${innerHtml}
  </td></tr>

  <tr><td style="padding:26px 8px 0;">
    <p style="margin:0 0 10px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:#64748b;">
      These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.
    </p>
    <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;color:#475569;">
      &copy; 2026 PhixRx &middot; Shipping to the United States
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0;">
    <tr><td align="center" style="background-color:#FF5722;border-radius:6px;">
      <a href="${href}" style="display:inline-block;padding:15px 34px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${label}</a>
    </td></tr>
  </table>`;
}

const P = "margin:0 0 16px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#cbd5e1;";
const H = "margin:0 0 18px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;line-height:1.3;color:#ffffff;";

/* ---- Email 1: confirm your address ---- */

function confirmationEmail(name, verifyLink) {
  const hi = name ? `Hey ${escAttr(name)},` : "Hey,";

  const html = shell(`
    <p style="${P}">${hi}</p>
    <h1 style="${H}">You're one click from the list.</h1>
    <p style="${P}">Confirm your email and your personal referral link unlocks straight away.</p>
    ${button(verifyLink, "Confirm my email")}
    <p style="${P}">Every friend who joins through your link moves you up. Three of them and you skip the line entirely for the first run.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">
      <tr><td style="background-color:#0A192F;border-left:3px solid #00E5FF;border-radius:4px;padding:16px 18px;">
        <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#94a3b8;">
          Why the extra step: referrals only count once someone confirms. It keeps the whole thing honest, and it means the small first run goes to people who actually brought friends.
        </p>
      </td></tr>
    </table>

    <p style="margin:28px 0 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#ffffff;font-weight:600;">
      Shady Biskaly
    </p>
    <p style="margin:2px 0 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.55;color:#64748b;">
      R.Ph., BScPharm<br>Founder, Social Phix
    </p>

    <p style="margin:22px 0 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#475569;">
      Didn't sign up? Ignore this and nothing happens. The link expires in a week.
    </p>
  `);

  const text = `${hi}

You're one click from the Social Phix list.

Confirm your email: ${verifyLink}

Once you confirm, your personal referral link unlocks. Every friend who joins through it moves you up — three of them and you skip the line entirely for the first run.

Why the extra step: referrals only count once someone confirms. Keeps it honest, and means the small first run goes to people who actually brought friends.

Shady Biskaly
R.Ph., BScPharm
Founder, Social Phix

Didn't sign up? Ignore this. The link expires in a week.`;

  return { subject: "Confirm your email — then your link is live", html, text };
}

/* ---- Email 2: welcome, with the referral link ---- */

function welcomeEmail(name, code) {
  const hi = name ? `Hey ${escAttr(name)},` : "Hey,";
  const link = `${SITE}/?ref=${code}`;
  const tracker = `${SITE}/success.html?ref=${code}`;

  const tier = (n, title, detail) => `
    <tr>
      <td width="42" valign="top" style="padding:9px 0;">
        <div style="width:30px;height:30px;line-height:30px;text-align:center;border-radius:15px;background-color:#0A192F;border:1px solid #00E5FF;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;font-weight:800;color:#00E5FF;">${n}</div>
      </td>
      <td valign="top" style="padding:9px 0;">
        <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;">${title}</p>
        <p style="margin:2px 0 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:#94a3b8;">${detail}</p>
      </td>
    </tr>`;

  const html = shell(`
    <p style="${P}">${hi}</p>
    <h1 style="${H}">You're confirmed. Here's your link.</h1>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;">
      <tr><td style="background-color:#050B14;border:1px solid #1e3a5f;border-radius:8px;padding:18px;">
        <p style="margin:0 0 6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#00E5FF;">Share this</p>
        <a href="${link}" style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;word-break:break-all;">${link}</a>
      </td></tr>
    </table>

    <p style="${P}">Every friend who joins through it moves you up the line. And it stacks:</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;">
      ${tier(3,  "Skip the line",   "Priority spot in the first run")}
      ${tier(5,  "A free bottle",   "Added to whatever pack you order")}
      ${tier(10, "A free 3-pack",   "$24 value, on me")}
      ${tier(25, "A free 8-pack",   "$56 — a month of things that matter")}
    </table>

    ${button(tracker, "Track my referrals")}

    <p style="${P}font-size:14px;color:#94a3b8;">Referrals count once your friend confirms their email, same as you just did.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;">
      <tr><td style="border-top:1px solid #1e3a5f;padding-top:24px;">
        <p style="${P}">Worth saying why the first run is small: I'm a pharmacist who built this because nothing on the shelf worked for the moment you need to be calm <em>and</em> sharp at once. There's no warehouse behind it. So the first batch goes to the people who help get it made.</p>
        <p style="${P}">If you want the pharmacology behind the formula, <a href="${SITE}/science.html" style="color:#00E5FF;">it's all here</a>. I cited the papers, so you can check my work.</p>
      </td></tr>
    </table>

    <p style="margin:28px 0 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#ffffff;font-weight:600;">
      Shady Biskaly
    </p>
    <p style="margin:2px 0 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.55;color:#64748b;">
      R.Ph., BScPharm<br>Founder, Social Phix
    </p>

    <p style="margin:22px 0 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#475569;">
      P.S. Reply to this if you've got questions about the formula. I read everything, and I'm the one who wrote it.
    </p>
  `);

  const text = `${hi}

You're confirmed. Here's your link.

${link}

Every friend who joins through it moves you up the line. And it stacks:

  3 friends  — Skip the line. Priority spot in the first run.
  5          — A free bottle added to your order.
  10         — A free 3-pack. $24 value, on me.
  25         — A free 8-pack. $56.

Track your referrals: ${tracker}

Referrals count once your friend confirms their email, same as you just did.

---

Worth saying why the first run is small: I'm a pharmacist who built this because nothing on the shelf worked for the moment you need to be calm AND sharp at once. There's no warehouse behind it. So the first batch goes to the people who help get it made.

If you want the pharmacology behind the formula, it's all here — I cited the papers, so you can check my work: ${SITE}/science.html

Shady Biskaly
R.Ph., BScPharm
Founder, Social Phix

P.S. Reply if you've got questions about the formula. I read everything, and I'm the one who wrote it.`;

  return { subject: "You're in. Here's your link.", html, text };
}

function escAttr(s) {
  return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

/* ==================== HELPERS ==================== */

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return await request.json();
  const fd = await request.formData();
  return Object.fromEntries(fd.entries());
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

// "alex" -> "Alex", "MARY-JANE" -> "Mary-Jane", "o'brien" -> "O'Brien"
// Also collapses runs of whitespace.
function titleCase(s) {
  if (!s) return "";
  return String(s)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s\-'])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

function firstNameOf(full) {
  if (!full) return null;
  return titleCase(String(full).trim().split(/\s+/)[0]) || null;
}

function newToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

// Ambiguous characters left out on purpose, so codes survive being read aloud.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

async function uniqueCode(env) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join("");
    if (!(await env.DB.get(`code:${code}`))) return code;
  }
  throw new Error("could not generate a unique code");
}

function verifyUrl(request, token) {
  return `${new URL(request.url).origin}/verify?t=${token}`;
}

function redirect(to) {
  return new Response(null, { status: 302, headers: { Location: to } });
}

function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", SITE);
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function html(inner) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Social Phix</title>
     <style>
       body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#111}
       h1{font-size:22px}h2{font-size:16px;margin-top:28px;color:#475569}
       table{border-collapse:collapse;width:100%;margin-top:10px}
       td{border-bottom:1px solid #eee;padding:7px 4px;font-size:14px}
       td:last-child{text-align:right}
       code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-size:13px}
       .good{color:#15803d;font-weight:600}.bad{color:#b91c1c}
       .note{background:#f8fafc;border-left:3px solid #0ea5e9;padding:12px 16px;margin-top:24px;font-size:14px}
       pre{background:#f4f4f5;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
     </style>${inner}`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
