// Can this DOM stub actually deliver typing to React's onChange?
//
// This is the gate the whole repo was missing: the subagent testing this plugin
// found that NO existing gate had ever typed into a field, because the stub could
// not deliver the event. A controlled input is the smallest possible proof, and it
// is deliberately unrelated to the product code so a failure here means the
// harness is broken, not the plugin.
//
// Run: node test/s16-typing.mjs
import { join, sep } from "node:path";
import { createRequire } from "node:module";
import { installDom, typeInto } from "./dom-stub.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

const { document, Event } = installDom({ width: 360, height: 640 });
const ROOT = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules");
const requireFromProfile = createRequire(join(ROOT, "noop.js"));
const domEntry = requireFromProfile.resolve("react-dom/server");
const domRoot = domEntry.slice(0, domEntry.indexOf(`${sep}react-dom${sep}`));
const requireFromDom = createRequire(join(domRoot, "noop.js"));
const { createRoot } = requireFromDom("react-dom/client");
const React = requireFromDom("react");

async function settle(turns = 10) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// --- 1. the two properties React inspects -------------------------------
const probe = document.createElement("input");
check("an <input> reports type 'text' by default", probe.type === "text", `type=${probe.type}`);
check("value is NOT an own property (React needs this to install its tracker)",
  !Object.prototype.hasOwnProperty.call(probe, "value"),
  "own value property makes react-dom skip trackValueOnNode");
const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(probe), "value");
check("value has a prototype getter/setter", typeof descriptor?.get === "function" && typeof descriptor?.set === "function",
  JSON.stringify(Object.keys(descriptor ?? {})));

// A text node must expose nodeValue, because React writes text that way.
const textNode = document.createTextNode("a");
textNode.nodeValue = "b";
check("Text.nodeValue aliases .data", textNode.data === "b" && textNode.textContent === "b",
  `data=${textNode.data} textContent=${textNode.textContent}`);

// --- 2. a controlled input actually round-trips ------------------------
{
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const changes = [];
  function Field() {
    const [text, setText] = React.useState("");
    return React.createElement("input", {
      value: text,
      onChange: (event) => {
        changes.push(event.target.value);
        setText(event.target.value);
      },
    });
  }
  root.render(React.createElement(Field));
  await settle();

  const input = container.find((element) => element.localName === "input");
  check("the input rendered", input !== null);
  if (input !== null) {
    check("react-dom installed its value tracker", input._valueTracker !== undefined,
      "no _valueTracker means onChange will never fire");
    typeInto(input, "\u670d\u52a1\u573a\u666f", Event);
    await settle();
    check("onChange fired once", changes.length === 1, `changes=${JSON.stringify(changes)}`);
    check("onChange received the typed text", changes[0] === "\u670d\u52a1\u573a\u666f",
      `got ${JSON.stringify(changes[0])}`);
    check("the controlled value round-tripped", input.value === "\u670d\u52a1\u573a\u666f",
      `value=${JSON.stringify(input.value)}`);
    check("the DOM text reflects the state",
      container.textContent === "" || container.textContent === "\u670d\u52a1\u573a\u666f",
      JSON.stringify(container.textContent));

    // Typing again must produce a second, distinct change.
    typeInto(input, "\u670d\u52a1\u573a\u666f\u7814\u7a76", Event);
    await settle();
    check("a second edit fires another change", changes.length === 2, `changes=${JSON.stringify(changes)}`);
    // Clearing must work too: the product's search box has a clear button.
    typeInto(input, "", Event);
    await settle();
    check("clearing the field fires a change with an empty string",
      changes.at(-1) === "" && input.value === "", `last=${JSON.stringify(changes.at(-1))}`);
  }
  root.unmount();
  await settle(4);
}

// --- 3. a textarea behaves the same way --------------------------------
{
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const seen = [];
  function Area() {
    const [text, setText] = React.useState("");
    return React.createElement("textarea", {
      value: text,
      onChange: (event) => {
        seen.push(event.target.value);
        setText(event.target.value);
      },
    });
  }
  root.render(React.createElement(Area));
  await settle();
  const area = container.find((element) => element.localName === "textarea");
  check("the textarea rendered", area !== null);
  if (area !== null) {
    typeInto(area, "\u8bc1\u636e", Event);
    await settle();
    check("a textarea delivers onChange too", seen.length === 1 && seen[0] === "\u8bc1\u636e",
      `seen=${JSON.stringify(seen)}`);
  }
  root.unmount();
  await settle(4);
}

console.log("");
if (failures.length > 0) {
  console.log(`TYPING FAILED (${failures.length})`);
  for (const failure of failures) console.log(` - ${failure}`);
} else {
  console.log("TYPING PASS");
}
process.exit(failures.length === 0 ? 0 : 1);
