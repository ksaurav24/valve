-- Extend a shared pause without shortening its remaining TTL.
local ms = math.ceil(tonumber(ARGV[1]))
local remaining = redis.call('PTTL', KEYS[1])
if ms > remaining and ms > 0 then redis.call('SET', KEYS[1], '1', 'PX', ms) end
return 1
