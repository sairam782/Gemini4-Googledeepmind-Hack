// Vercel invokes the exported HTTP server for ordinary requests and WebSocket upgrades.
process.env.VERCEL = "1";
process.env.DATA_DIR ??= "/tmp/revoice";
process.env.LEARNING_DIR ??= "/tmp/revoice/learning";

const { default: server } = await import("../server/src/index.ts");
export default server;
