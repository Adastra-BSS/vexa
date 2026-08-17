/**
 * jsdom's Web Storage wins over the runtime's.
 *
 * Node ships its own `localStorage`/`sessionStorage` accessors on `globalThis`, and they throw
 * `SecurityError: Cannot initialize local storage without a --localstorage-file path` unless the
 * process was started with that flag. The jsdom environment does not replace a global that already
 * exists — and its `window` IS this `globalThis` — so a surface test touching `localStorage` reaches
 * Node's throwing accessor and nothing under test can persist anything.
 *
 * Fix it where it broke: mint a real jsdom window of our own and hand its two Storage objects to the
 * globals the surfaces read. Same implementation the environment would have installed (quota, event
 * semantics, `key()`/`length` included), so the tests exercise Web Storage rather than a stand-in.
 */
import { JSDOM } from "jsdom";

const storageWindow = new JSDOM("", { url: "https://localhost" }).window;

for (const name of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, name, {
    value: storageWindow[name],
    configurable: true,
    writable: true,
  });
}
