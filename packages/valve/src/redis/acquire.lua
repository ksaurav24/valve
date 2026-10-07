-- Atomically grant a prefix across all rate rules using the Redis clock.
redis.replicate_commands()
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
local pttl = redis.call('PTTL', KEYS[1])
if pttl > 0 then return {0, pttl, pttl} end
local nr = #KEYS - 1
local rules = {}
local idx = 1
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
for cidx = 1, nc do
  local cost = tonumber(ARGV[idx])
  idx = idx + 1
  retry = 0
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
      redis.call('SET', KEYS[i+1], string.format('%.17g', r.a), 'PX', math.max(1, math.ceil(r.a - now)))
    else
      redis.call('HSET', KEYS[i+1], 'w', string.format('%.17g', r.a), 'n', string.format('%.17g', r.b))
      redis.call('PEXPIRE', KEYS[i+1], math.ceil(r.interval * 2))
    end
  end
end
return {granted, math.max(0, retry), 0}
