export const handlers = (globalThis.__events = {}); // lets tests emit backend events
export async function listen(name, fn) { handlers[name] = fn; return () => {}; }
