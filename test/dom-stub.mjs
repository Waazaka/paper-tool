// A minimal DOM for driving the real client bundle through real click sequences.
//
// The sidebar is a browser-only component, and every existing gate renders it
// with react-dom/server — which never runs an effect. That blind spot is exactly
// where "open the reader, then click another tab and the pane goes blank" lives:
// the crash happens in a useEffect or an async continuation, after render.
//
// This stub is deliberately small. It implements only the surface the client
// actually touches (elements, attributes, a little CSSOM, events, focus) so that
// react-dom/client can mount, effects can run, and a throw is observable instead
// of being swallowed by a renderer we cannot read. It is not a browser: no
// layout, so clientWidth/getBoundingClientRect are synthetic.
//
// Keep this file honest: if it needs to fake a behaviour to make a test pass, the
// test is wrong.

class ClassList {
  constructor() {
    this.tokens = new Set();
  }
  add(...names) {
    for (const name of names) if (name) this.tokens.add(name);
  }
  remove(...names) {
    for (const name of names) this.tokens.delete(name);
  }
  contains(name) {
    return this.tokens.has(name);
  }
  toggle(name, force) {
    const next = force === undefined ? !this.tokens.has(name) : Boolean(force);
    if (next) this.tokens.add(name);
    else this.tokens.delete(name);
    return next;
  }
  get value() {
    return [...this.tokens].join(" ");
  }
}

class Node {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    const parent = this.parentNode;
    return parent !== null && parent.nodeType === 1 ? parent : null;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, reference) {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    if (index < 0) throw new Error("insertBefore: reference is not a child");
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("removeChild: not a child");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this);
  }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) this.appendChild(node);
  }
  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    const text = new Text(this.ownerDocument, String(value ?? ""));
    this.replaceChildren(text);
  }
  contains(node) {
    for (let current = node; current !== null; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }
  // Depth-first walk, in document order, over elements only — what the tests
  // need to find a button by its accessible name.
  *elements() {
    for (const child of this.childNodes) {
      if (child.nodeType !== 1) continue;
      yield child;
      yield* child.elements();
    }
  }
  find(predicate) {
    for (const element of this.elements()) if (predicate(element)) return element;
    return null;
  }
  findAll(predicate) {
    return [...this.elements()].filter(predicate);
  }
  addEventListener(type, handler) {
    (this._listeners ??= new Map());
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this._listeners?.get(type)?.delete(handler);
  }
  dispatchEvent(event) {
    event.target ??= this;
    event.currentTarget = this;
    for (const handler of this._listeners?.get(event.type) ?? []) handler.call(this, event);
    // React attaches its listeners at the root and relies on bubbling.
    if (!event._stopped && this.parentNode !== null && this.parentNode.dispatchEvent) {
      this.parentNode.dispatchEvent(event);
    }
    return !event.defaultPrevented;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    // React sends className through setAttribute("class"), so the class list has
    // to be kept in sync or a `.pt-reader` lookup never matches a real node.
    if (name === "class") {
      this.className = String(value);
      for (const token of String(value).split(/\s+/)) if (token !== "") this.classList.add(token);
    }
    if (name === "id") this.id = String(value);
    if (name === "style") this.style.cssText = String(value);
    // Mirror the value/checked attributes onto the live properties, the way a
    // parser-set attribute behaves before the user types anything.
    if (name === "value") this._value = String(value);
    if (name === "checked") this.checked = value !== null && value !== false && value !== "false";
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

class Text extends Node {
  constructor(ownerDocument, data) {
    super(ownerDocument);
    this.nodeType = 3;
    this.nodeName = "#text";
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
  set textContent(value) {
    this.data = String(value ?? "");
  }
  // React updates text by assigning `node.nodeValue`, not `.data`. Making
  // nodeValue a real alias is what lets a re-rendered counter be visible: before
  // this, React wrote "1 / 5" into nodeValue while textContent still read the
  // stale "1 / ?", which looked exactly like a product bug.
  get nodeValue() {
    return this.data;
  }
  set nodeValue(value) {
    this.data = String(value ?? "");
  }
}

class Style {
  constructor() {
    this._props = new Map();
  }
  setProperty(name, value) {
    this._props.set(name, value);
  }
  getPropertyValue(name) {
    return this._props.get(name) ?? "";
  }
  removeProperty(name) {
    this._props.delete(name);
  }
  get cssText() {
    return [...this._props].map(([key, value]) => `${key}: ${value}`).join("; ");
  }
  set cssText(value) {
    this._props.clear();
    for (const part of String(value ?? "").split(";")) {
      const index = part.indexOf(":");
      if (index < 0) continue;
      const key = part.slice(0, index).trim();
      const val = part.slice(index + 1).trim();
      if (key !== "") this._props.set(key, val);
    }
  }
}

class Element extends Node {
  constructor(ownerDocument, tagName) {
    super(ownerDocument);
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.localName = String(tagName).toLowerCase();
    this.attributes = new Map();
    this.classList = new ClassList();
    this.style = new Style();
    this.className = "";
    this.id = "";
    // `value` is deliberately NOT assigned here. React decides whether to install
    // its change tracker with `!node.hasOwnProperty("value")`; an own data
    // property made every input untracked, which is why no gate in this repo had
    // ever successfully typed into a field. The accessor below lives on the
    // prototype so hasOwnProperty("value") stays false, like a real element.
    this._value = "";
    this.disabled = false;
    this.checked = false;
    this.dataset = {};
    this._rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  // react-dom's isTextInputElement() checks `supportedInputTypes[elem.type]`, so
  // an <input> without a type is not treated as a text input and onChange never
  // fires. Real inputs default to type="text".
  get type() {
    if (this.localName === "input") return this.getAttribute("type") ?? "text";
    if (this.localName === "textarea") return "textarea";
    return this.getAttribute("type") ?? undefined;
  }
  set type(value) {
    this.setAttribute("type", String(value));
  }
  get value() {
    return this._value;
  }
  set value(next) {
    this._value = String(next ?? "");
  }
  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }
  // react-dom's <select> handling iterates `select.options` and reads its length
  // while setting `value`. Without this collection it throws
  // "Cannot read properties of undefined (reading 'length')" from updateOptions,
  // which looks exactly like an application crash. A real HTMLSelectElement
  // exposes it, so the stub must too.
  get options() {
    if (this.localName !== "select") return undefined;
    return this.findAll((element) => element.localName === "option");
  }
  get selectedIndex() {
    const options = this.options ?? [];
    const index = options.findIndex((option) => option.selected === true);
    return index;
  }
  set selectedIndex(index) {
    for (const [position, option] of (this.options ?? []).entries()) option.selected = position === index;
  }
  get clientWidth() {
    return this._rect.width;
  }
  get clientHeight() {
    return this._rect.height;
  }
  getBoundingClientRect() {
    return { ...this._rect };
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
  click() {
    this.dispatchEvent(new DomEvent("click", { bubbles: true }));
  }
  getContext() {
    // Canvas 2D is not implemented. pdf.js is never loaded in these tests; a
    // test that needs it must inject its own stub rather than pretend here.
    return null;
  }
  closest(selector) {
    const wanted = String(selector).replace(/^\./, "");
    for (let node = this; node !== null && node.nodeType === 1; node = node.parentNode) {
      if (node.classList.contains(wanted)) return node;
    }
    return null;
  }
  querySelector(selector) {
    return this.find((element) => matches(element, selector));
  }
  querySelectorAll(selector) {
    return this.findAll((element) => matches(element, selector));
  }
}

function matches(element, selector) {
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  if (selector.startsWith("[")) {
    const inner = selector.slice(1, -1);
    const equals = inner.indexOf("=");
    if (equals < 0) return element.hasAttribute(inner);
    const name = inner.slice(0, equals);
    const value = inner.slice(equals + 1).replace(/^["']|["']$/g, "");
    return element.getAttribute(name) === value;
  }
  return element.localName === selector.toLowerCase();
}

class DomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? true;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stopped = false;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stopped = true;
  }
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = null;
    this.nodeType = 9;
    this.nodeName = "#document";
    this.activeElement = null;
    this.readyState = "complete";
    this.head = new Element(this, "head");
    this.body = new Element(this, "body");
    this.appendChild(this.head);
    this.appendChild(this.body);
    this._byId = new Map();
  }
  createElement(tagName) {
    return new Element(this, tagName);
  }
  createElementNS(_namespace, tagName) {
    return new Element(this, tagName);
  }
  createTextNode(data) {
    return new Text(this, data);
  }
  createDocumentFragment() {
    const fragment = new Element(this, "#fragment");
    fragment.nodeType = 11;
    return fragment;
  }
  getElementById(id) {
    return this.find((element) => element.id === id);
  }
  querySelector(selector) {
    return this.find((element) => matches(element, selector));
  }
  querySelectorAll(selector) {
    return this.findAll((element) => matches(element, selector));
  }
}

/**
 * Install the stub on globalThis and return handles the tests need.
 *
 * `size` lets a test give every element a non-zero box, which matters because
 * the reader derives its scale from clientWidth and divides by it. A zero-width
 * box would make the fit-to-width path silently no-op and hide a real crash.
 */
export function installDom({ width = 360, height = 640 } = {}) {
  const document = new Document();
  const window = {
    document,
    devicePixelRatio: 2,
    innerWidth: width,
    innerHeight: height,
    getSelection: () => null,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    URL: globalThis.URL,
    Blob: globalThis.Blob,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    queueMicrotask: globalThis.queueMicrotask,
    console: globalThis.console,
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  window.HTMLElement = Element;
  window.Element = Element;
  window.Node = Node;
  window.Event = DomEvent;
  window.MouseEvent = DomEvent;
  // react-dom probes these by name while tracking focus; an undefined constructor
  // throws "Right-hand side of 'instanceof' is not an object" on every commit.
  for (const name of [
    "HTMLIFrameElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
    "HTMLButtonElement", "HTMLCanvasElement", "HTMLDivElement", "HTMLSpanElement",
    "HTMLAnchorElement", "HTMLImageElement", "SVGElement", "SVGSVGElement",
  ]) window[name] = Element;

  // Give every element a box so layout-dependent code (fit-to-width) runs.
  const originalCreate = document.createElement.bind(document);
  document.createElement = (tagName) => {
    const element = originalCreate(tagName);
    element._rect = { x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height };
    return element;
  };

  globalThis.document = document;
  globalThis.window = window;
  globalThis.HTMLElement = Element;
  globalThis.Element = Element;
  globalThis.Node = Node;
  globalThis.Event = DomEvent;
  globalThis.MouseEvent = DomEvent;
  for (const name of [
    "HTMLIFrameElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
    "HTMLButtonElement", "HTMLCanvasElement", "HTMLDivElement", "HTMLSpanElement",
    "HTMLAnchorElement", "HTMLImageElement", "SVGElement", "SVGSVGElement",
  ]) globalThis[name] = Element;

  return { document, window, Event: DomEvent, Element };
}

/** Fire a real click on the first element whose text matches. */
export function clickText(root, text) {
  const target = root.find((element) => element.textContent.trim() === text)
    ?? root.find((element) => element.textContent.includes(text));
  if (target === null) throw new Error(`no clickable element contains ${JSON.stringify(text)}`);
  target.dispatchEvent(new DomEvent("click", { bubbles: true }));
  return target;
}

/**
 * Type into an input the way a browser does.
 *
 * The subtlety that made every typing test in this repo silently vacuous: React
 * detects a change by comparing the node's current value against the value its
 * tracker captured earlier. Setting `tracker.setValue(newValue)` before
 * dispatching tells React "nothing changed", so onChange never fires. The step
 * that is actually required is the opposite — leave the tracker holding the OLD
 * value, change the node, then dispatch; React compares, sees a difference, calls
 * onChange, and updates the tracker itself.
 */
export function typeInto(element, value, EventCtor) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")
    ?? Object.getOwnPropertyDescriptor(Element.prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
  // A real keystroke produces `input` for text fields; `change` follows on blur.
  // Dispatching both matches what a test keyed on either one expects.
  element.dispatchEvent(new EventCtor("input", { bubbles: true }));
  element.dispatchEvent(new EventCtor("change", { bubbles: true }));
}

export { DomEvent };
