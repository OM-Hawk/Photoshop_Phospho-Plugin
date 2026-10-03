// `npm run test:update` — reruns the suite and rewrites tests/__snapshots__/.
const { spawnSync } = require("node:child_process");
const r = spawnSync(process.execPath, ["--test", "tests/**/*.test.js"], {
  stdio: "inherit",
  env: { ...process.env, UPDATE_SNAPSHOTS: "1" }
});
process.exit(r.status ?? 1);
