-- Renew only existing unexpired leases; never resurrect lost ownership.
redis.replicate_commands()
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local valid = 1
for i=2,#ARGV do
  if redis.call('ZSCORE', KEYS[1], ARGV[i]) then redis.call('ZADD', KEYS[1], 'XX', now + tonumber(ARGV[1]), ARGV[i])
  else valid = 0 end
end
local last = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
-- Absolute expiry on the TIME clock; see acquire.lua.
if #last > 0 then redis.call('PEXPIREAT', KEYS[1], math.ceil(tonumber(last[2]))) end
return valid
