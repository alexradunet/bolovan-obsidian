# Bolovan

Bolovan is an AI agent built directly into Obsidian. Install the plugin, choose a provider, and work with the vault from the sidebar on desktop or mobile—no external agent or native executable required.

## Providers

- **OpenAI** — enter an API key in Bolovan settings. The key is stored in Obsidian SecretStorage on the current device.
- **OpenAI-compatible** — advanced configuration for a custom `/v1` endpoint implementing Chat Completions and function tools.
- **Local WebGPU** — runs the curated, optimized Qwen 3.5 0.8B ONNX model through Transformers.js. The model downloads on first use and stays in the browser cache. There is intentionally no CPU fallback.

Provider profiles, secrets, model caches, the device id, and the selected conversation branch are device-local. Portable agent knowledge and conversations live in the synced brain folder.

## Vault capabilities

The harness exposes four tools: read a file, search notes, list a folder, and change a file. Every change displays the exact resulting content or move for approval. The commit then rechecks the note's SHA-256; if it changed after preview, nothing is written. The agent can read and list its own plugin source under `.obsidian/plugins/bolovan`, but every write under `.obsidian` stays refused.

The default brain folder is `system/Bolovan` and can be changed in settings. A manifest lets another device auto-discover it. Instructions, skills, prompts, and device-owned conversation branches sync as ordinary vault files. Concurrent branches are preserved and never automatically merged.

The composer can attach the active note and any `[[wikilink]]` mentions. Tool calls are visible in the transcript, runs are cancellable, and conversations can be resumed from the session picker.

## Development

Target: Obsidian 1.13.4 or newer on desktop and mobile.

```bash
npm install
npm test
npm run build
```

Engineering rules live in [AGENTS.md](AGENTS.md); load-bearing decisions live in [docs/adr/](docs/adr/).
