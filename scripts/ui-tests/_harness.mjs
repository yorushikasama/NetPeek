// UI 单测共用工具：把 ui/*.js 里的函数抽出来在 Node 里直接跑。
//
// 为什么不 import：这些文件是给浏览器用的 IIFE，顶层就摸 document / window，
// 直接 import 会立刻炸。而本轮要验证的恰好都是纯函数与格式化逻辑，抽出来跑
// 既快又不依赖浏览器（headless Chrome 在本机已不可用，见 docs/开发进度.md）。
//
// 运行：node scripts/ui-tests/run-all.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UI_DIR = path.resolve(HERE, '../../src/NetPeek.App/ui');

export function readUi(file) {
  return fs.readFileSync(path.join(UI_DIR, file), 'utf8');
}

/**
 * 抽出 `function name(...) { ... }` 的完整源码。
 * 用大括号配平定界；模板字符串里的 ${...} 本身成对，不会破坏计数。
 */
export function grabFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) {
    throw new Error(`未找到函数 ${name} —— 源文件改名后请同步更新测试`);
  }
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 的大括号不配平`);
}

/**
 * 把若干函数拼成一个工厂：函数体里对外部变量的引用改由形参提供。
 * 例：makeWith('main.js', ['clampUnit','fmtBytes'], { rateUnit: 'auto' })
 */
export function makeWith(file, names, params) {
  const src = readUi(file);
  const body = names.map((n) => grabFunction(src, n)).join('\n');
  const keys = Object.keys(params);
  const fn = new Function(...keys, `${body}\nreturn { ${names.join(', ')} };`);
  return fn(...keys.map((k) => params[k]));
}

/** 在干净上下文里加载浏览器 IIFE（提供最小 window），返回它的全局对象。
 *  extra 用来注入脚本顶层就需要的东西（如 document 桩）。
 *  定时器是浏览器天然有的，vm 沙箱里没有，所以一并补上——不然任何带防抖的
 *  脚本在这里第一行就炸，而那正是我们最想测的那类逻辑。 */
export function loadScripts(files, extra = {}) {
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    ...extra,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(readUi(f), ctx);
  return ctx;
}

export function loadBrowserScript(file) {
  return loadScripts([file]);
}

// ---------- 最小 DOM ----------
// updatePeerCell / peerIconNode 现在会建节点（旗帜是背景图方块，语义图标是内联 SVG），
// 只靠一个假对象测不动了。这里给一份够用的实现：元素 / 文本节点 / fragment，
// classList、style、dataset、innerHTML（当作不透明标记，不计入 textContent ——
// 真实 DOM 里 SVG 元素本来也没有文本）。
export function makeDocument() {
  const text = (v) => ({
    nodeType: 3,
    nodeValue: String(v),
    textContent: String(v),
  });
  const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : n.textContent);

  // 真实 DOM 里 appendChild/replaceChildren 遇到 DocumentFragment 会把它的子节点
  // 「搬」进去并清空 fragment；不模拟这一步，所有走 fragment 的代码在测试里
  // 都会表现成「只挂了一个空壳」。
  const flatten = (node) => {
    if (node.nodeType !== 11) return [node];
    const kids = node.children.flatMap(flatten);
    node.children = [];
    return kids;
  };

  const element = (tag) => {
    const el = {
      tagName: tag,
      nodeType: 1,
      className: '',
      title: '',
      hidden: false,
      style: {},
      dataset: {},
      children: [],
      _html: '',
      appendChild(c) {
        this.children.push(...flatten(c));
        return c;
      },
      replaceChildren(...cs) {
        this.children = cs.flatMap(flatten);
      },
      get firstChild() { return this.children[0]; },
      get lastChild() { return this.children[this.children.length - 1]; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); this.children = []; },
      get textContent() { return this.children.map(textOf).join(''); },
      set textContent(v) { this.children = v === '' || v === null ? [] : [text(String(v))]; },
    };
    const classes = new Set();
    el.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      has: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
    };
    return el;
  };

  return {
    createElement: element,
    createTextNode: text,
    createDocumentFragment: () => {
      const f = element('#fragment');
      f.nodeType = 11;
      return f;
    },
  };
}

/** 假的表格单元格：只需 textContent / title / classList / 子节点操作。 */
export function fakeCell(document) {
  return document.createElement('td');
}

// ---------- 断言 ----------
let failures = 0;
let checks = 0;

export function eq(actual, expected, label) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.log(`  FAIL ${label}`);
    console.log(`       got  ${JSON.stringify(actual)}`);
    console.log(`       want ${JSON.stringify(expected)}`);
  }
}

export function ok(value, label) {
  eq(!!value, true, label);
}

export function section(title) {
  console.log(`  · ${title}`);
}

export function report(name) {
  if (failures === 0) {
    console.log(`PASS ${name}（${checks} 项断言）`);
    return 0;
  }
  console.log(`FAIL ${name}（${failures}/${checks} 项失败）`);
  return 1;
}
