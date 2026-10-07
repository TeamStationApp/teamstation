// Native ESM keeps compiled fixture services outside the TypeScript test hook.
export async function load(url) {
  return await import(url)
}
