export interface LocalRuntime {
  processor: any;
  model: any;
}

interface TransformersRuntime {
  AutoProcessor: {
    from_pretrained(modelId: string): Promise<any>;
  };
  Qwen3_5ForConditionalGeneration: {
    from_pretrained(modelId: string, options: Record<string, unknown>): Promise<any>;
  };
}

interface OnnxRuntime {
  InferenceSession?: {
    create?: (...args: any[]) => unknown;
  };
}

export interface WebGpuRuntimeImports {
  onnx(): Promise<OnnxRuntime>;
  transformers(): Promise<TransformersRuntime>;
}

const defaultImports: WebGpuRuntimeImports = {
  onnx: () => import("onnxruntime-web/webgpu"),
  transformers: () => import("@huggingface/transformers"),
};

const ONNX_RUNTIME = Symbol.for("onnxruntime");

export async function loadWebGpuRuntime(
  modelId: string,
  imports: WebGpuRuntimeImports = defaultImports,
): Promise<LocalRuntime> {
  const onnx = await imports.onnx();
  if (typeof onnx.InferenceSession?.create !== "function") {
    throw new Error("ONNX Runtime Web failed to initialize for WebGPU");
  }
  // Obsidian's renderer exposes Node's `process`, so Transformers.js otherwise
  // selects its Node backend even though this is a browser-targeted bundle.
  // Transformers checks this documented override before detecting the host.
  (globalThis as any)[ONNX_RUNTIME] = onnx;

  const transformers = await imports.transformers();
  const [processor, model] = await Promise.all([
    transformers.AutoProcessor.from_pretrained(modelId),
    transformers.Qwen3_5ForConditionalGeneration.from_pretrained(modelId, {
      device: "webgpu",
      dtype: {
        embed_tokens: "q4",
        vision_encoder: "fp16",
        decoder_model_merged: "q4",
      },
    }),
  ]);
  return { processor, model };
}
