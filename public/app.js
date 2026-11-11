const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString();
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const OFFER_LABEL = { retry: 'Retry payment', pause: 'Pause', downgrade: 'Downgrade' };
const PLAN_NAME = { pro: 'Pro', basic: 'Basic', lite: 'Lite' };
const STATUS_LABEL = {
  thinking: 'Agent investigating…',
  draft: 'Needs your approval',
  sent: 'Offer sent',
  awaiting_paypal_approval: 'Customer approving in PayPal',
  recovered: 'Recovered',
  lost: 'Lost',
  error: 'Error',
};
const REASON_LABEL = {
  PAYMENT_DENIED: 'Payment denied',
  PAYER_CANNOT_PAY: 'Payer cannot pay',
  INTERNAL_SERVER_ERROR: 'PayPal error',
  PAYER_ACCOUNT_RESTRICTED: 'Payer account restricted',
};

let lastJson = '';

async function load() {
  const data = await fetch('/api/state').then((r) => r.json());
  const json = JSON.stringify(data);
  if (json === lastJson) return;
  lastJson = json;
  render(data);
}

function render(d) {
  $('#mode-badge').textContent = d.mode === 'live' ? 'PayPal: Sandbox (live API)' : 'PayPal: Demo mode (mock API)';
  $('#mode-badge').className = 'badge ' + (d.mode === 'live' ? 'live' : 'demo');
  $('#ai-badge').textContent = 'AI: ' + d.ai;
  $('#merchant').textContent = `${d.settings.merchantName} · AI recovery for failed PayPal subscription payments`;
  $('#autopilot').checked = d.settings.autopilot;
  $('#track').classList.toggle('hidden', d.mode !== 'live');

  const m = d.metrics;
  $('#k-risk').textContent = money(m.atRiskMrr);
  $('#k-rec').textContent = money(m.recoveredMrr);
  $('#k-saved').textContent = m.recovered;
  $('#k-saved-foot').textContent = `of ${m.failedPayments} failed payment${m.failedPayments === 1 ? '' : 's'}`;
  $('#k-rate').textContent = m.recoveryRate === null ? '–' : m.recoveryRate + '%';

  $('#subs').innerHTML = d.subscribers
    .map((s) => {
      const open = d.rescues.some((r) => r.subscriptionId === s.subscriptionId && !['recovered', 'lost', 'error'].includes(r.status));
      return `<tr>
        <td><div class="cust">${esc(s.name)}</div><div class="muted small">${s.tenureMonths ?? '?'} mo · ${s.sessionsLast30d ?? '?'} sessions/30d</div></td>
        <td>${esc(s.plan)}${s.price ? `<div class="muted small">${money(s.price)}/mo</div>` : ''}</td>
        <td><span class="st st-${esc(s.status)}">${esc(s.status)}</span></td>
        <td><button class="btn ghost small" data-fail="${esc(s.subscriptionId)}" ${open ? 'disabled' : ''}>Simulate failed payment</button></td>
      </tr>`;
    })
    .join('');

  if (d.rescues.length) {
    $('#rescues').innerHTML = d.rescues.map(rescueCard).join('');
  }

  $('#api').innerHTML = d.apiLog
    .map((a) => `<li><span class="t">${time(a.ts)}</span><span class="m m-${a.method}">${a.method}</span><span class="p">${esc(a.path)}</span><span class="code c${String(a.status)[0]}">${a.status}</span></li>`)
    .join('') || '<li class="muted">No calls yet</li>';

  $('#events').innerHTML = d.events
    .map((e) => `<li class="ev-${e.kind}"><span class="t">${time(e.ts)}</span>${esc(e.text)}</li>`)
    .join('');
}

function rescueCard(r) {
  const p = r.plan || {};
  const offer = p.offer ? `${OFFER_LABEL[p.offer]}${p.offer === 'downgrade' ? ' → ' + esc(PLAN_NAME[p.target_plan] || p.target_plan) : ''}${p.offer === 'pause' ? ` ${p.pause_months} month${p.pause_months > 1 ? 's' : ''}` : ''}` : '';
  const trace = (r.trace || []).map((t) => `<span class="chip">${esc(t.tool)}</span>`).join('<span class="arrow">→</span>');
  const offerUrl = `${location.origin}/offer/${r.id}`;
  let actions = '';
  if (r.status === 'draft') actions = `<button class="btn" data-approve="${r.id}">Approve &amp; send offer</button>`;
  if (['sent', 'awaiting_paypal_approval', 'recovered', 'lost'].includes(r.status))
    actions = `<a class="btn ghost" href="/offer/${r.id}" target="_blank">Open customer offer ↗</a>`;
  return `<article class="rescue r-${r.status}">
    <div class="r-top">
      <div>
        <div class="r-name">${esc(r.customer)}</div>
        <div class="muted small">${esc(r.planName || '')} ${r.planPrice ? '· ' + money(r.planPrice) + '/mo' : ''} · ${esc(REASON_LABEL[r.failureReason] || r.failureReason || '')} · ${r.failedCount ?? ''} failed payment${r.failedCount === 1 ? '' : 's'}</div>
      </div>
      <span class="pill p-${r.status}">${STATUS_LABEL[r.status] || r.status}</span>
    </div>
    ${r.status === 'thinking' ? '<div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span> Reading PayPal subscription history and customer data…</div>' : ''}
    ${r.status === 'error' ? `<div class="err">${esc(r.error)}</div>` : ''}
    ${p.offer ? `
      <div class="decision">
        <div class="decision-head"><span class="offer o-${p.offer}">${offer}</span><span class="muted small">${esc(r.decidedBy)} · confidence ${Math.round((p.confidence || 0) * 100)}%</span></div>
        <p class="reason">${esc(p.reasoning)}</p>
        ${trace ? `<div class="trace">${trace}</div>` : ''}
      </div>
      <details class="msg" ${r.status === 'draft' ? 'open' : ''}><summary>Message to customer: <b>${esc(p.email_subject)}</b></summary><p>${esc(p.email_body).replace(/\n/g, '<br>')}</p></details>` : ''}
    ${r.outcome ? `<div class="outcome ${r.status === 'recovered' ? 'good' : 'bad'}">${esc(r.outcome)}${r.recoveredMrr ? ` · +${money(r.recoveredMrr)}/mo` : ''}</div>` : ''}
    ${actions ? `<div class="r-actions">${actions}${r.status !== 'draft' ? `<span class="muted small mono">${esc(offerUrl)}</span>` : ''}</div>` : ''}
  </article>`;
}

document.addEventListener('click', async (e) => {
  const fail = e.target.closest('[data-fail]');
  if (fail) {
    fail.disabled = true;
    await fetch('/api/simulate-failure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriptionId: fail.dataset.fail }) });
    load();
  }
  const approve = e.target.closest('[data-approve]');
  if (approve) {
    await fetch(`/api/rescues/${approve.dataset.approve}/approve`, { method: 'POST' });
    load();
  }
});

$('#autopilot').addEventListener('change', (e) =>
  fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autopilot: e.target.checked }) }).then(load)
);

$('#track').addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriptionId: $('#track-id').value }) });
  $('#track-id').value = '';
  load();
});

load();
setInterval(load, 1500);
