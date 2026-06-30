import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Locked decision #4 enforced mechanically: isolation of external clients. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("architecture guards", () => {
  const files = tsFiles("src");

  it("only src/db/client.ts imports @supabase/supabase-js (value import)", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      // type-only imports are fine (erased at runtime)
      const valueImport = /^import\s+(?!type\s)[^;]*from\s+["']@supabase\/supabase-js["']/m.test(
        src,
      );
      return valueImport && !f.endsWith("db/client.ts");
    });
    expect(offenders).toEqual([]);
  });

  it("only the LM Studio provider imports the openai SDK", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /from\s+["']openai["']/.test(src) && !f.endsWith("providers/lmstudio.ts");
    });
    expect(offenders).toEqual([]);
  });

  it("business logic never imports the supabase repositories directly (only composition roots may)", () => {
    const offenders = files.filter((f) => {
      if (f.includes(join("repositories", "supabase"))) return false;
      if (f.endsWith(join("api", "server.ts"))) return false;
      const src = readFileSync(f, "utf8");
      return /repositories\/supabase/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
