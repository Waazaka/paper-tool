// Where can a teardown throw take the UI down, and does the boundary save it?
//
// This gate exists because the reported "doc.destroy is not a function" happened
// inside a useEffect cleanup, and the answer to "who catches that?" is not the
// same for every unmount path. Getting it wrong is how a plugin ships a boundary
// that looks like a safety net but silently leaves a blank pane.
//
// Measured behaviour on React 19 (this gate asserts it, it does not assume it):
//   * root.unmount()        → the throw escapes the boundary; the pane ends EMPTY.
//   * a state update that   → the throw IS routed to the boundary, which renders
//     unmounts the child        its message. This is the path the user hit, and
//                              it is why they saw "这个视图出错了 doc.destroy …".
//
// Either way the lesson is the same and is enforced by s14: teardown code must
// never throw, because one of the two paths has no net under it.
//
// Run: node test/s15-teardown.mjs
import { join, sep } from "node:path";
import { createRequire } from "node:module";
import { installDom } from "./dom-stub.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

installDom({ width: 360, height: 640 });
const ROOT = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules");
const requireFromProfile = createRequire(join(ROOT, "noop.js"));
const domEntry = requireFromProfile.resolve("react-dom/server");
const domRoot = domEntry.slice(0, domEntry.indexOf(`${sep}react-dom${sep}`));
const requireFromDom = createRequire(join(domRoot, "noop.js"));
const { createRoot } = requireFromDom("react-dom/client");
const React = requireFromDom("react");

async function settle(turns = 12) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeBoundary() {
  return class Boundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
      return { error };
    }
    render() {
      return this.state.error === null
        ? this.props.children
        : React.createElement("div", null, `BOUNDARY: ${this.state.error.message}`);
    }
  };
}

// A child whose cleanup throws, exactly like the old doc.destroy() call did.
function makeThrowingChild(message) {
  return function ThrowingChild({ onReady }) {
    React.useEffect(() => {
      onReady?.();
      return () => {
        throw new Error(message);
      };
    }, []);
    return React.createElement("div", null, "child-body");
  };
}

// --- path 1: root.unmount() ---------------------------------------------
{
  const Boundary = makeBoundary();
  const Child = makeThrowingChild("teardown boom (root)");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(Boundary, null, React.createElement(Child)));
  await settle();

  check("path 1: the child mounts", container.textContent.includes("child-body"),
    container.textContent.slice(0, 120));

  let threwSynchronously = false;
  try {
    root.unmount();
  } catch {
    threwSynchronously = true;
  }
  await settle();
  check("path 1: root.unmount() does not rethrow into the caller", threwSynchronously === false,
    "a synchronous rethrow would crash the caller's event handler");
  check("path 1: the pane ends up EMPTY when a teardown throws", container.textContent.trim() === "",
    JSON.stringify(container.textContent.slice(0, 120)));
  check("path 1: the boundary does NOT catch a teardown throw",
    !container.textContent.includes("BOUNDARY"),
    "if this ever passes, React changed: revisit every teardown in client.js");
}

// --- path 2: a state update unmounts the child --------------------------
// This is what the user did: click 「返回列表」, which sets reader = null.
{
  const Boundary = makeBoundary();
  const Child = makeThrowingChild("teardown boom (state)");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let setShowChild = null;
  function Host() {
    const [show, setShow] = React.useState(true);
    setShowChild = setShow;
    return React.createElement(Boundary, null,
      show ? React.createElement(Child) : React.createElement("div", null, "list-view"));
  }
  root.render(React.createElement(Host));
  await settle();
  check("path 2: the child mounts", container.textContent.includes("child-body"),
    container.textContent.slice(0, 120));

  // Guard against stale references: the render has to have handed us the setter.
  if (setShowChild === null) {
    check("path 2: the host exposed its state setter", false);
  } else {
    try {
      setShowChild(false);
    } catch {
      /* a throw here would be caught by the boundary, not this try */
    }
    await settle();
    check("path 2: the pane is not left empty", container.textContent.trim() !== "",
      JSON.stringify(container.textContent.slice(0, 120)));
    check("path 2: the boundary catches the teardown throw from a state update",
      container.textContent.includes("BOUNDARY"),
      `pane: ${JSON.stringify(container.textContent.slice(0, 120))}`);
  }
  root.unmount();
  await settle(4);
}

console.log("");
if (failures.length > 0) {
  console.log(`TEARDOWN FAILED (${failures.length})`);
  for (const failure of failures) console.log(` - ${failure}`);
} else {
  console.log("TEARDOWN PASS");
}
process.exit(failures.length === 0 ? 0 : 1);
