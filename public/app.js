// Mo3ty RSI Engine dashboard. Vanilla JS + canvas; polls /api/state every few seconds.

const POLL_MS = 3000;
const TF_MS = 15 * 60 * 1000;
const RING_C = 2 * Math.PI * 27; // circumference of the countdown ring
const C = {
  green: '#34d399',
  red: '#f87171',
  pink: '#f472b6',
  lime: '#a3e635',
  amber: '#fbbf24',
  cyan: '#22d3ee',
  violet: '#a78bfa',
  blue: '#60a5fa',
  text: '#e6ebff',
  muted: '#8b95c4',
  grid: 'rgba(129,140,248,0.10)',
};

const ui = {
  snap: null,
  sigFilter: 'ALL',
  offsetMs: 0,
  lastOk: 0,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function fmtPrice(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtUsd(v, signed = false) {
  if (!isNum(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!signed) return `${v < 0 ? '-' : ''}$${s}`;
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}$${s}`;
}
function fmtPct(v, signed = false, d = 2) {
  if (!isNum(v)) return '—';
  return `${signed && v > 0 ? '+' : ''}${v.toFixed(d)}%`;
}
function fmtNum(v, d = 2) {
  if (!isNum(v)) return '—';
  return v.toFixed(d);
}
function hms(t) {
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' });
}
function dt(t) {
  if (!t) return '—';
  const d = new Date(t);
  return d.toLocaleString('en-GB', { hour12: false, timeZone: 'UTC', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function ago(t) {
  if (!t) return '—';
  const s = Math.max(0, Math.round((Date.now() - ui.offsetMs - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const clsPnl = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

// ---------- data polling ----------
async function poll() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    ui.snap = snap;
    ui.offsetMs = Date.now() - snap.generatedAt;
    ui.lastOk = Date.now();
    render();
  } catch (err) {
    showConnectionError(err);
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

function showConnectionError(err) {
  const bar = $('#alertBar');
  bar.className = 'alert warn';
  bar.textContent = `Cannot reach the engine (${err.message}). Retrying…`;
}

// ---------- render orchestration ----------
function render() {
  const s = ui.snap;
  if (!s) return;
  renderBadges(s);
  renderAlert(s);
  renderRules(s);
  renderKpis(s);
  renderEquity(s);
  renderPerf(s);
  renderPnl(s);
  renderPositions(s);
  renderTrades(s);
  renderSignals(s);
  renderEvents(s);
  $('#lastTick').textContent = s.status.lastTickAt
    ? `last poll ${ago(s.status.lastTickAt)} · tick #${s.status.tickCount} · ${s.config.symbols.length} symbols`
    : 'waiting for first poll…';
}

function renderBadges(s) {
  const modeCls = s.mode === 'live' ? 'live' : 'paper';
  const dataCls = s.dataSource === 'synthetic' ? 'synthetic' : 'mexc';
  const dataLabel = s.dataSource === 'synthetic' ? 'Simulated data' : 'MEXC market data';
  const stCls = s.status.state === 'RUNNING' ? 'running' : 'warning';
  $('#badges').innerHTML = `
    <span class="badge ${modeCls}"><span class="pip"></span>${s.mode === 'live' ? 'LIVE trading' : 'Paper trading'}</span>
    <span class="badge ${dataCls}"><span class="pip"></span>${dataLabel}</span>
    <span class="badge ${stCls}"><span class="pip"></span>${s.status.state === 'RUNNING' ? 'Engine running' : 'Check warnings'}</span>
    <span class="badge paper" style="color:var(--violet)"><span class="pip"></span>${s.timeframe} · 1:${s.config.rewardRatio} R:R</span>`;
}

function renderAlert(s) {
  const bar = $('#alertBar');
  const msgs = [];
  let cls = 'alert';
  if (s.mode === 'live') {
    cls = 'alert live';
    msgs.push('LIVE TRADING: real orders are placed on MEXC with your account balance.');
  } else if (s.dataSource === 'synthetic') {
    cls = 'alert warn';
    msgs.push('Simulated demo data — these are generated candles, not real market prices.');
  }
  if (s.status.lastError && Date.now() - ui.offsetMs - s.status.lastError.t < 10 * 60 * 1000) {
    cls = s.mode === 'live' ? 'alert live' : 'alert warn';
    msgs.push(`Last error: ${s.status.lastError.msg}`);
  }
  const erred = s.symbols.filter((x) => x.status === 'ERROR');
  if (erred.length) msgs.push(`Data issues on ${erred.map((x) => x.symbol).join(', ')}`);
  if (msgs.length === 0) {
    bar.className = 'alert hidden';
    bar.textContent = '';
    return;
  }
  bar.className = cls;
  bar.textContent = msgs.join('   •   ');
}

function renderRules(s) {
  const c = s.config;
  const chips = [
    `<span class="rule-chip buy">▲ Bull divergence <span class="k">→</span> <b>BUY / LONG</b></span>`,
    `<span class="rule-chip sell">▼ Bear divergence <span class="k">→</span> <b>SELL / SHORT</b></span>`,
    `<span class="rule-chip tf">◷ <b>${s.timeframe}</b> <span class="k">closed bars only</span></span>`,
    `<span class="rule-chip rr">◎ TP <b>1:${c.rewardRatio}</b> <span class="k">· SL = swing ${c.stopBufferPct ? `+${c.stopBufferPct}%` : 'low / high'}</span></span>`,
    `<span class="rule-chip size">◆ Margin <b>${c.riskMarginPct}%</b> <span class="k">× </span><b>${c.leverage}x</b></span>`,
    `<span class="rule-chip gate">≈ CHOP &lt; <b>${c.chopMax}</b> <span class="k">&amp; ATR ratio ≥</span> <b>${c.volRatioMin}</b></span>`,
    `<span class="rule-chip size">≡ Max open <b>${c.maxOpenPositions}</b></span>`,
  ];
  $('#ruleStrip').innerHTML = chips.join('');
}

function renderKpis(s) {
  const a = s.account;
  const st = s.stats;
  const winP = Math.max(0, Math.min(100, st.winRate || 0));
  const pf = st.profitFactor === Infinity ? '∞' : fmtNum(st.profitFactor, 2);
  const cards = [
    { cls: 'k-cyan', label: 'Equity', value: fmtUsd(a.equity), sub: `balance ${fmtUsd(a.balance)}` },
    { cls: 'k-violet', label: 'Available margin', value: fmtUsd(a.available), sub: `in use ${fmtUsd(a.marginUsed)}` },
    { cls: a.unrealized >= 0 ? 'k-green' : 'k-red', label: 'Unrealised PnL', value: fmtUsd(a.unrealized, true), sub: `${fmtPct(a.equity ? (a.unrealized / a.equity) * 100 : 0, true)} of equity` },
    { cls: a.pnlTotal >= 0 ? 'k-lime' : 'k-red', label: 'Total PnL', value: fmtUsd(a.pnlTotal, true), sub: `${fmtPct(a.pnlTotalPct, true)} vs start ${fmtUsd(a.startEquity)}` },
    { cls: 'k-blue', label: 'Win rate', value: fmtPct(st.winRate, false, 1), sub: `${st.wins}W · ${st.losses}L · ${st.trades} trades`, ring: winP },
    { cls: 'k-pink', label: 'Profit factor', value: pf, sub: `avg R ${fmtNum(st.avgR, 2)} · streak ${st.streak >= 0 ? '+' : ''}${st.streak}` },
    { cls: 'k-amber', label: 'Max drawdown', value: fmtPct(st.maxDrawdownPct, false, 2), sub: `best ${fmtUsd(st.bestTrade, true)} · worst ${fmtUsd(st.worstTrade, true)}` },
    { cls: st.pnlToday >= 0 ? 'k-green' : 'k-red', label: "Today's PnL", value: fmtUsd(st.pnlToday, true), sub: `${st.tradesToday} closed today` },
  ];
  $('#kpis').innerHTML = cards
    .map(
      (k) => `
      <div class="kpi ${k.cls}">
        <div class="label">${k.label}</div>
        <div class="value">${k.value}</div>
        <div class="sub">${k.sub}</div>
        ${k.ring !== undefined ? `<div class="winring" style="--p:${k.ring.toFixed(1)}"><span>${k.ring.toFixed(0)}%</span></div>` : ''}
      </div>`,
    )
    .join('');
}

// ---------- canvas helpers ----------
function prepCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(20, rect.width);
  const h = Math.max(20, rect.height);
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function text(ctx, str, x, y, color = C.muted, size = 11, align = 'left', weight = 600) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}

function labelBox(ctx, str, x, y, bg, fg = '#0b1020') {
  ctx.font = '700 11px ui-monospace, Menlo, Consolas, monospace';
  const w = ctx.measureText(str).width + 10;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y - 9, w, 18, 5);
  ctx.fill();
  text(ctx, str, x + 5, y, fg, 11, 'left', 700);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hLine(ctx, x1, x2, y, color, dash = [], width = 1) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

// ---------- equity chart ----------
function renderEquity(s) {
  const canvas = $('#equityChart');
  const { ctx, w, h } = prepCanvas(canvas);
  const pts = s.equity || [];
  $('#equitySub').textContent = pts.length
    ? `${pts.length} points · start ${fmtUsd(s.account.startEquity)} · now ${fmtUsd(s.account.equity)}`
    : 'Equity will appear after the first poll';
  if (pts.length < 2) {
    text(ctx, 'Collecting equity points…', w / 2, h / 2, C.muted, 12, 'center');
    return;
  }
  const padL = 10, padR = 84, padT = 14, padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const vals = pts.map((p) => p.equity);
  let lo = Math.min(...vals, s.account.startEquity);
  let hi = Math.max(...vals, s.account.startEquity);
  const span = hi - lo || Math.max(1, hi * 0.001);
  lo -= span * 0.1;
  hi += span * 0.1;
  const y = (v) => padT + ((hi - v) / (hi - lo)) * plotH;
  const x = (i) => padL + (i / (pts.length - 1)) * plotW;

  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) * k) / 3;
    hLine(ctx, padL, w - padR, y(v), C.grid, [3, 4]);
    text(ctx, fmtUsd(v).replace('$', ''), w - padR + 6, y(v), C.muted, 10);
  }
  // baseline
  hLine(ctx, padL, w - padR, y(s.account.startEquity), 'rgba(251,191,36,0.6)', [6, 4], 1.2);
  text(ctx, 'start', padL + 4, y(s.account.startEquity) - 8, C.amber, 10, 'left', 700);

  const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  const up = vals[vals.length - 1] >= s.account.startEquity;
  grad.addColorStop(0, up ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)');
  grad.addColorStop(1, 'rgba(10,14,30,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(vals[0]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(x(i), y(vals[i]));
  ctx.lineTo(x(pts.length - 1), h - padB);
  ctx.lineTo(x(0), h - padB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  const lineGrad = ctx.createLinearGradient(padL, 0, w - padR, 0);
  lineGrad.addColorStop(0, C.cyan);
  lineGrad.addColorStop(0.5, C.violet);
  lineGrad.addColorStop(1, C.pink);
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 2.2;
  ctx.shadowColor = 'rgba(167,139,250,0.55)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(x(0), y(vals[0]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(x(i), y(vals[i]));
  ctx.stroke();
  ctx.restore();

  const lx = x(pts.length - 1);
  const ly = y(vals[vals.length - 1]);
  ctx.beginPath();
  ctx.fillStyle = up ? C.green : C.red;
  ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
  ctx.fill();
  labelBox(ctx, fmtUsd(vals[vals.length - 1]), w - padR + 4, ly, up ? C.green : C.red, '#06120c');
}

// ---------- performance ----------
function renderPerf(s) {
  const st = s.stats;
  const total = st.wins + st.losses;
  const winPct = total ? (st.wins / total) * 100 : 0;
  const items = [
    ['Trades', st.trades, C.cyan],
    ['Net PnL', fmtUsd(st.totalPnl, true), clsColor(st.totalPnl)],
    ['Return', fmtPct(st.totalReturnPct, true), clsColor(st.totalReturnPct)],
    ['Avg R', fmtNum(st.avgR, 2) + 'R', clsColor(st.avgR)],
    ['Profit factor', st.profitFactor === Infinity ? '∞' : fmtNum(st.profitFactor, 2), C.violet],
    ['Max DD', fmtPct(st.maxDrawdownPct, false, 2), C.amber],
    ['Best trade', fmtUsd(st.bestTrade, true), C.green],
    ['Worst trade', fmtUsd(st.worstTrade, true), C.red],
  ];
  $('#perf').innerHTML =
    items.map(([l, v, c]) => `<div class="perf-item"><div class="l">${l}</div><div class="v" style="color:${c}">${v}</div></div>`).join('') +
    `<div class="perf-item" style="grid-column: span 2"><div class="l">Wins vs losses</div>
      <div class="split">
        <div style="width:${winPct}%;background:linear-gradient(90deg,${C.green},${C.lime})"></div>
        <div style="width:${100 - winPct}%;background:linear-gradient(90deg,${C.pink},${C.red})"></div>
      </div>
      <div class="muted" style="font-size:11px;margin-top:6px;font-family:var(--mono)">${st.wins} wins · ${st.losses} losses</div>
    </div>`;
}
function clsColor(v) {
  return v > 0 ? C.green : v < 0 ? C.red : C.muted;
}

// ---------- PnL analytics ----------
function renderPnl(s) {
  const p = s.pnl;
  if (!p) return;
  renderCumulative(s, p);
  renderDaily(p);
  renderSymbolBars(p);
  renderRHist(p);
  renderBreakdown(s, p);
}

function renderCumulative(s, p) {
  const canvas = $('#cumChart');
  const { ctx, w, h } = prepCanvas(canvas);
  const pts = p.cumulative;
  $('#cumSub').textContent = pts.length
    ? `${pts.length} closed trades · net ${fmtUsd(pts[pts.length - 1].cum, true)} · best ${fmtUsd(p.bestTrade?.pnl ?? 0, true)} · worst ${fmtUsd(p.worstTrade?.pnl ?? 0, true)}`
    : 'Closed trades only';
  if (pts.length === 0) {
    text(ctx, 'No closed trades yet — the curve starts with the first exit.', w / 2, h / 2, C.muted, 12, 'center');
    return;
  }
  const padL = 10, padR = 84, padT = 14, padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const vals = [0, ...pts.map((q) => q.cum)];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = hi - lo || 1;
  lo -= span * 0.1;
  hi += span * 0.1;
  const y = (v) => padT + ((hi - v) / (hi - lo)) * plotH;
  const x = (i) => padL + (vals.length === 1 ? 0 : (i / (vals.length - 1)) * plotW);

  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) * k) / 3;
    hLine(ctx, padL, w - padR, y(v), C.grid, [3, 4]);
    text(ctx, fmtUsd(v).replace('$', ''), w - padR + 6, y(v), C.muted, 10);
  }
  hLine(ctx, padL, w - padR, y(0), 'rgba(230,235,255,0.45)', [6, 4], 1.2);
  text(ctx, '0', padL + 4, y(0) - 8, C.muted, 10, 'left', 700);

  const last = vals[vals.length - 1];
  const up = last >= 0;
  const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, up ? 'rgba(163,230,53,0.35)' : 'rgba(248,113,113,0.35)');
  grad.addColorStop(1, 'rgba(10,14,30,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(0));
  for (let i = 0; i < vals.length; i++) ctx.lineTo(x(i), y(vals[i]));
  ctx.lineTo(x(vals.length - 1), y(0));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  ctx.strokeStyle = up ? C.lime : C.red;
  ctx.lineWidth = 2.2;
  ctx.shadowColor = up ? 'rgba(163,230,53,0.5)' : 'rgba(248,113,113,0.5)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(x(0), y(0));
  for (let i = 0; i < vals.length; i++) ctx.lineTo(x(i), y(vals[i]));
  ctx.stroke();
  ctx.restore();

  // One dot per closed trade: green = win, red = loss.
  for (let i = 1; i < vals.length; i++) {
    const win = pts[i - 1].pnl > 0;
    ctx.beginPath();
    ctx.fillStyle = win ? C.green : C.red;
    ctx.arc(x(i), y(vals[i]), 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  labelBox(ctx, fmtUsd(last, true), w - padR + 4, y(last), up ? C.lime : C.red, '#06120c');
}

function renderDaily(p) {
  const canvas = $('#dailyChart');
  const { ctx, w, h } = prepCanvas(canvas);
  const days = p.daily;
  const best = p.bestDay;
  const worst = p.worstDay;
  $('#dailySub').textContent = best
    ? `best ${best.day.slice(5)} ${fmtUsd(best.pnl, true)} · worst ${worst.day.slice(5)} ${fmtUsd(worst.pnl, true)}`
    : 'No closed trades in the last 30 days';
  const padL = 10, padR = 62, padT = 14, padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const vals = days.map((d) => d.pnl);
  const maxAbs = Math.max(1e-9, ...vals.map((v) => Math.abs(v)));
  const y = (v) => padT + plotH / 2 - (v / maxAbs) * (plotH / 2) * 0.9;
  hLine(ctx, padL, w - padR, y(0), 'rgba(230,235,255,0.35)', [4, 3], 1);
  text(ctx, '0', w - padR + 6, y(0), C.muted, 10);
  text(ctx, fmtUsd(maxAbs, true).replace('$', ''), w - padR + 6, padT + 4, C.muted, 10);
  const slot = plotW / days.length;
  const bw = Math.max(3, Math.min(18, slot * 0.66));
  days.forEach((d, i) => {
    const cx = padL + slot * (i + 0.5);
    if (d.trades === 0) {
      hLine(ctx, cx - bw / 2, cx + bw / 2, y(0), 'rgba(139,149,196,0.35)', [], 2);
      return;
    }
    const top = Math.min(y(0), y(d.pnl));
    const height = Math.max(2, Math.abs(y(d.pnl) - y(0)));
    const grad = ctx.createLinearGradient(0, top, 0, top + height);
    if (d.pnl >= 0) {
      grad.addColorStop(0, C.lime);
      grad.addColorStop(1, 'rgba(52,211,153,0.55)');
    } else {
      grad.addColorStop(0, 'rgba(248,113,113,0.55)');
      grad.addColorStop(1, C.red);
    }
    ctx.fillStyle = grad;
    roundRect(ctx, cx - bw / 2, top, bw, height, 3);
    ctx.fill();
  });
  for (let i = 0; i < days.length; i += Math.max(1, Math.floor(days.length / 5))) {
    text(ctx, days[i].day.slice(5), padL + slot * (i + 0.5), h - 9, C.muted, 10, 'center');
  }
}

function renderSymbolBars(p) {
  const el = $('#symBars');
  if (!p.bySymbol.length) {
    el.innerHTML = '<div class="empty muted" style="padding:20px">No closed trades yet.</div>';
    return;
  }
  const maxAbs = Math.max(1e-9, ...p.bySymbol.map((r) => Math.abs(r.pnl)));
  el.innerHTML = p.bySymbol
    .map((r) => {
      const pct = (Math.abs(r.pnl) / maxAbs) * 100;
      const col = r.pnl >= 0 ? C.green : C.red;
      const wr = r.trades ? ((r.wins / r.trades) * 100).toFixed(0) : '0';
      return `<div class="sym-row">
        <span class="sym">${esc(r.symbol)}</span>
        <div class="track"><div class="fill" style="width:${pct}%;background:linear-gradient(90deg,${col}55,${col})"></div></div>
        <span class="val" style="color:${col}">${fmtUsd(r.pnl, true)}</span>
        <span class="muted" style="grid-column:2 / span 2;font-size:11px">${r.trades} trades · ${wr}% win</span>
      </div>`;
    })
    .join('');
}

function renderRHist(p) {
  const canvas = $('#rChart');
  const { ctx, w, h } = prepCanvas(canvas);
  const bins = p.rHist;
  const total = bins.reduce((s, b) => s + b.count, 0);
  if (total === 0) {
    text(ctx, 'R distribution appears after the first trade closes.', w / 2, h / 2, C.muted, 12, 'center');
    return;
  }
  const padL = 10, padR = 10, padT = 14, padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const maxC = Math.max(1, ...bins.map((b) => b.count));
  const slot = plotW / bins.length;
  const bw = slot * 0.62;
  bins.forEach((b, i) => {
    const cx = padL + slot * (i + 0.5);
    const bh = (b.count / maxC) * plotH;
    const c = i < 3 ? C.red : i === 3 ? C.amber : C.green;
    if (b.count > 0) {
      const grad = ctx.createLinearGradient(0, h - padB - bh, 0, h - padB);
      grad.addColorStop(0, c);
      grad.addColorStop(1, 'rgba(10,14,30,0.4)');
      ctx.fillStyle = grad;
      roundRect(ctx, cx - bw / 2, h - padB - bh, bw, bh, 4);
      ctx.fill();
    }
    text(ctx, String(b.count), cx, h - padB - bh - 9, b.count ? c : C.muted, 11, 'center', 800);
    text(ctx, b.label, cx, h - 14, C.muted, 9, 'center');
  });
  hLine(ctx, padL, w - padR, h - padB, 'rgba(230,235,255,0.25)', [], 1);
}

function renderBreakdown(s, p) {
  const el = $('#breakdown');
  const sides = p.bySide;
  const total = sides.reduce((a, r) => a + Math.abs(r.pnl), 0) || 1;
  const sideHtml = sides
    .map((r) => {
      const col = r.side === 'LONG' ? C.green : C.pink;
      const wr = r.trades ? ((r.wins / r.trades) * 100).toFixed(0) : '0';
      return `<div class="split-row">
        <div class="head"><span><span class="pill ${r.side === 'LONG' ? 'long' : 'short'}">${r.side}</span> ${r.trades} trades · ${wr}% win</span>
        <b style="color:${r.pnl >= 0 ? C.green : C.red}">${fmtUsd(r.pnl, true)}</b></div>
        <div class="track" style="height:10px;border-radius:999px;background:rgba(255,255,255,.07);position:relative;overflow:hidden">
          <div style="position:absolute;top:0;bottom:0;left:0;width:${(Math.abs(r.pnl) / total) * 100}%;border-radius:999px;background:linear-gradient(90deg,${col}55,${col})"></div>
        </div>
      </div>`;
    })
    .join('');
  const ex = p.exitReasons || {};
  const tp = ex.TAKE_PROFIT || 0;
  const sl = ex.STOP_LOSS || 0;
  const other = Object.entries(ex)
    .filter(([k]) => k !== 'TAKE_PROFIT' && k !== 'STOP_LOSS')
    .reduce((a, [, v]) => a + v, 0);
  const closed = tp + sl + other;
  const tpPct = closed ? (tp / closed) * 100 : 0;
  el.innerHTML = `${sideHtml}
    <div class="exit-grid">
      <div><div class="l">Take profit exits</div><div class="v pos">${tp} <span class="muted" style="font-size:12px">${tpPct.toFixed(0)}%</span></div></div>
      <div><div class="l">Stop loss exits</div><div class="v neg">${sl}</div></div>
      <div><div class="l">Other exits</div><div class="v" style="color:${C.amber}">${other}</div></div>
      <div><div class="l">Avg R per trade</div><div class="v" style="color:${s.stats.avgR >= 0 ? C.green : C.red}">${fmtNum(s.stats.avgR, 2)}R</div></div>
    </div>
    <div class="best-worst">
      <div><div class="muted">Best trade</div><b style="color:${C.green}">${p.bestTrade ? `${esc(p.bestTrade.symbol)} ${fmtUsd(p.bestTrade.pnl, true)}` : '—'}</b></div>
      <div><div class="muted">Worst trade</div><b style="color:${C.red}">${p.worstTrade ? `${esc(p.worstTrade.symbol)} ${fmtUsd(p.worstTrade.pnl, true)}` : '—'}</b></div>
    </div>`;
}

// ---------- tables ----------
function sideTag(side, external) {
  if (external) return `<span class="pill ext">external</span>`;
  return `<span class="pill ${side === 'LONG' ? 'long' : 'short'}">${side}</span>`;
}

function renderPositions(s) {
  $('#posCount').textContent = s.positions.length;
  const head = `<thead><tr>
    <th>Symbol</th><th>Side</th><th>Source</th><th class="num">Entry</th><th class="num">Mark</th>
    <th class="num">Stop</th><th class="num">Target</th><th>Progress to TP</th>
    <th class="num">Margin</th><th class="num">Unrealised</th><th>Opened</th></tr></thead>`;
  if (s.positions.length === 0) {
    $('#posTable').innerHTML = `${head}<tbody><tr><td class="empty" colspan="11">No open positions. The engine is waiting for a divergence inside a tradable market.</td></tr></tbody>`;
    return;
  }
  const rows = s.positions.map((p) => {
    const sym = s.symbols.find((x) => x.symbol === p.symbol);
    const mark = sym?.price;
    let progress = '';
    if (!p.external && isNum(p.stop) && isNum(p.takeProfit) && isNum(mark)) {
      // Works for both sides: 0% at the stop, 100% at the target.
      const frac = (mark - p.stop) / (p.takeProfit - p.stop);
      const pct = Math.max(0, Math.min(100, frac * 100));
      progress = `<div class="progress" title="${pct.toFixed(0)}% of the way from stop to target">
        <i style="left:${pct}%"></i></div>`;
    } else {
      progress = `<span class="muted">${p.external ? 'managed outside bot' : '—'}</span>`;
    }
    return `<tr>
      <td class="sym">${esc(p.symbol)}</td>
      <td>${sideTag(p.side, p.external)}</td>
      <td><span class="pill ${p.source === 'live' ? 'other' : 'ext'}">${esc(p.status === 'PENDING' ? 'pending' : p.source)}</span></td>
      <td class="num">${fmtPrice(p.entry)}</td>
      <td class="num">${fmtPrice(mark)}</td>
      <td class="num neg">${fmtPrice(p.stop)}</td>
      <td class="num pos">${fmtPrice(p.takeProfit)}</td>
      <td>${progress}</td>
      <td class="num">${fmtUsd(p.margin)}</td>
      <td class="num ${clsPnl(p.unrealized)}">${fmtUsd(p.unrealized, true)}</td>
      <td class="muted">${p.openedAt ? dt(p.openedAt) : '—'}</td>
    </tr>`;
  });
  $('#posTable').innerHTML = `${head}<tbody>${rows.join('')}</tbody>`;
}

function renderTrades(s) {
  $('#tradeCount').textContent = s.stats.trades;
  const head = `<thead><tr>
    <th>Closed</th><th>Symbol</th><th>Side</th><th>Divergence</th><th class="num">Entry</th><th class="num">Exit</th>
    <th>Reason</th><th class="num">Margin</th><th class="num">PnL</th><th class="num">PnL %</th><th class="num">R</th></tr></thead>`;
  if (s.trades.length === 0) {
    $('#tradeTable').innerHTML = `${head}<tbody><tr><td class="empty" colspan="11">No closed trades yet.</td></tr></tbody>`;
    return;
  }
  const rows = s.trades.map((t) => {
    const reason = t.exitReason === 'TAKE_PROFIT' ? 'tp' : t.exitReason === 'STOP_LOSS' ? 'sl' : 'other';
    const label = t.exitReason.replace('_', ' ');
    return `<tr>
      <td class="muted">${dt(t.closedAt)}</td>
      <td class="sym">${esc(t.symbol)}</td>
      <td><span class="pill ${t.side === 'LONG' ? 'long' : 'short'}">${t.side}</span></td>
      <td><span class="pill ${t.divergence === 'BULL' ? 'bull' : 'bear'}">${t.divergence || '—'}</span></td>
      <td class="num">${fmtPrice(t.entry)}</td>
      <td class="num">${fmtPrice(t.exit)}</td>
      <td><span class="pill ${reason}">${label}</span></td>
      <td class="num">${fmtUsd(t.margin)}</td>
      <td class="num ${clsPnl(t.pnl)}">${fmtUsd(t.pnl, true)}</td>
      <td class="num ${clsPnl(t.pnlPct)}">${fmtPct(t.pnlPct, true)}</td>
      <td class="num ${clsPnl(t.rMultiple)}">${fmtNum(t.rMultiple, 2)}R</td>
    </tr>`;
  });
  $('#tradeTable').innerHTML = `${head}<tbody>${rows.join('')}</tbody>`;
}

function renderSignals(s) {
  const filters = ['ALL', 'EXECUTED', 'SKIPPED', 'FAILED'];
  const counts = (k) => (k === 'ALL' ? s.signals.length : s.signals.filter((x) => x.action === k).length);
  const fhtml = filters.map((f) => `<button class="chip ${ui.sigFilter === f ? 'on' : ''}" data-f="${f}">${f} · ${counts(f)}</button>`).join('');
  const fEl = $('#sigFilters');
  if (fEl.dataset.key !== fhtml) {
    fEl.dataset.key = fhtml;
    fEl.innerHTML = fhtml;
  }
  const list = s.signals.filter((x) => ui.sigFilter === 'ALL' || x.action === ui.sigFilter);
  if (list.length === 0) {
    $('#signalList').innerHTML = `<div class="empty muted" style="padding:24px">No ${ui.sigFilter === 'ALL' ? '' : ui.sigFilter.toLowerCase() + ' '}signals yet. Bull/bear divergences appear here as soon as the 15m bar closes.</div>`;
    return;
  }
  $('#signalList').innerHTML = list
    .slice(0, 120)
    .map(
      (g) => `
      <div class="sig ${g.action}">
        <div class="sig-top">
          <span class="sym">${esc(g.symbol)}</span>
          <span class="pill ${g.type === 'BULL' ? 'bull' : 'bear'}">${g.type} DIV</span>
          <span class="pill ${g.action}">${g.action}</span>
          <span class="pill reg-${g.regime}">${String(g.regime).replace('_', ' ')}</span>
          <span class="sig-time">${dt(g.barT)}</span>
        </div>
        <div class="sig-reason">${esc(g.reason)}</div>
        <div class="muted" style="font-family:var(--mono);font-size:11px;margin-top:4px">
          close ${fmtPrice(g.price)} · swing ${fmtPrice(g.swingPrice)} · RSI ${fmtNum(g.rsi, 1)}${g.prevRsi != null ? ` (prev ${fmtNum(g.prevRsi, 1)})` : ''} · CHOP ${fmtNum(g.chop, 1)} · ATR× ${fmtNum(g.volRatio, 2)}
        </div>
      </div>`,
    )
    .join('');
}

$('#sigFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  ui.sigFilter = b.dataset.f;
  if (ui.snap) renderSignals(ui.snap);
});

function renderEvents(s) {
  const items = [];
  if (s.status.lastError) items.push({ t: s.status.lastError.t, msg: s.status.lastError.msg, err: true });
  for (const e of s.events || []) items.push({ t: e.t, msg: e.msg, err: false });
  items.sort((a, b) => b.t - a.t);
  $('#events').innerHTML = items.length
    ? items
        .slice(0, 40)
        .map((i) => `<li class="${i.err ? 'err' : ''}"><span class="t">${hms(i.t)}</span>${esc(i.msg)}</li>`)
        .join('')
    : `<li><span class="t">${hms(Date.now() - ui.offsetMs)}</span>Engine started. No events yet.</li>`;
}

// ---------- clocks ----------
function tickClock() {
  const now = Date.now() - ui.offsetMs;
  $('#utcNow').textContent = `${hms(now)} UTC`;
  const s = ui.snap;
  if (!s) return;
  const remaining = Math.max(0, s.status.nextCandleAt - now);
  const elapsed = TF_MS - remaining;
  const mm = String(Math.floor(remaining / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
  $('#countdown').textContent = `${mm}:${ss}`;
  $('#ringFg').style.strokeDasharray = RING_C.toFixed(2);
  $('#ringFg').style.strokeDashoffset = (RING_C * (1 - elapsed / TF_MS)).toFixed(2);
  if (Date.now() - ui.lastOk > 15000 && ui.lastOk) {
    $('#lastTick').textContent = `no response for ${Math.round((Date.now() - ui.lastOk) / 1000)}s`;
  }
}

window.addEventListener('resize', () => ui.snap && render());
setInterval(tickClock, 1000);
tickClock();
poll();
