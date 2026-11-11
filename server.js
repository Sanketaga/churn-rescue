require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const { state, logEvent, getRescue, metrics, planById, planByKey } = require('./src/store');
const { createPayPal } = require('./src/paypal');
const { seedDemo, seedLive } = require('./src/seed');
const rescue = require('./src/rescue');
const { MODEL } = require('./src/agent');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const ctx = { paypal: createPayPal() };
const PORT = process.env.PORT || 3000;
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// ---- startup --------------------------------------------------------------
async function snapshot(id) {
  try {
    state.customers[id].snapshot = await ctx.paypal.getSubscription(id);
  } catch (e) {
    state.customers[id].snapshotError = e.message;
  }
}

async function boot() {
  if (ctx.paypal.mode === 'demo') {
    seedDemo(ctx.paypal);
    logEvent('Demo mode: using a mock PayPal API (add sandbox keys in .env for live calls)');
  } else {
    const ids = (process.env.PAYPAL_SUBSCRIPTION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    seedLive(ids);
    logEvent(`Live mode: PayPal sandbox, tracking ${ids.length} subscription(s)`);
  }
  for (const id of Object.keys(state.customers)) await snapshot(id);
}

// ---- dashboard API ---------------------------------------------------------
app.get('/api/state', (req, res) => {
  const subscribers = Object.values(state.customers).map((c) => {
    const s = c.snapshot || {};
    const plan = planById(s.plan_id);
    const n = s.subscriber?.name || {};
    return {
      subscriptionId: c.subscriptionId,
      name: c.name || [n.given_name, n.surname].filter(Boolean).join(' ') || c.subscriptionId,
      email: s.subscriber?.email_address,
      status: s.status || 'UNKNOWN',
      plan: plan?.name || s.plan_id,
      price: plan?.price,
      tenureMonths: c.tenureMonths,
      sessionsLast30d: c.sessionsLast30d,
      failedCount: s.billing_info?.failed_payments_count || 0,
      error: c.snapshotError,
    };
  });
  res.json({
    mode: ctx.paypal.mode,
    ai: process.env.ANTHROPIC_API_KEY ? `Claude (${MODEL})` : 'Rules fallback (no ANTHROPIC_API_KEY)',
    settings: state.settings,
    metrics: metrics(),
    subscribers,
    rescues: state.rescues,
    apiLog: state.apiLog.slice(0, 25),
    events: state.events.slice(0, 25),
  });
});

app.post('/api/settings', (req, res) => {
  if (typeof req.body.autopilot === 'boolean') state.settings.autopilot = req.body.autopilot;
  res.json(state.settings);
});

// Fire a BILLING.SUBSCRIPTION.PAYMENT.FAILED event for a subscriber.
// Demo mode: the mock PayPal records a declined payment first.
// Live mode: PayPal can't be forced to decline, so we replay the event shape
// (use the PayPal Webhooks Simulator for a real PayPal-sent event).
app.post('/api/simulate-failure', async (req, res) => {
  const id = req.body.subscriptionId;
  const c = state.customers[id];
  if (!c) return res.status(404).json({ error: 'Unknown subscription' });
  if (ctx.paypal.mode === 'demo') {
    const plan = planById(c.snapshot.plan_id);
    ctx.paypal.failPayment(id, c.demoFailReason || 'PAYMENT_DENIED', plan.price.toFixed(2));
  }
  const event = {
    id: `WH-SIM-${Date.now()}`,
    event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
    resource_type: 'subscription',
    resource: { id },
    summary: 'Subscription payment failed',
  };
  res.json({ ok: true });
  await processEvent(event, 'simulated webhook');
  await snapshot(id);
});

app.post('/api/track', async (req, res) => {
  const id = (req.body.subscriptionId || '').trim();
  if (!id) return res.status(400).json({ error: 'subscriptionId required' });
  state.customers[id] = state.customers[id] || { subscriptionId: id, tenureMonths: null, sessionsLast30d: null };
  await snapshot(id);
  res.json(state.customers[id]);
});

app.post('/api/rescues/:id/approve', (req, res) => {
  try {
    res.json(rescue.approve(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- PayPal webhooks -------------------------------------------------------
async function processEvent(event, source) {
  if (event.event_type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
    await rescue.handlePaymentFailed(event.resource.id, ctx, source);
  } else if (event.event_type === 'BILLING.SUBSCRIPTION.SUSPENDED') {
    logEvent(`PayPal suspended ${event.resource.id} after failed payments`, 'alert');
    await rescue.handlePaymentFailed(event.resource.id, ctx, source);
  } else {
    logEvent(`Webhook ${event.event_type} received (no action)`);
  }
}

app.post('/webhooks/paypal', async (req, res) => {
  const event = req.body;
  let source = 'PayPal webhook';
  if (ctx.paypal.mode === 'live') {
    try {
      const v = await ctx.paypal.verifyWebhook(req.headers, event);
      source = v.verified ? 'PayPal webhook (signature verified)' : `PayPal webhook (unverified: ${v.reason || 'failed'})`;
      if (!v.verified && process.env.PAYPAL_WEBHOOK_ID) return res.sendStatus(400);
    } catch (e) {
      return res.sendStatus(400);
    }
  }
  res.sendStatus(200); // acknowledge fast, process in the background
  processEvent(event, source).catch((e) => logEvent(`Webhook processing failed: ${e.message}`, 'error'));
});

// ---- customer-facing offer -------------------------------------------------
app.get('/offer/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'offer.html')));

app.get('/api/offer/:id', (req, res) => {
  const r = getRescue(req.params.id);
  if (!r || r.status === 'thinking' || r.status === 'draft') return res.status(404).json({ error: 'Offer not found' });
  const current = planByKey(r.planKey);
  const target = planByKey(r.plan.target_plan) || state.plans.filter((p) => p.price < (current?.price || 0)).sort((a, b) => b.price - a.price)[0];
  const options = [
    { key: 'retry', title: `Keep ${r.planName}`, detail: `Retry your $${r.planPrice} payment with PayPal and keep everything as it is.` },
    { key: 'pause', title: `Pause for ${r.plan.pause_months || 1} month${(r.plan.pause_months || 1) > 1 ? 's' : ''}`, detail: 'No charge while paused. Your progress and files stay safe.' },
  ];
  if (target) options.push({ key: 'downgrade', title: `Switch to ${target.name}`, detail: `$${target.price}/month instead of $${r.planPrice}. Change approved securely with PayPal.` });
  options.sort((a, b) => (a.key === r.plan.offer ? -1 : b.key === r.plan.offer ? 1 : 0));
  res.json({
    merchant: state.settings.merchantName,
    customer: r.customer,
    subject: r.plan.email_subject,
    message: r.plan.email_body,
    recommended: r.plan.offer,
    options,
    status: r.status,
    outcome: r.outcome,
  });
});

app.post('/api/offer/:id/accept', async (req, res) => {
  try {
    res.json(await rescue.accept(req.params.id, req.body.option, ctx, baseUrl(req)));
    const r = getRescue(req.params.id);
    if (r) await snapshot(r.subscriptionId);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/offer/:id/decline', (req, res) => {
  try {
    res.json(rescue.decline(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/offer/:id/approved', async (req, res) => {
  try {
    const r = await rescue.confirmRevision(req.params.id, ctx);
    if (r) await snapshot(r.subscriptionId);
  } catch (e) {
    logEvent(`Could not confirm plan change: ${e.message}`, 'error');
  }
  res.redirect(`/offer/${req.params.id}`);
});

// ---- demo-mode stand-in for the PayPal approval page -----------------------
app.get('/mock-paypal/approve', (req, res) => {
  if (ctx.paypal.mode !== 'demo') return res.sendStatus(404);
  const plan = planById(req.query.plan);
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Approve plan change</title><link rel="stylesheet" href="/styles.css"></head>
  <body class="pp-page"><div class="pp-card">
  <div class="pp-banner">Demo mode: simulated PayPal approval step</div>
  <div class="pp-logo">Approval step</div>
  <p class="muted small">In live mode this is PayPal's own approval page, returned by POST /v1/billing/subscriptions/{id}/revise.</p>
  <h2>Approve your subscription change</h2>
  <p>${state.settings.merchantName} is asking to change your plan to <b>${plan?.name}</b> at <b>$${plan?.price?.toFixed(2)}/month</b>.</p>
  <form method="post" action="/mock-paypal/approve">
    <input type="hidden" name="sub" value="${String(req.query.sub).replace(/"/g, '')}">
    <input type="hidden" name="plan" value="${String(req.query.plan).replace(/"/g, '')}">
    <input type="hidden" name="return" value="${String(req.query.return).replace(/"/g, '')}">
    <button class="pp-btn" type="submit">Agree &amp; Continue</button>
  </form></div></body></html>`);
});

app.post('/mock-paypal/approve', (req, res) => {
  if (ctx.paypal.mode !== 'demo') return res.sendStatus(404);
  ctx.paypal.applyRevision(req.body.sub, req.body.plan);
  const ret = new URL(req.body.return, baseUrl(req));
  res.redirect(ret.pathname); // only ever redirect within this app
});

app.get('/health', (req, res) => res.json({ ok: true, mode: ctx.paypal.mode }));

boot().then(() => {
  app.listen(PORT, () => {
    console.log(`Churn Rescue running on http://localhost:${PORT}  [PayPal: ${ctx.paypal.mode}] [AI: ${process.env.ANTHROPIC_API_KEY ? MODEL : 'rules fallback'}]`);
  });
});
