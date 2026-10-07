-- End the shared pause.
return redis.call('DEL', KEYS[1])
