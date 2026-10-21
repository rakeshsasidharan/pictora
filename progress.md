# Progress

## #35 Image tools: upscale, remove background, erase object and outpaint

**Status:** blocked, not started. Flagged `needs-human` by the daily build routine on 2026-10-21.

**Done:** nothing on this branch beyond this note.

**Left:** the whole scope of #35: registry entries for the six Stability tool models, the `tool` job type, the worker's tool calls and version storage, the Tools menu with the mask editor and outpaint controls, IAM for the inference profiles, and the tests.

**Why:** the scope needs facts that the routine's cloud environment can't reach. Its network policy blocks `aws.amazon.com`, `docs.aws.amazon.com` and the price-listing sites, and web search found no per-image prices for these models.

- **Prices:** the issue asks for "prices from Bedrock pricing at build time, converted to points". Points drive what users are charged, the platform spend and the spend cap, so a guessed price is worse than none. The only figure found is a third-party listing of $0.06 for outpaint, which AWS doesn't confirm.
- **Model IDs and request bodies:** the IDs (`stability.stable-fast-upscale-v1:0`, `stability.stable-conservative-upscale-v1:0`, `stability.stable-creative-upscale-v1:0`, `stability.stable-image-remove-background-v1:0`, `stability.stable-image-erase-object-v1:0`, `stability.stable-outpaint-v1:0`) and the request fields (mask format, outpaint `left`/`right`/`up`/`down`, creative upscale's required `prompt`) can't be checked against the Bedrock model docs either.

**Needed:** one of these:

- Post on the issue the on-demand per-image price, in us-east-1 and us-west-2, of each of the six models, and confirm the model IDs. The routine can then build the full scope from that comment.
- Or allow `aws.amazon.com` and `docs.aws.amazon.com` in the routine environment's network policy, so the next run can read them itself.

After either, remove `needs-human` from #35.
