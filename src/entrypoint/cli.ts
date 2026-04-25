#!/usr/bin/env node
import "dotenv/config";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  // 快路径：不需要加载 React/Ink
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(`easy-agent v${VERSION}`);
    process.exit(0);
  }

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`easy-agent v${VERSION} — Terminal-native agentic coding system\n...`);
    process.exit(0);
  }

  // --dump-system-prompt: 输出组装后的 system prompt
  if (process.argv.includes("--dump-system-prompt")) {
    const { buildSystemPrompt } = await import("../context/systemPrompt.js");
    const prompt = await buildSystemPrompt({ cwd: process.cwd() });
    console.log(prompt);
    process.exit(0);
  }

  // 解析 --model 参数
  const modelIndex = process.argv.indexOf("--model");
  const model = modelIndex !== -1 ? process.argv[modelIndex + 1] : undefined;

  // 动态 import React/Ink（只在真正需要时加载）
  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("../ui/App.js");
  const { DEFAULT_MODEL } = await import("../services/client.js");
  const { getToolsApiParams } = await import("../tools/index.js");
  const { buildSystemPrompt } = await import("../context/systemPrompt.js");

  const resolvedModel = model ?? DEFAULT_MODEL;
  const system = await buildSystemPrompt({ cwd: process.cwd() });
  const toolsApiParams = getToolsApiParams();

  const { waitUntilExit } = render(
    React.createElement(App, { model: resolvedModel, system, toolsApiParams }),
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});