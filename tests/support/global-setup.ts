import { mcr } from "./coverage.ts";

export default async function globalSetup() {
  mcr().cleanCache();
}
