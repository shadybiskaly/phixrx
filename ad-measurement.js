/* Only homepage measurement. Never load Meta on the referral/survey page. */
(() => {
  'use strict';
  const PIXEL = '1020097220917425';
  const KEY = 'socialphix-meta-consent-v1';
  const params = new URLSearchParams(location.search);
  window.socialPhixAttribution = params;
  // Keep signup attribution in memory; don't expose referral codes to Meta.
  const safe = new URL(location.href);
  safe.search = '';
  safe.hash = '';
  const click = params.get('fbclid');
  if (click && /^[A-Za-z0-9_-]{1,1000}$/.test(click)) safe.searchParams.set('fbclid', click);
  if (safe.href !== location.href) history.replaceState(null, '', safe.pathname + safe.search);
  const panel = document.getElementById('ad-consent');
  let choice = null, initialized = false, sentLead = false;
  const blocked = navigator.globalPrivacyControl === true;
  try { choice = localStorage.getItem(KEY); } catch (_) {}
  function allowed() { return choice === 'allow' && !blocked; }
  function start() {
    if (!allowed() || initialized) return;
    initialized = true;
    const q = window.fbq = function () {
      q.callMethod ? q.callMethod.apply(q, arguments) : q.queue.push(arguments);
    };
    window._fbq = q;
    q.push = q; q.loaded = true; q.version = '2.0'; q.queue = [];
    q.disablePushState = true;
    q('set', 'autoConfig', false, PIXEL);
    q('init', PIXEL);
    q('consent', 'grant');
    q('trackSingle', PIXEL, 'PageView');
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);
  }
  function choose(value) {
    choice = value;
    try { localStorage.setItem(KEY, value); } catch (_) {}
    panel.hidden = true;
    if (allowed()) {
      if (initialized) window.fbq('consent', 'grant');
      else start();
    } else if (initialized) window.fbq('consent', 'revoke');
  }
  document.getElementById('allow-ad-measurement').addEventListener('click', () => choose('allow'));
  document.getElementById('decline-ad-measurement').addEventListener('click', () => choose('deny'));
  document.getElementById('ad-privacy-settings').addEventListener('click', () => {
    panel.hidden = false;
    document.getElementById('decline-ad-measurement').focus();
  });
  if (blocked) {
    choice = 'deny';
    document.getElementById('allow-ad-measurement').disabled = true;
    document.getElementById('allow-ad-measurement').textContent = 'Privacy signal respected';
  }
  panel.hidden = blocked || choice === 'allow' || choice === 'deny';
  start();
  window.socialPhixMeasurement = {
    async lead() {
      if (!allowed() || sentLead || !initialized) return;
      sentLead = true;
      const eventID = window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID() : 'signup-' + Date.now();
      // No form values, questionnaire data, price, or referral code.
      window.fbq('trackSingle', PIXEL, 'Lead', {}, { eventID });
      // Allow the already-loaded pixel to dispatch before navigation. Signup
      // must still complete when scripts are blocked or the request fails.
      await new Promise(resolve => setTimeout(resolve, 650));
    }
  };
})();
