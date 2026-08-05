import { parseYaml } from "obsidian";

const MAX_INSPECT_ITEMS = 100;
const MAX_CONFIG_CHARS = 40_000;

type StructuredObject = Record<string, unknown>;

interface ParsedCanvas {
  nodes: StructuredObject[];
  edges: StructuredObject[];
}

export function inspectStructuredFile(path: string, content: string): StructuredObject | undefined {
  const extension = path.split(".").at(-1)?.toLocaleLowerCase();
  if (extension === "canvas") {
    const canvas = parseCanvas(content, path);
    const nodes = canvas.nodes.slice(0, MAX_INSPECT_ITEMS)
      .map((node, index) => ({ index, ...node }));
    const edges = canvas.edges.slice(0, MAX_INSPECT_ITEMS)
      .map((edge, index) => ({ index, ...edge }));
    return {
      format: "canvas",
      nodeCount: canvas.nodes.length,
      edgeCount: canvas.edges.length,
      nodes,
      edges,
      cappedAt: MAX_INSPECT_ITEMS,
      truncated: canvas.nodes.length > nodes.length || canvas.edges.length > edges.length,
      rules: [
        "Node array order is back-to-front z-order.",
        "Groups contain nodes by geometry, not child IDs.",
        "Preserve IDs and unknown keys; every edge must reference existing node IDs.",
      ],
    };
  }
  if (extension === "base") {
    const config = parseBase(content, path);
    const serialized = JSON.stringify(config);
    const truncated = serialized.length > MAX_CONFIG_CHARS;
    return {
      format: "base",
      config: truncated ? undefined : config,
      configPreview: truncated ? serialized.slice(0, MAX_CONFIG_CHARS) : undefined,
      configChars: serialized.length,
      truncated,
      expressionsEvaluated: false,
      rules: [
        "Global and view filters combine with AND.",
        "Preserve unknown view keys and use note., file., and formula. property sources deliberately.",
        "Obsidian evaluates formulas when the Base renders; inspection validates structure only.",
      ],
    };
  }
  return undefined;
}

export function validateStructuredFile(path: string, content: string): void {
  const extension = path.split(".").at(-1)?.toLocaleLowerCase();
  if (extension === "canvas") {
    parseCanvas(content, path);
  } else if (extension === "base") {
    parseBase(content, path);
  }
}

function parseCanvas(content: string, path: string): ParsedCanvas {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid Canvas JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = requireObject(parsed, `Invalid Canvas in ${path}: top level must be an object`);
  const nodesValue = root.nodes ?? [];
  const edgesValue = root.edges ?? [];
  if (!Array.isArray(nodesValue) || !Array.isArray(edgesValue)) {
    throw new Error(`Invalid Canvas in ${path}: nodes and edges must be arrays`);
  }

  const nodes: StructuredObject[] = [];
  const nodeIds = new Set<string>();
  for (const [index, rawNode] of nodesValue.entries()) {
    const context = `node ${index}`;
    const node = requireObject(rawNode, `Invalid Canvas in ${path}: ${context} must be an object`);
    const id = requiredFieldString(node, "id", path, context);
    if (nodeIds.has(id)) {
      throw new Error(`Invalid Canvas in ${path}: duplicate node id ${id}`);
    }
    nodeIds.add(id);
    const type = requiredFieldString(node, "type", path, context);
    for (const key of ["x", "y", "width", "height"]) {
      if (typeof node[key] !== "number" || !Number.isInteger(node[key])) {
        throw new Error(`Invalid Canvas in ${path}: ${context}.${key} must be an integer`);
      }
    }
    optionalFieldString(node, "color", path, context);
    if (type === "text") {
      requiredFieldString(node, "text", path, context, true);
    } else if (type === "file") {
      requiredFieldString(node, "file", path, context);
      const subpath = optionalFieldString(node, "subpath", path, context);
      if (subpath !== undefined && !subpath.startsWith("#")) {
        throw new Error(`Invalid Canvas in ${path}: ${context}.subpath must begin with #`);
      }
    } else if (type === "link") {
      requiredFieldString(node, "url", path, context);
    } else if (type === "group") {
      optionalFieldString(node, "label", path, context);
      optionalFieldString(node, "background", path, context);
      const style = optionalFieldString(node, "backgroundStyle", path, context);
      if (style !== undefined && !["cover", "ratio", "repeat"].includes(style)) {
        throw new Error(`Invalid Canvas in ${path}: ${context}.backgroundStyle is unsupported`);
      }
    } else {
      throw new Error(`Invalid Canvas in ${path}: ${context}.type ${type} is unsupported`);
    }
    nodes.push(node);
  }

  const edges: StructuredObject[] = [];
  const edgeIds = new Set<string>();
  for (const [index, rawEdge] of edgesValue.entries()) {
    const context = `edge ${index}`;
    const edge = requireObject(rawEdge, `Invalid Canvas in ${path}: ${context} must be an object`);
    const id = requiredFieldString(edge, "id", path, context);
    if (edgeIds.has(id)) {
      throw new Error(`Invalid Canvas in ${path}: duplicate edge id ${id}`);
    }
    edgeIds.add(id);
    const fromNode = requiredFieldString(edge, "fromNode", path, context);
    const toNode = requiredFieldString(edge, "toNode", path, context);
    if (!nodeIds.has(fromNode) || !nodeIds.has(toNode)) {
      throw new Error(`Invalid Canvas in ${path}: ${context} references a missing node`);
    }
    for (const key of ["fromSide", "toSide"]) {
      const side = optionalFieldString(edge, key, path, context);
      if (side !== undefined && !["top", "right", "bottom", "left"].includes(side)) {
        throw new Error(`Invalid Canvas in ${path}: ${context}.${key} is unsupported`);
      }
    }
    for (const key of ["fromEnd", "toEnd"]) {
      const end = optionalFieldString(edge, key, path, context);
      if (end !== undefined && !["none", "arrow"].includes(end)) {
        throw new Error(`Invalid Canvas in ${path}: ${context}.${key} is unsupported`);
      }
    }
    optionalFieldString(edge, "color", path, context);
    optionalFieldString(edge, "label", path, context);
    edges.push(edge);
  }

  return { nodes, edges };
}

function parseBase(content: string, path: string): StructuredObject {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    throw new Error(`Invalid Bases YAML in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = requireObject(parsed, `Invalid Base in ${path}: top level must be a YAML object`);

  if (root.filters !== undefined) {
    validateBaseFilter(root.filters, path, "filters");
  }
  validateOptionalStringMap(root, "formulas", path);
  validateOptionalStringMap(root, "summaries", path);
  if (root.properties !== undefined) {
    const properties = requireObject(root.properties, `Invalid Base in ${path}: properties must be an object`);
    for (const [property, rawConfig] of Object.entries(properties)) {
      const config = requireObject(
        rawConfig,
        `Invalid Base in ${path}: properties.${property} must be an object`,
      );
      optionalFieldString(config, "displayName", path, `properties.${property}`);
    }
  }
  if (root.views !== undefined) {
    if (!Array.isArray(root.views)) {
      throw new Error(`Invalid Base in ${path}: views must be an array`);
    }
    for (const [index, rawView] of root.views.entries()) {
      const context = `views.${index}`;
      const view = requireObject(rawView, `Invalid Base in ${path}: view ${index} must be an object`);
      requiredFieldString(view, "type", path, context);
      requiredFieldString(view, "name", path, context);
      if (view.filters !== undefined) {
        validateBaseFilter(view.filters, path, `${context}.filters`);
      }
      if (view.order !== undefined
        && (!Array.isArray(view.order) || view.order.some((property) => typeof property !== "string"))) {
        throw new Error(`Invalid Base in ${path}: ${context}.order must be a string array`);
      }
      if (view.summaries !== undefined) {
        validateStringMap(view.summaries, path, `${context}.summaries`);
      }
      if (view.groupBy !== undefined) {
        const groupBy = requireObject(
          view.groupBy,
          `Invalid Base in ${path}: ${context}.groupBy must be an object`,
        );
        optionalFieldString(groupBy, "property", path, `${context}.groupBy`);
        const direction = optionalFieldString(groupBy, "direction", path, `${context}.groupBy`);
        if (direction !== undefined && direction !== "ASC" && direction !== "DESC") {
          throw new Error(`Invalid Base in ${path}: ${context}.groupBy.direction must be ASC or DESC`);
        }
      }
      if (view.limit !== undefined
        && (typeof view.limit !== "number" || !Number.isInteger(view.limit) || view.limit < 0)) {
        throw new Error(`Invalid Base in ${path}: ${context}.limit must be a non-negative integer`);
      }
    }
  }
  return root;
}

function validateBaseFilter(value: unknown, path: string, context: string): void {
  if (typeof value === "string") {
    return;
  }
  const filter = requireObject(
    value,
    `Invalid Base in ${path}: ${context} must be an expression string or filter object`,
  );
  const keys = Object.keys(filter);
  const key = keys[0];
  if (keys.length !== 1 || !key || !["and", "or", "not"].includes(key) || !Array.isArray(filter[key])) {
    throw new Error(`Invalid Base in ${path}: ${context} must contain one and, or, or not array`);
  }
  for (const [index, child] of filter[key].entries()) {
    validateBaseFilter(child, path, `${context}.${key}.${index}`);
  }
}

function validateOptionalStringMap(value: StructuredObject, key: string, path: string): void {
  if (value[key] !== undefined) {
    validateStringMap(value[key], path, key);
  }
}

function validateStringMap(value: unknown, path: string, context: string): void {
  const map = requireObject(value, `Invalid Base in ${path}: ${context} must be an object`);
  if (Object.values(map).some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid Base in ${path}: ${context} must map names to strings`);
  }
}

function requiredFieldString(
  value: StructuredObject,
  key: string,
  path: string,
  context: string,
  allowEmpty = false,
): string {
  const field = value[key];
  if (typeof field !== "string" || (!allowEmpty && !field)) {
    throw new Error(`Invalid structured file ${path}: ${context}.${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return field;
}

function optionalFieldString(
  value: StructuredObject,
  key: string,
  path: string,
  context: string,
): string | undefined {
  const field = value[key];
  if (field !== undefined && typeof field !== "string") {
    throw new Error(`Invalid structured file ${path}: ${context}.${key} must be a string`);
  }
  return field;
}

function requireObject(value: unknown, message: string): StructuredObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as StructuredObject;
}
