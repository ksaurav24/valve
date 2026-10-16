-- Atomically grant a prefix across all rate rules using the Redis clock.
redis.replicate_commands()
-- Pin configuration independently of expiring budget state. Check on every
-- admission, before any budget mutation, including while the quota is paused.
local configKey = KEYS[#KEYS]
local config = redis.call('GET', configKey)
if config and config ~= ARGV[1] then return 'CONFIG_MISMATCH' end
if not config then redis.call('SET', configKey, ARGV[1]) end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
local pttl = redis.call('PTTL', KEYS[1])
if pttl > 0 then return {0, pttl, pttl} end
local nr = #KEYS - 2
local idx = 2
local leaseLimit = nil
local leaseTtl = nil
local owner = nil
local slotKey = nil
local slots = 0
if ARGV[2] == 'leases' then
  leaseLimit = tonumber(ARGV[3])
  leaseTtl = tonumber(ARGV[4])
  owner = ARGV[5]
  slotKey = KEYS[#KEYS-1]
  nr = nr - 1
  idx = 6
  redis.call('ZREMRANGEBYSCORE', slotKey, '-inf', now)
  slots = redis.call('ZCARD', slotKey)
end
local rules = {}
for i = 1, nr do
  local r = { algo = tonumber(ARGV[idx]), interval = tonumber(ARGV[idx+1]), limit = tonumber(ARGV[idx+2]), burst = tonumber(ARGV[idx+3]), a = 0, b = 0 }
  idx = idx + 4
  if r.algo == 0 then
    r.a = tonumber(redis.call('GET', KEYS[i+1])) or 0
  else
    local v = redis.call('HMGET', KEYS[i+1], 'w', 'n')
    r.a = tonumber(v[1]) or 0
    r.b = tonumber(v[2]) or 0
  end
  rules[i] = r
end
local nc = tonumber(ARGV[idx])
idx = idx + 1
local granted = 0
local retry = 0
local leaseBlocked = 0
for cidx = 1, nc do
  local cost = tonumber(ARGV[idx])
  idx = idx + 1
  retry = 0
  if leaseLimit and slots + granted >= leaseLimit then
    -- Slots granted by this call are added below, so the set can still be empty.
    local earliest = redis.call('ZRANGE', slotKey, 0, 0, 'WITHSCORES')
    retry = math.max(1, math.ceil((tonumber(earliest[2]) or (now + leaseTtl)) - now))
    leaseBlocked = 1
    break
  end
  for i = 1, nr do
    local r = rules[i]
    if r.algo == 0 then
      local step = r.interval / r.limit
      retry = math.max(retry, math.ceil(math.max(r.a, now) + step * cost - step * r.burst - now))
    else
      local w = math.floor(now / r.interval)
      local n = 0
      if r.a == w then n = r.b end
      if n + cost > r.limit then retry = math.max(retry, math.ceil((w+1)*r.interval - now)) end
    end
  end
  if retry > 0 then break end
  for i = 1, nr do
    local r = rules[i]
    if r.algo == 0 then r.a = math.max(r.a, now) + r.interval / r.limit * cost
    else
      local w = math.floor(now / r.interval)
      if r.a ~= w then r.b = 0 end
      r.a = w
      r.b = r.b + cost
    end
  end
  granted = granted + 1
end
if granted > 0 then
  for i = 1, nr do
    local r = rules[i]
    if r.algo == 0 then
      -- Expire at an absolute time from the same clock as `now`. A relative TTL
      -- counts from Redis's millisecond snapshot, which can trail TIME, so the
      -- key could vanish just before its theoretical arrival time.
      redis.call('SET', KEYS[i+1], string.format('%.17g', r.a), 'PXAT', math.ceil(r.a))
    else
      redis.call('HSET', KEYS[i+1], 'w', string.format('%.17g', r.a), 'n', string.format('%.17g', r.b))
      redis.call('PEXPIRE', KEYS[i+1], math.ceil(r.interval * 2))
    end
  end
end
if leaseLimit then
  local tokens = {}
  for i = 1, granted do
    local token = owner .. ':' .. (i-1)
    redis.call('ZADD', slotKey, now + leaseTtl, token)
    tokens[i] = token
  end
  local last = redis.call('ZRANGE', slotKey, -1, -1, 'WITHSCORES')
  if #last > 0 then redis.call('PEXPIREAT', slotKey, math.ceil(tonumber(last[2]))) end
  return {granted, math.max(0, retry), 0, tokens, leaseBlocked}
end
return {granted, math.max(0, retry), 0}
