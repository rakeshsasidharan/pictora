# Progress

## #32 Private beta mode with invite allowlist

**Done:** nothing yet. The routine stopped before writing code.

**Left:** the whole scope:
- `BETA_MODE` per environment in CDK context
- `BETA#ALLOWLIST/<email>` items, with documented CLI commands
- the pre-sign-up allowlist check for email and Google sign-ups, and the "Pictora is in private beta" message
- admin add, remove and list
- the beta banner with a feedback link
- the tests the issue lists

**Why:** the issue asks for the allowlist to be managed "from the admin area (add, remove, list)". The admin area (route guard, `adminRoute`, admin layout and navigation) is #26, which is in PR #103 and not on `main`. Every issue starts from `main`, so the admin part can't be built or tested here without duplicating #26's code, and "Depends on" lists only #5 and #25.
