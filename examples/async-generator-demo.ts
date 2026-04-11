// ============================================================
// AsyncGenerator + yield 典型用法演示
// 运行: npx tsx examples/async-generator-demo.ts
// ============================================================

// ─── 1. 最基础的 Generator ──────────────────────────────────────
// function* 声明普通生成器，yield 暂停并产出值
function* simpleGenerator() {
  yield 1;
  yield 2;
  yield 3;
  return "done"; // return 值不会被 for...of 遍历到
}

console.log("=== 1. 基础 Generator ===");
for (const val of simpleGenerator()) {
  console.log("收到:", val);
}

// ─── 2. AsyncGenerator：模拟 LLM 流式输出 ───────────────────────
// async function* = 可以在内部 await，yield 产出 Promise 包裹的值
async function* fakeLLMStream(prompt: string): AsyncGenerator<string, string> {
  const words = `你好，我是 AI。你刚才说的是：「${prompt}」。这是一个流式回复的演示。`.split("");

  for (const char of words) {
    // 模拟网络延迟 — 每个 token 间隔 50ms
    await new Promise((r) => setTimeout(r, 50));
    yield char; // 逐字吐出
  }

  return "complete"; // 最终返回值
}

// 消费方用 for await 拉取
async function demoLLMStream() {
  console.log("\n=== 2. 模拟 LLM 流式输出 ===");
  process.stdout.write("AI: ");

  const gen = fakeLLMStream("帮我写个 Hello World");
  for await (const char of gen) {
    process.stdout.write(char);
  }
  console.log("\n(流式输出完毕)");
}

// ─── 3. 手动 .next() 控制拉取节奏 ────────────────────────────────
// for await 是语法糖，底层就是不断调用 .next()
async function demoManualNext() {
  console.log("\n=== 3. 手动 .next() 拉取 ===");
  const gen = fakeLLMStream("手动拉取");

  let result = await gen.next(); // 第一次拉取
  while (!result.done) {
    process.stdout.write(result.value);
    result = await gen.next(); // 继续拉取
  }
  console.log("\n最终 return 值:", result.value); // "complete"
}

// ─── 4. yield* 委托：生成器嵌套生成器 ─────────────────────────────
// yield* 把控制权交给另一个生成器
async function* generateHeader(): AsyncGenerator<string> {
  yield "--- 开始 ---\n";
}

async function* generateBody(): AsyncGenerator<string> {
  for (let i = 1; i <= 3; i++) {
    await new Promise((r) => setTimeout(r, 100));
    yield `第 ${i} 段内容\n`;
  }
}

async function* generateFooter(): AsyncGenerator<string> {
  yield "--- 结束 ---\n";
}

async function* fullDocument(): AsyncGenerator<string> {
  yield* generateHeader(); // 委托给 header 生成器
  yield* generateBody();   // 委托给 body 生成器
  yield* generateFooter(); // 委托给 footer 生成器
}

async function demoYieldStar() {
  console.log("\n=== 4. yield* 委托 ===");
  for await (const chunk of fullDocument()) {
    process.stdout.write(chunk);
  }
}

// ─── 5. 双向通信：调用方向生成器传值 ──────────────────────────────
// .next(value) 传入的值会成为 yield 表达式的返回值
async function* askBot(): AsyncGenerator<string, void, string> {
  //         TYield▲  TReturn▲  TNext▲ (调用方回传的类型)
  const name = yield "你叫什么名字？";
  const lang = yield `你好 ${name}！你喜欢什么编程语言？`;
  yield `${lang} 是个很好的选择！`;
}

async function demoTwoWay() {
  console.log("\n=== 5. 双向通信 ===");
  const bot = askBot();

  // 第一步：启动生成器，拿到第一个 yield 的值
  const q1 = await bot.next();
  console.log("Bot:", q1.value); // "你叫什么名字？"

  // 回答问题，值传回给生成器中 name 变量
  const q2 = await bot.next("小明");
  console.log("Bot:", q2.value); // "你好 小明！你喜欢什么编程语言？"

  const q3 = await bot.next("TypeScript");
  console.log("Bot:", q3.value); // "TypeScript 是个很好的选择！"
}

// ─── 6. 实际场景：带 AbortSignal 的流式管道 ───────────────────────
// 和项目 stream.ts 类似的模式
interface ChunkEvent {
  type: "start" | "data" | "end";
  text?: string;
  usage?: { tokens: number };
}

async function* streamWithSignal(
  signal: AbortSignal,
): AsyncGenerator<ChunkEvent, { totalTokens: number }> {
  let tokens = 0;
  yield { type: "start" };

  const words = "这是一段可以被中断的流式文本。".split("");
  for (const char of words) {
    if (signal.aborted) {
      // 检测到取消，提前结束
      return { totalTokens: tokens };
    }
    await new Promise((r) => setTimeout(r, 30));
    tokens++;
    yield { type: "data", text: char };
  }

  yield { type: "end", usage: { tokens } };
  return { totalTokens: tokens };
}

async function demoAbort() {
  console.log("\n=== 6. AbortSignal 中断流 ===");
  const controller = new AbortController();

  // 300ms 后取消
  setTimeout(() => {
    controller.abort();
    console.log("\n(已中断!)");
  }, 300);

  process.stdout.write("流: ");
  const gen = streamWithSignal(controller.signal);
  for await (const event of gen) {
    if (event.type === "data") {
      process.stdout.write(event.text!);
    }
  }
}

// ─── 运行所有演示 ──────────────────────────────────────────────
async function main() {
  for await (const demo of [
    demoLLMStream,
    demoManualNext,
    demoYieldStar,
    demoTwoWay,
    demoAbort,
  ]) {
    await demo();
  }
}

main().catch(console.error);
