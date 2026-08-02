# Nazar

Nazar is a local, scoped agent for an Obsidian vault. The current code is an integration spike proving that Pi's SDK can run inside an Obsidian plugin with a single Obsidian-backed read tool.

## Development

The project requires Node.js 22.19 or newer.

```bash
npm install
npm test
npm run build
```

The spike expects an OpenAI-compatible local model server at `http://127.0.0.1:8080/v1`. It does not download or launch a model yet.
