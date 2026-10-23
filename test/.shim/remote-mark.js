// Apply the public @Remote decorator from @deepseek-ai/dsh-typert-protocol to a
// plain-JS class method. The package ships decorators for TS/next-JS sources;
// without decorator syntax we drive the same public API with a synthesized
// decorator context, so the resulting prototype marker is byte-identical to the
// one the compiler pipeline would write (`remoteMethods()` reads it back).
import { Remote } from "file:///D:/dhs/%E7%9F%A5%E8%AF%86%E5%BA%93%E6%8F%92%E4%BB%B6/packages/paper-tool/test/.shim/protocol-shim.mjs";

export function markRemote(Class, methodName) {
  const initializers = [];
  Remote(undefined, {
    name: methodName,
    private: false,
    static: false,
    addInitializer(fn) { initializers.push(fn); },
  });
  const receiver = Object.create(Class.prototype);
  for (const fn of initializers) fn.call(receiver);
}
