// Host entry for @local/paper-tool.
//
// One service, two front doors: the sidebar reaches it over RPC, the agent
// through tools. Both go through the same methods.
import { PaperToolService } from "./lib/host-service.js";
import { registerPaperTools } from "./lib/tools.js";

export const inject = ["sessions", "typert", "tools"];

export function apply(ctx, config = {}) {
  // The library is shared across workspaces, and its default home is the
  // profile root rather than the cwd, so cross-workspace sessions see the same
  // shelf. Read here (not in the store) because the process environment is the
  // plugin's business, not the store's. `config.dbPath` still wins outright.
  const homeDir = config.homeDir ?? process.env.DSH_HOME ?? "";
  const service = new PaperToolService(ctx, { ...config, homeDir });
  // The service holds one SQLite handle per library. Without a teardown hook
  // a plugin reload leaks every handle plus its WAL/SHM files, and the
  // workspace directory then cannot be moved or deleted until DSH exits.
  ctx.effect(() => () => service.dispose());
  registerPaperTools(ctx, () => service);
}
