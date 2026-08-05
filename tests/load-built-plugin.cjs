const Module = require("node:module");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const originalLoad = Module._load;

Module._load = function loadWithObsidianStub(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Notice: class Notice {},
      Plugin: class Plugin {},
      PluginSettingTab: class PluginSettingTab {},
      TFile: class TFile {},
      ItemView: class ItemView {},
      FuzzySuggestModal: class FuzzySuggestModal {},
      Modal: class Modal {
        open() {}
        close() {}
      },
      setIcon: () => undefined,
      MarkdownRenderer: { render: async () => undefined },
      normalizePath: (value) => value,
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const builtBundle = fs.readFileSync(path.resolve(__dirname, "../main.js"), "utf8");
assert.doesNotMatch(
  builtBundle,
  /name:"Provider"|providerKind/,
  "Built plugin still includes the obsolete provider selector",
);

try {
  const temporaryBundle = path.join(os.tmpdir(), "bolovan-load-test.cjs");
  fs.copyFileSync(path.resolve(__dirname, "../main.js"), temporaryBundle);
  require(temporaryBundle);
  console.log("Built Obsidian plugin module loaded successfully");
} finally {
  Module._load = originalLoad;
  fs.rmSync(path.join(os.tmpdir(), "bolovan-load-test.cjs"), { force: true });
}
