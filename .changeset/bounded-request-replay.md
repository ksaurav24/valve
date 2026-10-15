---
'valvejs': patch
---

Bound automatic replay of inherited Request bodies to 64 KiB by default.
Larger bodies are sent once, avoiding whole-upload buffering during retries.
Use a finite `maxReplayBodySize` to adjust the byte limit, or `0` to send
Request bodies once without probing. Small string and byte bodies still
retry under the existing method policy. Explicit `init.body` overrides no
longer clone the unused Request body; direct init streams remain single-use.
