import json
import logging
import os
from datetime import datetime, timezone

import websocket
from kafka import KafkaProducer

# On se connecte au WebSocket public de Coinbase pour recevoir les trades BTC-USD
# en temps reel. Chaque trade recu est normalise dans le meme format que Binance
# pour que les consumers en aval n'aient pas a gerer deux formats differents.

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

KAFKA_BROKER = os.getenv("KAFKA_BROKER", "localhost:9093")
KAFKA_TOPIC  = os.getenv("KAFKA_TOPIC",  "crypto.trades.raw")
PRODUCT_ID   = os.getenv("PRODUCT_ID",   "BTC-USD")

# On utilise les memes parametres que le producer Binance pour
# garder une coherence dans la facon dont on publie dans Kafka
producer = KafkaProducer(
    bootstrap_servers=[KAFKA_BROKER],
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    retries=5,
)


def normalize(raw: dict) -> dict:
    """On transforme un trade Coinbase dans le meme format que Binance
    pour que les consumers n'aient pas a gerer des formats differents.
    Le champ 'side' de Coinbase indique le cote du taker : si le taker
    vend (side=sell), alors l'acheteur est le maker, ce qui correspond
    au champ 'm' de Binance."""
    return {
        "exchange":       "coinbase",
        "symbol":         raw["product_id"],
        "trade_id":       str(raw["trade_id"]),
        "price":          float(raw["price"]),
        "quantity":       float(raw["size"]),
        "timestamp":      raw["time"],
        "is_buyer_maker": raw["side"] == "sell",
    }


def on_message(ws, message):
    data = json.loads(message)
    # Coinbase envoie differents types de messages sur le feed (subscriptions,
    # heartbeats, etc). On ne s'interesse qu'aux "match" qui representent
    # les trades reellement executes sur le carnet d'ordres.
    if data.get("type") in ("match", "last_match"):
        trade = normalize(data)
        key = trade['trade_id'].encode()
        producer.send(KAFKA_TOPIC, value=trade, key=key)
        logger.info(f"-> Kafka | price={trade['price']:.2f} qty={trade['quantity']:.6f}")


def on_error(ws, error):
    logger.error(f"WebSocket error: {error}")


def on_close(ws, code, msg):
    logger.warning(f"Connexion fermee (code={code})")


def on_open(ws):
    # On s'abonne uniquement au channel "matches" pour ne recevoir que les trades.
    # On pourrait aussi s'abonner a "ticker" ou "level2" mais on n'en a pas besoin
    # pour notre pipeline, ca ferait du trafic inutile.
    subscribe = {
        "type": "subscribe",
        "channels": [{"name": "matches", "product_ids": [PRODUCT_ID]}]
    }
    ws.send(json.dumps(subscribe))
    logger.info(f"Connecte au stream Coinbase : {PRODUCT_ID}")


if __name__ == "__main__":
    url = "wss://ws-feed.exchange.coinbase.com"
    logger.info(f"Connexion a {url} ...")

    ws = websocket.WebSocketApp(
        url,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    ws.run_forever()
