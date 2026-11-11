// End-to-end check: start the server, fail every subscriber's payment,
// approve each rescue, accept the recommended option, and verify recovery.
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3999;
const base = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (url, opts = {}) =>
  fetch(base + url, { headers: { 'Content-Type': 'application/json' }, ...opts }).then((r) => r.json());

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT },
    stdio: 'inherit',
  });
  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(base + '/health'); break; } catch { await sleep(250); }
    }
    let state = await json('/api/state');
    console.log(`mode=${state.mode} ai=${state.ai} subscribers=${state.subscribers.length}`);
    for (const s of state.subscribers) {
      await json('/api/simulate-failure', { method: 'POST', body: JSON.stringify({ subscriptionId: s.subscriptionId }) });
    }
    for (let i = 0; i < 120; i++) {
      state = await json('/api/state');
      if (state.rescues.every((r) => r.status !== 'thinking')) break;
      await sleep(1000);
    }
    for (const r of state.rescues) {
      if (r.status === 'error') throw new Error(`${r.customer}: ${r.error}`);
      console.log(`- ${r.customer}: ${r.plan.offer}${r.plan.target_plan ? ' -> ' + r.plan.target_plan : ''} | ${r.plan.reasoning}`);
      await json(`/api/rescues/${r.id}/approve`, { method: 'POST' });
      const out = await json(`/api/offer/${r.id}/accept`, { method: 'POST', body: JSON.stringify({ option: r.plan.offer }) });
      if (out.redirect) {
        const u = new URL(out.redirect, base);
        const form = new URLSearchParams({ sub: u.searchParams.get('sub'), plan: u.searchParams.get('plan'), return: u.searchParams.get('return') });
        const res = await fetch(base + '/mock-paypal/approve', { method: 'POST', body: form, redirect: 'manual' });
        await fetch(base + res.headers.get('location'), { redirect: 'manual' });
      }
    }
    state = await json('/api/state');
    console.log('metrics', state.metrics);
    if (state.metrics.recovered !== state.subscribers.length) throw new Error('Not every rescue recovered');
    console.log('SMOKE TEST PASSED');
  } finally {
    server.kill();
  }
})().catch((e) => {
  console.error('SMOKE TEST FAILED:', e.message);
  process.exit(1);
});
