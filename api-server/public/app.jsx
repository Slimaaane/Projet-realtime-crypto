const { useState, useEffect, useRef, useMemo } = React;

// -- Icones minimalistes en SVG -----------------------------------------------
// On utilise des icones inline plutot qu'une librairie externe pour ne pas
// ajouter de dependance supplementaire juste pour 4 icones.
const Icon = ({ name, size = 16, stroke = 1.75 }) => {
  const props = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const paths = {
    trend: <><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></>,
    volume: <><rect x="3" y="10" width="3" height="11" rx="1" /><rect x="9" y="6" width="3" height="15" rx="1" /><rect x="15" y="13" width="3" height="8" rx="1" /></>,
    pulse: <path d="M3 12h4l2-7 4 14 2-7h6" />,
    bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
  };
  return <svg {...props}>{paths[name]}</svg>;
};

// -- Fonctions utilitaires ----------------------------------------------------
const fmtUSD = (n, d = 2) => {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtNum = (n, d = 0) => {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtCompact = (n) => {
  if (n === null || n === undefined || isNaN(n) || n === 0) return '--';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
};
const pad2 = (n) => String(n).padStart(2, '0');
const timeStr = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

// Moyenne mobile simple calculee cote client pour l'affichage du graphique.
// On fait ca ici pour ne pas alourdir le serveur avec des calculs purement visuels.
function sma(arr, window) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = arr.slice(start, i + 1);
    const avg = slice.reduce((s, v) => s + v.p, 0) / slice.length;
    out.push({ t: arr[i].t, p: avg });
  }
  return out;
}

// -- Graphique SVG custom -----------------------------------------------------
// On dessine le graphique directement en SVG plutot que d'utiliser Chart.js
// pour garder le controle total sur le rendu et le style, et parce que
// ca donne un controle total sur le rendu et le style.
function PriceChart({ series, smaShort, smaLong }) {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 320 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (series.length < 3) {
    return <div className="chart-empty">En attente de donnees...</div>;
  }

  const { w, h } = size;
  const padL = 60, padR = 16, padT = 14, padB = 30;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const allP = series.map(s => s.p).concat(smaShort.map(s => s.p), smaLong.map(s => s.p));
  const minP = Math.min(...allP) - 20;
  const maxP = Math.max(...allP) + 20;
  const rangeP = maxP - minP || 1;
  const minT = series[0].t;
  const maxT = series[series.length - 1].t;
  const rangeT = maxT - minT || 1;

  const x = (t) => padL + ((t - minT) / rangeT) * innerW;
  const y = (p) => padT + (1 - (p - minP) / rangeP) * innerH;

  const toPath = (arr) => arr.map((d, i) => (i === 0 ? 'M' : 'L') + x(d.t).toFixed(1) + ' ' + y(d.p).toFixed(1)).join(' ');

  const linePath = toPath(series);
  const areaPath = linePath + ` L ${x(maxT).toFixed(1)} ${(padT + innerH).toFixed(1)} L ${x(minT).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;
  const shortPath = smaShort.length > 2 ? toPath(smaShort) : '';
  const longPath = smaLong.length > 2 ? toPath(smaLong) : '';

  const yTicks = 5;
  const yVals = Array.from({ length: yTicks }, (_, i) => minP + (i / (yTicks - 1)) * rangeP);
  const xTickCount = 6;
  const xVals = Array.from({ length: xTickCount }, (_, i) => minT + (i / (xTickCount - 1)) * rangeT);

  const lastPrice = series[series.length - 1].p;
  const lastX = x(maxT);
  const lastY = y(lastPrice);

  return (
    <div className="chart-wrap" ref={ref}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {yVals.map((v, i) => (
          <g key={'y' + i}>
            <line x1={padL} y1={y(v)} x2={padL + innerW} y2={y(v)} stroke="#f0f2f5" strokeWidth="1" />
            <text x={padL - 8} y={y(v) + 4} fontSize="11" fill="#9ca3af" textAnchor="end" fontFamily="JetBrains Mono">
              {fmtNum(v, 0)}
            </text>
          </g>
        ))}

        {xVals.map((t, i) => (
          <text key={'x' + i} x={x(t)} y={h - 8} fontSize="11" fill="#9ca3af" textAnchor="middle" fontFamily="JetBrains Mono">
            {timeStr(new Date(t)).slice(0, 5)}
          </text>
        ))}

        <path d={areaPath} fill="url(#priceGrad)" />
        {longPath && <path d={longPath} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.9" />}
        {shortPath && <path d={shortPath} fill="none" stroke="#22c55e" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.9" />}
        <path d={linePath} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        <line x1={padL} y1={lastY} x2={lastX} y2={lastY} stroke="#3b82f6" strokeWidth="1" strokeDasharray="3 3" opacity="0.4" />
        <circle cx={lastX} cy={lastY} r="5" fill="#fff" stroke="#3b82f6" strokeWidth="2" />
        <rect x={lastX + 8} y={lastY - 10} width="90" height="20" rx="4" fill="#3b82f6" />
        <text x={lastX + 53} y={lastY + 4} fontSize="11" fill="#fff" textAnchor="middle" fontWeight="600" fontFamily="JetBrains Mono">
          {fmtNum(lastPrice, 2)}
        </text>
      </svg>
    </div>
  );
}

// -- Sparkline ----------------------------------------------------------------
function Sparkline({ data, color }) {
  if (!data || data.length < 3) return null;
  const w = 220, h = 32;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const rng = max - min || 1;
  const path = data.map((v, i) => {
    const px = (i / (data.length - 1)) * w;
    const py = h - ((v - min) / rng) * h;
    return (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1);
  }).join(' ');
  const area = path + ` L ${w} ${h} L 0 ${h} Z`;
  const gradId = 'sparkgrad-' + color.replace('#', '');
  return (
    <svg className="kpi-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', display: 'block' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// -- KPI Card -----------------------------------------------------------------
function KpiCard({ icon, iconClass, label, value, delta, deltaLabel, sparkData, sparkColor }) {
  const hasDelta = delta !== null && delta !== undefined && !isNaN(delta);
  return (
    <div className="card kpi">
      <div className="kpi-head">
        <span className="kpi-label">{label}</span>
        <span className={'kpi-icon ' + iconClass}><Icon name={icon} size={16} /></span>
      </div>
      <div>
        <div className="kpi-value mono">{value}</div>
        <Sparkline data={sparkData} color={sparkColor} />
        <div className="kpi-foot">
          {hasDelta && (
            <span className={'tk-delta ' + (delta >= 0 ? 'delta-up' : 'delta-down')}>
              {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(2)}%
            </span>
          )}
          <span>{deltaLabel}</span>
        </div>
      </div>
    </div>
  );
}

// -- Health Row ---------------------------------------------------------------
function HealthRow({ status, name, sub, val, showBar, bar }) {
  return (
    <div className="health-row">
      <div className="h-left">
        <span className={'h-pill ' + status}></span>
        <div>
          <div className="h-name">{name}</div>
          <div className="h-sub">{sub}</div>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className={'h-val mono ' + (status === 'ok' ? 'ok' : '')}>{val}</div>
        {showBar && <div className="h-bar"><div className="h-bar-fill" style={{ width: (bar * 100) + '%' }}></div></div>}
      </div>
    </div>
  );
}


// -- Application principale ---------------------------------------------------
// Toute la logique de donnees passe par Socket.IO. Le serveur API lit les
// metriques depuis Redis (pre-calculees par le stream-processor) et nous
// les pousse toutes les 500ms. On ne fait jamais de requete directe a Kafka
// ni a MongoDB depuis le dashboard, comme le demande le sujet.

function App() {
  // Etat des donnees temps reel
  const [lastPrice, setLastPrice] = useState(null);
  const [changePct, setChangePct] = useState(0);
  const [coinbasePrice, setCoinbasePrice] = useState(null);
  const [coinbaseChange, setCoinbaseChange] = useState(0);
  const [series, setSeries] = useState([]);
  const [trades, setTrades] = useState([]);
  const [tradesPerSec, setTradesPerSec] = useState(0);
  const [anomalyCount, setAnomalyCount] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [volumes, setVolumes] = useState({ '1m': 0, '5m': 0, '15m': 0, '1h': 0 });
  const [health, setHealth] = useState(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(new Date());

  // Etat UI (navigation, filtres)
  const [activeNav, setActiveNav] = useState('Live');
  const [activeRange, setActiveRange] = useState('30m');
  const [activeFeed, setActiveFeed] = useState('All');

  // Reference pour savoir quand on a ajoute le dernier point au graphique.
  // On echantillonne toutes les 3 secondes pour ne pas surcharger le SVG
  // avec trop de points (30 min / 3s = 600 points max).
  const lastChartUpdate = useRef(0);

  // Connexion Socket.IO : on recoit les donnees temps reel du serveur API
  useEffect(() => {
    const socket = io();

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('realtime', (data) => {
      setNow(new Date());

      // Prix BTC/USDT depuis Binance
      const btcusdt = data.prices['BTC/USDT'];
      if (btcusdt && btcusdt.price) {
        const p = parseFloat(btcusdt.price);
        setLastPrice(p);
        setChangePct(parseFloat(btcusdt.change_pct_1h) || 0);

        // On ajoute le prix a la serie du graphique, mais on echantillonne
        // pour ne pas avoir 2 points par seconde (le WebSocket pousse toutes les 500ms)
        const nowMs = Date.now();
        setSeries(prev => {
          if (nowMs - lastChartUpdate.current < 3000) {
            // On met a jour le dernier point au lieu d'en ajouter un nouveau
            if (prev.length === 0) return [{ t: nowMs, p }];
            const next = [...prev];
            next[next.length - 1] = { t: nowMs, p };
            return next;
          }
          lastChartUpdate.current = nowMs;
          const next = [...prev, { t: nowMs, p }];
          if (next.length > 600) next.shift();
          return next;
        });
      }

      // Prix BTC-USD depuis Coinbase
      const btcusd = data.prices['BTC-USD'];
      if (btcusd && btcusd.price) {
        setCoinbasePrice(parseFloat(btcusd.price));
        setCoinbaseChange(parseFloat(btcusd.change_pct_1h) || 0);
      }

      // Throughput (trades par seconde)
      if (data.throughput && data.throughput.trades_per_sec) {
        setTradesPerSec(parseInt(data.throughput.trades_per_sec) || 0);
      }

      // Nombre d'anomalies sur les 10 dernieres minutes
      if (data.anomalies && data.anomalies.count_10min) {
        setAnomalyCount(parseInt(data.anomalies.count_10min) || 0);
      }

      // Derniers trades pour le feed live
      if (data.trades && data.trades.length > 0) {
        setTrades(data.trades.map((t, i) => ({
          id: t.trade_id || `${Date.now()}-${i}`,
          price: t.price,
          qty: t.quantity,
          side: t.is_buyer_maker ? 'sell' : 'buy',
          exchange: t.exchange === 'binance' ? 'BIN' : 'CBP',
          time: new Date(t.timestamp),
          symbol: t.symbol,
        })));
      }

      // Alertes d'anomalies
      if (data.alerts) {
        setAlerts(data.alerts.map((a, i) => ({
          id: `${a.timestamp}-${i}`,
          kind: a.type,
          msg: a.message,
          source: a.symbol,
          time: new Date(a.timestamp),
        })));
      }

      // Volumes par fenetre glissante
      const btcWindows = data.windows['BTC/USDT'] || {};
      setVolumes({
        '1m': parseFloat((btcWindows['1min'] || {}).volume_usd) || 0,
        '5m': parseFloat((btcWindows['5min'] || {}).volume_usd) || 0,
        '15m': parseFloat((btcWindows['15min'] || {}).volume_usd) || 0,
        '1h': parseFloat((btcWindows['1h'] || {}).volume_usd) || 0,
      });
    });

    return () => socket.disconnect();
  }, []);

  // Sante du pipeline : on interroge l'endpoint REST toutes les 5 secondes.
  // On ne met pas ca dans le flux WebSocket parce que ces donnees changent
  // beaucoup moins vite que les trades.
  useEffect(() => {
    const fetchHealth = () => {
      fetch('/api/health')
        .then(r => r.json())
        .then(setHealth)
        .catch(() => {});
    };
    fetchHealth();
    const id = setInterval(fetchHealth, 5000);
    return () => clearInterval(id);
  }, []);

  // Moyennes mobiles calculees a partir de la serie de prix
  const smaShort = useMemo(() => sma(series, 8), [series]);
  const smaLong = useMemo(() => sma(series, 30), [series]);

  // Spread entre Binance et Coinbase
  const spread = (lastPrice && coinbasePrice) ? lastPrice - coinbasePrice : null;
  const spreadBps = (spread !== null && lastPrice) ? (spread / lastPrice) * 10000 : null;

  // Sparkline : on prend les 40 derniers points de prix pour la mini-courbe
  const sparkSeries = series.slice(-40).map(s => s.p);

  // Filtre du feed par exchange
  const filteredTrades = activeFeed === 'All' ? trades
    : activeFeed === 'Binance' ? trades.filter(t => t.exchange === 'BIN')
    : trades.filter(t => t.exchange === 'CBP');

  // Statut des exchanges (on considere connecte si on recoit des donnees)
  const binanceOk = lastPrice !== null;
  const coinbaseOk = coinbasePrice !== null;

  return (
    <>
      {/* HEADER */}
      <div className="header">
        <div className="h-title">
          <h1>Crypto Market Monitor -- Real-Time Pipeline</h1>
          <p>Streaming order flow et detection d'anomalies sur les exchanges centralises</p>
        </div>
        <div className="h-right">
          <div className="nav-pills">
            {['Live', 'History', 'Anomalies', 'Pipeline'].map(n => (
              <button key={n} className={'pill ' + (activeNav === n ? 'active' : '')} onClick={() => setActiveNav(n)}>{n}</button>
            ))}
          </div>
          <div className={'exch-badge' + (binanceOk ? '' : ' disconnected')}><span className="dot"></span>Binance</div>
          <div className={'exch-badge' + (coinbaseOk ? '' : ' disconnected')}><span className="dot"></span>Coinbase</div>
          <div className={'live-pill' + (connected ? '' : ' disconnected')}>
            <span className="ldot"></span>
            {connected ? 'LIVE' : 'OFFLINE'}
          </div>
        </div>
      </div>

      {/* TICKER */}
      <div className="ticker">
        <div className="tk">
          <div className="tk-l">
            <span className="tk-label">Binance -- BTC/USDT</span>
            <span className="tk-sub">Spot -- Best Bid/Ask</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="tk-price mono">{fmtNum(lastPrice, 2)}</span>
            <span className={'tk-delta ' + (changePct >= 0 ? 'delta-up' : 'delta-down')}>
              {changePct >= 0 ? '▲' : '▼'} {Math.abs(changePct).toFixed(2)}%
            </span>
          </div>
        </div>
        <div className="tk">
          <div className="tk-l">
            <span className="tk-label">Coinbase -- BTC-USD</span>
            <span className="tk-sub">Spot -- Last Match</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="tk-price mono">{fmtNum(coinbasePrice, 2)}</span>
            {coinbasePrice !== null && (
              <span className={'tk-delta ' + (coinbaseChange >= 0 ? 'delta-up' : 'delta-down')}>
                {coinbaseChange >= 0 ? '▲' : '▼'} {Math.abs(coinbaseChange).toFixed(2)}%
              </span>
            )}
          </div>
        </div>
        <div className="tk">
          <div className="tk-l">
            <span className="tk-label">Cross-Exchange Spread</span>
            <span className="tk-sub">Binance - Coinbase</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="tk-price mono">
              {spread !== null ? `${spread >= 0 ? '+' : ''}${spread.toFixed(2)}` : '--'}
            </span>
            {spreadBps !== null && (
              <span className={'tk-delta ' + (Math.abs(spreadBps) > 5 ? 'delta-down' : 'delta-flat')}>
                {spreadBps.toFixed(1)} bps
              </span>
            )}
          </div>
        </div>
      </div>

      {/* KPI CARDS */}
      <div className="kpis">
        <KpiCard
          icon="trend" iconClass="blue"
          label="BTC/USDT Price"
          value={fmtUSD(lastPrice, 2)}
          delta={changePct}
          deltaLabel="vs 1h ago"
          sparkData={sparkSeries}
          sparkColor="#3b82f6"
        />
        <KpiCard
          icon="volume" iconClass="green"
          label="Volume -- 5min Rolling"
          value={fmtCompact(volumes['5m'])}
          delta={null}
          deltaLabel={`~${fmtNum(parseInt((volumes['5m'] || 0) / ((lastPrice || 1))), 0)} trades`}
          sparkData={sparkSeries}
          sparkColor="#22c55e"
        />
        <KpiCard
          icon="pulse" iconClass="amber"
          label="Trades / Second"
          value={fmtNum(tradesPerSec, 0)}
          delta={null}
          deltaLabel="Binance + Coinbase"
          sparkData={[]}
          sparkColor="#f59e0b"
        />
        <KpiCard
          icon="bell" iconClass="rose"
          label="Anomalies -- last 10min"
          value={fmtNum(anomalyCount, 0)}
          delta={null}
          deltaLabel="Detection 3 sigma"
          sparkData={[]}
          sparkColor="#ef4444"
        />
      </div>

      {/* MAIN ROW */}
      <div className="main-row">
        <div className="card chart-card">
          <div className="chart-head">
            <div>
              <h3 className="chart-title">BTC/USDT -- Price Stream</h3>
              <p className="chart-sub">Binance spot -- Updated every tick -- {timeStr(now)}</p>
            </div>
            <div className="chart-range">
              {['5m', '15m', '30m', '1h'].map(r => (
                <button key={r} className={'range-btn ' + (activeRange === r ? 'active' : '')} onClick={() => setActiveRange(r)}>{r}</button>
              ))}
            </div>
          </div>
          <PriceChart series={series} smaShort={smaShort} smaLong={smaLong} />
          <div className="chart-legend">
            <div className="legend-item">
              <span className="legend-line" style={{ background: '#3b82f6' }}></span>
              Price <span className="legend-val mono">{fmtNum(lastPrice, 2)}</span>
            </div>
            <div className="legend-item">
              <span className="legend-line" style={{ background: '#22c55e' }}></span>
              SMA 8 <span className="legend-val mono">{smaShort.length > 0 ? fmtNum(smaShort[smaShort.length - 1].p, 2) : '--'}</span>
            </div>
            <div className="legend-item">
              <span className="legend-line" style={{ background: '#f59e0b' }}></span>
              SMA 30 <span className="legend-val mono">{smaLong.length > 0 ? fmtNum(smaLong[smaLong.length - 1].p, 2) : '--'}</span>
            </div>
            {series.length > 2 && (
              <div className="legend-item" style={{ marginLeft: 'auto' }}>
                Range <span className="legend-val mono">
                  {fmtNum(Math.min(...series.map(s => s.p)), 0)} -- {fmtNum(Math.max(...series.map(s => s.p)), 0)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* TRADE FEED */}
        <div className="card feed-card">
          <div className="feed-head">
            <h3>Recent Trades</h3>
            <div className="feed-tabs">
              {['All', 'Binance', 'Coinbase'].map(f => (
                <span key={f} className={'feed-tab ' + (activeFeed === f ? 'active' : '')} onClick={() => setActiveFeed(f)}>{f}</span>
              ))}
            </div>
          </div>
          <div className="feed-cols">
            <span>Price</span>
            <span>Qty (BTC)</span>
            <span>Source</span>
            <span style={{ textAlign: 'right' }}>Time</span>
          </div>
          <div className="feed-list">
            {filteredTrades.length === 0 ? (
              <div className="empty-state">En attente de trades...</div>
            ) : (
              filteredTrades.map(t => (
                <div key={t.id} className="feed-row">
                  <span className="feed-side mono" style={{ color: t.side === 'buy' ? '#15803d' : '#b91c1c' }}>
                    <span className="side-dot" style={{ background: t.side === 'buy' ? '#22c55e' : '#ef4444' }}></span>
                    {fmtNum(t.price, 2)}
                  </span>
                  <span className="feed-qty mono">{parseFloat(t.qty).toFixed(6)}</span>
                  <span className="feed-ex">
                    <span className="ex-tag">{t.exchange}</span>
                  </span>
                  <span className="feed-time mono">{timeStr(t.time)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* BOTTOM ROW */}
      <div className="bottom-row">
        {/* ALERTS */}
        <div className="card">
          <div className="sect-head">
            <h3>Real-Time Alerts</h3>
            <span className="meta">{alerts.length} active</span>
          </div>
          <div className="alerts-list">
            {alerts.length === 0 ? (
              <div className="empty-state">Aucune anomalie detectee</div>
            ) : (
              alerts.map(a => (
                <div key={a.id} className="alert-row">
                  <span className={'alert-pill ' + a.kind}></span>
                  <div className="alert-body">
                    <div className="alert-msg">{a.msg}</div>
                    <div className="alert-meta">
                      <span className="alert-tag">{a.kind === 'price_anomaly' ? 'price' : a.kind === 'volume_spike' ? 'volume' : a.kind}</span>
                      <span>{a.source}</span>
                      <span className="mono">{timeStr(a.time)}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* VOLUME WINDOWS */}
        <div className="card">
          <div className="sect-head">
            <h3>Volume by Window</h3>
            <span className="meta">USD notional</span>
          </div>
          <div className="vol-list">
            {[
              { k: '1m', label: '1 minute' },
              { k: '5m', label: '5 minutes' },
              { k: '15m', label: '15 minutes' },
              { k: '1h', label: '1 hour' }
            ].map(v => {
              const val = volumes[v.k] || 0;
              // On calibre les barres par rapport au volume 1h (le plus grand)
              const maxVol = volumes['1h'] || 1;
              const pct = Math.min(100, (val / maxVol) * 100);
              return (
                <div key={v.k} className="vol-row">
                  <div className="vol-top">
                    <span className="vol-label">{v.label}</span>
                    <span className="vol-val mono">{fmtCompact(val)}</span>
                  </div>
                  <div className="vol-bar"><div className="vol-fill" style={{ width: pct + '%' }}></div></div>
                </div>
              );
            })}
          </div>
        </div>

        {/* PIPELINE HEALTH */}
        <div className="card">
          <div className="sect-head">
            <h3>Pipeline Health</h3>
            <span className="meta mono">{connected ? 'connected' : 'disconnected'}</span>
          </div>
          <div className="health-list">
            {health ? (
              <>
                <HealthRow
                  status={health.redis === 'connected' ? 'ok' : 'err'}
                  name="Redis"
                  sub="Cache temps reel et metriques"
                  val={health.redis}
                />
                <HealthRow
                  status={health.mongodb === 'connected' ? 'ok' : 'err'}
                  name="MongoDB"
                  sub="Stockage permanent des trades"
                  val={health.mongodb}
                />
                <HealthRow
                  status={binanceOk ? 'ok' : 'err'}
                  name="WebSocket Binance"
                  sub="BTC/USDT stream"
                  val={binanceOk ? 'connected' : 'waiting'}
                />
                <HealthRow
                  status={coinbaseOk ? 'ok' : 'warn'}
                  name="WebSocket Coinbase"
                  sub="BTC-USD stream"
                  val={coinbaseOk ? 'connected' : 'waiting'}
                />
                <HealthRow
                  status={health.active_workers === health.total_workers ? 'ok' : health.active_workers > 0 ? 'warn' : 'err'}
                  name="Stream Workers"
                  sub="Consumer group: crypto-processor"
                  val={`${health.active_workers} / ${health.total_workers} active`}
                  showBar
                  bar={health.active_workers / health.total_workers}
                />
              </>
            ) : (
              <div className="empty-state">Chargement...</div>
            )}
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <div className="footer">
        <div className="f-left">
          <span>Kafka topic <span className="chip mono">crypto.trades.raw</span></span>
          <span>Consumer group <span className="chip mono">group-ingestion</span></span>
        </div>
        <div className="f-right">
          <span><span className="chip"><span className="dot"></span>Last update {timeStr(now)} UTC</span></span>
        </div>
      </div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
