#!/usr/bin/env bash
# Start three Docker Redis masters and configure a local integration cluster.
set -euo pipefail
for port in 17300 17301 17302; do
  docker run -d --rm --name "valve-test-cluster-$port" --network host redis:7.4 redis-server --port "$port" --bind 127.0.0.1 --cluster-enabled yes --cluster-config-file "/tmp/nodes-$port.conf" --cluster-node-timeout 5000 --appendonly no
done
for port in 17300 17301 17302; do
  for attempt in {1..50}; do
    if docker exec "valve-test-cluster-$port" redis-cli -p "$port" ping >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  docker exec "valve-test-cluster-$port" redis-cli -p "$port" ping
done
docker exec valve-test-cluster-17300 redis-cli --cluster create 127.0.0.1:17300 127.0.0.1:17301 127.0.0.1:17302 --cluster-replicas 0 --cluster-yes
