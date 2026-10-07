-- Extend a pause and notify subscribed valves atomically.
local current = redis.call('PTTL', KEYS[1])
local duration = math.max(current, math.ceil(tonumber(ARGV[1])))
if duration > 0 then redis.call('SET', KEYS[1], '1', 'PX', duration) end
redis.call('PUBLISH', KEYS[2], 'pause:' .. math.max(0, duration))
return 1
