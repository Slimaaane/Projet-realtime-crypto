# 📈 Projet Data Engineering EFREI : Real-Time Crypto Market Monitoring System

## 🎯 Introduction et Objectifs
[cite_start]L'objectif de ce projet est de concevoir un système de streaming de données temps réel capable d'ingérer des flux live du marché des cryptomonnaies, de les traiter en continu, de détecter des événements importants et d'afficher des résultats exploitables sur un tableau de bord (Dashboard)[cite: 5, 6, 7, 8, 9]. [cite_start]Les données proviennent de flux générés en temps réel, incluant les transactions, les prix et les volumes[cite: 4].

## 🏗️ Architecture Globale
[cite_start]Le pipeline de données doit être complet et basé sur des principes stricts de découplage pour garantir sa robustesse et sa scalabilité[cite: 10, 47].

### 1. Ingestion des Données (Streaming Source)
* [cite_start]**Technologie :** API WebSockets[cite: 12].
* [cite_start]**Sources obligatoires :** * Binance Stream : flux continus de trades sur `BTC/USDT` ou `ETH/USDT`[cite: 102, 103, 104].
  * [cite_start]Coinbase Stream : flux structurés de matches sur `BTC-USD`[cite: 105, 106, 107].
* [cite_start]**Rôle :** Recevoir en continu les transactions (trades) dès qu'elles sont générées sur les marchés financiers crypto[cite: 4, 12].

### 2. Le Buffer Central (Kafka)
* [cite_start]**Technologie :** Apache Kafka[cite: 34].
* [cite_start]**Topic :** `crypto.trades.raw`[cite: 21].
* [cite_start]**Rôle :** Kafka est obligatoire dans ce projet pour jouer le rôle de tampon (buffer) entre les flux entrants (très rapides) et les processus de traitement[cite: 34, 35].
* [cite_start]**Avantages :** Il découple l'ingestion du traitement, ce qui apporte de la résilience en cas de panne et permet de distribuer les mêmes flux vers plusieurs consommateurs en parallèle[cite: 35, 36, 37].

### 3. Traitement en Temps Réel (Stream Processing)
* [cite_start]**Contrainte absolue :** Le traitement en temps réel est obligatoire, le batch processing est strictement interdit[cite: 193, 194].
* [cite_start]**Rôle :** Des "consumers" s'abonnent au topic Kafka pour parser les événements au format JSON et filtrer les données pertinentes (prix, volume, horodatage)[cite: 13, 65, 66, 67, 68].
* [cite_start]**Opérations & Analytics :** Calcul de moyennes (ex: prix moyen), de volumes cumulés sur des fenêtres glissantes, et détection d'anomalies (variations rapides de prix, volumes anormaux) en temps réel[cite: 13, 38].

### 4. Stockage et Passerelle Serveur (API Layer)
* [cite_start]**Stockage :** Une base de données (comme MongoDB ou TimescaleDB) doit être utilisée pour stocker les trades bruts, les agrégats et les métriques calculées[cite: 72, 81, 180].
* [cite_start]**API Layer :** Une passerelle serveur (API REST ou WebSocket via Node.js/Socket.IO) doit être mise en place[cite: 27, 28, 40].
* [cite_start]**Règle stricte d'architecture :** Le tableau de bord ne doit jamais être un "consumer Kafka direct" ni lire directement dans la base de données[cite: 44, 45]. [cite_start]Il faut obligatoirement passer par cette couche API intermédiaire qui s'occupe d'agréger, de formater et de pousser les données[cite: 46].

### 5. Restitution (Dashboard Temps Réel)
* [cite_start]**Technologie :** HTML, CSS et JavaScript[cite: 31, 110].
* [cite_start]**Rôle :** Un affichage live obligatoire connecté au système de traitement pour visualiser les résultats en continu[cite: 111, 195].
* [cite_start]**Éléments attendus :** L'interface doit être claire et ergonomique[cite: 112]. [cite_start]Elle doit inclure le prix et des graphiques (moyennes mobiles), un flux des transactions récentes (trades feed), des alertes en temps réel et des métriques détaillées[cite: 29, 30, 32, 33, 125, 134, 149].