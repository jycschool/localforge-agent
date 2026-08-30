export interface FileVisual {
  className: string;
  label: string;
}

const EXTENSION_VISUALS: Record<string, FileVisual> = {
  c: { className: "icon-c", label: "C" },
  cjs: { className: "icon-js", label: "JS" },
  cpp: { className: "icon-cpp", label: "C+" },
  cs: { className: "icon-csharp", label: "C#" },
  css: { className: "icon-css", label: "CSS" },
  csv: { className: "icon-data", label: "CSV" },
  dart: { className: "icon-dart", label: "D" },
  env: { className: "icon-config", label: "ENV" },
  gif: { className: "icon-image", label: "IMG" },
  go: { className: "icon-go", label: "Go" },
  html: { className: "icon-html", label: "<>" },
  h: { className: "icon-c", label: "H" },
  hpp: { className: "icon-cpp", label: "H+" },
  ini: { className: "icon-config", label: "INI" },
  java: { className: "icon-java", label: "J" },
  jpeg: { className: "icon-image", label: "IMG" },
  jpg: { className: "icon-image", label: "IMG" },
  js: { className: "icon-js", label: "JS" },
  json: { className: "icon-json", label: "{}" },
  jsx: { className: "icon-react", label: "RX" },
  kt: { className: "icon-kotlin", label: "KT" },
  kts: { className: "icon-kotlin", label: "KT" },
  lock: { className: "icon-lock", label: "LK" },
  md: { className: "icon-markdown", label: "MD" },
  mjs: { className: "icon-js", label: "JS" },
  mts: { className: "icon-ts", label: "TS" },
  pdf: { className: "icon-pdf", label: "PDF" },
  php: { className: "icon-php", label: "PHP" },
  png: { className: "icon-image", label: "IMG" },
  ps1: { className: "icon-shell", label: ">_" },
  py: { className: "icon-python", label: "PY" },
  rb: { className: "icon-ruby", label: "RB" },
  rs: { className: "icon-rust", label: "RS" },
  scss: { className: "icon-css", label: "CSS" },
  sh: { className: "icon-shell", label: ">_" },
  sql: { className: "icon-data", label: "SQL" },
  svelte: { className: "icon-svelte", label: "SV" },
  svg: { className: "icon-image", label: "SVG" },
  swift: { className: "icon-swift", label: "SW" },
  toml: { className: "icon-config", label: "CFG" },
  ts: { className: "icon-ts", label: "TS" },
  tsx: { className: "icon-react", label: "RX" },
  txt: { className: "icon-text", label: "TXT" },
  vue: { className: "icon-vue", label: "V" },
  webp: { className: "icon-image", label: "IMG" },
  xml: { className: "icon-markup", label: "<>" },
  yaml: { className: "icon-yaml", label: "YML" },
  yml: { className: "icon-yaml", label: "YML" },
};

export function fileVisualFor(filePath: string): FileVisual {
  const fileName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? filePath.toLowerCase();
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName)) {
    return { className: "icon-test", label: "✓" };
  }
  if (
    fileName === ".gitignore" ||
    fileName === ".gitattributes" ||
    fileName === ".editorconfig" ||
    fileName === ".eslintignore" ||
    fileName === ".npmrc" ||
    fileName === ".prettierignore" ||
    fileName === "dockerfile"
  ) {
    return { className: "icon-config", label: "CFG" };
  }
  if (
    fileName === "package.json" ||
    fileName === "tsconfig.json" ||
    fileName.endsWith(".config.js") ||
    fileName.endsWith(".config.mjs") ||
    fileName.endsWith(".config.ts")
  ) {
    return { className: "icon-config", label: "CFG" };
  }
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return EXTENSION_VISUALS[extension] ?? { className: "icon-default", label: "" };
}
