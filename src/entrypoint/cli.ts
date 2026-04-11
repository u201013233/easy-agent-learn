#!/usr/bin/env node
import "dotenv/config";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  // 快路径：不需要加载 React/Ink
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log( easy-agent v${VERSION} );
    process.exit(0);
  }

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log( easy-agent v${VERSION} — Terminal-native agentic coding system\n... );
    process.exit(0);
  }

  // 解析 --model 参数
  const modelIndex = process.argv.indexOf("--model");
  const model = modelIndex !== -1 ? process.argv[modelIndex + 1] : undefined;

  // 动态 import React/Ink（只在真正需要时加载）
  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("../ui/App.js");
  const { DEFAULT_MODEL } = await import("../services/api/client.js");

  const resolvedModel = model ?? DEFAULT_MODEL;
  const system = "You are a helpful AI coding assistant. Be concise and direct.";

  const { waitUntilExit } = render(
    React.createElement(App, { model: resolvedModel, system }),
  );
  await waitUntilExit();
}

main().catch((err) => {
  console.error( Fatal: ${err.message} );
  process.exit(1);
});