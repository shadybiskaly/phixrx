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
    firstName: (sub.name || "").split(/\s+/)[0] || null,
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
      first_name: (name || "").split(/\s+/)[0] || undefined,
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

/* ==================== EMAIL (Resend) ==================== */

async function sendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY not set — no email sent to", to);
    return;
  }

  const res = await fetch(RESEND, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
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
    <p style="${P}margin-top:24px;">&mdash; Shady</p>
    <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#64748b;">
      Shady Biskaly, R.Ph., BScPharm<br>Founder, Social Phix
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

— Shady
Shady Biskaly, R.Ph., BScPharm
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
    <h1 style="${H}">You're in. Here's your link.</h1>
    <p style="${P}">I'm a pharmacist, not a beverage company. There's no warehouse behind this — the first run is genuinely small, and I'd rather it went to the people who helped get it made.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;">
      <tr><td style="background-color:#050B14;border:1px solid #1e3a5f;border-radius:8px;padding:18px;">
        <p style="margin:0 0 6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#00E5FF;">Your personal link</p>
        <a href="${link}" style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;word-break:break-all;">${link}</a>
      </td></tr>
    </table>

    <p style="${P}">Every friend who joins through it moves you up. And it stacks:</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;">
      ${tier(3,  "Skip the line",   "Priority spot in the first run")}
      ${tier(5,  "A free bottle",   "Added to whatever pack you order")}
      ${tier(10, "A free 3-pack",   "$24 value, on me")}
      ${tier(25, "A free 8-pack",   "$56 — a month of things that matter")}
    </table>

    ${button(tracker, "Track my referrals")}

    <p style="${P}font-size:13px;color:#94a3b8;">Referrals count once your friend confirms their email, same as you just did.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;">
      <tr><td style="border-top:1px solid #1e3a5f;padding-top:24px;">
        <p style="${P}">Quickly, why this exists.</p>
        <p style="${P}">More than a decade behind a pharmacy counter, and what I keep noticing has nothing to do with the counter. People are more anxious than I've ever seen them, sharpest in the younger crowd — always half-worried about how they're coming across, more hours on a screen than in a room with actual people, and then feeling it the moment they're in one.</p>
        <p style="${P}">Alcohol dulls you. Energy drinks wire you the wrong way. Herbal calmers put you to sleep. Nothing was built for the moment you need to be calm <em>and</em> sharp at once. So I built it.</p>
        <p style="${P}">If you want the actual pharmacology, <a href="${SITE}/science.html" style="color:#00E5FF;">it's all here</a>. I cited the papers. You can check my work.</p>
      </td></tr>
    </table>

    <p style="${P}margin-top:22px;">Talk soon,</p>
    <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#64748b;">
      <strong style="color:#ffffff;">Shady</strong><br>Shady Biskaly, R.Ph., BScPharm<br>Founder, Social Phix
    </p>
    <p style="margin:22px 0 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#475569;">
      P.S. Reply to this if you've got questions about the formula. I read everything, and I'm the one who wrote it.
    </p>
  `);

  const text = `${hi}

You're in. Here's your link.

I'm a pharmacist, not a beverage company. There's no warehouse behind this — the first run is genuinely small, and I'd rather it went to the people who helped get it made.

Your personal link:
${link}

Every friend who joins through it moves you up. And it stacks:

  3 friends  — Skip the line. Priority spot in the first run.
  5          — A free bottle added to your order.
  10         — A free 3-pack. $24, on me.
  25         — A free 8-pack. $56.

Track your referrals: ${tracker}

Referrals count once your friend confirms their email, same as you just did.

---

Quickly, why this exists.

More than a decade behind a pharmacy counter, and what I keep noticing has nothing to do with the counter. People are more anxious than I've ever seen them, sharpest in the younger crowd — always half-worried about how they're coming across, more hours on a screen than in a room with actual people, and then feeling it the moment they're in one.

Alcohol dulls you. Energy drinks wire you the wrong way. Herbal calmers put you to sleep. Nothing was built for the moment you need to be calm AND sharp at once. So I built it.

The actual pharmacology, with citations: ${SITE}/science.html

Talk soon,
Shady
Shady Biskaly, R.Ph., BScPharm
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
