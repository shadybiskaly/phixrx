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
const VERSION = "2026-07-27.b";

// Pasted secrets often pick up a trailing space or newline that you
// can't see in the dashboard. Trim before use.
const trim = v => (typeof v === "string" ? v.trim() : v);

const SITE = "https://www.socialphix.com";

// Browsers block cross-origin requests unless the server names the origin
// back. Anything you might load the form from needs to be in here.
const ALLOWED_ORIGINS = [
  "https://www.socialphix.com",
  "https://socialphix.com",
  "https://shadybiskaly.github.io",   // GitHub Pages default, for previewing
  "http://localhost:8080",
  "http://localhost:3000",
  "http://127.0.0.1:8080",
];
const KIT  = "https://api.kit.com/v4";
const RESEND = "https://api.resend.com/emails";

// Change this once your domain is verified in Resend.
// Until then Resend only allows sending to your own address.
const FROM = "Shady at Social Phix <shady@socialphix.com>";
const REPLY_TO = "shady@socialphix.com";

// CAN-SPAM requires a valid physical postal address in commercial email.
// A PO box registered to the business is fine. REPLACE THIS.
const POSTAL_ADDRESS = "PhixRx, [street address], [city], ON [postal code], Canada";

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

// The worker's own address, captured per request so emails can build
// links back to it without you having to configure it anywhere.
let WORKER_ORIGIN = "";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    WORKER_ORIGIN = url.origin;

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), request);

    try {
      if (path === "/signup" && request.method === "POST") return cors(await signup(request, env), request);
      if (path === "/unsubscribe") return unsubscribe(request, url, env);
      if (path === "/verify") return await verify(url, env);
      if (path === "/stats")  return cors(await stats(url, env), request);
      if (path === "/count")  return cors(await publicCount(env), request);

      // Protected routes
      if (path === "/setup" || path === "/admin" || path === "/test-email"
          || path === "/health" || path === "/export" || path === "/delete"
          || path === "/sync-kit") {
        if (!env.SHARED_SECRET || !safeEqual(url.searchParams.get("token"), trim(env.SHARED_SECRET))) {
          return new Response("Unauthorized. Check your token.", { status: 401 });
        }
        if (path === "/setup")  return runSetup(env);
        if (path === "/admin")  return adminView(env);
        if (path === "/health") return healthCheck(env);
        if (path === "/export")   return exportCsv(env);
        if (path === "/delete")   return deleteSignup(url, env);
        if (path === "/sync-kit") return syncKit(url, env);
        return testEmail(url, env);
      }

      return indexPage(url);
    } catch (err) {
      console.error("ERROR:", err.stack || err.message);
      const friendly = /Resend/i.test(err.message)
        ? "We couldn't send your confirmation email. Please try again shortly."
        : "Something went wrong on our end.";
      return cors(json({ ok: false, error: friendly, detail: err.message }, 500), request);
    }
  },
};

/* ==================== TURNSTILE ==================== */

/**
 * Verifies the Turnstile token server-side. This is the part that was
 * missing before: a Turnstile widget only protects anything if the
 * server receiving the form checks the token. Now that's us.
 *
 * Optional. If TURNSTILE_SECRET isn't set, verification is skipped
 * and the other spam rules still apply.
 */
async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: "no token" };

  const form = new FormData();
  form.append("secret", trim(env.TURNSTILE_SECRET));
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );
    const data = await res.json();
    return data.success
      ? { ok: true }
      : { ok: false, reason: (data["error-codes"] || []).join(", ") || "rejected" };
  } catch (err) {
    // Don't lock people out if Cloudflare's endpoint has a wobble.
    console.warn("Turnstile check errored, allowing through:", err.message);
    return { ok: true, degraded: true };
  }
}

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

  // --- Bot check ---------------------------------------------------
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const turnstile = await verifyTurnstile(
    form["cf-turnstile-response"], ip, env
  );
  if (!turnstile.ok) {
    console.log("turnstile rejected:", email, turnstile.reason);
    return json({ ok: false, error: "Please complete the verification and try again." }, 400);
  }

  const rateKey = `rate:${ip}`;
  const attempts = parseInt(await env.DB.get(rateKey), 10) || 0;

  if (attempts >= MAX_SIGNUPS_PER_IP_PER_HOUR) {
    console.log("rate limited:", ip);
    return json({ ok: false, error: "Too many signups from this connection. Try again later." }, 429);
  }
  await env.DB.put(rateKey, String(attempts + 1), { expirationTtl: 3600 });

  // --- Previously unsubscribed? -------------------------------------
  // Someone who opted out stays opted out. Silently re-adding them is
  // exactly the pattern that earns spam complaints and blocklistings.
  const suppressed = await env.DB.get(`unsub:${email}`);
  if (suppressed) {
    console.log("signup blocked — on the suppression list:", email);
    return json({
      ok: false,
      error: "This address was removed from our list. Email us if you'd like to rejoin.",
    }, 400);
  }

  // --- Already known? ---------------------------------------------
  const existingRaw = await env.DB.get(`sub:${email}`);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);

    if (existing.verified) {
      // Already confirmed. Rather than doing nothing silently, send their
      // welcome email again — useful for anyone who lost the link, and it
      // makes repeat testing visible instead of looking like a failure.
      let emailSent = true, emailError = null;
      try {
        await sendEmail(env, { to: email, ...welcomeEmail(existing.name, existing.code, await unsubUrl(email, env)) });
      } catch (err) {
        emailSent = false;
        emailError = err.message;
        console.error("WELCOME RESEND FAILED for", email, "->", err.message);
      }

      console.log("signup: already verified —", email,
                  emailSent ? "| welcome email resent" : "| EMAIL FAILED");

      return json({
        ok: true, alreadyVerified: true, code: existing.code,
        emailSent, emailError,
        note: "This address was already confirmed. Their link has been emailed again.",
      });
    }
    // Signed up but never confirmed. Send a fresh link rather than a duplicate record.
    const token = newToken();
    await env.DB.put(`pending:${token}`, email, { expirationTtl: PENDING_TTL_SECONDS });

    const link = verifyUrl(request, token);

    let emailSent = true, emailError = null;
    try {
      await sendEmail(env, { to: email, ...confirmationEmail(existing.name, link, await unsubUrl(email, env)) });
    } catch (err) {
      emailSent = false;
      emailError = err.message;
      console.error("RESEND OF CONFIRMATION FAILED for", email, "->", err.message);
    }

    await pushToKit(env, email, existing.name, { verify_url: link }, TAG_PENDING);

    return json({ ok: true, resent: true, emailSent, emailError });
  }

  // --- New signup --------------------------------------------------
  // Code is issued now rather than at verification, so they can see their
  // tracker straight away. Rewards still require confirmation — that's
  // what makes confirming worth doing.
  const code = await uniqueCode(env);

  const record = {
    email,
    name,
    code,
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
  await env.DB.put(`code:${code}`, email);
  await env.DB.put(`pending:${token}`, email, { expirationTtl: PENDING_TTL_SECONDS });

  const link = verifyUrl(request, token);

  // Send the confirmation before anything optional, so a Kit problem
  // can never stop someone from being able to confirm. If the send fails
  // we keep the signup anyway — better to have their details and resend
  // than lose them — but we report it so it's never silent.
  let emailSent = true, emailError = null;
  try {
    await sendEmail(env, { to: email, ...confirmationEmail(name, link, await unsubUrl(email, env)) });
  } catch (err) {
    emailSent = false;
    emailError = err.message;
    console.error("CONFIRMATION EMAIL FAILED for", email, "->", err.message);
  }

  await pushToKit(env, email, name, {
    verify_url:     link,
    referral_code:  code,
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

  console.log("signup:", email, ref ? `(referred by ${ref})` : "",
              emailSent ? "| email sent" : "| EMAIL FAILED");

  return json({ ok: true, code, emailSent, emailError });
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

  // --- Activate them ----------------------------------------------
  // The code was issued at signup. Older records won't have one, so mint
  // it here as a fallback.
  const code = sub.code || await uniqueCode(env);
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
    await sendEmail(env, { to: email, ...welcomeEmail(sub.name, code, await unsubUrl(email, env)) });
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

  if (!referrer.verified) {
    console.log("referral counted but referrer unconfirmed:", referrerEmail);
  }

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
    // Drives the "confirm to activate" banner. Read live rather than
    // passed in the URL, so it's right even on a bookmarked link.
    verified: Boolean(sub.verified),
  });
}

/**
 * Public signup count, for social proof on the landing page.
 *
 * Returns nothing until there are enough signups to be persuasive —
 * "join 3 others" is worse than saying nothing at all.
 */
async function publicCount(env) {
  const list = await env.DB.list({ prefix: "sub:" });
  const total = list.keys.length;

  return json({
    ok: true,
    show: total >= 25,
    // Rounded down past 100 so it doesn't visibly tick like a fake counter.
    count: total >= 100 ? Math.floor(total / 10) * 10 : total,
  });
}

/* ==================== 4. KIT ==================== */

async function pushToKit(env, email, name, fields, tagName, opts = {}) {
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
      // Only assert "active" for genuinely new or confirming signups.
      // Sending it on every call — including a backfill — would quietly
      // re-subscribe anyone who had opted out in Kit.
      ...(opts.activate === false ? {} : { state: "active" }),
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

/**
 * Actually unsubscribes someone in Kit.
 *
 * Kit needs the subscriber id, not the address, so we look it up first.
 * Note this is one-way: Kit offers no API to reactivate a cancelled
 * subscriber — they'd have to re-subscribe through a form themselves.
 */
async function unsubscribeFromKit(env, email) {
  if (!env.KIT_API_KEY) return { ok: false, reason: "Kit not connected" };

  const found = await kit("GET",
    `/subscribers?email_address=${encodeURIComponent(email)}`, env);

  const subscriber = (found.subscribers || [])[0];
  if (!subscriber) return { ok: false, reason: "not found in Kit" };

  await kit("POST", `/subscribers/${subscriber.id}/unsubscribe`, env);
  return { ok: true, id: subscriber.id };
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
  const people = [];

  for (const key of list.keys) {
    const raw = await env.DB.get(key.name);
    if (raw) people.push(JSON.parse(raw));
  }

  people.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  // Opt-outs are removed from the list entirely and live under their own
  // prefix, so they never appear in these numbers or the table below.
  const unsubList = await env.DB.list({ prefix: "unsub:" });
  const unsubbed  = unsubList.keys.length;

  const verified = people.filter(p => p.verified).length;
  const pending  = people.length - verified;
  const referred = people.filter(p => p.referredBy).length;
  const totalRef = people.reduce((n, p) => n + (p.referrals || 0), 0);
  const rate     = people.length ? Math.round((verified / people.length) * 100) : 0;

  const tally = (field) => {
    const counts = {};
    for (const p of people) if (p[field]) counts[p[field]] = (counts[p[field]] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };

  const bar = (rows, accent) => {
    if (!rows.length) return `<p class="muted">Nothing yet.</p>`;
    const max = Math.max(...rows.map(r => r[1]));
    return rows.map(([label, n]) => `
      <div class="barrow">
        <div class="barlabel">${esc(label)}</div>
        <div class="bartrack"><div class="barfill" style="width:${Math.round((n / max) * 100)}%;background:${accent}"></div></div>
        <div class="barnum">${n}</div>
      </div>`).join("");
  };

  const card = (label, value, note = "") => `
    <div class="card">
      <div class="cardnum">${value}</div>
      <div class="cardlabel">${label}</div>
      ${note ? `<div class="cardnote">${note}</div>` : ""}
    </div>`;

  const rows = people.map(p => `
    <tr data-verified="${p.verified ? 1 : 0}">
      <td>${esc(p.email)}</td>
      <td>${esc(p.name || "—")}</td>
      <td class="c">${p.verified ? '<span class="pill ok">confirmed</span>' : '<span class="pill wait">pending</span>'}</td>
      <td class="c"><strong>${p.referrals || 0}</strong></td>
      <td>${esc(p.selectedPack || "—")}</td>
      <td>${esc(p.useCase || "—")}</td>
      <td>${esc(p.priceReaction || "—")}</td>
      <td>${esc(p.referredBy || "—")}</td>
      <td class="muted">${esc((p.createdAt || "").slice(0, 10))}</td>
    </tr>`).join("");

  const top = people.filter(p => p.referrals > 0)
                    .sort((a, b) => b.referrals - a.referrals)
                    .slice(0, 10);

  return html(`
    <div class="wide">
      <div class="head">
        <h1>Waitlist</h1>
        <div style="display:flex;gap:8px;">
          <a class="btn" href="/export?token=${esc(env.SHARED_SECRET)}">Download CSV</a>
          <a class="btn" style="background:#0369a1;" href="/sync-kit?token=${esc(env.SHARED_SECRET)}">Sync to Kit</a>
        </div>
      </div>

      <div class="note" style="margin-top:14px;border-left-color:${env.KIT_API_KEY ? "#15803d" : "#f97316"};">
        <strong>Kit:</strong> ${env.KIT_API_KEY
          ? "connected. New signups are added automatically."
          : `not connected. Add <code>KIT_API_KEY</code> as a Secret in your worker settings, then run <a href="/setup?token=${esc(env.SHARED_SECRET)}">/setup</a>.`}
      </div>

      <div class="cards">
        ${card("Confirmed", verified)}
        ${card("Pending", pending, `${rate}% confirm`)}
        ${card("Via referral", referred, people.length ? Math.round(referred / people.length * 100) + "% of signups" : "")}
        ${card("Referrals made", totalRef)}
        ${card("Unsubscribed", unsubbed, unsubbed ? "removed from the list" : "")}
      </div>

      <div class="cols">
        <div class="col">
          <h2>Pack chosen</h2>
          ${bar(tally("selectedPack"), "#0ea5e9")}
        </div>
        <div class="col">
          <h2>Reaction to $7 a bottle</h2>
          ${bar(tally("priceReaction"), "#f97316")}
        </div>
      </div>

      <h2>What they're using it for</h2>
      ${bar(tally("useCase"), "#8b5cf6")}

      ${top.length ? `
        <h2>Top referrers</h2>
        <table class="data">
          <tr><th>Email</th><th class="c">Referrals</th></tr>
          ${top.map(p => `<tr><td>${esc(p.email)}</td><td class="c"><strong>${p.referrals}</strong></td></tr>`).join("")}
        </table>` : ""}

      <div class="head" style="margin-top:34px;">
        <h2 style="margin:0;">Everyone (${people.length})</h2>
        <div>
          <input id="search" placeholder="Filter by email or name..." />
          <select id="filter">
            <option value="all">All</option>
            <option value="1">Confirmed only</option>
            <option value="0">Pending only</option>
          </select>
        </div>
      </div>

      <p class="muted" style="font-size:13px;margin-top:6px;">Click any column heading to sort. Click again to reverse.</p>
      <table class="data" id="all">
        <tr>
          <th data-sort="text">Email</th>
          <th data-sort="text">Name</th>
          <th data-sort="text" class="c">Status</th>
          <th data-sort="num" class="c">Refs</th>
          <th data-sort="text">Pack</th>
          <th data-sort="text">Use case</th>
          <th data-sort="text">Price</th>
          <th data-sort="text">Referred by</th>
          <th data-sort="text">Joined</th>
        </tr>
        ${rows || '<tr><td colspan="9" class="muted">No signups yet.</td></tr>'}
      </table>

      <div class="note">
        The two numbers that decide whether $56 is the right ask: the pack split and the
        price reaction. Watch those before anything else.
      </div>
    </div>

    <script>
      const search = document.getElementById('search');
      const filter = document.getElementById('filter');
      const rows = Array.from(document.querySelectorAll('#all tr')).slice(1);

      function apply() {
        const q = (search.value || '').toLowerCase();
        const f = filter.value;
        rows.forEach(r => {
          const text = r.textContent.toLowerCase();
          const v = r.getAttribute('data-verified');
          const okText = !q || text.includes(q);
          const okFilter = f === 'all' || v === f;
          r.style.display = (okText && okFilter) ? '' : 'none';
        });
      }
      search.addEventListener('input', apply);
      filter.addEventListener('change', apply);

      // Column sorting
      const table = document.getElementById('all');
      const headers = Array.from(table.querySelectorAll('th'));
      let sortCol = -1, sortAsc = true;

      headers.forEach((th, i) => {
        th.style.cursor = 'pointer';
        th.title = 'Sort by ' + th.textContent.trim();
        th.addEventListener('click', () => {
          sortAsc = (sortCol === i) ? !sortAsc : true;
          sortCol = i;
          const numeric = th.dataset.sort === 'num';

          const sorted = rows.slice().sort((a, b) => {
            const av = a.children[i].textContent.trim();
            const bv = b.children[i].textContent.trim();
            let cmp;
            if (numeric) {
              cmp = (parseFloat(av) || 0) - (parseFloat(bv) || 0);
            } else {
              cmp = av.localeCompare(bv);
            }
            return sortAsc ? cmp : -cmp;
          });

          sorted.forEach(r => table.appendChild(r));
          headers.forEach(h => h.textContent = h.textContent.replace(/ [\u2191\u2193]$/, ''));
          th.textContent = th.textContent + (sortAsc ? ' \u2191' : ' \u2193');
        });
      });
    </script>
  `, true);
}

/* ==================== UNSUBSCRIBE ==================== */

/**
 * One-click unsubscribe. Deliberately requires no login and no
 * confirmation step — CAN-SPAM allows at most a single page, and
 * Gmail's bulk sender rules expect a one-click POST to work.
 *
 *   GET  /unsubscribe?e=EMAIL&t=TOKEN   shows a confirmation page
 *   POST /unsubscribe?e=EMAIL&t=TOKEN   silent, for List-Unsubscribe-Post
 *
 * The token is an HMAC of the address, so nobody can unsubscribe
 * anyone else by guessing URLs.
 */
async function unsubscribe(request, url, env) {
  const email = (url.searchParams.get("e") || "").trim().toLowerCase();
  const token = (url.searchParams.get("t") || "").trim();

  const expected = email ? await unsubToken(email, env) : null;
  const valid = Boolean(email && token && safeEqual(token, expected));

  // Mail clients fire this in the background. Answer plainly, no HTML.
  const oneClick = request.method === "POST";

  if (!valid) {
    if (oneClick) return new Response("Invalid link", { status: 400 });
    return html(`
      <h1>That link didn't work</h1>
      <p>It may have been broken by your email client, or already used.</p>
      <p>Email <a href="mailto:${esc(REPLY_TO)}">${esc(REPLY_TO)}</a> and we'll
         take you off the list by hand — no questions, no delay.</p>`);
  }

  const raw = await env.DB.get(`sub:${email}`);

  if (raw) {
    const sub = JSON.parse(raw);

    // Remove them from the waitlist properly: record gone, referral code
    // freed, any outstanding verification links killed.
    await env.DB.delete(`sub:${email}`);
    if (sub.code) await env.DB.delete(`code:${sub.code}`);

    const pendings = await env.DB.list({ prefix: "pending:" });
    for (const key of pendings.keys) {
      if ((await env.DB.get(key.name)) === email) await env.DB.delete(key.name);
    }
  }

  // Keep a suppression entry — the address and the date, nothing else.
  // It's the only way to guarantee they never get re-added and emailed.
  await env.DB.put(`unsub:${email}`, JSON.stringify({
    email,
    unsubscribedAt: new Date().toISOString(),
  }));

  // Unsubscribe them in Kit too, so a broadcast can't reach them either.
  try {
    const result = await unsubscribeFromKit(env, email);
    console.log("Kit unsubscribe:", email, result.ok ? "done" : result.reason);
  } catch (err) {
    console.warn("Kit unsubscribe failed:", err.message);
  }

  console.log("unsubscribed and removed:", email);

  if (oneClick) return new Response("OK", { status: 200 });

  return html(`
    <h1>You're unsubscribed</h1>
    <p class="good">${esc(email)} won't receive anything further from us.</p>
    <p>That took effect immediately — nothing else to do.</p>
    <div class="note">
      Your details have been removed from our list. We keep only your email
      address on a suppression list, so you can't be added back by mistake.
      Want that gone too? Email <a href="mailto:${esc(REPLY_TO)}">${esc(REPLY_TO)}</a>.
    </div>
    <p style="margin-top:20px;"><a href="${SITE}">Back to socialphix.com</a></p>`);
}

/**
 * HMAC of the address, truncated. Deterministic, so the same address
 * always produces the same link, and unguessable without the secret.
 */
async function unsubToken(email, env) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(trim(env.SHARED_SECRET) || "no-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email));
  return [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

async function unsubUrl(email, env) {
  const t = await unsubToken(email, env);
  return `${WORKER_ORIGIN}/unsubscribe?e=${encodeURIComponent(email)}&t=${t}`;
}

/* ==================== DELETE ==================== */

/**
 * Removes one signup completely, so you can run the flow again with the
 * same address. Also what you'd use to honour a deletion request, which
 * your privacy policy promises.
 *   /delete?token=SECRET&email=someone@example.com
 */
async function deleteSignup(url, env) {
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const token = esc(url.searchParams.get("token") || "");

  if (!email) {
    return html(`
      <h1>Delete a signup</h1>
      <p>Removes the record entirely — useful for re-testing with the same
         address, and for honouring deletion requests.</p>
      <form method="GET" action="/delete" style="margin-top:18px;">
        <input type="hidden" name="token" value="${token}">
        <input type="email" name="email" placeholder="address to remove" required
               style="width:280px;" autofocus>
        <button type="submit" class="btn" style="border:0;cursor:pointer;">Delete</button>
      </form>`);
  }

  const raw = await env.DB.get(`sub:${email}`);
  if (!raw) {
    return html(`<h1>Nothing to delete</h1>
      <p>No record for <code>${esc(email)}</code>.</p>
      <p><a href="/delete?token=${token}">Try another</a></p>`);
  }

  const sub = JSON.parse(raw);

  await env.DB.delete(`sub:${email}`);
  if (sub.code) await env.DB.delete(`code:${sub.code}`);

  // Clear any outstanding verification links for this address.
  const pendings = await env.DB.list({ prefix: "pending:" });
  let cleared = 0;
  for (const key of pendings.keys) {
    if ((await env.DB.get(key.name)) === email) {
      await env.DB.delete(key.name);
      cleared++;
    }
  }

  console.log("deleted:", email, "| code:", sub.code || "none", "| tokens:", cleared);

  return html(`
    <h1>Deleted</h1>
    <p class="good">Removed <code>${esc(email)}</code>.</p>
    <table>
      <tr><td>Referral code freed</td><td><code>${esc(sub.code || "—")}</code></td></tr>
      <tr><td>Pending links cleared</td><td>${cleared}</td></tr>
      <tr><td>Was confirmed</td><td>${sub.verified ? "yes" : "no"}</td></tr>
    </table>
    <div class="note">You can now sign up with this address again as if it were new.</div>
    <p style="margin-top:18px;"><a href="/admin?token=${token}">Back to dashboard</a></p>`);
}

/* ==================== KIT BACKFILL ==================== */

/**
 * Pushes everyone already in the database up to Kit.
 *   /sync-kit?token=SECRET
 *
 * Needed once, after you switch Kit on — anyone who signed up while
 * KIT_API_KEY was unset never got sent. New signups go automatically.
 *
 * Cloudflare caps outbound calls per request, so this works through the
 * list in batches and hands you a link to continue.
 */
async function syncKit(url, env) {
  const token = esc(url.searchParams.get("token") || "");

  if (!env.KIT_API_KEY) {
    return html(`
      <h1>Kit isn't connected yet</h1>
      <p>Add <code>KIT_API_KEY</code> as a Secret in your worker settings and deploy,
         then run <a href="/setup?token=${token}">/setup</a> to create the fields
         and tags. Come back here afterwards.</p>`);
  }

  const BATCH = 15;
  const start = parseInt(url.searchParams.get("from"), 10) || 0;

  const list = await env.DB.list({ prefix: "sub:" });
  const keys = list.keys.slice(start, start + BATCH);

  let synced = 0;
  const problems = [];

  for (const key of keys) {
    const raw = await env.DB.get(key.name);
    if (!raw) continue;
    const s = JSON.parse(raw);

    try {
      await pushToKit(env, s.email, s.name, {
        referral_code:    s.code,
        users_referred:   s.referrals ?? 0,
        email_verified:   s.verified ? "true" : "false",
        referred_by_code: s.referredBy,
        selected_pack:    s.selectedPack,
        use_case:         s.useCase,
        price_reaction:   s.priceReaction,
        utm_source:       s.utmSource,
        utm_medium:       s.utmMedium,
        utm_campaign:     s.utmCampaign,
        country_code:     s.country,
        city:             s.city,
      }, s.verified ? TAG_VERIFIED : TAG_PENDING, { activate: false });
      synced++;
    } catch (err) {
      problems.push(`${s.email}: ${err.message}`);
    }
  }

  const done = start + keys.length;
  const remaining = list.keys.length - done;

  return html(`
    <h1>Kit sync</h1>
    <table>
      <tr><td>Sent this batch</td><td><strong>${synced}</strong></td></tr>
      <tr><td>Done so far</td><td><strong>${done}</strong> of ${list.keys.length}</td></tr>
      <tr><td>Remaining</td><td><strong>${remaining}</strong></td></tr>
    </table>
    ${problems.length ? `<h2 class="bad">Problems</h2><ul>${problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    ${remaining > 0
      ? `<div class="note"><strong>More to go.</strong>
           <a href="/sync-kit?token=${token}&from=${done}">Continue with the next ${BATCH}</a>.</div>`
      : `<div class="note"><p class="good">Everyone is in Kit.</p>
           New signups sync automatically from now on — you won't need this again.</div>`}
    <p style="margin-top:18px;"><a href="/admin?token=${token}">Back to dashboard</a></p>`);
}

/* ==================== EXPORT ==================== */

/**
 * Downloads your whole list as a CSV.
 *   /export?token=SECRET
 * Opens in Excel or Google Sheets. Your data is yours — take a copy
 * whenever you like.
 */
async function exportCsv(env) {
  const list = await env.DB.list({ prefix: "sub:" });
  const rows = [];

  for (const key of list.keys) {
    const raw = await env.DB.get(key.name);
    if (!raw) continue;
    rows.push(JSON.parse(raw));
  }

  // Newest first.
  rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const cols = [
    "email", "name", "verified", "referrals", "code", "referredBy",
    "selectedPack", "useCase", "priceReaction",
    "country", "city", "utmSource", "utmMedium", "utmCampaign",
    "createdAt", "verifiedAt",
  ];

  const cell = v => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    // Quote anything containing a comma, quote or newline.
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [
    cols.join(","),
    ...rows.map(r => cols.map(col => cell(r[col])).join(",")),
  ].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="socialphix-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
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
    ["/test-email?token=" + token, "Send one test email", true],
    ["/admin?token=" + token,      "Your signup numbers", true],
    ["/delete?token=" + token,     "Remove a signup so you can re-test", true],
    ["/sync-kit?token=" + token,   "Push existing signups up to Kit", true],
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

  /* --- Postal address (CAN-SPAM) --- */
  if (/\[|\]/.test(POSTAL_ADDRESS)) {
    rows.push(["Postal address", "info",
      "Still a placeholder. Commercial email legally needs a real address where mail reaches you — " +
      "a rented office, a mailbox service, or your own address. Fine while you're only emailing yourself; " +
      "sort it before you drive real traffic. Edit <code>POSTAL_ADDRESS</code> near the top of the worker."]);
  } else {
    ok("Postal address", esc(POSTAL_ADDRESS));
  }

  /* --- Turnstile --- */
  if (env.TURNSTILE_SECRET) {
    ok("Bot protection", "Turnstile active — tokens verified server-side");
  } else {
    rows.push(["Bot protection", "info",
      "Turnstile not configured. Rate limiting, disposable-domain blocking and email " +
      "verification still apply, but there's no bot challenge on the form. " +
      "Add <code>TURNSTILE_SECRET</code> to enable it."]);
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
      Next: <code>/test-email?token=YOUR_SECRET</code> actually sends one.
    </div>
  `);
}

/* ==================== EMAIL TEST ==================== */

/**
 * Isolates email sending from everything else.
 *   /test-email?token=SECRET            (then type a real address on the page)
 * Tells you exactly what Resend said, in plain language.
 */
async function testEmail(url, env) {
  const to = (url.searchParams.get("to") || "").trim();

  // Reserved placeholder domains Resend rejects outright.
  const PLACEHOLDERS = ["example.com", "example.org", "example.net", "test.com", "domain.com", "email.com"];
  const domain = (to.split("@")[1] || "").toLowerCase();

  if (!to || PLACEHOLDERS.includes(domain)) {
    const warning = to
      ? `<div class="note" style="border-left-color:#f97316;">
           <strong>${esc(domain)} won't work.</strong> It's a reserved placeholder domain and Resend
           blocks it on purpose. Use a real inbox you can open.
         </div>`
      : "";

    return html(`
      <h1>Email test</h1>
      ${warning}
      <p>Sends one confirmation email so you can see whether delivery works.</p>
      <form method="GET" action="/test-email" style="margin-top:18px;">
        <input type="hidden" name="token" value="${esc(url.searchParams.get("token") || "")}">
        <input type="email" name="to" placeholder="your.real@address.com" required
               style="width:280px;" autofocus>
        <button type="submit" class="btn" style="border:0;cursor:pointer;">Send test</button>
      </form>
    `);
  }

  const checks = [];
  checks.push(["RESEND_API_KEY set", env.RESEND_API_KEY ? "yes" : "NO — this is your problem"]);
  checks.push(["Sending from", esc(FROM)]);
  checks.push(["Sending to", esc(to)]);

  let result, detail = "";
  try {
    const mail = confirmationEmail("Test", `${url.origin}/verify?t=TESTTOKEN`, await unsubUrl(to, env));
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
      } else if (res.status === 422 && /`to` field|testing email/i.test(bodyText)) {
        hint = `<p><strong>The recipient address was rejected.</strong> Resend blocks placeholder
          domains like <code>example.com</code>. Send to a real inbox you can open.</p>`;
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

async function sendEmail(env, { to, subject, html, text, unsubscribeUrl }) {
  if (!env.RESEND_API_KEY) {
    // Throw rather than return quietly — a missing key used to mean
    // signups succeeded with no email and no visible clue why.
    throw new Error("RESEND_API_KEY secret is not set on this worker");
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
      // Gmail and Yahoo require these of bulk senders. Without them your
      // mail gets filtered regardless of how good the content is.
      ...(unsubscribeUrl ? {
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
  console.log("emailed:", to, "|", subject);
}

/* ---- Shared shell so both emails look like the site ---- */

function shell(innerHtml, unsubUrl) {
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
    <p style="margin:0 0 10px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:#475569;">
      ${POSTAL_ADDRESS}
    </p>
    <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;color:#475569;">
      &copy; 2026 PhixRx &middot; Shipping to the United States${unsubUrl
        ? ` &middot; <a href="${unsubUrl}" style="color:#64748b;text-decoration:underline;">Unsubscribe</a>`
        : ""}
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

function confirmationEmail(name, verifyLink, unsubUrl) {
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
  `, unsubUrl);

  const text = `${hi}

You're one click from the Social Phix list.

Confirm your email: ${verifyLink}

Once you confirm, your personal referral link unlocks. Every friend who joins through it moves you up — three of them and you skip the line entirely for the first run.

Why the extra step: referrals only count once someone confirms. Keeps it honest, and means the small first run goes to people who actually brought friends.

Shady Biskaly
R.Ph., BScPharm
Founder, Social Phix

Didn't sign up? Ignore this. The link expires in a week.

---
${POSTAL_ADDRESS}
${unsubUrl ? "Unsubscribe: " + unsubUrl : ""}`;

  return { subject: "Confirm your email — then your link is live", html, text, unsubscribeUrl: unsubUrl };
}

/* ---- Email 2: welcome, with the referral link ---- */

function welcomeEmail(name, code, unsubUrl) {
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
  `, unsubUrl);

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

P.S. Reply if you've got questions about the formula. I read everything, and I'm the one who wrote it.

---
${POSTAL_ADDRESS}
${unsubUrl ? "Unsubscribe: " + unsubUrl : ""}`;

  return { subject: "You're in. Here's your link.", html, text, unsubscribeUrl: unsubUrl };
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

function cors(res, request) {
  const origin = request?.headers?.get("Origin");

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
  } else {
    // Fall back to the main site so a missing Origin header still works.
    res.headers.set("Access-Control-Allow-Origin", SITE);
    if (origin) console.warn("Blocked origin:", origin, "— add it to ALLOWED_ORIGINS if that's yours");
  }

  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

/**
 * Compares two secrets without leaking length or content through timing.
 * A plain !== returns as soon as it finds a mismatched byte, which in
 * theory lets an attacker recover a token one character at a time.
 */
function safeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function html(inner, wide = false) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Social Phix</title>
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <meta name="robots" content="noindex,nofollow">
     <meta name="referrer" content="no-referrer">
     <style>
       body{font:15px/1.6 system-ui,-apple-system,sans-serif;margin:0;padding:36px 20px;color:#0f172a;background:#f8fafc}
       .wide,body>*:not(.wide){max-width:${wide ? "1080px" : "640px"};margin:0 auto}
       h1{font-size:24px;margin:0 0 4px}
       h2{font-size:15px;margin:32px 0 12px;color:#475569;text-transform:uppercase;letter-spacing:.6px}
       code{background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:13px}
       pre{background:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
       table{border-collapse:collapse;width:100%;margin-top:10px;background:#fff;border-radius:8px;overflow:hidden}
       td,th{border-bottom:1px solid #e2e8f0;padding:9px 12px;font-size:13px;text-align:left}
       th{background:#f1f5f9;font-weight:600;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
       td.c,th.c{text-align:center}
       .muted{color:#94a3b8}
       .good{color:#15803d;font-weight:600}.bad{color:#b91c1c}
       .note{background:#eff6ff;border-left:3px solid #0ea5e9;padding:14px 18px;margin-top:28px;font-size:14px;border-radius:0 6px 6px 0}
       .head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
       .btn{display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:9px 18px;border-radius:6px;font-size:13px;font-weight:600}
       .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:20px}
       .card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:18px}
       .cardnum{font-size:30px;font-weight:800;letter-spacing:-1px}
       .cardlabel{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin-top:2px}
       .cardnote{font-size:12px;color:#94a3b8;margin-top:4px}
       .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:28px}
       .barrow{display:flex;align-items:center;gap:12px;margin-bottom:7px}
       .barlabel{width:150px;font-size:13px;flex-shrink:0}
       .bartrack{flex:1;height:9px;background:#e2e8f0;border-radius:5px;overflow:hidden}
       .barfill{height:100%;border-radius:5px}
       .barnum{width:34px;text-align:right;font-size:13px;font-weight:700;flex-shrink:0}
       .pill{display:inline-block;padding:2px 9px;border-radius:11px;font-size:11px;font-weight:600}
       .pill.ok{background:#dcfce7;color:#15803d}
       .pill.wait{background:#fef3c7;color:#a16207}
       input,select{padding:7px 11px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:inherit}
       input{width:210px}
       a{color:#0369a1}
     </style>${inner}`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
