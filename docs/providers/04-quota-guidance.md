# Provider quota-guidance catalogue

The Imperium extension adds a source-linked free-tier guide beside **Keys → provider
key row → Models & account limits**. It answers three different questions without
mixing their answers:

1. **Published guidance** — what current provider evidence says the allowance is.
2. **Configured limits** — the local gates the operator chose to enforce.
3. **Observed usage** — response headers, cooldowns and recorded requests seen at
   runtime.

Changing one never silently rewrites either of the others.

## Catalogue ownership

The reviewed records live in
`server/src/data/quota-guidance.ts` on the separate extension branch. They are not
inserted into the remotely signed FreeLLMAPI catalogue and are not mutable database
state. A guidance change appears in the dashboard only after the extension image is
rebuilt and recreated through the documented extension deployment process.

The initial set covers the providers configured on the operator's installation on
2026-09-02: Google, Groq, Hugging Face, NVIDIA, Ollama, OpenCode Zen and OpenRouter.
The UI displays **Quota guidance not researched for this provider** for other
providers instead of inventing a default.

## Evidence rules

Evidence is ordered as follows:

1. a supervised authenticated account/API observation controls current account
   access;
2. official provider documentation controls the published allowance;
3. official provider announcements may supplement documentation;
4. forum and third-party material remains an unverified research lead.

Every record carries `verifiedAt` and `reviewAfter`. The normal review window is 30
days; volatile promotions and uncertain claims use an earlier date. Stale,
contradictory and superseded records remain visible but cannot populate limits.

## Applying guidance

The dashboard can copy verified, current RPM/RPD/TPM/TPD guidance into the editable
fields after a confirmation click. The operator must still review the populated
values and choose **Save**.

- Provider/account limits belong to one credential.
- Provider/model limits apply across all keys for that provider.
- Credit, currency, concurrency, compute and provider-defined windows are displayed
  as **Reference only** until FreeLLMAPI has a matching enforcement field.
- Guidance never disables or deletes a model. Advisory flags link the operator back
  to the existing model-access decision.

## Codex refresh workflow

Ask Codex to refresh the quota-guidance catalogue for the providers currently
configured in the running extension. The maintenance run must:

1. read this document and
   `docs/adr/ARCH-20260902-provider-quota-guidance.md`;
2. inspect configured provider names without reading or printing credentials;
3. search current first-party documentation before considering secondary sources;
4. retain conflicting claims separately and mark uncertainty instead of choosing an
   unsupported number;
5. update source URLs, `verifiedAt`, `reviewAfter`, status, facts and any model-ID
   replacements in `server/src/data/quota-guidance.ts`;
6. run the quota-guidance API test, provider-key settings tests, client guidance
   render test and production build;
7. present the diff for review without committing, pushing or deploying unless each
   action is separately requested.

Web research is read-only by default. A live provider call consumes real capacity and
requires explicit operator permission for that provider and that refresh. When
authorized, use the smallest practical completion, never change billing or keys, and
record the result as account-specific evidence rather than universal policy.

When a provider renames or removes a model, retain the old record as `superseded`,
link its replacement where known, and create a separate current record. Never carry
old limits across model identities automatically.
