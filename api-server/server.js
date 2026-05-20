const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crypto';
const REDIS_URI = process.env.REDIS_URI || 'redis://localhost:6379';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// On sert les fichiers statiques du dashboard (HTML/CSS/JS) depuis le dossier public.
// C'est plus propre que d'embarquer le HTML dans le code comme on l'a fait
// pour le health-dashboard, et ca permet de separer front et back.
app.use(express.static(path.join(__dirname, 'public')));

let db;
const redis = new Redis(REDIS_URI);

// On attend que MongoDB soit pret avant de demarrer le serveur
// pour eviter des erreurs sur les endpoints qui requetent la base.
// Redis est gere differemment car ioredis se reconnecte automatiquement.
MongoClient.connect(MONGO_URI)
  .then(client => {
    db = client.db();
    console.log('Connecte a MongoDB');
  })
  .catch(err => {
    console.error('Erreur connexion MongoDB:', err.message);
    process.exit(1);
  });

// Les deux symboles qu'on surveille dans le pipeline.
// On les centralise ici pour ne pas les repeter dans chaque endpoint.
const SYMBOLS = ['BTC/USDT', 'BTC-USD'];


// -- REST API ----------------------------------------------------------------
// Ces endpoints permettent au dashboard de recuperer l'etat initial au chargement
// de la page, avant que le WebSocket ne prenne le relais pour les mises a jour.

// On recupere tous les KPI temps reel depuis Redis.
// On passe par Redis et pas MongoDB parce que les metriques y sont deja
// pre-calculees par le stream-processor, donc c'est instantane.
app.get('/api/kpi', async (req, res) => {
  try {
    const kpi = {};
    for (const symbol of SYMBOLS) {
      const price = await redis.hgetall(`kpi:price:${symbol}`);
      const windows = {};
      for (const w of ['1min', '5min', '15min', '1h']) {
        windows[w] = await redis.hgetall(`kpi:stats:${symbol}:${w}`);
      }
      kpi[symbol] = { price, windows };
    }
    kpi.throughput = await redis.hgetall('kpi:throughput');
    kpi.anomalies = await redis.hgetall('kpi:anomalies');
    res.json(kpi);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Les derniers trades sont dans une liste Redis pour un acces rapide.
// On ne passe pas par MongoDB ici car on veut les trades les plus recents
// et Redis les a deja en memoire, sans latence de requete base.
app.get('/api/trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const raw = await redis.lrange('trades:latest', 0, limit - 1);
    res.json(raw.map(t => JSON.parse(t)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Les alertes sont aussi dans Redis pour un acces instantane.
app.get('/api/alerts', async (req, res) => {
  try {
    const raw = await redis.lrange('alerts:recent', 0, 49);
    res.json(raw.map(a => JSON.parse(a)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint de sante pour verifier que l'API server et ses connexions
// aux services en amont fonctionnent. Utile pour le debug et pour
// afficher l'etat du pipeline dans le dashboard.
app.get('/api/health', async (req, res) => {
  try {
    const redisPing = await redis.ping();
    const mongoOk = db ? true : false;

    let activeWorkers = 0;
    for (let i = 1; i <= 8; i++) {
      if (await redis.exists(`worker:${i}:heartbeat`)) activeWorkers++;
    }

    res.json({
      redis: redisPing === 'PONG' ? 'connected' : 'disconnected',
      mongodb: mongoOk ? 'connected' : 'disconnected',
      active_workers: activeWorkers,
      total_workers: 8,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Etat de sante complet du pipeline : containers Docker + workers + Binance.
// On proxy vers le health-dashboard (qui a acces au socket Docker) et on
// enrichit avec les heartbeats Redis des workers.
app.get('/api/pipeline', async (req, res) => {
  try {
    const workers = {};
    for (let i = 1; i <= 8; i++) {
      workers[String(i)] = (await redis.exists(`worker:${i}:heartbeat`)) ? 'active' : 'inactive';
    }

    const priceData = await redis.hgetall('kpi:price:BTC/USDT');
    let binanceStatus = 'disconnected';
    let dataAgeSec = null;
    if (priceData && priceData.timestamp) {
      const age = (Date.now() - new Date(priceData.timestamp).getTime()) / 1000;
      dataAgeSec = Math.round(age * 10) / 10;
      binanceStatus = age < 10 ? 'connected' : 'disconnected';
    }

    let containers = {};
    try {
      const r = await fetch('http://health-dashboard:8888/api/health');
      const d = await r.json();
      containers = d.containers || {};
    } catch (_) {
      containers = {};
    }

    res.json({ containers, workers, binance: { status: binanceStatus, age_sec: dataAgeSec }, computed_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historique des trades depuis MongoDB, pour les periodes plus longues
// que ce que Redis garde en memoire (Redis ne garde que les 500 derniers).
app.get('/api/trades/history', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Base de donnees pas encore prete' });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const symbol = req.query.symbol || 'BTC/USDT';
    const trades = await db.collection('trades')
      .find({ symbol })
      .sort({ _id: -1 })
      .limit(limit)
      .project({ _id: 0 })
      .toArray();
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// -- WebSocket (Socket.IO) ---------------------------------------------------
// C'est ici que se fait le push temps reel vers le dashboard.
// Le sujet insiste sur le fait que le dashboard ne doit JAMAIS etre un consumer
// Kafka direct. On passe donc par cette couche intermediaire qui lit les
// metriques depuis Redis et les pousse aux clients connectes.

io.on('connection', (socket) => {
  console.log(`Client connecte: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Client deconnecte: ${socket.id}`);
  });
});

// On pousse les donnees toutes les 500ms vers tous les clients connectes.
// 500ms est un bon compromis : assez rapide pour donner une impression
// de temps reel, mais pas trop frequent pour ne pas surcharger Redis
// avec des lectures inutiles. Les lectures Redis sont sub-milliseconde
// donc 500ms c'est tres confortable.
setInterval(async () => {
  try {
    if (io.engine.clientsCount === 0) return;

    const data = { prices: {}, windows: {} };

    for (const symbol of SYMBOLS) {
      data.prices[symbol] = await redis.hgetall(`kpi:price:${symbol}`);
      data.windows[symbol] = {};
      for (const w of ['1min', '5min', '15min', '1h']) {
        data.windows[symbol][w] = await redis.hgetall(`kpi:stats:${symbol}:${w}`);
      }
    }

    data.throughput = await redis.hgetall('kpi:throughput');
    data.anomalies = await redis.hgetall('kpi:anomalies');

    const rawTrades = await redis.lrange('trades:latest', 0, 19);
    data.trades = rawTrades.map(t => JSON.parse(t));

    const rawAlerts = await redis.lrange('alerts:recent', 0, 9);
    data.alerts = rawAlerts.map(a => JSON.parse(a));

    // Latence pipeline : ecart entre l'horodatage du trade sur l'exchange
    // et le moment ou le worker a ecrit dans Redis. Mesure end-to-end.
    const btcKpi = data.prices['BTC/USDT'];
    if (btcKpi && btcKpi.timestamp && btcKpi.trade_ts) {
      const latency = new Date(btcKpi.timestamp) - new Date(btcKpi.trade_ts);
      data.latency_ms = (latency > 0 && latency < 30000) ? latency : null;
    } else {
      data.latency_ms = null;
    }

    io.emit('realtime', data);
  } catch (err) {
    console.error('Erreur push WebSocket:', err.message);
  }
}, 500);


server.listen(PORT, () => {
  console.log(`API server demarre sur le port ${PORT}`);
});
