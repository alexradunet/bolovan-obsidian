const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalLoad = Module._load;

Module._load = function loadWithObsidianStub(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Notice: class Notice {},
      Plugin: class Plugin {},
      PluginSettingTab: class PluginSettingTab {},
      Setting: class Setting {},
      TFile: class TFile {},
      FileSystemAdapter: class FileSystemAdapter {},
      ItemView: class ItemView {},
      Modal: class Modal {
        open() {}
        close() {}
      },
      Component: class Component {
        load() {}
        unload() {}
      },
      MarkdownRenderer: { render: async () => undefined },
      normalizePath: (value) => value,
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

try {
  const temporaryBundle = path.join(os.tmpdir(), "bolovan-load-test.cjs");
  fs.copyFileSync(path.resolve(__dirname, "../main.js"), temporaryBundle);
  require(temporaryBundle);
  console.log("Built Obsidian plugin module loaded successfully");
} finally {
  Module._load = originalLoad;
  fs.rmSync(path.join(os.tmpdir(), "bolovan-load-test.cjs"), { force: true });
}
