// 事件回归用 DOM 子集：解析真实 HTML，保留父子关系、节点复用及事件冒泡。
// 不模拟布局、原生控件默认动作或 canvas；不覆盖/抽取被测脚本中的业务函数。
export class DomEvent {
  constructor(type, init = {}) {
    Object.assign(this, { type, bubbles: false, cancelable: false, defaultPrevented: false }, init);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}

export class EventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event) {
    event.target = this;
    for (let node = this; node; node = node.parentNode) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners.get(event.type) || [])]) {
        const result = fn.call(node, event);
        if (result?.then) result.catch((error) => this.ownerDocument.errors.push(error));
      }
      if (!event.bubbles || event.stopped) break;
    }
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

class TextNode {
  constructor(value) { this.nodeType = 3; this.nodeValue = String(value); this.parentNode = null; }
  get textContent() { return this.nodeValue; }
  set textContent(value) { this.nodeValue = String(value); }
  remove() {
    if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
}

class Element extends EventTarget {
  constructor(tag, document) {
    super();
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.scrollHeight = this.clientHeight = this.scrollTop = 0;
    this.style = {
      setProperty(key, value) { this[key] = String(value); },
      getPropertyValue(key) { return this[key] || ''; },
      removeProperty(key) { delete this[key]; },
    };
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      contains: (name) => classes().has(name),
      add: (...names) => { this.className = [...new Set([...classes(), ...names])].join(' '); },
      remove: (...names) => { this.className = [...classes()].filter((s) => !names.includes(s)).join(' '); },
      toggle: (name, force) => {
        const on = force === undefined ? !classes().has(name) : !!force;
        this.classList[on ? 'add' : 'remove'](name);
        return on;
      },
    };
    const dataKey = (key) => 'data-' + key.replace(/[A-Z]/g, (s) => '-' + s.toLowerCase());
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute(dataKey(key)) ?? undefined,
      set: (_, key, value) => { this.setAttribute(dataKey(key), value); return true; },
    });
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get previousElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] || null; }
  remove() { TextNode.prototype.remove.call(this); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.insertBefore(child, before);
      return node;
    }
    if (node === before) return node;
    node.remove();
    const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    if (index < 0) throw new Error('insertBefore 的参照节点不属于父节点');
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) child.remove();
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new TextNode(node) : node);
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) { this.replaceChildren(value == null ? '' : String(value)); }
  set innerHTML(value) { this.replaceChildren(parseHtml(String(value), this.ownerDocument)); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.localName === 'select') return (this.querySelector('option[selected]') || this.querySelector('option'))?.value || '';
    return this.getAttribute('value') || '';
  }
  set value(value) { this._value = String(value); }
  matches(selector) {
    const parts = selector.trim().split(/\s+/);
    let node = this;
    if (!matchesSimple(node, parts.pop())) return false;
    while (parts.length) {
      const parent = parts.pop();
      do { node = node.parentElement; } while (node && !matchesSimple(node, parent));
      if (!node) return false;
    }
    return true;
  }
  closest(selector) {
    for (let node = this; node?.nodeType === 1; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new DomEvent('click', { bubbles: true, cancelable: true })); }
  getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }; }
}

for (const property of ['id', 'title', 'src', 'min', 'max', 'className']) {
  const attr = property === 'className' ? 'class' : property;
  Object.defineProperty(Element.prototype, property, {
    get() { return this.getAttribute(attr) || ''; },
    set(value) { this.setAttribute(attr, value); },
  });
}
for (const property of ['hidden', 'disabled', 'checked']) {
  Object.defineProperty(Element.prototype, property, {
    get() { return this.attributes.has(property); },
    set(value) { if (value) this.setAttribute(property, ''); else this.removeAttribute(property); },
  });
}

function matchesSimple(node, selector) {
  const tokens = selector.match(/^[\w*-]+|[.#][\w-]+|\[[\w-]+(?:=["']?[^\]"']*["']?)?\]/g) || [];
  if (tokens.join('') !== selector) throw new Error(`事件 DOM 未实现选择器：${selector}`);
  return tokens.every((token) => {
    if (token[0] === '.') return node.classList.contains(token.slice(1));
    if (token[0] === '#') return node.id === token.slice(1);
    if (token[0] === '[') {
      const [, key, value] = token.match(/^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/);
      return value === undefined ? node.attributes.has(key) : node.getAttribute(key) === value;
    }
    return token === '*' || node.localName === token.toLowerCase();
  });
}

function decode(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) =>
    entity[0] === '#' ? String.fromCodePoint(parseInt(entity.slice(entity[1] === 'x' ? 2 : 1), entity[1] === 'x' ? 16 : 10)) : named[entity]);
}

function parseHtml(html, document) {
  const root = document.createDocumentFragment();
  const stack = [root];
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  // 页面脚本通过 loadScripts 原样执行；这里禁止隐式执行 HTML 里的脚本。
  const source = html.replace(/<!--[\s\S]*?-->|<!doctype[^>]*>/gi, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  for (const token of source.match(/<\/?[a-z][^>]*>|[^<]+|</gi) || []) {
    if (token.startsWith('</')) {
      const tag = token.slice(2, -1).trim().toLowerCase();
      const index = stack.findLastIndex((node) => node.localName === tag);
      if (index > 0) stack.length = index;
    } else if (/^<[a-z]/i.test(token)) {
      const [, tag, attrs] = token.match(/^<([\w:-]+)([\s\S]*?)\/?\s*>$/);
      const node = document.createElement(tag);
      for (const [, key, double, single, bare] of attrs.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        node.setAttribute(key, decode(double ?? single ?? bare ?? ''));
      }
      stack.at(-1).appendChild(node);
      if (!voids.has(node.localName) && !token.endsWith('/>')) stack.push(node);
    } else {
      stack.at(-1).appendChild(document.createTextNode(decode(token)));
    }
  }
  return root;
}

export function makeEventDocument(html) {
  const document = new Element('#document', null);
  document.nodeType = 9;
  document.ownerDocument = document;
  document.errors = [];
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = (text) => new TextNode(text);
  document.createDocumentFragment = () => Object.assign(new Element('#fragment', document), { nodeType: 11 });
  document.getElementById = (id) => document.querySelector('#' + id);
  document.getSelection = () => ({ isCollapsed: true, toString: () => '' });
  document.appendChild(parseHtml(html, document));
  document.documentElement = document.querySelector('html');
  document.body = document.querySelector('body');
  return document;
}
