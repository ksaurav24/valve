-- Managed limits: registration, reads, updates, and admission against authoritative limits.
-- Every read and check precedes every write. Problems the caller can act on are
-- returned as '!CODE:message' statuses, never raised, so no store-error policy
-- can admit jobs past them.
redis.replicate_commands()
local MAX = 9007199254740991
local QUARTER = MAX / 4
local op = ARGV[1]
local marker = ARGV[2]
local pin = ARGV[3]
local known = ARGV[4]
local nr = tonumber(ARGV[5])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
local function status(code, message) return '!' .. code .. ':' .. message end
local function integer(v, min, max)
  return type(v) == 'number' and v >= min and v <= max and v == math.floor(v)
end
local function fmt(v) return string.format('%.17g', v) end
if not nr or not integer(nr, 1, 2048) then return status('INVALID_OPTIONS', 'Invalid managed request.') end

-- Requested structure. Names, scopes, algorithms and intervals are pinned by the marker.
local rules, byName, names = {}, {}, {}
for i = 1, nr do
  local base = 5 + (i - 1) * 6
  local r = { name = ARGV[base + 1], algo = ARGV[base + 2] == 'gcra' and 0 or 1, I = tonumber(ARGV[base + 3]),
    seedL = tonumber(ARGV[base + 4]), seedB = tonumber(ARGV[base + 5]), scoped = ARGV[base + 6] == '1' }
  if not r.I or r.I < 1 or r.I > QUARTER or not integer(r.seedL, 1, MAX) or not integer(r.seedB, 1, MAX) or (r.algo == 1 and r.seedB ~= 1) or byName[r.name] then
    return status('INVALID_OPTIONS', 'Invalid managed rule.')
  end
  rules[i] = r; byName[r.name] = r; names[i] = 'n:' .. r.name
end
local nextArg = 5 + nr * 6 + 1

-- Resolve the pin and the limits, registering, adopting, or restoring as needed.
local config = redis.call('GET', KEYS[1])
local meta = redis.call('HMGET', KEYS[2], 'v', 'e', 'r', 's', 'p', 'u', unpack(names))
local mismatch = status('INVALID_OPTIONS', 'Shared managed limits do not match this structure. Use the same rule names, scopes, algorithms, intervals, and global concurrency on every worker.')
local register = false
local writePin = nil
local epoch, revision, updated, storedPin
if meta[1] then
  if meta[1] ~= '1' then return status('INVALID_OPTIONS', 'Managed limits use an unsupported schema. Upgrade valve.') end
  if meta[4] ~= marker then return mismatch end
  if config and config ~= marker and not (config == meta[5] and meta[6] == '0') then return mismatch end
  epoch, revision, updated, storedPin = meta[2], tonumber(meta[3]), meta[6] == '1', meta[5]
  if not epoch or not string.match(epoch, '^%d+$') or not integer(tonumber(epoch), 0, MAX) or not integer(revision, 1, MAX) or not storedPin or (meta[6] ~= '0' and meta[6] ~= '1') then return status('INVALID_OPTIONS', 'Managed limits are corrupt.') end
  for i, r in ipairs(rules) do
    local packed = meta[6 + i]
    if not packed then return status('INVALID_OPTIONS', 'Managed limits are corrupt.') end
    local f = {}
    for v in string.gmatch(packed, '%S+') do f[#f + 1] = tonumber(v) end
    if #f ~= 10 then return status('INVALID_OPTIONS', 'Managed limits are corrupt.') end
    for _, v in ipairs(f) do if v ~= v or v == math.huge or v == -math.huge then return status('INVALID_OPTIONS', 'Managed limits are corrupt.') end end
    if f[1] ~= r.algo or f[2] ~= r.I or not integer(f[3], 1, MAX) or not integer(f[4], 1, MAX) or f[5] < 0 or f[5] > MAX or f[7] < 1 / MAX or f[7] > QUARTER or f[8] < 0 or f[8] > MAX or not integer(f[9], f[4], MAX) or (r.algo == 1 and (f[4] ~= 1 or f[5] ~= 0 or f[6] ~= 0 or f[8] ~= 0 or f[9] ~= 1)) then
      return status('INVALID_OPTIONS', 'Managed limits are corrupt.')
    end
    if r.algo == 1 and f[10] ~= 0 then return status('INVALID_OPTIONS', 'Managed limits are corrupt.') end
    if math.abs(f[10]) > math.abs(f[6]) * 2.220446049250313e-16 then return status('INVALID_OPTIONS', 'Managed limits are corrupt.') end
    r.L, r.b, r.c, r.th, r.sr, r.sw, r.ub, r.tr = f[3], f[4], f[5], f[6], f[7], f[8], f[9], f[10]
  end
  if not config then writePin = updated and marker or storedPin end
else
  if config and config ~= marker and config ~= pin then return mismatch end
  register = true
  epoch = t[1] .. string.format('%06d', tonumber(t[2]))
  revision = 1
  updated = config == marker
  storedPin = pin
  for _, r in ipairs(rules) do
    r.L, r.b, r.c, r.th, r.sr, r.sw, r.ub, r.tr = r.seedL, r.seedB, 0, 0, r.I / r.seedL, 0, r.seedB, 0
  end
  if not config then writePin = pin end
end

-- Keep each compensated operation separate: luamin may reassociate nested sums.
local function advance(r)
  local step = r.I / r.L
  local slope = r.sr / step
  local elapsed = now - r.c
  return elapsed * slope
end
local function theta(r)
  local delta = advance(r)
  local offset = r.tr + delta
  return r.th + offset
end
local function rebase(r)
  local delta = advance(r)
  local sum = r.th + delta
  local part = sum - r.th
  local recovered = sum - part
  local left = r.th - recovered
  local right = delta - part
  local error = left + right
  local remainder = error + r.tr
  local next = sum + remainder
  local rounded = next - sum
  r.tr = remainder - rounded
  r.th = next; r.c = now
end
local function ratio(r) return r.I / r.L / r.sr end
local function identity(r) return r.c == 0 and r.th == 0 and r.tr == 0 and r.I / r.L == r.sr end
local function precise(r, L, b)
  if r.algo ~= 0 then return true end
  local extent = math.abs(theta(r)) + r.sr * math.max(r.ub, b or r.b, L or r.L)
  return extent < math.huge and extent * 2.220446049250313e-16 <= r.sr / 1024
end
for _, r in ipairs(rules) do
  if r.algo == 0 and (r.sr * r.b > QUARTER or (r.I / r.L) * r.ub > QUARTER or not precise(r)) then
    return status('INVALID_OPTIONS', 'Managed GCRA limits exceed the safe numeric precision. Use a lower rate or a coordinated migration.')
  end
end
local function cap(r) return r.algo == 0 and r.b or r.L end
local function pack(r) return table.concat({ r.algo, fmt(r.I), fmt(r.L), fmt(r.b), fmt(r.c), fmt(r.th), fmt(r.sr), fmt(r.sw), fmt(r.ub), fmt(r.tr) }, ' ') end
local function version() return epoch .. '.' .. fmt(revision) end
local function snapshot()
  local out = { version(), fmt(revision) }
  for _, r in ipairs(rules) do
    out[#out + 1] = r.name; out[#out + 1] = fmt(r.L); out[#out + 1] = fmt(r.b)
  end
  return out
end
local function changedSnapshot() if known == version() then return {} end return snapshot() end
-- Real expiry of virtual arrival time x; equal to immutable PXAT in the identity frame.
local function expireAt(r, x, th) if identity(r) then return math.ceil(x) end return math.ceil(now + (x - th) * ratio(r)) end
-- Read GCRA or fixed-window state, rejecting unparseable values instead of raising.
local function readState(key, r)
  if r.algo == 0 then
    local v = redis.pcall('GET', key)
    if type(v) == 'table' and v.err then return nil end
    if not v then return { a = 0, b = 0, live = false } end
    local x = tonumber(v)
    if not x or x ~= x or x < 0 or x == math.huge then return nil end
    return { a = x, b = 0, live = true }
  end
  local v = redis.pcall('HMGET', key, 'w', 'n')
  if type(v) == 'table' and v.err then return nil end
  local w, n = tonumber(v[1] or 0), tonumber(v[2] or 0)
  if not integer(w, 0, MAX) or not integer(n, 0, MAX) then return nil end
  return { a = w, b = n, live = v[1] ~= false }
end
local corrupt = status('INVALID_OPTIONS', 'Stored rate state has an invalid type or value.')
local function commitLimits()
  if register then
    local fields = { 'v', '1', 'e', epoch, 'r', fmt(revision), 's', marker, 'p', storedPin, 'u', updated and '1' or '0' }
    for _, r in ipairs(rules) do fields[#fields + 1] = 'n:' .. r.name; fields[#fields + 1] = pack(r) end
    redis.call('HSET', KEYS[2], unpack(fields))
  end
  if writePin then redis.call('SET', KEYS[1], writePin) end
end

if op == 'g' then
  commitLimits()
  return snapshot()
end

if op == 'u' then
  local ok, p = pcall(cjson.decode, ARGV[nextArg])
  if not ok or type(p) ~= 'table' or type(p.p) ~= 'table' or type(p.x) ~= 'table' then return status('INVALID_OPTIONS', 'Invalid limits patch.') end
  local function fields(list, what)
    local out = {}
    for _, e in ipairs(list) do
      local r = type(e) == 'table' and byName[e[1]]
      if not r or out[e[1]] then return nil, status('INVALID_OPTIONS', what .. ' names an unknown rule.') end
      local v = { limit = e[2] ~= false and e[2] or nil, burst = e[3] ~= false and e[3] or nil }
      for _, n in pairs(v) do if not integer(n, 1, MAX) then return nil, status('INVALID_OPTIONS', what .. ' values must be positive integers.') end end
      if v.burst and r.algo ~= 0 then return nil, status('INVALID_OPTIONS', what .. ' cannot set burst on a fixed-window rule.') end
      out[e[1]] = v
    end
    return out
  end
  local patch, err = fields(p.p, 'limits patch')
  if not patch then return err end
  local expect, err2 = fields(p.x, 'limits expect')
  if not expect then return err2 end
  for name, v in pairs(expect) do
    local r, target = byName[name], patch[name] or {}
    for _, field in ipairs({ 'limit', 'burst' }) do
      local current = field == 'limit' and r.L or r.b
      if v[field] and current ~= v[field] and target[field] ~= current then
        return status('LIMITS_CONFLICT', 'limits changed concurrently: ' .. name .. '.' .. field .. ' is ' .. fmt(current) .. ', expected ' .. fmt(v[field]) .. '. Read the current limits and retry.')
      end
    end
  end
  local planned = {}
  for _, r in ipairs(rules) do
    local v = patch[r.name]
    if v then
      local L, b = v.limit or r.L, v.burst or r.b
      if r.algo == 0 and (r.sr * b > QUARTER or (r.I / L) * math.max(r.ub, b) > QUARTER or not precise(r, L, b)) then
        return status('INVALID_OPTIONS', 'limits patch for ' .. r.name .. ' exceeds the safe numeric range.')
      end
      if L ~= r.L or b ~= r.b then planned[#planned + 1] = { r, L, b } end
    end
  end
  -- Read bounded unscoped GCRA state whose expiry follows the rate.
  local refresh = {}
  if #planned > 0 and revision == MAX then return status('INVALID_OPTIONS', 'Managed limits revision is exhausted. Use a coordinated migration.') end
  if #planned > 0 then
    local k = 5
    for _, r in ipairs(rules) do
      if not r.scoped then
        k = k + 1
        if r.algo == 0 and patch[r.name] then
          local s = readState(KEYS[k], r)
          if not s then return corrupt end
          if s.live then refresh[#refresh + 1] = { KEYS[k], r, s.a } end
        end
      end
    end
  end
  local relaxed = 0
  for _, e in ipairs(planned) do
    local r, L, b = e[1], e[2], e[3]
    if L > r.L or b > r.b then relaxed = 1 end
    local before, after = r.I / r.L, r.I / L
    r.ub = math.max(r.ub, b)
    if r.algo == 0 and after ~= before then
      rebase(r)
      if after > before then r.sw = math.max(r.sw, now + r.ub * after) end
    end
    r.L, r.b = L, b
  end
  commitLimits()
  if #planned > 0 then
    revision = revision + 1
    local fields = { 'r', fmt(revision), 'u', '1' }
    for _, e in ipairs(planned) do fields[#fields + 1] = 'n:' .. e[1].name; fields[#fields + 1] = pack(e[1]) end
    redis.call('HSET', KEYS[2], unpack(fields))
    redis.call('SET', KEYS[1], marker)
    for _, e in ipairs(refresh) do
      local key, r, x = e[1], e[2], e[3]
      local th = theta(r)
      x = math.min(x, th + r.sr * r.ub)
      if x > th then redis.call('PEXPIREAT', key, expireAt(r, x, th)) end
    end
    redis.call('PUBLISH', KEYS[5], 'limits:' .. version() .. ':' .. relaxed)
  end
  return snapshot()
end

local pause = math.max(0, redis.call('PTTL', KEYS[3]))

if op == 'a' then
  -- Static prefix admission, mirroring acquire.lua with authoritative limits.
  local leaseLimit, leaseTtl, owner = nil, nil, nil
  local idx = nextArg
  if ARGV[idx] == 'leases' then
    leaseLimit, leaseTtl, owner = tonumber(ARGV[idx + 1]), tonumber(ARGV[idx + 2]), ARGV[idx + 3]
    idx = idx + 4
  else
    idx = idx + 1
  end
  local nc = tonumber(ARGV[idx])
  idx = idx + 1
  if pause > 0 then
    commitLimits()
    return { 0, pause, pause, {}, 0, 0, changedSnapshot() }
  end
  local slots, earliest = 0, nil
  if leaseLimit then
    slots = redis.call('ZCOUNT', KEYS[4], '(' .. now, '+inf')
    local first = redis.call('ZRANGEBYSCORE', KEYS[4], '(' .. now, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
    if #first > 0 then earliest = tonumber(first[2]) end
  end
  local states, thetas = {}, {}
  for i, r in ipairs(rules) do
    local s = readState(KEYS[5 + i], r)
    if not s then return corrupt end
    if r.algo == 0 then
      thetas[i] = theta(r)
      s.a = math.min(s.a, thetas[i] + r.sr * r.ub)
    end
    states[i] = s
  end
  local granted, retry, leaseBlocked, impossible = 0, 0, 0, 0
  for _ = 1, nc do
    local cost = tonumber(ARGV[idx])
    idx = idx + 1
    retry = 0
    if leaseLimit and slots + granted >= leaseLimit then
      retry = math.max(1, math.ceil((earliest or (now + leaseTtl)) - now))
      leaseBlocked = 1
      break
    end
    for _, r in ipairs(rules) do if cost > cap(r) then impossible = 1 end end
    if impossible == 1 then break end
    for i, r in ipairs(rules) do
      local s = states[i]
      if r.algo == 0 then
        local excess = math.max(s.a, thetas[i]) + r.sr * cost - r.sr * r.b - thetas[i]
        if excess > 0 then retry = math.max(retry, math.ceil(excess * ratio(r))) end
      else
        local w = math.floor(now / r.I)
        local n = 0
        if s.a == w then n = s.b end
        if n + cost > r.L then retry = math.max(retry, math.ceil((w + 1) * r.I - now)) end
      end
    end
    if retry > 0 then break end
    for i, r in ipairs(rules) do
      local s = states[i]
      if r.algo == 0 then s.a = math.max(s.a, thetas[i]) + r.sr * cost
      else
        local w = math.floor(now / r.I)
        if s.a ~= w then s.b = 0 end
        s.a = w
        s.b = s.b + cost
      end
    end
    granted = granted + 1
  end
  if impossible == 1 then retry = 0 end
  commitLimits()
  if granted > 0 then
    for i, r in ipairs(rules) do
      local s = states[i]
      if r.algo == 0 then
        redis.call('SET', KEYS[5 + i], fmt(s.a), 'PXAT', expireAt(r, s.a, thetas[i]))
      else
        redis.call('HSET', KEYS[5 + i], 'w', fmt(s.a), 'n', fmt(s.b))
        redis.call('PEXPIRE', KEYS[5 + i], math.ceil(r.I * 2))
      end
    end
  end
  local tokens = {}
  if leaseLimit then
    redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
    for i = 1, granted do
      tokens[i] = owner .. ':' .. (i - 1)
      redis.call('ZADD', KEYS[4], now + leaseTtl, tokens[i])
    end
    local last = redis.call('ZRANGE', KEYS[4], -1, -1, 'WITHSCORES')
    if #last > 0 then redis.call('PEXPIREAT', KEYS[4], math.ceil(tonumber(last[2]))) end
  end
  return { granted, math.max(0, retry), 0, tokens, leaseBlocked, impossible, changedSnapshot() }
end

if op == 's' then
  -- Sparse all-or-none scoped admission, mirroring scoped.lua with authoritative limits.
  local ok, p = pcall(cjson.decode, ARGV[nextArg])
  if not ok or type(p) ~= 'table' or type(p.kr) ~= 'table' or type(p.jobs) ~= 'table' then return status('INVALID_OPTIONS', 'Invalid scoped request.') end
  local nk, nj = #p.kr, #p.jobs
  if nk < 1 or nk > 2048 or nj < 1 or nj > 128 or #KEYS ~= nk + 5 then return status('INVALID_OPTIONS', 'Invalid scoped bounds.') end
  local lease = p.lease
  local slots, earliest = 0, nil
  if lease then
    if not integer(lease.limit, 1, MAX) or type(lease.ttlMs) ~= 'number' or lease.ttlMs < 30 or lease.ttlMs > MAX - now or type(lease.owner) ~= 'string' or #lease.owner < 1 or #lease.owner > 1024 then return status('INVALID_OPTIONS', 'Invalid scoped lease.') end
    slots = redis.call('ZCOUNT', KEYS[4], '(' .. now, '+inf')
    local first = redis.call('ZRANGEBYSCORE', KEYS[4], '(' .. now, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
    if #first > 0 then earliest = tonumber(first[2]) end
  end
  local keys, seen = {}, {}
  for k, ri in ipairs(p.kr) do
    local r = integer(ri, 1, nr) and rules[ri]
    local key = KEYS[k + 5]
    if not r or seen[key] then return status('INVALID_OPTIONS', 'Invalid scoped key.') end
    seen[key] = true
    local s = readState(key, r)
    if not s then return corrupt end
    if r.algo == 0 then
      s.th = theta(r)
      s.a = math.min(s.a, s.th + r.sr * r.ub)
    end
    s.r = r
    keys[k] = s
  end
  for j, job in ipairs(p.jobs) do
    if type(job) ~= 'table' or not integer(job.cost, 1, MAX) or type(job.refs) ~= 'table' or #job.refs < 1 or #job.refs > 16 then return status('INVALID_OPTIONS', 'Invalid scoped job.') end
    local refs = {}
    for _, zero in ipairs(job.refs) do
      if not integer(zero, 0, nk - 1) or refs[zero] then return status('INVALID_OPTIONS', 'Invalid scoped reference.') end
      refs[zero] = true
    end
    if lease and redis.call('ZSCORE', KEYS[4], lease.owner .. ':' .. (j - 1)) then return status('INVALID_OPTIONS', 'Duplicate scoped lease owner.') end
  end
  local granted, blocked, tokens = {}, {}, {}
  for j, job in ipairs(p.jobs) do
    local leaseRetry = 0
    if lease and slots + #granted >= lease.limit then leaseRetry = math.max(math.ceil((earliest or (now + lease.ttlMs)) - now), 1) end
    local retry = math.max(pause, leaseRetry)
    local impossible = false
    for _, zero in ipairs(job.refs) do if job.cost > cap(keys[zero + 1].r) then impossible = true end end
    for _, zero in ipairs(job.refs) do
      local s = keys[zero + 1]
      local r = s.r
      if impossible then
      elseif r.algo == 0 then
        local excess = math.max(s.a, s.th) + r.sr * job.cost - r.sr * r.b - s.th
        if excess > 0 then retry = math.max(retry, math.ceil(excess * ratio(r))) end
      else
        local w = math.floor(now / r.I)
        local count = s.a == w and s.b or 0
        if count + job.cost > r.L then retry = math.max(retry, math.ceil((w + 1) * r.I - now)) end
      end
    end
    -- A pause or full lease set answers first; capacity is judged once admissible.
    if impossible and pause == 0 and leaseRetry == 0 then
      blocked[#blocked + 1] = { j - 1, 1, 0, 1 }
    elseif retry > 0 or impossible then
      blocked[#blocked + 1] = { j - 1, math.max(retry, 1), (lease and retry == leaseRetry) and 1 or 0, 0 }
    else
      granted[#granted + 1] = j - 1
      for _, zero in ipairs(job.refs) do
        local s = keys[zero + 1]
        local r = s.r
        s.changed = true
        if r.algo == 0 then s.a = math.max(s.a, s.th) + r.sr * job.cost
        else
          local w = math.floor(now / r.I)
          s.b = (s.a == w and s.b or 0) + job.cost
          s.a = w
        end
      end
      if lease then tokens[#tokens + 1] = { j - 1, lease.owner .. ':' .. (j - 1) } end
    end
  end
  -- No mutation above this point.
  commitLimits()
  for k, s in ipairs(keys) do
    local key, r = KEYS[k + 5], s.r
    if s.changed then
      if r.algo == 0 then redis.call('SET', key, fmt(s.a), 'PXAT', expireAt(r, s.a, s.th))
      else
        redis.call('HSET', key, 'w', fmt(s.a), 'n', fmt(s.b))
        redis.call('PEXPIREAT', key, math.ceil((s.a + 1) * r.I))
      end
    elseif r.algo == 0 and s.live and now < r.sw and s.a > s.th then
      -- After a rate decrease, keep live debt from expiring at its older, earlier time.
      redis.call('PEXPIREAT', key, expireAt(r, s.a, s.th))
    end
  end
  if lease then
    redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
    for _, token in ipairs(tokens) do redis.call('ZADD', KEYS[4], now + lease.ttlMs, token[2]) end
    local last = redis.call('ZRANGE', KEYS[4], -1, -1, 'WITHSCORES')
    if #last > 0 then redis.call('PEXPIREAT', KEYS[4], math.ceil(tonumber(last[2]))) end
  end
  return { granted, blocked, tokens, pause, changedSnapshot() }
end
return status('INVALID_OPTIONS', 'Unknown managed operation.')
