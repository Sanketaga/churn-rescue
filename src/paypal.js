// PayPal client with two interchangeable implementations:
//  - LivePayPal: real calls to the PayPal REST API (sandbox by default)
//  - MockPayPal: an in-memory stand-in that returns the same response shapes,
//    used when no sandbox credentials are configured (DEMO MODE).
// Every call is written to the audit log so the dashboard shows exactly which
// PayPal endpoints the agent used.

const { state, logApi } = require('./store');

const BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

class LivePayPal {
  constructor({ clientId, clientSecret }) {
    this.mode = 'live';
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.tokenExpires = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    logApi({ mode: 'live', method: 'POST', path: '/v1/oauth2/token', status: res.status });
    if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
    const json = await res.json();
    this.token = json.access_token;
    this.tokenExpires = Date.now() + json.expires_in * 1000;
    return this.token;
  }

  async request(method, path, body) {
    const token = await this.accessToken();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    logApi({ mode: 'live', method, path, status: res.status });
    if (!res.ok) throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${text}`);
    return text ? JSON.parse(text) : {};
  }

  getSubscription(id) {
    return this.request('GET', `/v1/billing/subscriptions/${id}`);
  }
  suspend(id, reason) {
    return this.request('POST', `/v1/billing/subscriptions/${id}/suspend`, { reason });
  }
  activate(id, reason) {
    return this.request('POST', `/v1/billing/subscriptions/${id}/activate`, { reason });
  }
  captureOutstanding(id, amount, note) {
    return this.request('POST', `/v1/billing/subscriptions/${id}/capture`, {
      note,
      capture_type: 'OUTSTANDING_BALANCE',
      amount,
    });
  }
  revise(id, planId, returnUrl, cancelUrl) {
    return this.request('POST', `/v1/billing/subscriptions/${id}/revise`, {
      plan_id: planId,
      application_context: {
        brand_name: state.settings.merchantName,
        user_action: 'CONTINUE',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    });
  }
  async verifyWebhook(headers, event) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) return { verified: false, reason: 'PAYPAL_WEBHOOK_ID not set' };
    const result = await this.request('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event,
    });
    return { verified: result.verification_status === 'SUCCESS' };
  }
}

// ---------------------------------------------------------------------------
// Demo mode: same interface and response shapes, backed by memory.
class MockPayPal {
  constructor() {
    this.mode = 'demo';
    this.subs = {};
  }
  log(method, path, status = 200) {
    logApi({ mode: 'demo', method, path, status });
  }
  seed(sub) {
    this.subs[sub.id] = sub;
  }
  async getSubscription(id) {
    const sub = this.subs[id];
    this.log('GET', `/v1/billing/subscriptions/${id}`, sub ? 200 : 404);
    if (!sub) throw new Error(`Subscription ${id} not found`);
    return JSON.parse(JSON.stringify(sub));
  }
  async suspend(id, reason) {
    this.log('POST', `/v1/billing/subscriptions/${id}/suspend`, 204);
    Object.assign(this.subs[id], { status: 'SUSPENDED', status_change_note: reason });
    return {};
  }
  async activate(id, reason) {
    this.log('POST', `/v1/billing/subscriptions/${id}/activate`, 204);
    Object.assign(this.subs[id], { status: 'ACTIVE', status_change_note: reason });
    return {};
  }
  async captureOutstanding(id, amount) {
    this.log('POST', `/v1/billing/subscriptions/${id}/capture`, 202);
    const sub = this.subs[id];
    sub.status = 'ACTIVE';
    sub.billing_info.outstanding_balance = { currency_code: 'USD', value: '0.00' };
    sub.billing_info.last_payment = { amount, time: new Date().toISOString() };
    return { status: 'COMPLETED', id: 'CAPTURE-' + Date.now(), amount_with_breakdown: { gross_amount: amount } };
  }
  async revise(id, planId, returnUrl) {
    this.log('POST', `/v1/billing/subscriptions/${id}/revise`, 200);
    const approve = `/mock-paypal/approve?sub=${encodeURIComponent(id)}&plan=${encodeURIComponent(planId)}&return=${encodeURIComponent(returnUrl)}`;
    return { plan_id: planId, links: [{ rel: 'approve', href: approve, method: 'GET' }] };
  }
  applyRevision(id, planId) {
    const sub = this.subs[id];
    sub.plan_id = planId;
    sub.status = 'ACTIVE';
    sub.billing_info.outstanding_balance = { currency_code: 'USD', value: '0.00' };
  }
  // Demo-only helper: make a payment fail, as PayPal would after a declined charge.
  failPayment(id, reasonCode, amount) {
    const sub = this.subs[id];
    sub.billing_info.failed_payments_count = (sub.billing_info.failed_payments_count || 0) + 1;
    sub.billing_info.outstanding_balance = { currency_code: 'USD', value: amount };
    sub.billing_info.last_failed_payment = {
      amount: { currency_code: 'USD', value: amount },
      time: new Date().toISOString(),
      reason_code: reasonCode,
    };
    return sub;
  }
  async verifyWebhook() {
    return { verified: false, reason: 'demo mode' };
  }
}

function createPayPal() {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  if (PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET) {
    return new LivePayPal({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET });
  }
  return new MockPayPal();
}

module.exports = { createPayPal, LivePayPal, MockPayPal, BASE };
