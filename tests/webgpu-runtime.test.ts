import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWebGpuRuntime } from "../src/webgpu-runtime";

const ONNX_RUNTIME = Symbol.for("onnxruntime");
const previousRuntime = (globalThis as any)[ONNX_RUNTIME];

afterEach(() => {
  if (previousRuntime === undefined) {
    delete (globalThis as any)[ONNX_RUNTIME];
  } else {
    (globalThis as any)[ONNX_RUNTIME] = previousRuntime;
  }
});

describe("WebGPU runtime initialization", () => {
  it("registers ONNX Runtime Web before Transformers initializes", async () => {
    delete (globalThis as any)[ONNX_RUNTIME];
    const create = vi.fn();
    const processor = {};
    const model = {};

    const runtime = await loadWebGpuRuntime("local-model", {
      onnx: async () => ({ InferenceSession: { create } }),
      transformers: async () => {
        const registered = (globalThis as any)[ONNX_RUNTIME];
        if (typeof registered?.InferenceSession?.create !== "function") {
          throw new TypeError("Cannot read properties of undefined (reading 'create')");
        }
        return {
          AutoProcessor: { from_pretrained: vi.fn().mockResolvedValue(processor) },
          Qwen3_5ForConditionalGeneration: {
            from_pretrained: vi.fn().mockResolvedValue(model),
          },
        };
      },
    });

    expect(runtime).toEqual({ processor, model });
    expect((globalThis as any)[ONNX_RUNTIME].InferenceSession.create).toBe(create);
  });
});
