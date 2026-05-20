import json
import logging
import math
import os
import sys
import time
from collections import deque
from datetime import datetime, timezone

import redis
from kafka import KafkaConsumer
from pymongo import MongoClient

# Chaque worker recoit un ID en argument pour pouvoir etre identifie
# dans les logs et dans les heartbeats Redis. On lance 8 workers en
# parallele via start.sh pour repartir la charge de traitement.
WORKER_ID = sys.argv[1] if len(sys.argv) > 1 else "?"

logging.basicConfig(
    level=logging.INFO,
    format=f"%(asctime)s [Worker-{WORKER_ID}] %(message)s"
)
logger = logging.getLogger(__name__)

KAFKA_BROKER = os.getenv("KAFKA_BROKER", "localhost:9093")
KAFKA_TOPIC  = os.getenv("KAFKA_TOPIC",  "crypto.trades.raw")
MONGO_URI    = os.getenv("MONGO_URI",    "mongodb://localhost:27017/crypto")
REDIS_URI    = os.getenv("REDIS_URI",    "redis://localhost:6379")

# On limite le nombre de trades gardes dans Redis pour ne pas exploser
# la memoire. 500 trades recents suffisent pour le feed du dashboard.
REDIS_MAX_TRADES   = 500
REDIS_MAX_ALERTS   = 50

# Les fenetres glissantes servent a calculer les metriques sur differentes
# periodes. On fait 1min, 5min, 15min et 1h pour avoir une vue a
# plusieurs echelles de temps, comme sur un vrai terminal de trading.
WINDOWS            = {"1min": 60, "5min": 300, "15min": 900, "1h": 3600}

# Pour la detection d'anomalies, on utilise un seuil a 3 ecarts-types
# au-dessus de la moyenne. C'est le seuil classique en statistique
# (regle des 3 sigma) : tout ce qui depasse est considere comme anormal.
SIGMA_THRESHOLD    = 3.0

# Le ratio pour les pics de volume : si un trade a un volume 5x superieur
# a la moyenne, on le considere comme un pic. Ce ratio est ajustable.
VOLUME_SPIKE_RATIO = 5.0

# Taille du buffer pour le calcul des stats d'anomalies. On garde les
# 100 derniers trades pour calculer moyenne et ecart-type. Plus le buffer
# est grand, plus la detection est stable mais moins reactive.
ANOMALY_BUF_SIZE   = 100
MIN_SAMPLES        = 10

mongo_client = MongoClient(MONGO_URI)
db           = mongo_client.get_default_database()
trades_col   = db["trades"]

r = redis.from_url(REDIS_URI, decode_responses=True)

# On utilise le group_id "group-ingestion" pour que les 8 workers se
# repartissent les partitions du topic. Comme ca chaque trade n'est
# traite qu'une seule fois, pas en doublon.
consumer = KafkaConsumer(
    KAFKA_TOPIC,
    bootstrap_servers=[KAFKA_BROKER],
    group_id="group-ingestion",
    value_deserializer=lambda m: json.loads(m.decode("utf-8")),
    auto_offset_reset="latest",
)

# Buffers par symbole : BTC/USDT et BTC-USD ont des prix differents (~70$ d'ecart).
# Melanger les deux dans un meme buffer genere de fausses anomalies (l'ecart
# de prix entre exchanges depasse souvent 3 sigma si le buffer est mixte).
price_buffers  = {}   # { symbol: deque }
volume_buffers = {}   # { symbol: deque }

logger.info("Demarre -- en attente de messages...")


def _mean(vals):
    return sum(vals) / len(vals)


def _std(vals, avg):
    return math.sqrt(sum((x - avg) ** 2 for x in vals) / len(vals))


def compute_window_stats(trades):
    """On calcule les statistiques agregees sur une liste de trades :
    prix moyen, min, max, volume total en quantite et en USD, et
    nombre de trades. Ces stats alimentent les KPI du dashboard."""
    if not trades:
        return None
    prices = [t["price"]    for t in trades]
    qtys   = [t["quantity"] for t in trades]
    return {
        "avg_price":   round(_mean(prices), 2),
        "min_price":   min(prices),
        "max_price":   max(prices),
        "volume_qty":  round(sum(qtys), 8),
        "volume_usd":  round(sum(p * q for p, q in zip(prices, qtys)), 2),
        "trade_count": len(trades),
    }


for msg in consumer:
    try:
        trade  = msg.value
        symbol = trade["symbol"]
        price  = trade["price"]
        qty    = trade["quantity"]
        ts     = trade["timestamp"]
        now_ms = int(time.time() * 1000)

        # Heartbeat : on signale a Redis que ce worker est vivant.
        # Le TTL de 10s fait qu'un worker qui ne traite plus rien
        # sera automatiquement marque comme inactif dans le dashboard.
        r.setex(f"worker:{WORKER_ID}:heartbeat", 10, "1")

        # -- 1. MongoDB : stockage permanent ---------------------------------
        # On stocke chaque trade dans MongoDB pour avoir un historique
        # complet qu'on peut requeter plus tard (analyses, debug, etc).
        doc = {
            "exchange":       trade["exchange"],
            "symbol":         symbol,
            "trade_id":       trade["trade_id"],
            "price":          price,
            "quantity":       qty,
            "timestamp":      ts,
            "is_buyer_maker": trade["is_buyer_maker"],
            "worker_id":      WORKER_ID,
        }
        trades_col.insert_one(doc)
        trade_json = json.dumps({k: v for k, v in doc.items() if k != "_id"})

        # -- 2. Redis : fenetre glissante + feed trades -----------------------
        # On utilise un sorted set Redis avec le timestamp comme score.
        # Ca permet de recuperer facilement les trades d'une periode donnee
        # et de supprimer ceux qui sortent de la fenetre de 1h.
        window_key = f"window:{symbol}"
        pipe = r.pipeline()
        pipe.zadd(window_key, {trade_json: now_ms})
        pipe.zremrangebyscore(window_key, 0, now_ms - 3600 * 1000)
        pipe.lpush("trades:latest", trade_json)
        pipe.ltrim("trades:latest", 0, REDIS_MAX_TRADES - 1)
        # Compteur de throughput : on garde les ticks de la derniere seconde
        # dans un sorted set pour calculer le nombre de trades par seconde.
        pipe.zadd("throughput:ticks", {f"{now_ms}-{WORKER_ID}": now_ms})
        pipe.zremrangebyscore("throughput:ticks", 0, now_ms - 1000)
        pipe.execute()

        # -- 3. KPI : prix actuel + variation vs 1h ---------------------------
        # On recupere le trade le plus ancien dans la fenetre de 1h pour
        # calculer la variation de prix. Ca donne un pourcentage de
        # changement sur la derniere heure, utile pour le dashboard.
        oldest = r.zrangebyscore(window_key, now_ms - 3600 * 1000, "+inf", start=0, num=1)
        change_pct_1h = 0.0
        if oldest:
            price_1h_ago = json.loads(oldest[0])["price"]
            if price_1h_ago:
                change_pct_1h = round((price - price_1h_ago) / price_1h_ago * 100, 2)

        r.hset(f"kpi:price:{symbol}", mapping={
            "price":         price,
            "timestamp":     datetime.now(timezone.utc).isoformat(),
            "trade_ts":      ts,
            "exchange":      trade["exchange"],
            "change_pct_1h": change_pct_1h,
        })

        # -- 4. KPI : agregations par fenetre (1min / 5min / 15min / 1h) ------
        # Pour chaque fenetre, on recupere tous les trades de la periode
        # et on calcule les stats. On stocke le resultat dans un hash Redis
        # que l'API server pourra lire directement.
        stats_pipe = r.pipeline()
        for name, seconds in WINDOWS.items():
            raw    = r.zrangebyscore(window_key, now_ms - seconds * 1000, "+inf")
            stats  = compute_window_stats([json.loads(t) for t in raw])
            if stats:
                stats_pipe.hset(f"kpi:stats:{symbol}:{name}",
                                mapping={k: str(v) for k, v in stats.items()})
        stats_pipe.execute()

        # -- 5. KPI : trades/seconde ------------------------------------------
        ticks = r.zcount("throughput:ticks", now_ms - 1000, "+inf")
        r.hset("kpi:throughput", mapping={
            "trades_per_sec": ticks,
            "computed_at":    ts,
        })

        # -- 6. Detection d'anomalies ----------------------------------------
        # Buffers separes par symbole pour eviter les fausses alertes dues
        # au melange BTC/USDT (~77480) et BTC-USD (~77410).
        if symbol not in price_buffers:
            price_buffers[symbol]  = deque(maxlen=ANOMALY_BUF_SIZE)
            volume_buffers[symbol] = deque(maxlen=ANOMALY_BUF_SIZE)

        price_buffers[symbol].append(price)
        volume_buffers[symbol].append(qty)

        if len(price_buffers[symbol]) >= MIN_SAMPLES:
            avg_p = _mean(price_buffers[symbol])
            std_p = _std(price_buffers[symbol], avg_p)
            avg_v = _mean(volume_buffers[symbol])
            alert = None

            if std_p > 0 and abs(price - avg_p) > SIGMA_THRESHOLD * std_p:
                dev   = abs(price - avg_p) / std_p
                alert = {
                    "type":      "price_anomaly",
                    "symbol":    symbol,
                    "message":   f"Prix anormal : {price:.2f}$ ({dev:.1f} sigma)",
                    "price":     price,
                    "timestamp": ts,
                }
            elif avg_v > 0 and qty > avg_v * VOLUME_SPIKE_RATIO:
                alert = {
                    "type":      "volume_spike",
                    "symbol":    symbol,
                    "message":   f"Pic de volume : {qty:.6f} (x{qty / avg_v:.1f} la moy.)",
                    "price":     price,
                    "quantity":  qty,
                    "timestamp": ts,
                }

            if alert:
                alert_pipe = r.pipeline()
                alert_pipe.lpush("alerts:recent", json.dumps(alert))
                alert_pipe.ltrim("alerts:recent", 0, REDIS_MAX_ALERTS - 1)
                # On garde aussi un compteur d'anomalies sur 10 min dans un
                # sorted set pour afficher le nombre total dans le dashboard.
                alert_pipe.zadd("anomalies:window", {f"{now_ms}-{WORKER_ID}": now_ms})
                alert_pipe.zremrangebyscore("anomalies:window", 0, now_ms - 600 * 1000)
                alert_pipe.execute()

                count_10min = r.zcount("anomalies:window", now_ms - 600 * 1000, "+inf")
                r.hset("kpi:anomalies", mapping={
                    "count_10min": count_10min,
                    "last_type":   alert["type"],
                    "last_ts":     ts,
                })
                logger.warning(f"ALERTE | {alert['message']}")

        logger.info(f"Trade stocke | {symbol} price={price:.2f}$ qty={qty:.6f}")

    except Exception as e:
        logger.error(f"Erreur message ignore: {e}")
