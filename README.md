# Churn Rescue

**An AI agent that turns failed PayPal subscription payments into saved customers.**

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (Build what's next with PayPal and AI).

Small subscription businesses (creators, course sellers, indie SaaS) lose a big share of subscribers to *failed payments*, not to people deciding to cancel. Most only send one generic "your payment failed" email. Churn Rescue listens for PayPal payment-failure webhooks, lets an AI agent investigate each customer, picks the offer most likely to keep them (**retry**, **pause** or **downgrade**), writes a personal message, and then carries out the customer's choice through the PayPal Subscriptions API.

![flow](https://img.shields.io/badge/PayPal-Subscriptions%20%2B%20Webhooks-0070e0) ![ai](https://img.shields.io/badge/AI-Claude%20tool%20use-6d3cf0) ![license](https://img.shields.io/badge/license-MIT-green)

## How it works

```
PayPal webhook                     AI agent (Claude, tool use)                 Customer           PayPal action
BILLING.SUBSCRIPTION.  ──►  get_paypal_subscription (PayPal API)   ──►  merchant   ──►  offer   ──►  retry    → POST /subscriptions/{id}/capture
PAYMENT.FAILED              get_customer_profile   (merchant data)       approves       page        pause    → POST /subscriptions/{id}/suspend
                            get_plan_catalog                                                        downgrade→ POST /subscriptions/{id}/revise
                            submit_rescue_plan  ──► guardrails                                                  (customer approves on PayPal)
```

1. **Detect.** `POST /webhooks/paypal` receives `BILLING.SUBSCRIPTION.PAYMENT.FAILED` (and `BILLING.SUBSCRIPTION.SUSPENDED`). In live mode the signature is checked with `POST /v1/notifications/verify-webhook-signature`.
2. **Investigate.** A Claude agent calls tools: it reads the real subscription from `GET /v1/billing/subscriptions/{id}` (plan, tenure, failed payment count, last failure reason code, outstanding balance), the merchant's own engagement data, and the plan catalog.
3. **Decide.** The agent submits one rescue plan (offer, reasoning that cites the data, confidence, and a short message in the merchant's brand voice). **Server-side guardrails** validate it: downgrades must be to a cheaper plan, pauses are 1–3 months. The AI never moves money directly.
4. **Approve.** By default the merchant reviews and approves each rescue (or turns on **Autopilot**).
5. **Act through PayPal.** The customer opens their offer page and picks an option:
   - **Retry**: `POST /v1/billing/subscriptions/{id}/capture` charges the outstanding balance.
   - **Pause**: `POST /v1/billing/subscriptions/{id}/suspend`, resume date tracked.
   - **Downgrade**: `POST /v1/billing/subscriptions/{id}/revise` returns a PayPal approval link; the customer approves the cheaper plan on PayPal and is returned to the app.
6. **Measure.** The dashboard shows revenue at risk, revenue recovered, subscribers saved, recovery rate, and a live audit log of every PayPal API call.

## Tech

| Part | Used for |
|---|---|
| **PayPal Subscriptions API** | reading subscriptions; capture, suspend, activate, revise |
| **PayPal Webhooks** | payment-failure events + signature verification |
| **PayPal Catalog Products / Plans API** | `scripts/setup-paypal.js` creates the product and Pro/Basic/Lite plans |
| **Claude (Anthropic API, tool use)** | the rescue agent: investigates, decides, explains, writes the message |
| Node.js + Express, vanilla JS | server, merchant dashboard, customer offer page |

## Run it

Requires Node 18+.

```bash
git clone <this repo>
cd churn-rescue
npm install
cp .env.example .env     # optional, see below
npm start                # http://localhost:3000
```

### Modes

The app runs with zero configuration so judges can try it immediately, and switches to real services when keys are present. The current mode is always shown in the header.

| | No keys | With keys |
|---|---|---|
| PayPal | **Demo mode**: an in-memory mock that returns the same response shapes as the PayPal API | **Sandbox**: real calls to `api-m.sandbox.paypal.com` |
| AI | **Rules fallback** (simple heuristics, labelled in the UI) | **Claude** tool-use agent |

For the full experience, set `ANTHROPIC_API_KEY` in `.env` (a few cents of usage).

### Try the demo (2 minutes)

1. `npm start` and open http://localhost:3000
2. Click **Simulate failed payment** next to a subscriber (try *Aisha*, *Diego* and *Maya*: they need different rescues).
3. Watch the agent investigate, then read its recommendation and reasoning. Click **Approve & send offer**.
4. Click **Open customer offer** and choose the recommended option. For a downgrade you go through the PayPal approval step.
5. Back on the dashboard: the subscriber is recovered and revenue recovered goes up. The PayPal API log shows every call that was made.

### Use your PayPal sandbox

1. Create a sandbox app at [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → Sandbox, and put the Client ID and Secret in `.env`.
2. `npm run setup:paypal` creates a product, three plans and a few subscriptions, and prints the IDs to add to `.env` plus approval links. Open each link while logged in as a **sandbox buyer** account to activate the subscription.
3. `npm start`. The dashboard now reads your real sandbox subscriptions, and every action calls the PayPal sandbox API.
4. To receive real webhooks, expose the app (e.g. deploy to Render or use a tunnel), add a webhook in your sandbox app pointing to `https://<your-url>/webhooks/paypal` with the `BILLING.SUBSCRIPTION.PAYMENT.FAILED` event, set `PAYPAL_WEBHOOK_ID` and `PUBLIC_URL`, and send a test event with the **Webhooks Simulator** in the PayPal developer dashboard. The **Simulate failed payment** button replays the same event locally, because the sandbox can't be forced to decline a payment on demand.

### Test

```bash
npm test   # starts the server, fails every subscriber's payment, approves, accepts and checks recovery
```

## Project structure

```
server.js              Express app: dashboard API, PayPal webhook, offer pages
src/paypal.js          Live PayPal REST client + demo-mode mock with the same interface
src/agent.js           Claude tool-use agent, guardrails, rules fallback
src/rescue.js          Orchestration: webhook → decision → approval → PayPal action
src/store.js           In-memory state, plan catalog, metrics, audit log
src/seed.js            Sample subscribers for "Brushwork Studio", a small art-course business
scripts/setup-paypal.js  Creates sandbox product, plans and subscriptions
scripts/smoke-test.js    End-to-end test
public/                Dashboard and customer offer page
```

## Notes and limits

- Customer engagement data (sessions, notes) is sample merchant data; in production it would come from the merchant's own analytics or CRM.
- Message delivery is shown as an offer link; plugging in an email provider is a small next step.
- State is in memory, so restarting the server resets the demo.
- Never commit `.env`. Use sandbox credentials only.

## What's next

Smarter retry timing, A/B testing of offers, multi-language messages, and a Zapier integration so rescue events flow into tools merchants already use.

## License

[MIT](LICENSE)
