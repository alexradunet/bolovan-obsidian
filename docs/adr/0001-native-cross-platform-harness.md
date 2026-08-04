# ADR 0001: Own a cross-platform Obsidian agent harness

Date: 2026-08-04
Status: Accepted

## Context

Bolovan must install as one Community Plugin and behave consistently across Obsidian desktop and mobile. Requiring a separately installed process excludes mobile and makes setup dependent on the host operating system. A Node-oriented agent SDK has the same portability problem and delegates product behavior that Bolovan needs to control.

Obsidian provides the common boundaries we need on every platform: `Vault` and `FileManager` for notes, `requestUrl` for remote providers, `SecretStorage` for device-local credentials, and a browser renderer where WebGPU may be available.

## Decision

Bolovan owns a small native harness with two deep seams:

- A normalized model adapter supports hosted OpenAI, advanced OpenAI-compatible endpoints, and a lazy Transformers.js WebGPU provider.
- A Vault tool adapter exposes exactly `vault_read`, `vault_search`, `vault_list`, and `vault_change` through Obsidian APIs.

There are no process, shell, raw-filesystem, or Node runtime dependencies. Local inference is WebGPU-only; there is no silent CPU fallback. A device without qualified WebGPU uses a remote provider.

Every mutation is a two-phase operation. The adapter prepares and displays the exact resulting content or move, the user approves it, and the commit rechecks the source SHA-256. A stale approval writes nothing.

Portable configuration lives in a visible, configurable brain folder identified by `bolovan-brain.json`. Instructions, skills, prompts, and per-device conversation branches sync with the vault. API keys, provider configuration, cache data, the device id, and active-branch selection remain device-local. A device never writes another device's branch; it forks before appending.

## Consequences

- One plugin bundle works on every platform supported by the targeted Obsidian release.
- Provider behavior and tool semantics are product code and can be tested independently.
- Remote calls use completed-response rendering as the portable guarantee. Streaming can be added as a provider-specific enhancement later.
- Local model weights are downloaded on first use and retained by the browser cache; that cache is deliberately not synced.
- `web_search`, self-modifying plugin code, arbitrary shell access, and external brain folders are outside this milestone.
