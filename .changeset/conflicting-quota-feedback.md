---
'@ksaurav24/valve': patch
---

Honor the longest exhausted quota window when combining provider feedback readers, including conflicting IETF and x-ratelimit headers. Keep remaining/reset values paired within one reader and preserve explicit Retry-After precedence. Previously combine() selected the first remaining and reset independently; missing fields are now kept missing rather than borrowed from another quota. Standalone readers retain their parsing behavior.
