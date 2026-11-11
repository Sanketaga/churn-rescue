// In-memory state for the merchant workspace.
// Subscriptions themselves live in PayPal (or the mock PayPal client in demo mode);
// this store keeps the merchant's own data: plan catalog, customer engagement
// signals, rescue records and an audit log of every PayPal API call.

const crypto = require('crypto');

const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

const state = {
  settings: {
    autopilot: false, // false = merchant approves every rescue before it is sent
    merchantName: 'Brushwork Studio',
    brandVoice: 'warm, friendly and short. We are a small team of illustrators teaching digital painting.',
  },
  // Plan catalog. paypalPlanId is filled from env in live mode (see scripts/setup-paypal.js).
  plans: [
    { key: 'pro', name: 'Pro', price: 29, paypalPlanId: process.env.PAYPAL_PLAN_PRO || 'P-DEMO-PRO' },
    { key: 'basic', name: 'Basic', price: 12, paypalPlanId: process.env.PAYPAL_PLAN_BASIC || 'P-DEMO-BASIC' },
    { key: 'lite', name: 'Lite', price: 5, paypalPlanId: process.env.PAYPAL_PLAN_LITE || 'P-DEMO-LITE' },
  ],
  // Merchant-side customer profiles, keyed by PayPal subscription id.
  // In a real deployment these come from the merchant's own product analytics.
  customers: {},
  rescues: [],
  apiLog: [],
  events: [],
};

function planById(paypalPlanId) {
  return state.plans.find((p) => p.paypalPlanId === paypalPlanId);
}
function planByKey(key) {
  return state.plans.find((p) => p.key === key);
}

function logApi(entry) {
  state.apiLog.unshift({ ts: new Date().toISOString(), ...entry });
  state.apiLog = state.apiLog.slice(0, 80);
}

function logEvent(text, kind = 'info') {
  state.events.unshift({ ts: new Date().toISOString(), text, kind });
  state.events = state.events.slice(0, 80);
}

function addCustomer(subscriptionId, profile) {
  state.customers[subscriptionId] = { subscriptionId, ...profile };
}

function createRescue(data) {
  const rescue = { id: id('rsc'), createdAt: new Date().toISOString(), actions: [], ...data };
  state.rescues.unshift(rescue);
  return rescue;
}

function getRescue(rescueId) {
  return state.rescues.find((r) => r.id === rescueId);
}

function metrics() {
  const rescues = state.rescues;
  const recovered = rescues.filter((r) => r.status === 'recovered');
  const closed = rescues.filter((r) => ['recovered', 'lost'].includes(r.status));
  return {
    failedPayments: rescues.length,
    open: rescues.filter((r) => ['draft', 'sent', 'awaiting_paypal_approval'].includes(r.status)).length,
    recovered: recovered.length,
    recoveredMrr: recovered.reduce((s, r) => s + (r.recoveredMrr || 0), 0),
    atRiskMrr: rescues
      .filter((r) => !['recovered', 'lost'].includes(r.status))
      .reduce((s, r) => s + (r.planPrice || 0), 0),
    recoveryRate: closed.length ? Math.round((recovered.length / closed.length) * 100) : null,
  };
}

module.exports = { state, id, planById, planByKey, logApi, logEvent, addCustomer, createRescue, getRescue, metrics };
