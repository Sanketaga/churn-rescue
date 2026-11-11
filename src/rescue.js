// Orchestration: PayPal webhook -> agent decision -> customer offer -> PayPal action.

const { state, planById, planByKey, logEvent, createRescue, getRescue } = require('./store');
const agent = require('./agent');

function customerName(sub) {
  const n = sub.subscriber?.name || {};
  return [n.given_name, n.surname].filter(Boolean).join(' ') || sub.subscriber?.email_address || sub.id;
}

// Called for BILLING.SUBSCRIPTION.PAYMENT.FAILED (from PayPal, or the simulator).
async function handlePaymentFailed(subscriptionId, ctx, source) {
  const existing = state.rescues.find(
    (r) => r.subscriptionId === subscriptionId && ['thinking', 'draft', 'sent', 'awaiting_paypal_approval'].includes(r.status)
  );
  if (existing) {
    logEvent(`Rescue already open for ${subscriptionId}, ignoring duplicate event`);
    return existing;
  }
  const rescue = createRescue({ subscriptionId, status: 'thinking', source, customer: subscriptionId });
  logEvent(`Webhook BILLING.SUBSCRIPTION.PAYMENT.FAILED for ${subscriptionId} (${source})`, 'alert');
  try {
    const { plan, trace, decidedBy, subscription } = await agent.decide(subscriptionId, ctx);
    const current = planById(subscription.plan_id);
    Object.assign(rescue, {
      customer: customerName(subscription),
      email: subscription.subscriber?.email_address,
      planKey: current?.key,
      planName: current?.name,
      planPrice: current?.price || 0,
      failureReason: subscription.billing_info?.last_failed_payment?.reason_code || 'UNKNOWN',
      failedCount: subscription.billing_info?.failed_payments_count || 0,
      outstanding: subscription.billing_info?.outstanding_balance,
      plan,
      trace,
      decidedBy,
      status: state.settings.autopilot ? 'sent' : 'draft',
    });
    logEvent(`${decidedBy} recommends "${plan.offer}" for ${rescue.customer}`, 'ai');
    if (state.settings.autopilot) logEvent(`Autopilot sent rescue offer to ${rescue.customer}`);
  } catch (e) {
    rescue.status = 'error';
    rescue.error = e.message;
    logEvent(`Agent error for ${subscriptionId}: ${e.message}`, 'error');
  }
  return rescue;
}

function approve(rescueId) {
  const r = getRescue(rescueId);
  if (!r || r.status !== 'draft') throw new Error('Rescue is not awaiting approval');
  r.status = 'sent';
  r.sentAt = new Date().toISOString();
  logEvent(`Merchant approved and sent rescue offer to ${r.customer}`);
  return r;
}

// The customer accepted an option on the offer page. This is where money moves.
async function accept(rescueId, option, ctx, baseUrl) {
  const r = getRescue(rescueId);
  if (!r || !['sent', 'awaiting_paypal_approval'].includes(r.status)) throw new Error('This offer is no longer active');
  const pp = ctx.paypal;
  const chosen = { offer: option };
  r.chosen = chosen;

  if (option === 'retry') {
    const amount = r.outstanding?.value && r.outstanding.value !== '0.0' && r.outstanding.value !== '0.00'
      ? r.outstanding
      : { currency_code: 'USD', value: r.planPrice.toFixed(2) };
    const capture = await pp.captureOutstanding(r.subscriptionId, amount, 'Churn Rescue: customer retried payment');
    r.actions.push({ action: 'capture', detail: capture.status || 'submitted' });
    finish(r, r.planPrice, `Payment of $${amount.value} captured, ${r.planName} plan kept`);
    return { done: true };
  }

  if (option === 'pause') {
    const months = r.plan.pause_months || 1;
    await pp.suspend(r.subscriptionId, `Paused for ${months} month(s) at customer request (Churn Rescue)`);
    const resumeOn = new Date();
    resumeOn.setMonth(resumeOn.getMonth() + months);
    r.resumeOn = resumeOn.toISOString();
    r.actions.push({ action: 'suspend', detail: `resumes ${resumeOn.toDateString()}` });
    finish(r, 0, `Subscription paused for ${months} month(s), resumes ${resumeOn.toDateString()}`);
    r.savedMrr = r.planPrice;
    return { done: true };
  }

  if (option === 'downgrade') {
    const targetKey = r.plan.target_plan || (r.planKey === 'pro' ? 'basic' : 'lite');
    const target = planByKey(targetKey);
    const returnUrl = `${baseUrl}/offer/${r.id}/approved`;
    const cancelUrl = `${baseUrl}/offer/${r.id}`;
    const revision = await pp.revise(r.subscriptionId, target.paypalPlanId, returnUrl, cancelUrl);
    const approveLink = revision.links?.find((l) => l.rel === 'approve')?.href;
    r.pendingTarget = target.key;
    r.actions.push({ action: 'revise', detail: `to ${target.name}` });
    if (approveLink) {
      r.status = 'awaiting_paypal_approval';
      logEvent(`${r.customer} chose ${target.name}; waiting for PayPal approval`);
      return { redirect: approveLink };
    }
    finish(r, target.price, `Moved to ${target.name} plan ($${target.price}/mo)`);
    return { done: true };
  }
  throw new Error('Unknown option');
}

// Customer returned from PayPal after approving the plan revision.
async function confirmRevision(rescueId, ctx) {
  const r = getRescue(rescueId);
  if (!r || r.status !== 'awaiting_paypal_approval') return r;
  const target = planByKey(r.pendingTarget);
  if (ctx.paypal.mode === 'live') {
    // PayPal moves the outstanding balance onto the revised subscription; re-activate if it was suspended.
    const sub = await ctx.paypal.getSubscription(r.subscriptionId);
    if (sub.status === 'SUSPENDED') await ctx.paypal.activate(r.subscriptionId, 'Reactivated after plan change');
  }
  finish(r, target.price, `Moved to ${target.name} plan ($${target.price}/mo) via PayPal approval`);
  return r;
}

function finish(r, recoveredMrr, summary) {
  r.status = 'recovered';
  r.recoveredMrr = recoveredMrr;
  r.outcome = summary;
  r.recoveredAt = new Date().toISOString();
  logEvent(`Recovered ${r.customer}: ${summary}`, 'success');
}

function decline(rescueId) {
  const r = getRescue(rescueId);
  if (!r) throw new Error('Not found');
  r.status = 'lost';
  r.outcome = 'Customer chose to cancel';
  logEvent(`${r.customer} declined all options`, 'error');
  return r;
}

module.exports = { handlePaymentFailed, approve, accept, confirmRevision, decline };
