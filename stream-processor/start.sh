#!/bin/bash
for i in $(seq 1 8); do
    python consumer_worker.py $i &
done
wait
