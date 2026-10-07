-- Release slots and notify waiters in one server operation.
for i=1,#ARGV do redis.call('ZREM', KEYS[1], ARGV[i]) end
redis.call('PUBLISH', KEYS[2], 'release')
return 1
