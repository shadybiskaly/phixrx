# Welcome Email — Kit Setup

Sent when the `waitlist-verified` tag is applied (which the Cloudflare Worker does the moment someone confirms their email).

---

## Subject line

**Primary:** `You're in. Here's your link.`

Alternates worth A/B testing:
- `Confirmed — now let's get you to the front`
- `Your Social Phix link is live`
- `You're on the list. Here's how to skip it.`

**Preview text:** `What you unlock at 3, 5, 10 and 25 referrals.`

---

## The email

> Paste this into Kit's editor. The `{{ }}` bits are Liquid variables — Kit fills them in per subscriber. Keep them exactly as written.

---

Hey {{ subscriber.first_name }},

You're confirmed. That's the admin done.

Now the part that matters.

I'm a pharmacist, not a beverage company. There's no warehouse behind this — the first production run is genuinely small, and I'd rather it went to the people who helped get it made than to whoever happens to find the site that week.

So here's your link:

**{{ subscriber.referral_code | prepend: "https://www.socialphix.com/?ref=" }}**

Every friend who joins through it moves you up the line. And it stacks:

**3 friends** — you skip the line entirely. Priority spot in the first run.
**5** — a free bottle added to your order.
**10** — a free 3-pack. That's $24, on me.
**25** — a free 8-pack. $56, and enough for a month of things that matter.

→ **[Track your progress here]({{ subscriber.referral_code | prepend: "https://www.socialphix.com/success.html?ref=" }})**

One thing worth knowing: referrals only count once your friend confirms their email, same as you just did. Keeps it honest, and means the rewards go to people who brought actual humans.

---

**Why this exists, quickly.**

I've spent more than a decade behind a pharmacy counter. What I keep noticing has nothing to do with the counter — it's everywhere. People are more anxious than I've ever seen them, and it's sharpest in the younger crowd. Always half-worried about how they're coming across. More hours on a screen than in a room with actual people, and then feeling it the moment they're in one.

The options were bad. Alcohol dulls you. Energy drinks wire you the wrong way. Herbal calmers put you to sleep.

Nothing was built for the moment you need to be calm *and* sharp at the same time. So I built it.

If you want the actual pharmacology — the studies behind the L-theanine, the motherwort, all of it — [it's all here](https://www.socialphix.com/science.html). I cited the papers. You can check my work.

Talk soon,

**Shady**
Shady Biskaly, R.Ph., BScPharm
Founder, Social Phix

*P.S. — Reply to this email if you've got questions about the formula. I read everything, and I'm the one who wrote it.*

---

## Liquid variables used

| Variable | Source |
|---|---|
| `{{ subscriber.first_name }}` | Standard Kit field |
| `{{ subscriber.referral_code }}` | Custom field, set by the Worker |

The `| prepend:` filter builds the full URL from the code, so you only store the code itself in Kit.

**Test this before sending.** Kit's preview lets you pick a real subscriber — check that both links resolve to a real code and not a blank string. A broken referral link in a welcome email is the one mistake that kills the whole mechanic.

---

## Setting up the automation in Kit

1. **Automations → Visual Automations → New**
2. Trigger: **Tag added** → `waitlist-verified`
3. Action: **Email** → paste the above
4. Turn the automation live

Do a full end-to-end test before promoting anything: sign up with a real address, confirm, and check the email arrives with a working link.

---

## Two follow-ups worth queuing later

Same automation, added as delayed steps.

**Day 3, only if `users_referred` is 0** — a nudge. Short, no guilt, one line about the first run filling and a reminder of the 3-referral tier.

**On hitting a milestone** — a congratulations email. Kit can trigger on a custom field change if the Worker keeps `users_referred` updated. Worth doing: the moment someone unlocks a tier is exactly when they're most likely to push for the next one.

I can write both when you're ready.
