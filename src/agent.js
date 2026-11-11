// The rescue agent.
// Claude gets a small, fixed set of tools: it can READ the PayPal subscription,
// the merchant's customer profile and the plan catalog, and it must finish by
// calling submit_rescue_plan. It cannot move money itself: the money actions
// (capture / suspend / revise) only run after the customer picks an option,
// and the server validates every plan against guardrails first.

const Anthropic = require('@anthropic-ai/sdk');
const { state, planById, planByKey } = require('./store');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const TOOLS = [
  {
    name: 'get_paypal_subscription',
    description:
      'Fetch the live PayPal subscription (GET /v1/billing/subscriptions/{id}): status, plan, start time, billing_info with failed payment count, outstanding balance and the last failed payment reason code.',
    input_schema: {
      type: 'object',
      properties: { subscription_id: { type: 'string' } },
      required: ['subscription_id'],
    },
  },
  {
    name: 'get_customer_profile',
    description:
      "Fetch the merchant's own data about this customer: engagement in the last 30 days, days since last active, support notes and anything they told us.",
    input_schema: {
      type: 'object',
      properties: { subscription_id: { type: 'string' } },
      required: ['subscription_id'],
    },
  },
  {
    name: 'get_plan_catalog',
    description: 'List the plans this merchant sells on PayPal, with monthly prices.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'submit_rescue_plan',
    description:
      'Submit the final rescue plan. Call this exactly once, at the end. The customer will see your recommended option first, plus the alternatives.',
    input_schema: {
      type: 'object',
      properties: {
        offer: {
          type: 'string',
          enum: ['retry', 'pause', 'downgrade'],
          description:
            'retry = charge the outstanding balance again via PayPal; pause = suspend the subscription for pause_months; downgrade = move to a cheaper plan (target_plan).',
        },
        target_plan: { type: 'string', enum: ['basic', 'lite'], description: 'Required when offer = downgrade.' },
        pause_months: { type: 'integer', minimum: 1, maximum: 3, description: 'Required when offer = pause.' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasoning: {
          type: 'string',
          description: '2-4 sentences for the merchant explaining why this offer fits this customer, citing the data.',
        },
        email_subject: { type: 'string' },
        email_body: {
          type: 'string',
          description:
            "Short, personal message to the customer in the merchant's brand voice. No guilt-tripping, no fake urgency. Under 110 words. Do not include a link, it is added automatically.",
        },
      },
      required: ['offer', 'confidence', 'reasoning', 'email_subject', 'email_body'],
    },
  },
];

function systemPrompt() {
  return `You are Churn Rescue, a retention agent for "${state.settings.merchantName}", a small subscription business that bills customers through PayPal.
A subscriber's PayPal payment just failed. Your job: investigate with your tools, then choose the ONE offer most likely to keep this customer as a paying subscriber, and write the message they will receive.

How to decide:
- retry: the customer is engaged and the failure looks temporary or technical (e.g. expired funding source, a one-off decline). Keep their plan.
- pause: the customer is a long-standing, loyal subscriber who is temporarily not using the product (seasonal, travel, life event). A pause keeps them instead of losing them.
- downgrade: the customer is using little of what they pay for, or price looks like the problem (repeated failures, low usage, cost complaints). A cheaper plan beats a cancellation.
Rules: only downgrade to a plan cheaper than the current one. Pauses are 1-3 months. Base your reasoning on the data you fetched, and mention concrete numbers.
Brand voice: ${state.settings.brandVoice}`;
}

async function runTool(name, input, ctx) {
  switch (name) {
    case 'get_paypal_subscription':
      return ctx.paypal.getSubscription(input.subscription_id);
    case 'get_customer_profile':
      return state.customers[input.subscription_id] || { note: 'No merchant data for this customer.' };
    case 'get_plan_catalog':
      return state.plans.map((p) => ({ key: p.key, name: p.name, price_usd_per_month: p.price }));
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// Server-side guardrails: the model proposes, the server decides what is allowed.
function validatePlan(plan, sub) {
  const current = planById(sub.plan_id);
  if (plan.offer === 'downgrade') {
    const target = planByKey(plan.target_plan);
    if (!target || !current || target.price >= current.price) {
      // fall back to the cheapest plan below the current one, or retry if none
      const cheaper = state.plans.filter((p) => current && p.price < current.price).sort((a, b) => b.price - a.price)[0];
      if (cheaper) plan.target_plan = cheaper.key;
      else plan.offer = 'retry';
    }
  }
  if (plan.offer === 'pause') plan.pause_months = Math.min(3, Math.max(1, plan.pause_months || 1));
  plan.confidence = Math.min(1, Math.max(0, Number(plan.confidence) || 0.5));
  return plan;
}

async function decideWithClaude(subscriptionId, ctx) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const trace = [];
  const messages = [
    {
      role: 'user',
      content: `PayPal webhook BILLING.SUBSCRIPTION.PAYMENT.FAILED received for subscription ${subscriptionId}. Investigate and submit a rescue plan.`,
    },
  ];
  for (let turn = 0; turn < 8; turn++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt(),
      tools: TOOLS,
      tool_choice: turn === 7 ? { type: 'tool', name: 'submit_rescue_plan' } : { type: 'any' },
      messages,
    });
    messages.push({ role: 'assistant', content: res.content });
    const toolUses = res.content.filter((b) => b.type === 'tool_use');
    const final = toolUses.find((t) => t.name === 'submit_rescue_plan');
    if (final) {
      trace.push({ tool: 'submit_rescue_plan' });
      return { plan: final.input, trace, decidedBy: `Claude (${MODEL})` };
    }
    const results = [];
    for (const tu of toolUses) {
      trace.push({ tool: tu.name, input: tu.input });
      let content;
      try {
        content = JSON.stringify(await runTool(tu.name, tu.input, ctx));
      } catch (e) {
        content = `Error: ${e.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('Agent did not submit a plan');
}

// Used only when no ANTHROPIC_API_KEY is configured. Clearly labelled in the UI.
async function decideWithRules(subscriptionId, ctx) {
  const sub = await ctx.paypal.getSubscription(subscriptionId);
  const profile = state.customers[subscriptionId] || {};
  const current = planById(sub.plan_id);
  const name = sub.subscriber?.name?.given_name || 'there';
  const fails = sub.billing_info?.failed_payments_count || 0;
  let plan;
  if ((profile.daysSinceActive || 0) > 21 && (profile.tenureMonths || 0) >= 6) {
    plan = { offer: 'pause', pause_months: 2, reasoning: `Inactive for ${profile.daysSinceActive} days but a ${profile.tenureMonths}-month customer: pausing preserves the relationship.` };
  } else if (fails >= 3 || (profile.sessionsLast30d || 0) < 4) {
    plan = { offer: 'downgrade', target_plan: current?.key === 'pro' ? 'basic' : 'lite', reasoning: `${fails} failed payments and low usage suggest price is the issue.` };
  } else {
    plan = { offer: 'retry', reasoning: `Engaged customer (${profile.sessionsLast30d} sessions in 30 days); failure looks temporary.` };
  }
  plan.confidence = 0.5;
  plan.email_subject = `Quick heads-up about your ${current?.name || ''} plan`;
  plan.email_body = `Hi ${name}, your latest PayPal payment didn't go through. No stress, it happens! We've picked an option below that we think suits you best. Just choose one and you're all set.`;
  return { plan, trace: [{ tool: 'get_paypal_subscription', input: { subscription_id: subscriptionId } }], decidedBy: 'Rules fallback (no ANTHROPIC_API_KEY)' };
}

async function decide(subscriptionId, ctx) {
  const useClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  const result = useClaude ? await decideWithClaude(subscriptionId, ctx) : await decideWithRules(subscriptionId, ctx);
  const sub = await ctx.paypal.getSubscription(subscriptionId);
  result.plan = validatePlan(result.plan, sub);
  result.subscription = sub;
  return result;
}

module.exports = { decide, MODEL, TOOLS };
