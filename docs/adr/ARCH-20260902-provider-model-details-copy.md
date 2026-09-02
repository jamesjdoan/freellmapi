# ARCH-20260902-provider-model-details-copy

## Decision

Add a **Copy provider model details** action to the Model Scope dialog in the
Imperium-maintained FreeLLMAPI extension.

The action copies a concise, human-readable Markdown snapshot for the provider
whose dialog is open. It includes the provider name; its current free catalogue
models; each model's display name and provider-native ID; enabled state;
capabilities; configured provider-account and provider/model limits; quota scope;
guidance verification and review dates; advisory warnings; and evidence links.

The snapshot includes all current free catalogue models for the provider and marks
each one enabled or disabled, so an LLM can check both the available pool and the
operator's current selection without receiving separate exports. When a provider
has no FreeLLMAPI catalogue entry and uses the existing live-discovery fallback,
the snapshot clearly labels those models as live-discovered rather than curated
free-tier facts.

The export deliberately excludes secrets and credential-identifying metadata:
full or masked API keys, credential labels, encryption data, internal database IDs,
dashboard tokens and unified API keys. It also excludes request and usage history;
the purpose is configuration and quota verification, not an operational data dump.

The format is Markdown rather than raw JSON. It should be compact enough to paste
into an LLM without overwhelming it: one short provider summary, one compact model
section, configured limits only where present, and one evidence section without
duplicating source links for every model.

Copying is read-only. It never saves the dialog, changes a model toggle, changes a
limit, probes a provider or sends information to an external service. The operator
chooses where to paste the clipboard contents.

## Context

The Model Scope dialog now brings together the provider's free model catalogue,
enabled state, configured account/model limits and researched quota guidance. An
operator who wants an LLM to verify the configuration currently has to transcribe
or screenshot several parts of the dialog, which is slow and can accidentally
include credential material.

## YC Forcing Questions

**Demand reality:** What's the evidence this is actually the problem? What breaks or
hurts right now without this? → The operator wants to paste the provider's free
models and limit configuration into an LLM for checking, but the information is
spread through the dialog and manual copying risks omissions or credential leakage.

**Narrowest wedge:** What's the smallest version that proves the idea is worth
pursuing? → One copy button in Model Scope that emits a concise Markdown snapshot
for the current provider, with model details, enabled state, limits and dated quota
evidence, but no credential data.

**Future-fit:** Does this still make sense in 2–3 years, or are we solving today's
pain with tomorrow's debt? → Yes. A provider-scoped Markdown snapshot remains useful
for human and LLM review as providers, model IDs and quota policies change. It is a
read-only projection of existing data rather than a second configuration store.

## Consequences

**Makes easier:** Reviewing provider configuration with an LLM; verifying whether
limits are account- or model-scoped; sharing a complete model pool without exposing
keys; preserving provenance and freshness in the review prompt.

**Makes harder:** The export formatter must stay aligned with the Model Scope data
contract and remain intentionally concise as new model metadata is added.

## Testing seam

Use one pure provider-snapshot formatter as the content seam and the rendered Model
Scope copy action as the UI seam. Tests must prove useful model and quota details are
included, absent limits are omitted cleanly, and credential values, masked keys,
labels and internal IDs never enter the copied text.

## Status

APPROVED 2026-09-02 — Pass 1 complete
