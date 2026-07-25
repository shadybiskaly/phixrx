/**
 * LaunchList -> Kit sync
 * ===============================================================
 * You do NOT need to create anything in Kit by hand.
 * Deploy this, then visit the /setup link once in your browser
 * and it builds every custom field and tag for you.
 * ===============================================================
 *
 * SECRETS TO SET IN CLOUDFLARE (only two):
 *   KIT_API_KEY     from Kit -> Settings -> Advanced -> API
 *   SHARED_SECRET   any long random string you make up
 *
 * TWO URLS THIS WORKER ANSWERS:
 *   GET  /setup?token=YOUR_SHARED_SECRET   run once, in your browser
 *   POST /?token=YOUR_SHARED_SECRET        the LaunchList webhook
 *
 * WHAT IT DOES DAY TO DAY:
 *   new_user      -> adds them to Kit, tags "waitlist-pending"
 *   email_verify  -> tags "waitlist-verified", which triggers your
 *                    Kit automation to send the welcome email
 *   Spam (is_spam = 1) is dropped and never reaches Kit.
 */

const KIT = "https://api.kit.com/v4";

const TAG_PENDING  = "waitlist-pending";
const TAG_VERIFIED = "waitlist-verified";

// Kit turns each label into a lowercase underscored key,
// e.g. "Referral Code" -> referral_code
const FIELD_LABELS = [
  "Referral Code",
  "Waitlist Position",
  "Users Referred",
  "Email Verified",
  "Referred By Email",
  "Referred By Code",
  "Selected Pack",
  "User Group",
  "Use Case",
  "Price Reaction",
  "Utm Source",
  "Utm Medium",
  "Utm Campaign",
  "Country Code",
  "City",
];

// Cached across requests while the worker instance stays warm.
let tagCache = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Log every hit so the Cloudflare log stream shows what arrived.
    console.log(`--> ${request.method} ${url.pathname}${url.search}`);

    if (!env.SHARED_SECRET) {
      console.error("SHARED_SECRET secret is not set in Cloudflare");
      return new Response("SHARED_SECRET is not configured on this worker.", { status: 500 });
    }

    // Accept the token three ways. Some webhook services strip query
    // strings, so the path and header options are there as fallbacks:
    //   /?token=SECRET        query string
    //   /hook/SECRET          path segment
    //   X-Webhook-Token       header
    const tokenFromQuery  = url.searchParams.get("token");
    const tokenFromPath   = url.pathname.split("/").filter(Boolean).pop();
    const tokenFromHeader = request.headers.get("X-Webhook-Token");

    const authorized = [tokenFromQuery, tokenFromPath, tokenFromHeader]
      .some(t => t && t === env.SHARED_SECRET);

    if (!authorized) {
      console.warn("Rejected: token missing or wrong.",
        `query=${tokenFromQuery ? "present" : "none"}`,
        `path=${tokenFromPath || "none"}`,
        `header=${tokenFromHeader ? "present" : "none"}`);
      return new Response(
        "Unauthorized. The token didn't match SHARED_SECRET.\n\n" +
        "Try any of these:\n" +
        "  https://your-worker.workers.dev/?token=YOUR_SECRET\n" +
        "  https://your-worker.workers.dev/hook/YOUR_SECRET\n" +
        "  header  X-Webhook-Token: YOUR_SECRET\n",
        { status: 401 }
      );
    }

    if (url.pathname === "/setup") return runSetup(env);

    if (request.method !== "POST") {
      return new Response(
        "Worker is alive and your token is correct.\n\n" +
        "Next: visit /setup?token=YOUR_SECRET to create the Kit fields and tags.\n",
        { status: 200 }
      );
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }

    console.log("event:", payload.event || "(none)", "| email:", payload.email || "(none)");

    try {
      if (payload.event === "new_user")     return await handleNewUser(payload, env);
      if (payload.event === "email_verify") return await handleVerify(payload, env);
      return json({ ok: true, skipped: payload.event || "unknown" });
    } catch (err) {
      console.error("sync failed:", err.message);
      return json({ error: "sync failed", detail: err.message }, 500);
    }
  },
};

/* ================= ONE-TIME SETUP ================= */

async function runSetup(env) {
  const created = [];
  const problems = [];

  for (const label of FIELD_LABELS) {
    try {
      const res = await kit("POST", "/custom_fields", env, { label });
      const f = res.custom_field || {};
      created.push({ label, key: f.key || "?" });
    } catch (err) {
      problems.push(`Field "${label}": ${err.message}`);
    }
  }

  for (const name of [TAG_PENDING, TAG_VERIFIED]) {
    try {
      await kit("POST", "/tags", env, { name });
      created.push({ label: `Tag: ${name}`, key: name });
    } catch (err) {
      // Kit errors if the tag already exists - that's fine.
      if (/exist|taken|already/i.test(err.message)) {
        created.push({ label: `Tag: ${name}`, key: `${name} (already there)` });
      } else {
        problems.push(`Tag "${name}": ${err.message}`);
      }
    }
  }

  tagCache = null; // force a fresh lookup next time

  const rows = created
    .map(c => `<tr><td>${esc(c.label)}</td><td><code>${esc(c.key)}</code></td></tr>`)
    .join("");

  const errs = problems.length
    ? `<h2 class="bad">Problems</h2><ul>${problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>`
    : `<p class="good">No problems. Everything is ready.</p>`;

  return new Response(
    `<!doctype html><meta charset="utf-8">
     <title>Social Phix - Kit setup</title>
     <style>
       body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#111}
       h1{font-size:22px} h2{font-size:17px;margin-top:28px}
       table{border-collapse:collapse;width:100%;margin-top:14px}
       td{border-bottom:1px solid #eee;padding:7px 4px;font-size:14px}
       code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-size:13px}
       .good{color:#15803d;font-weight:600} .bad{color:#b91c1c}
       .note{background:#f8fafc;border-left:3px solid #0ea5e9;padding:12px 16px;margin-top:24px;font-size:14px}
     </style>
     <h1>Kit setup complete</h1>
     ${errs}
     <h2>Created in your Kit account</h2>
     <table>${rows}</table>
     <div class="note">
       <strong>You're done here.</strong> You can close this page.
       Next: connect the webhook in LaunchList, then build the welcome
       automation in Kit triggered by the <code>waitlist-verified</code> tag.
     </div>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

/* ================= WEBHOOK HANDLERS ================= */

async function handleNewUser(p, env) {
  if (p.is_spam === 1 || p.is_spam === "1") {
    return json({ ok: true, skipped: "spam" });
  }

  const info = p.info || {};
  const a = info.analytics || {};
  const l = info.location || {};
  const r = p.referred_by || null;

  const fields = clean({
    referral_code:     p.referral_code,
    waitlist_position: p.position,
    users_referred:    p.users_referred ?? 0,
    email_verified:    "false",
    referred_by_email: r ? r.email : null,
    referred_by_code:  r ? r.referral_code : null,
    selected_pack:     p.selectedPack,
    user_group:        p.userGroup,
    use_case:          p.useCase,
    price_reaction:    p.priceReaction,
    utm_source:        a.utm_source,
    utm_medium:        a.utm_medium,
    utm_campaign:      a.utm_campaign,
    country_code:      l.countryCode,
    city:              l.cityName,
  });

  const res = await kit("POST", "/subscribers", env, {
    email_address: p.email,
    first_name: firstName(p.name),
    state: "active",
    fields,
  });

  if (res.warnings && res.warnings.length) {
    console.warn("Kit ignored these fields:", res.warnings.join(", "));
  }

  await applyTag(TAG_PENDING, p.email, env);
  return json({ ok: true, event: "new_user", email: p.email });
}

async function handleVerify(p, env) {
  await kit("POST", "/subscribers", env, {
    email_address: p.email,
    fields: { email_verified: "true" },
  });
  await applyTag(TAG_VERIFIED, p.email, env);
  return json({ ok: true, event: "email_verify", email: p.email });
}

/* ================= KIT HELPERS ================= */

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
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// Look the tag up by name so you never have to find its id yourself.
async function applyTag(tagName, email, env) {
  if (!tagCache) {
    const res = await kit("GET", "/tags", env);
    tagCache = {};
    for (const t of res.tags || []) tagCache[t.name] = t.id;
  }

  const id = tagCache[tagName];
  if (!id) {
    console.warn(`Tag "${tagName}" not found in Kit. Run /setup once.`);
    return;
  }

  return kit("POST", `/tags/${id}/subscribers`, env, { email_address: email });
}

/* ================= SMALL HELPERS ================= */

// Kit custom fields only accept strings; drop anything empty.
function clean(obj) {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)])
  );
}

function firstName(full) {
  if (!full) return null;
  return String(full).trim().split(/\s+/)[0] || null;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
