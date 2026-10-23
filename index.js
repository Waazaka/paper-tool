// Host entry for @local/paper-tool.
//
// One service, two front doors: the sidebar reaches it over RPC, the agent
// through tools. Both go through the same methods.
import { PaperToolService } from "./lib/host-service.js";
import { registerPaperTools } from "./lib/tools.js";

export const inject = ["sessions", "typert", "tools"];

export function apply(ctx, config = {}) {
  const service = new PaperToolService(ctx, config);
  registerPaperTools(ctx, () => service);
}
