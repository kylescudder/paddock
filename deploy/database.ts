import { SQL } from "bun";

// Runtime role budget: app 4 + health 1 + deployment 1, out of 8 connections.
// Deployment checks are sequential and must not import the app's four-slot pool.
export function createDeploymentDatabase(url: string) {
  return new SQL(url, { max: 1, connectionTimeout: 10 });
}
