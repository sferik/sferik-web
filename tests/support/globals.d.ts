// Test-only globals that the tests' init scripts install in the page.
export {};

declare global {
  interface Window {
    spoken: unknown[];
    locks: string[];
  }
}
