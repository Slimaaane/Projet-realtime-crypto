import os
from datetime import datetime, timezone

import docker
import redis as redis_lib
from flask import Flask, jsonify

app = Flask(__name__)

REDIS_URI = os.getenv("REDIS_URI", "redis://localhost:6379")
r = redis_lib.from_url(REDIS_URI, decode_responses=True)
docker_client = docker.from_env()

SERVICES = ["kafka", "mongodb", "redis", "producer-binance", "stream-processor", "kafka-ui"]
WORKER_COUNT = 8


def check_containers():
    result = {}
    try:
        all_containers = {c.name: c for c in docker_client.containers.list(all=True)}
        for name in SERVICES:
            c = all_containers.get(name)
            if c:
                health = c.attrs.get("State", {}).get("Health", {}).get("Status", "none")
                result[name] = {"status": c.status, "health": health}
            else:
                result[name] = {"status": "absent", "health": "none"}
    except Exception as e:
        result["error"] = str(e)
    return result


def check_binance():
    price_data = r.hgetall("kpi:price:BTC/USDT")
    if not price_data or "timestamp" not in price_data:
        return {"status": "disconnected", "age_sec": None}
    try:
        last_dt = datetime.fromisoformat(price_data["timestamp"])
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - last_dt).total_seconds()
        return {
            "status": "connected" if age < 10 else "disconnected",
            "age_sec": round(age, 1),
        }
    except Exception:
        return {"status": "disconnected", "age_sec": None}


def check_workers():
    workers = {}
    for i in range(1, WORKER_COUNT + 1):
        active = r.exists(f"worker:{i}:heartbeat") == 1
        workers[str(i)] = "active" if active else "inactive"
    return workers


@app.route("/api/health")
def health():
    return jsonify({
        "containers": check_containers(),
        "binance":    check_binance(),
        "workers":    check_workers(),
        "computed_at": datetime.now(timezone.utc).isoformat(),
    })


@app.route("/")
def index():
    return DASHBOARD_HTML


DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <title>Health Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e6edf3; font-family: 'Segoe UI', sans-serif; padding: 28px; }

    h1   { font-size: 1.25rem; font-weight: 700; margin-bottom: 4px; }
    .sub { color: #8b949e; font-size: 0.78rem; margin-bottom: 28px; }

    .section       { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
    .section-title { font-size: 0.68rem; text-transform: uppercase; letter-spacing: .1em; color: #8b949e; margin-bottom: 14px; }

    .row  { display: flex; flex-wrap: wrap; gap: 10px; }
    .item { display: flex; align-items: center; gap: 8px; background: #21262d; border-radius: 6px; padding: 8px 14px; font-size: 0.82rem; min-width: 160px; }

    .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
    .green  { background: #3fb950; box-shadow: 0 0 6px #3fb95066; }
    .red    { background: #f85149; }
    .yellow { background: #d29922; }
    .gray   { background: #8b949e; }

    .pulse { animation: pulse 1.8s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }

    .badge { font-size: 0.68rem; font-weight: 600; padding: 2px 8px; border-radius: 10px; }
    .badge-green  { background:#1a3a2a; color:#3fb950; }
    .badge-red    { background:#3a1a1a; color:#f85149; }
    .badge-yellow { background:#3a2f1a; color:#d29922; }

    .header-bar { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
    .live       { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; color: #3fb950; }
  </style>
</head>
<body>

<div class="header-bar">
  <div>
    <h1>🩺 Health Dashboard — Crypto Pipeline</h1>
    <div class="sub">Rafraîchissement automatique toutes les 3 secondes</div>
  </div>
  <div class="live">
    <span class="dot green pulse"></span>
    <span id="last-update">—</span>
  </div>
</div>

<!-- Services Docker -->
<div class="section">
  <div class="section-title">Services Docker</div>
  <div class="row" id="services"></div>
</div>

<!-- Binance WebSocket -->
<div class="section">
  <div class="section-title">Binance WebSocket</div>
  <div class="row" id="binance"></div>
</div>

<!-- Workers -->
<div class="section">
  <div class="section-title">Workers Kafka (8 consumers)</div>
  <div class="row" id="workers"></div>
</div>

<script>
async function refresh() {
  try {
    const res  = await fetch("/api/health");
    const data = await res.json();

    document.getElementById("last-update").textContent =
      new Date(data.computed_at).toLocaleTimeString("fr-FR");

    // Services
    const servicesEl = document.getElementById("services");
    servicesEl.innerHTML = "";
    for (const [name, info] of Object.entries(data.containers)) {
      if (name === "error") continue;
      const running = info.status === "running";
      const healthy = info.health === "healthy";
      const hasHealth = info.health !== "none";

      let dotClass = running ? "green" : "red";
      if (running && hasHealth && !healthy) dotClass = "yellow";

      let badge = "";
      if (hasHealth && running) {
        const bc = healthy ? "badge-green" : "badge-yellow";
        badge = `<span class="badge ${bc}">${info.health}</span>`;
      }

      servicesEl.innerHTML += `
        <div class="item">
          <span class="dot ${dotClass}${running ? " pulse" : ""}"></span>
          <span>${name}</span>
          ${badge}
        </div>`;
    }

    // Binance
    const binanceEl = document.getElementById("binance");
    const b = data.binance;
    const connected = b.status === "connected";
    const bBadge = connected ? "badge-green" : "badge-red";
    const bLabel = connected ? "CONNECTÉ" : "DÉCONNECTÉ";
    const bAge   = b.age_sec !== null ? ` — donnée reçue il y a ${b.age_sec}s` : "";
    binanceEl.innerHTML = `
      <div class="item">
        <span class="dot ${connected ? "green pulse" : "red"}"></span>
        <span>WebSocket Binance</span>
        <span class="badge ${bBadge}">${bLabel}</span>
      </div>
      <div class="item" style="color:#8b949e;">${bAge || "Aucune donnée reçue"}</div>`;

    // Workers
    const workersEl = document.getElementById("workers");
    workersEl.innerHTML = "";
    const wEntries = Object.entries(data.workers).sort((a,b) => +a[0] - +b[0]);
    let activeCount = 0;
    for (const [id, status] of wEntries) {
      const active = status === "active";
      if (active) activeCount++;
      workersEl.innerHTML += `
        <div class="item">
          <span class="dot ${active ? "green pulse" : "red"}"></span>
          <span>Worker ${id}</span>
          <span class="badge ${active ? "badge-green" : "badge-red"}">${active ? "ACTIF" : "INACTIF"}</span>
        </div>`;
    }

    // Résumé workers
    const total = wEntries.length;
    const summaryColor = activeCount === total ? "#3fb950" : activeCount === 0 ? "#f85149" : "#d29922";
    workersEl.innerHTML += `
      <div class="item" style="color:${summaryColor};font-weight:600;">
        ${activeCount} / ${total} actifs
      </div>`;

  } catch(e) {
    console.error("Erreur:", e);
  }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>"""

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8888, debug=False)
