// One-time sandbox setup: creates a product, three monthly plans (Pro $29,
// Basic $12, Lite $5) and N subscriptions on the Pro/Basic plans.
// Prints the env lines to paste into .env and the approval links you open with
// a PayPal *sandbox* buyer account to activate each subscription.
//
//   node scripts/setup-paypal.js [numberOfSubscriptions=3]

require('dotenv').config({ quiet: true });
const { LivePayPal } = require('../src/paypal');

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) in .env first.');
  process.exit(1);
}
const pp = new LivePayPal({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET });

const plan = (productId, name, price) => ({
  product_id: productId,
  name: `Brushwork ${name}`,
  status: 'ACTIVE',
  billing_cycles: [
    {
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0,
      pricing_scheme: { fixed_price: { value: price, currency_code: 'USD' } },
    },
  ],
  payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
});

(async () => {
  const n = Number(process.argv[2] || 3);
  const product = await pp.request('POST', '/v1/catalogs/products', {
    name: 'Brushwork Studio membership',
    type: 'DIGITAL',
    category: 'EDUCATIONAL_AND_TEXTBOOKS',
  });
  const pro = await pp.request('POST', '/v1/billing/plans', plan(product.id, 'Pro', '29.00'));
  const basic = await pp.request('POST', '/v1/billing/plans', plan(product.id, 'Basic', '12.00'));
  const lite = await pp.request('POST', '/v1/billing/plans', plan(product.id, 'Lite', '5.00'));

  const subs = [];
  for (let i = 0; i < n; i++) {
    const s = await pp.request('POST', '/v1/billing/subscriptions', {
      plan_id: i % 2 === 0 ? pro.id : basic.id,
      application_context: {
        brand_name: 'Brushwork Studio',
        user_action: 'SUBSCRIBE_NOW',
        return_url: 'https://example.com/subscribed',
        cancel_url: 'https://example.com/cancelled',
      },
    });
    subs.push({ id: s.id, approve: s.links.find((l) => l.rel === 'approve').href });
  }

  console.log('\nAdd these lines to .env:\n');
  console.log(`PAYPAL_PLAN_PRO=${pro.id}`);
  console.log(`PAYPAL_PLAN_BASIC=${basic.id}`);
  console.log(`PAYPAL_PLAN_LITE=${lite.id}`);
  console.log(`PAYPAL_SUBSCRIPTION_IDS=${subs.map((s) => s.id).join(',')}`);
  console.log('\nApprove each subscription with a sandbox BUYER account (developer.paypal.com > Sandbox accounts):\n');
  subs.forEach((s) => console.log(`${s.id}: ${s.approve}`));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
