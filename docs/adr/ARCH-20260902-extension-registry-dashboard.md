# Extension Registry Dashboard

## Decision

Add a fork-specific **Extensions** entry to the FreeLLMAPI dashboard navigation. It opens a compact panel backed by a small typed registry of Imperium extension features. Each registry entry describes the feature, whether it is active, where its settings live, and one or more direct internal links to those settings.

The registry is documentation and navigation metadata only. It must not become a second settings store, duplicate feature state, or change upstream FreeLLMAPI behaviour. Feature settings continue to live in their existing pages and backend APIs.

The initial registry covers:

- unified-model provider preference ordering;
- per-key provider model access;
- provider/account RPM, RPD and TPD limits;
- quota-pool visibility and known-exhaustion routing protection;
- the separate extension-branch deployment model.

## Context

The provider-routing and quota extensions are working, but their controls are distributed across model detail pages, key-row hover actions and the chat-model quota summary. There is no visible extension index. A user could not locate the controls, and a future maintainer or AI entering the repository would have no durable map of which behaviour belongs to this fork.

## YC Forcing Questions

**Demand reality:** The controls were difficult to discover in the running dashboard, and the branch lacked a single user and maintainer entry point. This already caused confusion about whether the extension was loaded and where its settings lived.

**Narrowest wedge:** One visible Extensions navigation entry and one compact panel listing the currently shipped fork features with direct links. No plugin runtime, dynamic loading system or general marketplace.

**Future-fit:** A small typed registry lets later fork features register their documentation and navigation metadata without repeatedly redesigning the dashboard. Keeping the registry descriptive avoids coupling feature execution to the extension index.

## Consequences

**Makes easier:** Discovering extension controls, confirming that the custom image is loaded, onboarding future users and AIs, and adding documentation links for later fork features.

**Makes harder:** The registry must be updated whenever an extension control moves or a new fork feature ships. A stale link would create false confidence, so registry entries require navigation tests.

## Testing seam

Use the existing client test surface: unit-test the registry shape and render the navigation/panel to verify feature names, active state and internal destinations. Existing route and service tests remain the authority for the actual settings behaviour.

## Status

APPROVED 2026-09-02 — Pass 1 complete
