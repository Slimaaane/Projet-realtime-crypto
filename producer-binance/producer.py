import json
import logging
import os
from datetime import datetime, timezone

import websocket
from kafka import KafkaProducer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

KAFKA_BROKER = os.getenv("KAFKA_BROKER", "localhost:9093")
KAFKA_TOPIC  = os.getenv("KAFKA_TOPIC",  "crypto.trades.raw")
SYMBOL       = os.getenv("SYMBOL",       "btcusdt")

producer = KafkaProducer(
    bootstrap_servers=[KAFKA_BROKER],
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    retries=5,
)


def normalize(raw: dict) -> dict:
    """Transforme un trade brut Binance en format commun du pipeline."""
    return {
        "exchange":        "binance",
        "symbol":          "BTC/USDT",
        "trade_id":        str(raw["t"]),
        "price":           float(raw["p"]),
        "quantity":        float(raw["q"]),
        "timestamp":       datetime.fromtimestamp(raw["T"] / 1000, tz=timezone.utc).isoformat(),
        "is_buyer_maker":  raw["m"],
    }


def on_message(ws, message):
    raw   = json.loads(message)
    trade = normalize(raw)
    producer.send(KAFKA_TOPIC, trade)
    logger.info(f"→ Kafka | price={trade['price']:.2f} qty={trade['quantity']:.6f}")


def on_error(ws, error):
    logger.error(f"WebSocket error: {error}")


def on_close(ws, code, msg):
    logger.warning(f"Connexion fermée (code={code})")


def on_open(ws):
    logger.info(f"Connecté au stream Binance : {SYMBOL}@trade")


if __name__ == "__main__":
    url = f"wss://stream.binance.com:9443/ws/{SYMBOL}@trade"
    logger.info(f"Connexion à {url} ...")

    ws = websocket.WebSocketApp(
        url,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    ws.run_forever()
