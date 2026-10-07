-- Remove the pause before publishing its wakeup.
redis.call('DEL', KEYS[1])
redis.call('PUBLISH', KEYS[2], 'resume')
return 1
