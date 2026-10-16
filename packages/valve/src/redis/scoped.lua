-- Sparse atomic admission. All validation and reads precede every write.
redis.replicate_commands()
local p = cjson.decode(ARGV[1])
local function integer(v, min, max)
  return type(v) == 'number' and v >= min and v <= max and v == math.floor(v)
end
local function requireType(key, expected)
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= expected then error('Invalid scoped key type') end
end
local function number(v)
  if not v then return 0 end
  local n = tonumber(v)
  if not n or n ~= n or n < 0 or n > 9007199254740991 then error('Invalid scoped state') end
  return n
end
if type(p) ~= 'table' or type(p.rules) ~= 'table' or type(p.jobs) ~= 'table' or type(p.fingerprint) ~= 'string' then error('Invalid scoped request') end
local nr = #p.rules
local nj = #p.jobs
if nr < 1 or nr > 2048 or nj < 1 or nj > 128 or #KEYS ~= nr + 3 then error('Invalid scoped bounds') end
if KEYS[1] == KEYS[2] or KEYS[1] == KEYS[3] or KEYS[2] == KEYS[3] then error('Duplicate scoped control key') end
requireType(KEYS[1], 'string')
requireType(KEYS[2], 'string')
requireType(KEYS[3], 'zset')
local config = redis.call('GET', KEYS[1])
if config and config ~= p.fingerprint then return 'CONFIG_MISMATCH' end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
local pause = math.max(0, redis.call('PTTL', KEYS[2]))
local slots = 0
local earliest = nil
if p.lease then
  if not integer(p.lease.limit, 1, 9007199254740991) or (type(p.lease.ttlMs) ~= 'number' or p.lease.ttlMs < 30 or p.lease.ttlMs > 9007199254740991 - now) or type(p.lease.owner) ~= 'string' or #p.lease.owner < 1 or #p.lease.owner > 1024 then error('Invalid scoped lease') end
  slots = redis.call('ZCOUNT', KEYS[3], '(' .. now, '+inf')
  local last = redis.call('ZRANGE', KEYS[3], -1, -1, 'WITHSCORES')
  if #last > 0 then number(last[2]) end
  local first = redis.call('ZRANGEBYSCORE', KEYS[3], '(' .. now, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  if #first > 0 then earliest = number(first[2]) end
end
local seen = {}
for i, r in ipairs(p.rules) do
  if (r.algorithm ~= 'gcra' and r.algorithm ~= 'fixed-window') or (type(r.intervalMs) ~= 'number' or r.intervalMs < 1 or r.intervalMs > 2251799813685247) or not integer(r.limit, 1, 9007199254740991) or not integer(r.burst, 1, 9007199254740991) then error('Invalid scoped rule') end
  if seen[KEYS[i+3]] or KEYS[i+3] == KEYS[1] or KEYS[i+3] == KEYS[2] or KEYS[i+3] == KEYS[3] then error('Duplicate scoped key') end
  seen[KEYS[i+3]] = true
  requireType(KEYS[i+3], r.algorithm == 'gcra' and 'string' or 'hash')
  if r.algorithm == 'gcra' then
    r.a = number(redis.call('GET', KEYS[i+3])); r.b = 0
  else
    local v = redis.call('HMGET', KEYS[i+3], 'w', 'n')
    r.a = number(v[1]); r.b = number(v[2])
    if r.a ~= math.floor(r.a) or r.b ~= math.floor(r.b) then error('Invalid scoped window state') end
  end
end
for j, job in ipairs(p.jobs) do
  if not integer(job.cost, 1, 9007199254740991) or type(job.refs) ~= 'table' or #job.refs < 1 or #job.refs > 16 then error('Invalid scoped job') end
  local refs = {}
  for _, zero in ipairs(job.refs) do
    if not integer(zero, 0, nr-1) or refs[zero] then error('Invalid scoped reference') end
    refs[zero] = true
    local r = p.rules[zero+1]
    if job.cost > (r.algorithm == 'gcra' and r.burst or r.limit) then error('Invalid scoped cost') end
    if r.algorithm == 'gcra' and (r.intervalMs / r.limit * r.burst > 9007199254740991 - now) then error('Scoped rate exceeds numeric range') end
  end
  if p.lease and redis.call('ZSCORE', KEYS[3], p.lease.owner .. ':' .. (j-1)) then error('Duplicate scoped lease owner') end
end
local granted = {}
local blocked = {}
local tokens = {}
for j, job in ipairs(p.jobs) do
  local leaseRetry = 0
  if p.lease and slots + #granted >= p.lease.limit then leaseRetry = math.max(math.ceil((earliest or (now + p.lease.ttlMs)) - now), 1) end
  local retry = math.max(pause, leaseRetry)
  for _, zero in ipairs(job.refs) do
    local r = p.rules[zero+1]
    if r.algorithm == 'gcra' then
      local step = r.intervalMs / r.limit
      retry = math.max(retry, math.ceil(math.max(r.a, now) + step * job.cost - step * r.burst - now))
    else
      local w = math.floor(now / r.intervalMs)
      local count = r.a == w and r.b or 0
      if count + job.cost > r.limit then retry = math.max(retry, math.ceil((w+1)*r.intervalMs - now)) end
    end
  end
  if retry > 0 then
    blocked[#blocked+1] = p.lease and {j-1, retry, retry == leaseRetry and 1 or 0} or {j-1, retry}
  else
    granted[#granted+1] = j-1
    for _, zero in ipairs(job.refs) do
      local r = p.rules[zero+1]
      r.changed = true
      if r.algorithm == 'gcra' then r.a = math.max(r.a, now) + r.intervalMs / r.limit * job.cost
      else
        local w = math.floor(now / r.intervalMs)
        r.b = (r.a == w and r.b or 0) + job.cost
        r.a = w
      end
    end
    if p.lease then tokens[#tokens+1] = {j-1, p.lease.owner .. ':' .. (j-1)} end
  end
end
for _, r in ipairs(p.rules) do
  if r.changed and (r.a > 9007199254740991 or r.b > 9007199254740991) then error('Scoped state exceeds numeric range') end
end
-- No state mutation above this point, including configuration and expired leases.
if not config then redis.call('SET', KEYS[1], p.fingerprint) end
for i, r in ipairs(p.rules) do
  if r.changed then
    if r.algorithm == 'gcra' then redis.call('SET', KEYS[i+3], string.format('%.17g', r.a), 'PXAT', math.ceil(r.a))
    else
      redis.call('HSET', KEYS[i+3], 'w', string.format('%.17g', r.a), 'n', string.format('%.17g', r.b))
      redis.call('PEXPIREAT', KEYS[i+3], math.ceil((r.a+1)*r.intervalMs))
    end
  end
end
if p.lease then
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
  for _, token in ipairs(tokens) do redis.call('ZADD', KEYS[3], now + p.lease.ttlMs, token[2]) end
  local last = redis.call('ZRANGE', KEYS[3], -1, -1, 'WITHSCORES')
  if #last > 0 then redis.call('PEXPIREAT', KEYS[3], math.ceil(number(last[2]))) end
end
return {granted, blocked, tokens, pause}
