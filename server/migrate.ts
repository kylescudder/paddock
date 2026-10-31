import { databaseUrl } from "./database.ts";
import { migrate } from "./migrations.ts";

await migrate(await databaseUrl());
console.log("Paddock schema is ready (drizzle-kit)");
