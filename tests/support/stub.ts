// Replace a method for the rest of a test, counting its calls: what
// node:test's t.mock.method does, in a form Bun's node:test runs too.
import type { TestContext } from "node:test";

export function stub<T extends object, K extends keyof T>(t: TestContext, object: T, method: K, replacement: T[K]): { calls: number } {
  const original = object[method];
  const counter = { calls: 0 };
  object[method] = ((...args: unknown[]) => {
    counter.calls++;
    return (replacement as (...a: unknown[]) => unknown)(...args);
  }) as T[K];
  t.after(() => {
    object[method] = original;
  });
  return counter;
}
