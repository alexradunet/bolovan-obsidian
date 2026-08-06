# Bolovan

Bolovan is an AI agent built directly into Obsidian. Install the plugin, configure a model endpoint, and work with the vault from the sidebar on desktop or mobile—no external agent or native executable required.

## Model endpoint

Bolovan talks to one OpenAI-compatible endpoint. Configure the base URL, model name, and an API key in Bolovan settings. The key is stored in Obsidian SecretStorage on the current device. Endpoint configuration, secrets, the device id, and the selected conversation branch are device-local. Portable agent knowledge and conversations live in the synced brain folder.

## Privacy and network use

Bolovan sends requests only to the OpenAI-compatible model endpoint configured by the user. Requests may include conversation history, brain instructions and skills, attached note content, and model tool calls and results. The endpoint provider's terms, privacy policy, data retention, account requirements, and pricing apply.

When asked to read an HTTP or HTTPS URL, Bolovan fetches that page through Obsidian and may include the extracted text in a model request. Bolovan does not include client-side telemetry.

## Vault capabilities

The harness exposes bounded vault reads, structured search, folder listing, metadata and structured-file inspection, exact approved changes, workspace navigation, and bounded web reads. Every vault change displays the exact resulting content or move for approval. The commit then rechecks the source SHA-256; if it changed after preview, nothing is written. The agent can read and list its own plugin source under `.obsidian/plugins/bolovan`, but every write under `.obsidian` stays refused.

Canvas (`.canvas`) and Bases (`.base`) files are first-class text formats. Bolovan can discover them, paginate exact source, inspect their parsed structure, create or patch them, and open them in Obsidian. Proposed Canvas JSON and Bases YAML must pass format-aware validation before an approval preview appears. For a one-off note filter Bolovan uses its cancellable vault search without changing a Base; Obsidian's exact Bases formula evaluation remains available by saving and opening a user-approved Base rather than through an undocumented background query interface.

The default brain folder is `system/Bolovan` and can be changed in settings. A manifest lets another device auto-discover it. Instructions, skills, and device-owned conversation branches sync as ordinary vault files. Concurrent branches are preserved and never automatically merged.

Bolovan can turn a reusable procedure from the conversation into a skill under the brain's `Skills` folder. It may propose a skill after a successful non-trivial workflow, a useful correction, or recovery from failure. Skill creation and updates use the same exact-preview approval as other vault changes, and skills can only describe how to use capabilities Bolovan already has.

The composer can attach the active note and any `[[wikilink]]` mentions. Paste an HTTP or HTTPS link into a message and Bolovan can fetch it through Obsidian's cross-platform network API, extract readable text, and use that text to answer. Images embedded in an answer with Markdown or a vault image embed display directly in the conversation. Tool calls are visible in the transcript, runs are cancellable, and conversations can be resumed from the session picker.

## Development

Target: Obsidian 1.13.4 or newer on desktop and mobile.

```bash
npm install
npm test
npm run build
```

Engineering rules live in [AGENTS.md](AGENTS.md); load-bearing decisions live in [docs/adr/](docs/adr/).

## License

Bolovan is available under the [MIT License](LICENSE).
