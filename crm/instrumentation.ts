export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { start } = await import("./instrumentation.node");
  await start();
}
