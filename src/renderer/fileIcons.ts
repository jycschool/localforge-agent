export interface FileVisual {
  className: string;
  label: string;
}

const EXTENSION_VISUALS: Record<string, FileVisual> = {
  css: { className: "icon-css", label: "#" },
  csv: { className: "icon-data", label: "≡" },
  gif: { className: "icon-image", label: "◆" },
  go: { className: "icon-go", label: "Go" },
  html: { className: "icon-html", label: "<>" },
  java: { className: "icon-java", label: "J" },
  jpeg: { className: "icon-image", label: "◆" },
  jpg: { className: "icon-image", label: "◆" },
  js: { className: "icon-js", label: "JS" },
  json: { className: "icon-json", label: "{}" },
  jsx: { className: "icon-react", label: "R" },
  lock: { className: "icon-lock", label: "◇" },
  md: { className: "icon-markdown", label: "M↓" },
  pdf: { className: "icon-pdf", label: "P" },
  png: { className: "icon-image", label: "◆" },
  ps1: { className: "icon-shell", label: ">_" },
  py: { className: "icon-python", label: "Py" },
  rs: { className: "icon-rust", label: "Rs" },
  scss: { className: "icon-css", label: "#" },
  sh: { className: "icon-shell", label: ">_" },
  svg: { className: "icon-image", label: "◆" },
  toml: { className: "icon-config", label: "⚙" },
  ts: { className: "icon-ts", label: "TS" },
  tsx: { className: "icon-react", label: "R" },
  txt: { className: "icon-text", label: "T" },
  webp: { className: "icon-image", label: "◆" },
  xml: { className: "icon-markup", label: "<>" },
  yaml: { className: "icon-yaml", label: "Y" },
  yml: { className: "icon-yaml", label: "Y" },
};

export function fileVisualFor(filePath: string): FileVisual {
  const fileName = filePath.split("/").pop()?.toLowerCase() ?? filePath.toLowerCase();
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName)) {
    return { className: "icon-test", label: "✓" };
  }
  if (
    fileName === ".gitignore" ||
    fileName === ".gitattributes" ||
    fileName === ".editorconfig" ||
    fileName === "dockerfile"
  ) {
    return { className: "icon-config", label: "⚙" };
  }
  if (fileName === "package.json" || fileName === "tsconfig.json") {
    return { className: "icon-config", label: "⚙" };
  }
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return EXTENSION_VISUALS[extension] ?? { className: "icon-default", label: "·" };
}
