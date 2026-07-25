/**
 * SOCIAL PHIX — SELF-HOSTED WAITLIST
 * ===============================================================
 * Replaces LaunchList entirely. Handles signup, email verification,
 * referral codes, referral counting, and spam prevention.
 *
 * Kit sends the emails. This worker tells Kit when.
 * Cloudflare KV stores everyone. Free tier is plenty.
 *
 * ---------------------------------------------------------------
 * WHAT YOU NEED TO SET UP IN CLOUDFLARE (see SETUP-GUIDE.md)
 *
 *   KV namespace bound as:  DB
 *
 *   Secrets:
 *     KIT_API_KEY     Kit -> Settings -> Advanced -> API (the Key)
 *     SHARED_SECRET   any long random string you invent
 *
 * ---------------------------------------------------------------
 * URLS THIS WORKER ANSWERS
 *
 *   POST /signup                  your form posts here
 *   GET  /verify?t=TOKEN          the link in your confirmation email
 *   GET  /stats?code=CODE         live referral count for the tracker
 *   GET  /setup?token=SECRET      run once, creates Kit fields + tags
 *   GET  /admin?token=SECRET      your signup numbers at a glance
 *
 * ---------------------------------------------------------------
 * HOW A SIGNUP FLOWS
 *
 *   1. Form posts to /signup
 *   2. Worker checks it isn't spam, saves them as "pending",
 *      and tags them in Kit -> your Kit automation emails them
 *   3. They click the link -> /verify
 *   4. Worker marks them verified, generates their referral code,
 *      credits whoever referred them, tags them verified in Kit
 *      -> your Kit welcome automation fires
 *   5. Worker redirects them to your tracker page
 */

const SITE = "https://www.socialphix.com";
const KIT  = "https://api.kit.com/v4";

const TAG_PENDING  = "waitlist-pending";
const TAG_VERIFIED = "waitlist-verified";

const MAX_SIGNUPS_PER_IP_PER_HOUR = 3;
const PENDING_TTL_SECONDS = 60 * 60 * 24 * 7; // unconfirmed signups expire after 7 days

// Kit converts each label to a lowercase underscored key.
const FIELD_LABELS = [
  "Referral Code", "Verify Url", "Users Referred", "Email Verified",
  "Referred By Code", "Selected Pack", "User Group", "Use Case",
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
      if (path === "/setup" || path === "/admin") {
        if (url.searchParams.get("token") !== env.SHARED_SECRET || !env.SHARED_SECRET) {
          return new Response("Unauthorized.", { status: 401 });
        }
        return path === "/setup" ? runSetup(env) : adminView(env);
      }

      return new Response("Social Phix waitlist worker is running.", { status: 200 });
    } catch (err) {
      console.error("ERROR:", err.stack || err.message);
      return cors(json({ ok: false, error: "Something went wrong on our end." }, 500));
    }
  },
};

/* ==================== 1. SIGNUP ==================== */

async function signup(request, env) {
  const form = await readBody(request);

  const email = String(form.email || "").trim().toLowerCase();
  const name  = String(form.name  || "").trim();
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
    await pushToKit(env, email, name, { verify_url: verifyUrl(request, token) }, TAG_PENDING);
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
    userGroup:     form.userGroup     || null,
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

  await pushToKit(env, email, name, {
    verify_url:     verifyUrl(request, token),
    email_verified: "false",
    users_referred: "0",
    referred_by_code: ref || "",
    selected_pack:  record.selectedPack  || "",
    user_group:     record.userGroup     || "",
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
    firstName: (sub.name || "").split(/\s+/)[0] || null,
  });
}

/* ==================== 4. KIT ==================== */

async function pushToKit(env, email, name, fields, tagName) {
  const clean = Object.fromEntries(
    Object.entries(fields || {})
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)])
  );

  const res = await kit("POST", "/subscribers", env, {
    email_address: email,
    first_name: (name || "").split(/\s+/)[0] || undefined,
    state: "active",
    fields: clean,
  });

  if (res.warnings?.length) {
    console.warn("Kit ignored fields:", res.warnings.join(", "), "— run /setup");
  }

  if (tagName) await applyTag(env, tagName, email);
}

async function kit(method, path, env, body) {
  if (!env.KIT_API_KEY) throw new Error("KIT_API_KEY secret is not set");

  const res = await fetch(KIT + path, {
    method,
    headers: {
      "X-Kit-Api-Key": env.KIT_API_KEY,
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
  const packs = {}, groups = {}, prices = {};

  for (const key of list.keys) {
    const raw = await env.DB.get(key.name);
    if (!raw) continue;
    const s = JSON.parse(raw);

    if (s.verified) verified++; else pending++;
    if (s.referredBy) referred++;
    if (s.referrals > 0) top.push([s.email, s.referrals]);

    if (s.selectedPack)  packs[s.selectedPack]   = (packs[s.selectedPack] || 0) + 1;
    if (s.userGroup)     groups[s.userGroup]     = (groups[s.userGroup] || 0) + 1;
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
    ${breakdown("Who they are", groups)}
    ${breakdown("Reaction to $7 a bottle", prices)}
    ${top.length ? `<h2>Top referrers</h2><table>${top.slice(0, 20)
      .map(([e, n]) => `<tr><td>${esc(e)}</td><td><strong>${n}</strong></td></tr>`).join("")}</table>` : ""}
    <div class="note">Watch the pack split and the price reaction — those two tell you
    whether $56 is the right ask.</div>
  `);
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
     </style>${inner}`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
