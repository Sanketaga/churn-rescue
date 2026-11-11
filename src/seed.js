// Sample subscribers for "Brushwork Studio", a small online art-course business.
// In demo mode these become mock PayPal subscriptions. In live mode, the same
// merchant profiles are attached to your real sandbox subscription IDs (in order).

const { state, planByKey, addCustomer } = require('./store');

const monthsAgo = (m) => {
  const d = new Date();
  d.setMonth(d.getMonth() - m);
  return d.toISOString();
};

const SAMPLE = [
  {
    given: 'Maya', surname: 'Chen', email: 'maya.chen@example.com', plan: 'pro', tenure: 14,
    failReason: 'PAYMENT_DENIED', prevFails: 0,
    profile: { sessionsLast30d: 22, daysSinceActive: 1, lessonsCompleted: 61, notes: 'Posts in the community weekly. Mentioned in chat that she got a new bank card last week.' },
  },
  {
    given: 'Diego', surname: 'Alvarez', email: 'diego.alvarez@example.com', plan: 'pro', tenure: 4,
    failReason: 'PAYER_CANNOT_PAY', prevFails: 2,
    profile: { sessionsLast30d: 3, daysSinceActive: 9, lessonsCompleted: 7, notes: 'Only uses the beginner sketching course. Support ticket: "is there a cheaper option? money is tight this month."' },
  },
  {
    given: 'Aisha', surname: 'Bello', email: 'aisha.bello@example.com', plan: 'basic', tenure: 26,
    failReason: 'PAYER_CANNOT_PAY', prevFails: 0,
    profile: { sessionsLast30d: 0, daysSinceActive: 38, lessonsCompleted: 140, notes: 'Art teacher. Told support she is travelling for two months for a family wedding.' },
  },
  {
    given: 'Tom', surname: 'Becker', email: 'tom.becker@example.com', plan: 'basic', tenure: 7,
    failReason: 'PAYMENT_DENIED', prevFails: 1,
    profile: { sessionsLast30d: 15, daysSinceActive: 2, lessonsCompleted: 33, notes: 'Active in the portrait course.' },
  },
  {
    given: 'Priya', surname: 'Nair', email: 'priya.nair@example.com', plan: 'pro', tenure: 9,
    failReason: 'PAYER_CANNOT_PAY', prevFails: 3,
    profile: { sessionsLast30d: 5, daysSinceActive: 6, lessonsCompleted: 18, notes: 'Signed up during a Pro promo. Uses only the brush-pack downloads.' },
  },
];

function seedDemo(mockPayPal) {
  SAMPLE.forEach((s, i) => {
    const plan = planByKey(s.plan);
    const id = `I-DEMO${(1000 + i * 137).toString()}${s.given.toUpperCase()}`;
    mockPayPal.seed({
      id,
      status: 'ACTIVE',
      plan_id: plan.paypalPlanId,
      start_time: monthsAgo(s.tenure),
      subscriber: { name: { given_name: s.given, surname: s.surname }, email_address: s.email },
      billing_info: {
        outstanding_balance: { currency_code: 'USD', value: '0.00' },
        cycle_executions: [{ tenure_type: 'REGULAR', sequence: 1, cycles_completed: s.tenure, cycles_remaining: 0, total_cycles: 0 }],
        last_payment: { amount: { currency_code: 'USD', value: plan.price.toFixed(2) }, time: monthsAgo(1) },
        failed_payments_count: s.prevFails,
        next_billing_time: new Date().toISOString(),
      },
    });
    addCustomer(id, { name: `${s.given} ${s.surname}`, tenureMonths: s.tenure, demoFailReason: s.failReason, ...s.profile });
  });
}

// Live mode: attach sample profiles to your own sandbox subscriptions.
function seedLive(subscriptionIds) {
  subscriptionIds.forEach((id, i) => {
    const s = SAMPLE[i % SAMPLE.length];
    addCustomer(id, { name: null, tenureMonths: s.tenure, ...s.profile });
  });
}

module.exports = { seedDemo, seedLive, SAMPLE };
