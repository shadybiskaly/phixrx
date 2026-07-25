/**
 * LaunchList -> Loops sync
 * ---------------------------------------------------------------
 * Cloudflare Worker. Receives LaunchList webhooks and pushes
 * contacts into Loops, so Loops stays your email system of record
 * while LaunchList runs the waitlist + referral mechanics.
 *
 * DEPLOY
 *   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker
 *   2. Paste this file in, Deploy
 *   3. Settings -> Variables -> add these SECRETS (encrypted, not plaintext):
 *        LOOPS_API_KEY   your Loops API key
 *        SHARED_SECRET   any long random string you invent
 *   4. Copy your worker URL, then in LaunchList:
 *        Plugins -> Webhook -> Create a webhook
 *        URL: https://your-worker.workers.dev/?token=YOUR_SHARED_SECRET
 *   5. Hit "Send a test request" in LaunchList to confirm it works
 *
 * EVENTS HANDLED
 *   new_user      someone joins the waitlist
 *   email_verify  they confirm their email address
 *
 * Spam submissions (is_spam = 1) are dropped and never reach Loops.
 */

const LOOPS_ENDPOINT = "https://app.loops.so/api/v1/contacts/update";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    // --- Auth: LaunchList doesn't sign webhooks, so we gate on a shared token ---
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!env.SHARED_SECRET || token !== env.SHARED_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return json({ error: "invalid JSON" }, 400);
    }

    try {
      switch (payload.event) {
        case "new_user":
          return await handleNewUser(payload, env);
        case "email_verify":
          return await handleEmailVerify(payload, env);
        default:
          // Unknown event: acknowledge so LaunchList doesn't retry forever.
          return json({ ok: true, skipped: payload.event || "unknown" });
      }
    } catch (err) {
      console.error("sync failed:", err.message);
      return json({ error: "sync failed", detail: err.message }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */

async function handleNewUser(p, env) {
  // Drop anything LaunchList flagged as spam.
  if (p.is_spam === 1 || p.is_spam === "1") {
    return json({ ok: true, skipped: "spam" });
  }

  const info = p.info || {};
  const analytics = info.analytics || {};
  const location = info.location || {};
  const referrer = p.referred_by || null;

  const contact = {
    email: p.email,
    firstName: firstNameOf(p.name),
    lastName: lastNameOf(p.name),
    source: "LaunchList waitlist",
    subscribed: true,

    // Waitlist + referral state
    waitlistPosition: p.position ?? null,
    referralCode: p.referral_code ?? null,
    usersReferred: toInt(p.users_referred),
    emailVerified: Boolean(p.is_email_verified),
    referredByEmail: referrer ? referrer.email : null,
    referredByCode: referrer ? referrer.referral_code : null,

    // Attribution
    utmSource: analytics.utm_source ?? null,
    utmMedium: analytics.utm_medium ?? null,
    utmCampaign: analytics.utm_campaign ?? null,
    httpReferrer: analytics.http_referrer ?? null,

    // Geo (useful: you're shipping US-only at launch)
    country: location.countryName ?? null,
    countryCode: location.countryCode ?? null,
    city: location.cityName ?? null,
  };

  await pushToLoops(contact, env);
  return json({ ok: true, event: "new_user", email: p.email });
}

async function handleEmailVerify(p, env) {
  await pushToLoops(
    {
      email: p.email,
      emailVerified: true,
      emailVerifiedAt: p.email_verified_at ?? null,
    },
    env
  );
  return json({ ok: true, event: "email_verify", email: p.email });
}

/* ------------------------------------------------------------------ */

async function pushToLoops(contact, env) {
  if (!contact.email) throw new Error("no email in payload");
  if (!env.LOOPS_API_KEY) throw new Error("LOOPS_API_KEY not set");

  // Strip nulls so we never overwrite good Loops data with empty values.
  const body = Object.fromEntries(
    Object.entries(contact).filter(([, v]) => v !== null && v !== undefined)
  );

  const res = await fetch(LOOPS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LOOPS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Loops ${res.status}: ${text}`);
  }
  return res.json();
}

/* ---------------------------- helpers ----------------------------- */

function firstNameOf(full) {
  if (!full) return null;
  return String(full).trim().split(/\s+/)[0] || null;
}

function lastNameOf(full) {
  if (!full) return null;
  const parts = String(full).trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : null;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
